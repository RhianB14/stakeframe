import { randomUUID } from 'node:crypto';
import {
  parseCaption,
  ticketExtractionSchema,
  validatedLayoutsSchema,
  betInputSchema,
  financeCommandSchema,
  cents,
  money,
  normalizeEventLabel,
  saoPauloDate,
  parseAutomaticPlacedAt,
  automaticPolicyIsCurrent,
  automaticPolicyV3Schema,
  type ValidatedLayout,
  type AutomaticPolicyV3,
  type AutomaticReason,
  automaticReasonSchema,
  type BetInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { FinanceError, type SettingsRow } from './finance-core.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { automaticBookmakerSlug, automaticPolicyDigest, layoutDigest } from './automatic-policy.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';

type Evidence = {
  extraction?: unknown;
  model?: unknown;
  layoutId?: unknown;
  policyDigest?: unknown;
  ocrConsistent?: unknown;
};
type CatalogAlias = { catalog_id: string; kind: string; label: string; name: string };
type AliasResolution =
  | { state: 'resolved'; catalogId: string; name: string }
  | { state: 'missing' }
  | { state: 'ambiguous' };
type BookmakerContext =
  | { state: 'resolved'; bookmakerId: string; bookmakerName: string; tipsterId: string }
  | { state: 'review'; reason: 'CAPTION_UNRESOLVED' | 'BOOKMAKER_UNRESOLVED' }
  | { state: 'refused'; reason: 'BOOKMAKER_REFUSED' };
const normalized = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

async function createIncompleteTicket(
  client: PoolClient,
  settings: SettingsRow,
  extractionValue: unknown,
  bookmakerContext: BookmakerContext,
  now: Date,
) {
  const parsed = ticketExtractionSchema.safeParse(extractionValue);
  const extraction = parsed.success ? parsed.data : null;
  const id = randomUUID();
  const ticketNumber = settings.next_ticket_number;
  if (!Number.isInteger(ticketNumber) || ticketNumber < 1)
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  await client.query(
    'update finance.settings set next_ticket_number=next_ticket_number+1 where organization_id=current_setting($$app.organization_id$$, true)::uuid',
  );
  const resolved = bookmakerContext.state === 'resolved' ? bookmakerContext : null;
  const stake = extraction?.stake && extraction.stake !== '0' ? extraction.stake : null;
  const reference = extraction?.reference?.trim() || null;
  await client.query(
    "insert into finance.bet(id,ticket_number,bookmaker_id,tipster_id,stake,odds,placed_at,freebet_id,promotional_stake_returned,reference,remaining,unit_month,unit_amount,stake_journal_id,completion_state) values($1,$2,$3,$4,$5,$6,$7,null,false,$8,null,null,null,null,'incomplete')",
    [
      id,
      ticketNumber,
      resolved?.bookmakerId ?? null,
      resolved?.tipsterId ?? null,
      stake,
      extraction?.odds ?? null,
      now,
      reference,
    ],
  );
  const selections = extraction?.selections?.length
    ? extraction.selections
    : [{ event: null, sport: null, market: null, selection: null, odds: null }];
  for (const [position, selection] of selections.entries())
    await client.query(
      "insert into finance.selection(bet_id,position,event,sport,market,selection,odds,event_date,event_at,date_status) values($1,$2,$3,$4,$5,$6,$7,null,null,'pending')",
      [
        id,
        position,
        normalizeEventLabel(selection.event?.trim() || 'A definir'),
        selection.sport?.trim() || null,
        selection.market?.trim() || 'A definir',
        selection.selection?.trim() || 'A definir',
        selection.odds ?? null,
      ],
    );
  return id;
}

function resolveAlias(
  aliases: CatalogAlias[],
  kind: string,
  value: string | null,
): AliasResolution {
  if (!value) return { state: 'missing' };
  const matches = aliases.filter(
    (alias) => alias.kind === kind && normalized(alias.label) === normalized(value),
  );
  const ids = new Set(matches.map((alias) => alias.catalog_id));
  if (ids.size === 1) return { state: 'resolved', catalogId: [...ids][0]!, name: matches[0]!.name };
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
      'select a.catalog_id,a.kind,a.label,c.name from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id and c.organization_id=a.organization_id where a.organization_id=current_setting($$app.organization_id$$, true)::uuid and c.active',
    )
  ).rows;
  const tipster = resolveAlias(aliases, 'tipster', labels.tipster);
  if (tipster.state !== 'resolved') return { state: 'review', reason: 'CAPTION_UNRESOLVED' };

  // A selected catalog id is authoritative, but it is revalidated in this
  // transaction so an inactive, wrong-kind, or cross-tenant id cannot select a
  // layout or reach the financial writer.
  if (bookmakerOverrideId) {
    const selected = (
      await client.query<{ id: string; name: string }>(
        'select id,name from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and kind=$2 and active',
        [bookmakerOverrideId, 'bookmaker'],
      )
    ).rows[0];
    if (!selected) return { state: 'refused', reason: 'BOOKMAKER_REFUSED' };
    return {
      state: 'resolved',
      bookmakerId: selected.id,
      bookmakerName: selected.name,
      tipsterId: tipster.catalogId,
    };
  }

  if (!labels.bookmaker) return { state: 'review', reason: 'BOOKMAKER_UNRESOLVED' };
  const bookmaker = resolveAlias(aliases, 'bookmaker', labels.bookmaker);
  if (bookmaker.state !== 'resolved') return { state: 'refused', reason: 'BOOKMAKER_REFUSED' };
  return {
    state: 'resolved',
    bookmakerId: bookmaker.catalogId,
    bookmakerName: bookmaker.name,
    tipsterId: tipster.catalogId,
  };
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
  origin: { kind: 'real' | 'freebet' | 'hibrida'; freebetId: string | null },
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
  // A origem promocional é declarada pelo usuário (Mini App/web); sem ela o
  // produto assume dinheiro real. A leitura visual da IA é apenas diagnóstico:
  // um conflito explícito encaminha para revisão e nunca altera a escolha do
  // usuário.
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
      event: normalizeEventLabel(selection.event),
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
  configuredPolicy: AutomaticPolicyV3 | ValidatedLayout[] | null = [],
) {
  const legacyLayouts = Array.isArray(configuredPolicy)
    ? validatedLayoutsSchema.parse(configuredPolicy)
    : [];
  const globalPolicy =
    configuredPolicy && !Array.isArray(configuredPolicy)
      ? automaticPolicyV3Schema.parse(configuredPolicy)
      : null;
  const tenant = createTenantContext(database);
  return {
    async complete(
      context: OrganizationContext,
      id: string,
      attempt: number,
      result: Evidence & object,
    ) {
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
            imported_bet_id: string | null;
          }>(
            "update integration.inbox set extraction=$2,error_code=null,version=version+1,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and state='processing' and attempts=$3 returning caption,version,bet_origin,freebet_id,bookmaker_override_id,imported_bet_id",
            [id, JSON.stringify(result), attempt],
          )
        ).rows[0];
        if (!row) return { state: 'unchanged' as const };
        const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
        let reason: AutomaticReason = 'IMPORTED';
        let betId: string | null = row.imported_bet_id;
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
        // STK-G0-22-F6: apenas casas APROVADAS na policy explícita podem
        // seguir para o caminho automático; casa pendente ou fora da lista
        // permanece em revisão manual (fail-closed) — nenhuma policy
        // habilita uma casa sem homologação completa.
        const approvedBookmaker =
          bookmakerContext.state === 'resolved' &&
          (activeGlobalPolicy?.bookmakers.approved as readonly string[] | undefined)?.includes(
            automaticBookmakerSlug(bookmakerContext.bookmakerName) ?? '',
          ) === true;
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
          ? bookmakerContext.state === 'resolved' &&
            result.model === activeGlobalPolicy.model &&
            approvedBookmaker
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
        else if (!layout && activeGlobalPolicy && !approvedBookmaker)
          reason = 'BOOKMAKER_NOT_APPROVED';
        else if (!layout) reason = 'LAYOUT_NOT_VALIDATED';
        if (!betId && layout && bookmakerContext.state === 'resolved') {
          const assessed = await candidate(
            client,
            result,
            layout,
            bookmakerContext.bookmakerId,
            bookmakerContext.tipsterId,
            {
              kind:
                row.bet_origin === 'freebet' || row.bet_origin === 'hibrida'
                  ? row.bet_origin
                  : 'real',
              freebetId: row.freebet_id,
            },
            now,
          );
          reason = assessed.reason;
          if (assessed.bet) {
            try {
              const command = financeCommandSchema.parse({
                type: 'import.confirm',
                expectedVersion: settings.version,
                importId: id,
                expectedInboxVersion: row.version,
                decision: {
                  kind: 'create',
                  bet: assessed.bet,
                  duplicateReason: '',
                  betOrigin:
                    row.bet_origin === 'freebet' || row.bet_origin === 'hibrida'
                      ? row.bet_origin
                      : 'real',
                },
              });
              betId = (
                await executeFinancialCommand(
                  client,
                  'system:automatic-import',
                  randomUUID(),
                  command,
                  settings,
                )
              ).id;
            } catch (error) {
              if (error instanceof FinanceError) {
                const knownReason = automaticReasonSchema.safeParse(error.code);
                reason = knownReason.success ? knownReason.data : 'FINANCIAL_REVIEW_REQUIRED';
              } else throw error;
            }
          }
        }
        if (!betId)
          betId = await createIncompleteTicket(
            client,
            settings,
            result.extraction,
            bookmakerContext,
            now,
          );
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
          "update integration.inbox set state='imported',imported_bet_id=$2,extraction=$3 where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
          [id, betId, JSON.stringify({ ...result, automatic })],
        );
        await client.query(
          "insert into finance.audit(type,actor,entity_id,after) values('import.automatic','system:automatic-import',$1,$2)",
          [id, JSON.stringify({ attempt, ...automatic, betId })],
        );
        return { state: 'imported' as const, reason };
      });
    },
  };
}
