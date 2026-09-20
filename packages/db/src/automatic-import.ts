import { randomUUID } from 'node:crypto';
import {
  parseCaption,
  ticketExtractionSchema,
  validatedLayoutsSchema,
  betInputSchema,
  financeCommandSchema,
  cents,
  money,
  saoPauloDate,
  parseAutomaticPlacedAt,
  automaticPolicyIsCurrent,
  automaticPolicyV2Schema,
  type ValidatedLayout,
  type AutomaticPolicyV2,
  type AutomaticReason,
  type BetInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { FinanceError, type SettingsRow } from './finance-core.js';
import { createFinanceService } from './finance-service.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { automaticPolicyDigest, layoutDigest } from './automatic-policy.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';

type Evidence = {
  extraction?: unknown;
  model?: unknown;
  layoutId?: unknown;
  policyDigest?: unknown;
  ocrConsistent?: unknown;
};
type CatalogAlias = { catalog_id: string; kind: string; label: string };
type AliasResolution =
  { state: 'resolved'; catalogId: string } | { state: 'missing' } | { state: 'ambiguous' };
type BookmakerContext =
  | { state: 'resolved'; bookmakerId: string; tipsterId: string }
  | { state: 'review'; reason: 'CAPTION_UNRESOLVED' | 'BOOKMAKER_UNRESOLVED' }
  | { state: 'refused'; reason: 'BOOKMAKER_REFUSED' };
const normalized = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

function resolveAlias(
  aliases: CatalogAlias[],
  kind: string,
  value: string | null,
): AliasResolution {
  if (!value) return { state: 'missing' };
  const ids = new Set(
    aliases
      .filter((alias) => alias.kind === kind && normalized(alias.label) === normalized(value))
      .map((alias) => alias.catalog_id),
  );
  if (ids.size === 1) return { state: 'resolved', catalogId: [...ids][0]! };
  return ids.size === 0 ? { state: 'missing' } : { state: 'ambiguous' };
}

async function resolveBookmakerContext(
  client: PoolClient,
  caption: string,
  bookmakerOverrideId: string | null,
): Promise<BookmakerContext> {
  const labels = parseCaption(caption);
  const aliases = (
    await client.query<CatalogAlias>(
      'select a.catalog_id,a.kind,a.label from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id and c.organization_id=a.organization_id where a.organization_id=current_setting($$app.organization_id$$, true)::uuid and c.active',
    )
  ).rows;
  const tipster = resolveAlias(aliases, 'tipster', labels.tipster);
  if (tipster.state !== 'resolved') return { state: 'review', reason: 'CAPTION_UNRESOLVED' };

  // A selected catalog id is authoritative, but it is revalidated in this
  // transaction so an inactive, wrong-kind, or cross-tenant id cannot select a
  // layout or reach the financial writer.
  if (bookmakerOverrideId) {
    const selected = (
      await client.query<{ id: string }>(
        'select id from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and kind=$2 and active',
        [bookmakerOverrideId, 'bookmaker'],
      )
    ).rows[0];
    if (!selected) return { state: 'refused', reason: 'BOOKMAKER_REFUSED' };
    return { state: 'resolved', bookmakerId: selected.id, tipsterId: tipster.catalogId };
  }

  if (!labels.bookmaker) return { state: 'review', reason: 'BOOKMAKER_UNRESOLVED' };
  const bookmaker = resolveAlias(aliases, 'bookmaker', labels.bookmaker);
  if (bookmaker.state !== 'resolved') return { state: 'refused', reason: 'BOOKMAKER_REFUSED' };
  return { state: 'resolved', bookmakerId: bookmaker.catalogId, tipsterId: tipster.catalogId };
}

async function candidate(
  client: PoolClient,
  result: Evidence,
  layout: {
    model: ValidatedLayout['model'];
    allowFreebet: boolean;
    placedAtFormats: ValidatedLayout['placedAtFormat'][];
  },
  bookmakerId: string,
  tipsterId: string,
  origin: { kind: 'real' | 'freebet' | null; freebetId: string | null },
  now: Date,
): Promise<{ reason: AutomaticReason; bet?: BetInput }> {
  const evidence = ticketExtractionSchema.safeParse(result.extraction);
  if (!evidence.success) return { reason: 'EXTRACTION_UNCERTAIN' };
  const extraction = evidence.data;
  if (
    extraction.warnings.length ||
    extraction.currency !== 'BRL' ||
    !extraction.stake ||
    !extraction.odds
  )
    return { reason: 'EXTRACTION_UNCERTAIN' };
  if (result.ocrConsistent === false) return { reason: 'EXTRACTION_UNCERTAIN' };
  // STK-G0-19-R5: a origem financeira é declarada pelo usuário (Mini App/web);
  // sem ela nenhuma aposta financeira é criada (fail-closed). A leitura visual
  // da IA é apenas diagnóstico: um conflito explícito encaminha para revisão e
  // nunca altera automaticamente a escolha do usuário.
  if (origin.kind === null) return { reason: 'ORIGIN_UNRESOLVED' };
  if (origin.kind === 'real' && extraction.freebet === true) return { reason: 'FREEBET_CONFLICT' };
  if (origin.kind === 'freebet' && extraction.freebet === false)
    return { reason: 'FREEBET_CONFLICT' };
  // Data da aposta: somente o texto visual do comprovante (a data do jogo é
  // outro campo — eventAt, declarado pelo usuário e inicialmente pendente). O
  // horário de upload/Telegram nunca é usado como horário da aposta.
  const placedAtCandidates = layout.placedAtFormats
    .map((format) => parseAutomaticPlacedAt(extraction.placedAtText, format))
    .filter((value): value is string => value !== null);
  const uniquePlacedAt = [...new Set(placedAtCandidates)];
  const placedAt = uniquePlacedAt.length === 1 ? uniquePlacedAt[0]! : null;
  if (extraction.placedAtText !== null && placedAt === null)
    return { reason: 'PLACED_AT_UNCERTAIN' };
  if (placedAt === null) return { reason: 'PLACED_AT_UNCERTAIN' };
  if (Date.parse(placedAt) > now.getTime()) return { reason: 'PLACED_AT_UNCERTAIN' };
  let stake: string;
  try {
    stake = money(cents(extraction.stake));
  } catch {
    return { reason: 'EXTRACTION_UNCERTAIN' };
  }
  let freebetId: string | null = null;
  if (origin.kind === 'freebet') {
    if (!layout.allowFreebet) return { reason: 'FREEBET_UNRESOLVED' };
    // O crédito é o escolhido explicitamente pelo usuário; nunca ambíguo.
    if (!origin.freebetId) return { reason: 'FREEBET_UNRESOLVED' };
    const credits = (
      await client.query<{ id: string; stake_returned: boolean }>(
        'select id,stake_returned from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and bookmaker_id=$2 and amount=$3 and used_by is null and expires_on >= $4::date for update',
        [origin.freebetId, bookmakerId, stake, saoPauloDate(new Date(placedAt))],
      )
    ).rows;
    if (credits.length !== 1) return { reason: 'FREEBET_UNRESOLVED' };
    // O stake_returned do crédito é aplicado na própria transação financeira
    // (finance-commands lê o crédito sob lock); aqui basta o vínculo.
    freebetId = credits[0]!.id;
  }
  const parsed = betInputSchema.safeParse({
    bookmakerId,
    tipsterId,
    stake,
    odds: extraction.odds,
    placedAt,
    freebetId,
    // Referencia vazia e aceita quando a casa nao a apresenta (ex.: Bet365):
    // a deduplicacao por imagem/referencia/similaridade acontece na mesma
    // transacao financeira e colisao segue bloqueando. NUNCA gravamos uma
    // referencia sintetica.
    reference: extraction.reference ?? '',
    allowMissingUnit: false,
    // Data/hora do evento NÃO pertence à importação automática desta fase:
    // toda seleção nasce pendente de enriquecimento (eventDate e eventAt
    // nulos, dateStatus 'pending'). eventDateText é reservado e depreciado —
    // nunca é convertido em data, nunca autoriza nem bloqueia a importação.
    selections: extraction.selections.map((selection) => ({
      event: selection.event,
      sport: selection.sport,
      market: selection.market,
      selection: selection.selection,
      odds: selection.odds,
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending' as const,
    })),
  });
  if (!parsed.success) return { reason: 'EXTRACTION_UNCERTAIN' };
  // STK-G0-19-R6: o retorno visual é somente diagnóstico de fidelidade —
  // nunca bloqueia a importação. A base financeira é a stake validada, a odd
  // total validada e o cálculo decimal server-side (stake × totalOdds); uma
  // divergência visual não é prova de que stake/odd estejam erradas.
  return { reason: 'IMPORTED', bet: parsed.data };
}

export function createAutomaticImportService(
  database: Database,
  configuredPolicy: AutomaticPolicyV2 | ValidatedLayout[] | null = [],
) {
  const legacyLayouts = Array.isArray(configuredPolicy)
    ? validatedLayoutsSchema.parse(configuredPolicy)
    : [];
  const globalPolicy =
    configuredPolicy && !Array.isArray(configuredPolicy)
      ? automaticPolicyV2Schema.parse(configuredPolicy)
      : null;
  const finance = createFinanceService(database);
  const tenant = createTenantContext(database);
  return {
    async complete(
      context: OrganizationContext,
      id: string,
      attempt: number,
      result: Evidence & object,
    ) {
      if (legacyLayouts.length || globalPolicy) await finance.ensureCurrentUnit(context);
      return tenant.withOrganizationTransaction(context, async (client) => {
        // All financial writers acquire locks in this order: settings, inbox, attachment.
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0]!;
        const row = (
          await client.query<{
            caption: string;
            version: number;
            bet_origin: string | null;
            freebet_id: string | null;
            bookmaker_override_id: string | null;
          }>(
            "update integration.inbox set state='review',extraction=$2,error_code=null,version=version+1,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and state='processing' and attempts=$3 returning caption,version,bet_origin,freebet_id,bookmaker_override_id",
            [id, JSON.stringify(result), attempt],
          )
        ).rows[0];
        if (!row) return { state: 'unchanged' as const };
        const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
        let reason: AutomaticReason = 'LAYOUT_NOT_VALIDATED';
        let betId: string | null = null;
        const modelSelectedLayout =
          (result.layoutId !== undefined && result.layoutId !== null) ||
          (result.policyDigest !== undefined && result.policyDigest !== null);
        const bookmakerContext = modelSelectedLayout
          ? ({ state: 'refused', reason: 'BOOKMAKER_REFUSED' } as const)
          : await resolveBookmakerContext(client, row.caption, row.bookmaker_override_id);
        const activeGlobalPolicy =
          globalPolicy && automaticPolicyIsCurrent(globalPolicy, now.getTime())
            ? globalPolicy
            : null;
        const legacyLayout =
          bookmakerContext.state === 'resolved'
            ? legacyLayouts.filter(
                (value) =>
                  value.bookmakerId === bookmakerContext.bookmakerId &&
                  value.model === result.model &&
                  Date.parse(value.approvedAt) <= now.getTime() &&
                  Date.parse(value.expiresAt) > now.getTime(),
              ).length === 1
              ? (legacyLayouts.find(
                  (value) =>
                    value.bookmakerId === bookmakerContext.bookmakerId &&
                    value.model === result.model &&
                    Date.parse(value.approvedAt) <= now.getTime() &&
                    Date.parse(value.expiresAt) > now.getTime(),
                ) ?? null)
              : null
            : null;
        const layout = activeGlobalPolicy
          ? bookmakerContext.state === 'resolved' && result.model === activeGlobalPolicy.model
            ? {
                model: activeGlobalPolicy.model,
                allowFreebet: activeGlobalPolicy.allowFreebet,
                placedAtFormats: activeGlobalPolicy.placedAtFormats,
              }
            : null
          : legacyLayout
            ? {
                model: legacyLayout.model,
                allowFreebet: legacyLayout.allowFreebet,
                placedAtFormats: [legacyLayout.placedAtFormat],
              }
            : null;
        if (modelSelectedLayout) reason = 'EXTRACTION_UNCERTAIN';
        else if (bookmakerContext.state !== 'resolved') reason = bookmakerContext.reason;
        else if (!layout) reason = 'LAYOUT_NOT_VALIDATED';
        if (layout && bookmakerContext.state === 'resolved') {
          await client.query('savepoint automatic_finance');
          try {
            const assessed = await candidate(
              client,
              result,
              layout,
              bookmakerContext.bookmakerId,
              bookmakerContext.tipsterId,
              {
                kind:
                  row.bet_origin === 'real' || row.bet_origin === 'freebet' ? row.bet_origin : null,
                freebetId: row.freebet_id,
              },
              now,
            );
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
          policyId: activeGlobalPolicy ? 'automatic-import-v2' : (legacyLayout?.id ?? null),
          policyDigest: activeGlobalPolicy
            ? automaticPolicyDigest(activeGlobalPolicy)
            : legacyLayout
              ? layoutDigest(legacyLayout)
              : null,
          bookmakerOrigin: layout ? ('context' as const) : null,
          visualLayoutId: null,
        };
        await client.query(
          'update integration.inbox set extraction=$2 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
          [id, JSON.stringify({ ...result, automatic })],
        );
        await client.query(
          "insert into finance.audit(type,actor,entity_id,after) values('import.automatic','system:automatic-import',$1,$2)",
          [id, JSON.stringify({ attempt, ...automatic, betId })],
        );
        return { state: betId ? ('imported' as const) : ('review' as const), reason };
      });
    },
  };
}
