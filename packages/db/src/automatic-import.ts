import { randomUUID } from 'node:crypto';
import {
  parseCaption,
  ticketExtractionSchema,
  validatedLayoutsSchema,
  betInputSchema,
  financeCommandSchema,
  cents,
  money,
  suggestedReturn,
  saoPauloDate,
  parseAutomaticPlacedAt,
  automaticEventDate,
  type ValidatedLayout,
  type AutomaticReason,
  type BetInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { FinanceError, type SettingsRow } from './finance-core.js';
import { createFinanceService } from './finance-service.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { layoutDigest } from './automatic-policy.js';

type Evidence = {
  extraction?: unknown;
  model?: unknown;
  layoutId?: unknown;
  policyDigest?: unknown;
};
const normalized = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

async function candidate(
  client: PoolClient,
  caption: string,
  result: Evidence,
  layout: ValidatedLayout,
  now: Date,
): Promise<{ reason: AutomaticReason; bet?: BetInput }> {
  const evidence = ticketExtractionSchema.safeParse(result.extraction);
  if (!evidence.success) return { reason: 'EXTRACTION_UNCERTAIN' };
  const extraction = evidence.data;
  if (
    extraction.warnings.length ||
    extraction.currency !== 'BRL' ||
    extraction.freebet === null ||
    !extraction.stake ||
    !extraction.odds ||
    !extraction.reference?.trim()
  )
    return { reason: 'EXTRACTION_UNCERTAIN' };
  const labels = parseCaption(caption);
  if (labels.requiresReview) return { reason: 'CAPTION_UNRESOLVED' };
  const aliases = (
    await client.query<{ catalog_id: string; kind: string; label: string }>(
      'select a.catalog_id,a.kind,a.label from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id where c.active',
    )
  ).rows;
  const match = (kind: string, value: string | null) => {
    const ids = new Set(
      aliases
        .filter(
          (alias) => value && alias.kind === kind && normalized(alias.label) === normalized(value),
        )
        .map((alias) => alias.catalog_id),
    );
    return ids.size === 1 ? [...ids][0] : null;
  };
  const tipsterId = match('tipster', labels.tipster);
  const bookmakerId = match('bookmaker', labels.bookmaker);
  if (!tipsterId || !bookmakerId) return { reason: 'CAPTION_UNRESOLVED' };
  if (
    bookmakerId !== layout.bookmakerId ||
    match('bookmaker', extraction.bookmaker) !== bookmakerId
  )
    return { reason: 'BOOKMAKER_CONFLICT' };
  const placedAt = parseAutomaticPlacedAt(extraction.placedAtText, layout.placedAtFormat);
  if (!placedAt || Date.parse(placedAt) > now.getTime()) return { reason: 'PLACED_AT_UNCERTAIN' };
  let stake: string;
  try {
    stake = money(cents(extraction.stake));
  } catch {
    return { reason: 'EXTRACTION_UNCERTAIN' };
  }
  let freebetId: string | null = null;
  let stakeReturned = false;
  if (extraction.freebet) {
    if (!layout.allowFreebet) return { reason: 'FREEBET_UNRESOLVED' };
    const credits = (
      await client.query<{ id: string; stake_returned: boolean }>(
        'select id,stake_returned from finance.freebet where bookmaker_id=$1 and amount=$2 and used_by is null and expires_on >= $3::date order by id limit 2 for update',
        [bookmakerId, stake, saoPauloDate(new Date(placedAt))],
      )
    ).rows;
    if (credits.length !== 1) return { reason: 'FREEBET_UNRESOLVED' };
    freebetId = credits[0]!.id;
    stakeReturned = credits[0]!.stake_returned;
  }
  const parsed = betInputSchema.safeParse({
    bookmakerId,
    tipsterId,
    stake,
    odds: extraction.odds,
    placedAt,
    freebetId,
    reference: extraction.reference,
    allowMissingUnit: false,
    selections: extraction.selections.map((selection) => {
      const eventDate = automaticEventDate(selection.eventDateText);
      return {
        event: selection.event,
        sport: selection.sport,
        market: selection.market,
        selection: selection.selection,
        odds: selection.odds,
        eventDate,
        eventAt: null,
        dateStatus: eventDate ? 'estimated' : 'pending',
      };
    }),
  });
  if (!parsed.success) return { reason: 'EXTRACTION_UNCERTAIN' };
  if (extraction.potentialReturn !== null) {
    try {
      if (
        cents(extraction.potentialReturn) !==
        cents(suggestedReturn(stake, extraction.odds, 'win', extraction.freebet, stakeReturned))
      )
        return { reason: 'RETURN_MISMATCH' };
    } catch {
      return { reason: 'RETURN_MISMATCH' };
    }
  }
  return { reason: 'IMPORTED', bet: parsed.data };
}

export function createAutomaticImportService(
  database: Database,
  configuredLayouts: ValidatedLayout[] = [],
) {
  const layouts = validatedLayoutsSchema.parse(configuredLayouts);
  const finance = createFinanceService(database);
  return {
    async complete(id: string, attempt: number, result: Evidence & object) {
      if (layouts.length) await finance.ensureCurrentUnit();
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        // All financial writers acquire locks in this order: settings, inbox, attachment.
        const settings = (
          await client.query<SettingsRow>('select * from finance.settings where id=1 for update')
        ).rows[0]!;
        const row = (
          await client.query<{ caption: string; version: number }>(
            "update integration.inbox set state='review',extraction=$2,error_code=null,version=version+1,updated_at=now() where id=$1 and state='processing' and attempts=$3 returning caption,version",
            [id, JSON.stringify(result), attempt],
          )
        ).rows[0];
        if (!row) {
          await client.query('commit');
          return { state: 'unchanged' as const };
        }
        const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
        const layout = layouts.find(
          (value) =>
            value.id === result.layoutId &&
            value.model === result.model &&
            layoutDigest(value) === result.policyDigest &&
            Date.parse(value.approvedAt) <= now.getTime(),
        );
        let reason: AutomaticReason = 'LAYOUT_NOT_VALIDATED';
        let betId: string | null = null;
        if (layout) {
          await client.query('savepoint automatic_finance');
          try {
            const assessed = await candidate(client, row.caption, result, layout, now);
            reason = assessed.reason;
            if (assessed.bet) {
              const command = financeCommandSchema.parse({
                type: 'import.confirm',
                expectedVersion: settings.version,
                importId: id,
                expectedInboxVersion: row.version,
                decision: { kind: 'create', bet: assessed.bet, duplicateReason: '' },
              });
              const applied = await executeFinancialCommand(
                client,
                'system:automatic-import',
                randomUUID(),
                command,
                settings,
              );
              betId = applied.id;
            }
            await client.query('release savepoint automatic_finance');
          } catch (error) {
            await client.query('rollback to savepoint automatic_finance');
            if (error instanceof FinanceError) {
              reason =
                error.code === 'UNIT_REQUIRED' || error.code === 'DUPLICATE_REVIEW_REQUIRED'
                  ? error.code
                  : 'FINANCIAL_REVIEW_REQUIRED';
            } else if (
              error instanceof Error &&
              ['INVALID_MONEY', 'MONEY_OUT_OF_RANGE', 'INVALID_ODDS'].includes(error.message)
            ) {
              reason = 'FINANCIAL_REVIEW_REQUIRED';
            } else if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              ['23505', '23514', '23503'].includes(String(error.code))
            ) {
              reason = 'FINANCIAL_REVIEW_REQUIRED';
            } else {
              throw error;
            }
          }
        }
        const automatic = {
          reason,
          policyId: layout?.id ?? null,
          policyDigest: layout ? layoutDigest(layout) : null,
        };
        await client.query('update integration.inbox set extraction=$2 where id=$1', [
          id,
          JSON.stringify({ ...result, automatic }),
        ]);
        await client.query(
          "insert into finance.audit(type,actor,entity_id,after) values('import.automatic','system:automatic-import',$1,$2)",
          [id, JSON.stringify({ attempt, ...automatic, betId })],
        );
        await client.query('commit');
        return { state: betId ? ('imported' as const) : ('review' as const), reason };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
