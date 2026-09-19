import { createHash } from 'node:crypto';
import {
  deriveBetOrigin,
  parseCaption,
  settleReturnFor,
  ticketExtractionSchema,
  automaticDecisionSchema,
  financeCommandSchema,
  type SettleAction,
  importBookmakerResultSchema,
  importOriginResultSchema,
  importEventResultSchema,
  importTipsterResultSchema,
  type BetInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { createInboxStore } from './inbox.js';
import { createAttachmentStore, type ObjectStorage } from './attachments.js';
import { FinanceError, getBetRow, type SettingsRow } from './finance-core.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { createImportDraftService } from './telegram-sync.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { automaticPolicyNotice } from './layout-policy.js';

// STK-G0-20 — a aritmética dos retornos vive no shared (fonte única entre a
// mensagem do Telegram, o Mini App, a Web e a liquidação no servidor).

// Chave de idempotência determinística (formato uuid) para repetições do mesmo
// pedido — nunca duplica efeitos financeiros.
function deterministicKey(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// STK-G0-19-R9/R10 — recibos idempotentes das ações de importação (por
// organização e chave do cliente). O hash cobre ação + alvo + corpo normalizado;
// o resultado gravado é sanitizado (nunca conteúdo de bilhete) e vive em
// `result jsonb`, validado pelo schema específico da ação no replay.
type ImportActionKind = 'bookmaker' | 'origin' | 'event' | 'tipster';
type ImportActionReceiptRow = { action: string; hash: string; result: unknown };
type BookmakerResult = {
  version: number;
  betState: string | null;
  bookmakerId: string;
  bookmakerName: string | null;
  freebetCleared: boolean;
};
type OriginResult = {
  version: number;
  betState: string | null;
  kind: 'real' | 'freebet' | 'hibrida';
  freebetCleared: boolean;
};
type EventResult = { version: number; betState: string | null };
type TipsterResult = {
  version: number;
  betState: string | null;
  tipsterId: string;
  tipsterName: string | null;
};
const actionHash = (action: ImportActionKind, id: string, body: unknown): string =>
  createHash('sha256').update(JSON.stringify({ action, id, body })).digest('hex');
const readReceiptRow = async (
  client: PoolClient,
  key: string,
): Promise<ImportActionReceiptRow | null> =>
  (
    await client.query<ImportActionReceiptRow>(
      'select action,hash,result from integration.import_action_receipt where organization_id=current_setting($$app.organization_id$$, true)::uuid and key=$1',
      [key],
    )
  ).rows[0] ?? null;
const insertReceiptRow = async (
  client: PoolClient,
  key: string,
  action: ImportActionKind,
  actor: string,
  hash: string,
  result: unknown,
): Promise<void> => {
  await client.query(
    'insert into integration.import_action_receipt(organization_id,key,action,actor,hash,result) values(current_setting($$app.organization_id$$, true)::uuid,$1,$2,$3,$4,$5)',
    [key, action, actor, hash, result],
  );
};
// R10 — replay tipado: o resultado é validado pelo schema da própria ação;
// recibo ausente/adulterado falha FECHADO e sanitizado (nunca cast cego).
const receiptReplay = <T>(
  receipt: ImportActionReceiptRow | null,
  action: ImportActionKind,
  hash: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): T | null => {
  if (!receipt) return null;
  if (receipt.action !== action || receipt.hash !== hash)
    throw new FinanceError('IDEMPOTENCY_CONFLICT');
  const parsed = schema.safeParse(receipt.result);
  if (!parsed.success) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  return parsed.data;
};

export async function findDuplicates(
  client: Pick<PoolClient, 'query'>,
  importId: string,
  bet?: Pick<BetInput, 'bookmakerId' | 'reference' | 'stake' | 'odds' | 'placedAt'>,
) {
  const rows = (
    await client.query<{
      bet_id: string;
      reference: string;
      bookmaker_id: string;
      stake: string;
      placed_at: Date;
      image: boolean;
      ref: boolean;
      similar: boolean;
    }>(
      `select b.id as bet_id,b.reference,b.bookmaker_id,b.stake,b.placed_at,
    exists(select 1 from integration.inbox other join integration.inbox current on current.id=$1 and current.organization_id=other.organization_id where other.organization_id=current_setting($$app.organization_id$$, true)::uuid and other.sha256=current.sha256 and other.imported_bet_id=b.id) as image,
    ($3::text<>'' and b.bookmaker_id=$2 and lower(trim(b.reference))=lower(trim($3))) as ref,
    (b.bookmaker_id=$2 and b.stake=$4::numeric and b.odds=$5::numeric and (b.placed_at at time zone 'America/Sao_Paulo')::date=($6::timestamptz at time zone 'America/Sao_Paulo')::date) as similar
    from finance.bet b where b.organization_id=current_setting($$app.organization_id$$, true)::uuid and (
    exists(select 1 from integration.inbox other join integration.inbox current on current.id=$1 and current.organization_id=other.organization_id where other.organization_id=current_setting($$app.organization_id$$, true)::uuid and other.sha256=current.sha256 and other.imported_bet_id=b.id)
    or ($3::text<>'' and b.bookmaker_id=$2 and lower(trim(b.reference))=lower(trim($3)))
    or (b.bookmaker_id=$2 and b.stake=$4::numeric and b.odds=$5::numeric and (b.placed_at at time zone 'America/Sao_Paulo')::date=($6::timestamptz at time zone 'America/Sao_Paulo')::date)
    )
    order by b.created_at desc limit 101`,
      [
        importId,
        bet?.bookmakerId ?? null,
        bet?.reference ?? '',
        bet?.stake ?? null,
        bet?.odds ?? null,
        bet?.placedAt ?? null,
      ],
    )
  ).rows;
  return rows.map((row) => ({
    betId: row.bet_id,
    reference: row.reference,
    bookmakerId: row.bookmaker_id,
    stake: row.stake,
    placedAt: row.placed_at.toISOString(),
    reasons: [
      ...(row.image ? ['image' as const] : []),
      ...(row.ref ? ['reference' as const] : []),
      ...(row.similar ? ['similar' as const] : []),
    ],
  }));
}
type InboxRow = {
  id: string;
  source_key: string;
  caption: string;
  state: string;
  version: number;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  error_code: string | null;
  imported_bet_id: string | null;
  attachment_id: string;
  attachment_state: string;
  extraction: unknown;
};
const columns = 'i.*,a.state as attachment_state';
function item(row: InboxRow) {
  return {
    id: row.id,
    source: row.source_key.startsWith('web:') ? ('web' as const) : ('telegram' as const),
    caption: row.caption,
    state: row.state,
    version: row.version,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    errorCode: row.error_code,
    betId: row.imported_bet_id,
    imageAvailable: !['deleting', 'deleted'].includes(row.attachment_state),
  };
}
function normalized(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');
}
export function createImportService(database: Database, storage?: ObjectStorage) {
  const tenant = createTenantContext(database);
  const inbox = createInboxStore(database, undefined, storage);
  const attachments = createAttachmentStore(database, storage);
  const draft = createImportDraftService(database);
  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });
  return {
    /** Returns the authenticated user's organization context (provisioning on first use). */
    ensureContext(userId: string) {
      return tenant.ensureOrganizationMembership(userId);
    },
    /**
     * STK-G0-19-R5 — identidade do Mini App: o initData validado no servidor é
     * vinculado ao proprietário do beta (membership owner); sem correspondência
     * exata com o Telegram ID configurado retorna null (nunca autoriza).
     */
    async telegramOwnerContext(telegramUserId: number, expectedTelegramId: string | null) {
      if (!expectedTelegramId || String(telegramUserId) !== expectedTelegramId) return null;
      const owner = await tenant.ownerUserId();
      if (!owner) return null;
      return tenant.ensureOrganizationMembership(owner);
    },
    async upload(
      context: OrganizationContext,
      key: string,
      input: { image: string; caption: string },
    ) {
      const bytes = Buffer.from(input.image, 'base64');
      if (bytes.toString('base64') !== input.image) throw new Error('INVALID_INBOX_IMAGE');
      const requestHash = createHash('sha256')
        .update(bytes)
        .update('\0')
        .update(input.caption)
        .digest('hex');
      const id = await inbox.accept(
        context,
        {
          sourceKey: `web:${context.userId}:${key}`,
          caption: input.caption,
          requestHash,
          metadata: { source: 'web' },
        },
        async () => bytes,
      );
      return { id };
    },
    async list(
      context: OrganizationContext,
      query: {
        page: number;
        pageSize: number;
        state?: string | undefined;
        betId?: string | undefined;
      },
    ) {
      return read(context, async (client) => {
        const rows = await client.query<InboxRow & { total: string }>(
          `select ${columns},count(*) over() as total from integration.inbox i join integration.attachment a on a.id=i.attachment_id and a.organization_id=i.organization_id where i.organization_id=current_setting($$app.organization_id$$, true)::uuid and ($1::text is null or i.state=$1) and ($4::uuid is null or i.imported_bet_id=$4) order by i.created_at desc,i.id desc limit $2 offset $3`,
          [
            query.state ?? null,
            query.pageSize,
            (query.page - 1) * query.pageSize,
            query.betId ?? null,
          ],
        );
        const total =
          rows.rows[0]?.total ??
          (
            await client.query<{ total: string }>(
              'select count(*) as total from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and ($1::text is null or state=$1) and ($2::uuid is null or imported_bet_id=$2)',
              [query.state ?? null, query.betId ?? null],
            )
          ).rows[0]!.total;
        return {
          items: rows.rows.map(item),
          total: Number(total),
          page: query.page,
          pageSize: query.pageSize,
        };
      });
    },
    /** Atualização canônica do rascunho (origem/crédito/data do evento). */
    updateDraft(
      context: OrganizationContext,
      id: string,
      patch: {
        version: number;
        betOrigin?: 'real' | 'freebet' | 'hibrida' | null | undefined;
        freebetId?: string | null | undefined;
        eventAt?: string | null | undefined;
      },
      actor: string,
    ) {
      return draft.updateDraft(context, id, patch, actor);
    },
    attachTelegram(
      context: OrganizationContext,
      id: string,
      meta: { chatId: number; sourceMessageId: number; receivedAt: Date },
    ) {
      return draft.attachTelegram(context, id, meta);
    },
    queueResultMessage(context: OrganizationContext, id: string) {
      return draft.queueResultMessage(context, id);
    },
    async detail(context: OrganizationContext, id: string) {
      return read(context, async (client) => {
        const row = (
          await client.query<InboxRow>(
            `select ${columns} from integration.inbox i join integration.attachment a on a.id=i.attachment_id and a.organization_id=i.organization_id where i.organization_id=current_setting($$app.organization_id$$, true)::uuid and i.id=$1`,
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        const labels = parseCaption(row.caption);
        const evidence =
          row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
            ? row.extraction.extraction
            : row.extraction;
        const parsed = ticketExtractionSchema.safeParse(evidence);
        const extraction = parsed.success ? parsed.data : null;
        const decision = automaticDecisionSchema.safeParse(
          row.extraction && typeof row.extraction === 'object' && 'automatic' in row.extraction
            ? row.extraction.automatic
            : null,
        );
        const aliases = (
          await client.query<{ catalog_id: string; kind: string; label: string }>(
            'select a.catalog_id,a.kind,a.label from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id and c.organization_id=a.organization_id where a.organization_id=current_setting($$app.organization_id$$, true)::uuid and c.active',
          )
        ).rows;
        const match = (kind: string, label: string | null) =>
          label
            ? (aliases.find((a) => a.kind === kind && normalized(a.label) === normalized(label))
                ?.catalog_id ?? null)
            : null;
        const draftRow = (
          await client.query<{
            bet_origin: string | null;
            freebet_id: string | null;
            event_at: Date | null;
            event_date_status: string;
            telegram_received_at: Date | null;
            bookmaker_override_id: string | null;
          }>(
            'select bet_origin,freebet_id,event_at,event_date_status,telegram_received_at,bookmaker_override_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const captionBookmakerId = match('bookmaker', labels.bookmaker);
        const extractedBookmakerId = match('bookmaker', extraction?.bookmaker ?? null);
        // STK-G0-19-R7: a casa declarada pelo usuário tem precedência; a
        // declaração nunca é filtrada pela política automática (que só governa
        // a automação). Somente créditos compatíveis com o rascunho (casa,
        // valor da stake, validade, disponibilidade) são listados — e o PATCH
        // repete a validação completa sob lock antes de gravar.
        const draftBookmakerId =
          draftRow.bookmaker_override_id ?? captionBookmakerId ?? extractedBookmakerId;
        const draftStake = extraction?.stake ?? null;
        const credits =
          draftBookmakerId && draftStake
            ? (
                await client.query<{
                  id: string;
                  bookmaker_id: string;
                  amount: string;
                  expires_text: string;
                  stake_returned: boolean;
                }>(
                  "select id,bookmaker_id,amount,to_char(expires_on,'YYYY-MM-DD') as expires_text,stake_returned from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and used_by is null and expires_on >= (now() at time zone 'America/Sao_Paulo')::date and bookmaker_id=$1 and amount=$2 order by expires_on asc,id asc limit 50",
                  [draftBookmakerId, draftStake],
                )
              ).rows
            : [];
        const bookmakers = (
          await client.query<{ id: string; name: string }>(
            'select id,name from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and active order by name asc,id asc limit 200',
          )
        ).rows;
        const bet = row.imported_bet_id
          ? ((
              await client.query<{
                id: string;
                state: string;
                stake: string;
                odds: string;
                remaining: string;
                bookmaker_id: string;
                bookmaker_name: string;
                freebet_id: string | null;
              }>(
                'select b.id,b.state,b.stake,b.odds,b.remaining,b.bookmaker_id,b.freebet_id,c.name as bookmaker_name from finance.bet b join finance.catalog c on c.id=b.bookmaker_id and c.organization_id=b.organization_id where b.organization_id=current_setting($$app.organization_id$$, true)::uuid and b.id=$1',
                [row.imported_bet_id],
              )
            ).rows[0] ?? null)
          : null;
        const betSelections = bet
          ? (
              await client.query<{
                id: string;
                event: string;
                market: string;
                selection: string;
                event_at: Date | null;
                date_status: string;
              }>(
                'select id,event,market,selection,event_at,date_status from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by position',
                [bet.id],
              )
            ).rows
          : [];
        const duplicates = await findDuplicates(client, id, {
          bookmakerId: draftBookmakerId ?? '00000000-0000-0000-0000-000000000000',
          reference: extraction?.reference ?? '',
          stake: '0',
          odds: '1',
          placedAt: new Date(0).toISOString(),
        });
        return {
          item: item(row),
          extraction,
          labels,
          betOrigin:
            draftRow.bet_origin === 'real' || draftRow.bet_origin === 'freebet'
              ? draftRow.bet_origin
              : null,
          freebetId: draftRow.freebet_id,
          eventAt: draftRow.event_at ? draftRow.event_at.toISOString() : null,
          eventDateStatus: draftRow.event_date_status === 'confirmed' ? 'confirmed' : 'pending',
          telegramReceivedAt: draftRow.telegram_received_at
            ? draftRow.telegram_received_at.toISOString()
            : null,
          credits: credits.map((credit) => ({
            id: credit.id,
            bookmakerId: credit.bookmaker_id,
            amount: credit.amount,
            expiresOn: credit.expires_text,
            stakeReturned: credit.stake_returned,
          })),
          bookmakerOverrideId: draftRow.bookmaker_override_id,
          bookmakers,
          bet: bet
            ? {
                id: bet.id,
                state:
                  bet.state === 'open' || bet.state === 'settled'
                    ? bet.state
                    : ('cancelled' as const),
                stake: bet.stake,
                odds: bet.odds,
                remaining: bet.remaining,
                bookmakerId: bet.bookmaker_id,
                bookmakerName: bet.bookmaker_name,
                freebetId: bet.freebet_id,
                selections: betSelections.map((item) => ({
                  id: item.id,
                  event: item.event,
                  market: item.market,
                  selection: item.selection,
                  eventAt: item.event_at ? item.event_at.toISOString() : null,
                  dateStatus:
                    item.date_status === 'confirmed' || item.date_status === 'estimated'
                      ? item.date_status
                      : ('pending' as const),
                })),
              }
            : null,
          automaticPolicy: automaticPolicyNotice(),
          matches: {
            tipsterId: match('tipster', labels.tipster),
            captionBookmakerId,
            extractedBookmakerId,
            conflict:
              !!labels.bookmaker &&
              !!extraction?.bookmaker &&
              (captionBookmakerId && extractedBookmakerId
                ? captionBookmakerId !== extractedBookmakerId
                : normalized(labels.bookmaker) !== normalized(extraction.bookmaker)),
          },
          duplicates: duplicates.slice(0, 100),
          duplicateCount: duplicates.length,
          automatic: decision.success && decision.data.reason === 'IMPORTED',
          automaticReason: decision.success
            ? decision.data.reason
            : ('LAYOUT_NOT_VALIDATED' as const),
        };
      });
    },
    /**
     * STK-G0-19-R7 — transição REAL de status pelo Mini App (seção "Alterar
     * Status"): liquidação de aposta pendente (vitória/derrota) pelo comando
     * financeiro canônico, com autorização da organização, versão otimista,
     * idempotência determinística e a limpeza do Telegram enfileirada na
     * mesma transação (regra de saída de pendente da mensagem).
     */
    async setStatus(
      context: OrganizationContext,
      id: string,
      input: { version: number; action: SettleAction | 'pending' },
      actor: string,
    ) {
      return tenant.withOrganizationTransaction(context, async (client) => {
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0];
        if (!settings) throw new FinanceError('NOT_FOUND');
        if (!settings.initialized) throw new FinanceError('NOT_INITIALIZED');
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        if (!row.imported_bet_id) throw new FinanceError('STATE_CONFLICT');
        const bet = (
          await client.query<{
            id: string;
            state: string;
            remaining: string;
            odds: string;
            stake: string;
            freebet_amount: string | null;
          }>(
            'select b.id,b.state,b.remaining,b.odds,b.stake,f.amount as freebet_amount from finance.bet b left join finance.freebet f on f.organization_id=b.organization_id and f.id=b.freebet_id where b.organization_id=current_setting($$app.organization_id$$, true)::uuid and b.id=$1 for update of b',
            [row.imported_bet_id],
          )
        ).rows[0];
        if (!bet) throw new FinanceError('NOT_FOUND');
        if (bet.state !== 'open') {
          // Repetição idempotente: a MESMA liquidação já registrada é sucesso —
          // nunca um segundo efeito financeiro.
          const last = (
            await client.query<{ outcome: string }>(
              'select outcome from finance.settlement where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by settled_at desc, id desc limit 1',
              [bet.id],
            )
          ).rows[0];
          if (last?.outcome === input.action) return { version: row.version, betState: bet.state };
          throw new FinanceError('STATE_CONFLICT');
        }
        if (row.version !== input.version) throw new FinanceError('VERSION_CONFLICT');
        // G0-20: "Pendente" é um no-op informativo (a aposta permanece aberta).
        if (input.action === 'pending') return { version: row.version, betState: bet.state };
        // STK-G0-20 — valor derivado calculado NO SERVIDOR conforme a
        // modalidade financeira (real, freebet ou híbrida derivada do crédito)
        // e a transição escolhida no teclado de status / Mini App.
        const origin = deriveBetOrigin(bet.stake, bet.freebet_amount);
        const returnAmount = settleReturnFor(
          input.action,
          origin,
          bet.remaining,
          bet.odds,
          bet.freebet_amount,
        );
        if (returnAmount === null) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
        const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
        const command = financeCommandSchema.parse({
          type: 'bet.settle',
          id: bet.id,
          outcome: input.action,
          closedPrincipal: bet.remaining,
          returnAmount,
          settledAt: now.toISOString(),
          reason: 'Liquidação pelo Mini App',
          expectedVersion: settings.version,
        });
        const key = deterministicKey(`import-status:${id}:${input.action}`);
        await executeFinancialCommand(client, actor, key, command, settings);
        const updated = (
          await client.query<{ version: number }>(
            'select version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const settledBet = (
          await client.query<{ state: string }>(
            'select state from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [bet.id],
          )
        ).rows[0]!;
        return { version: updated.version, betState: settledBet.state };
      });
    },
    /**
     * STK-G0-19-R8 — troca de casa canônica. Pré-importação: rascunho (inbox)
     * segue como fonte (mesmo updateDraft do PATCH). Pós-importação: comando
     * financeiro `bet.bookmaker` na MESMA transação da leitura, com versão
     * otimista da inbox, crédito compatível exigido para freebet e sync do
     * Telegram por outbox — a inbox nunca diverge da aposta.
     */
    async applyBookmaker(
      context: OrganizationContext,
      id: string,
      input: { version: number; bookmakerId: string; freebetId?: string | null | undefined },
      actor: string,
      idempotencyKey: string,
    ) {
      const route = await read(context, async (client) => {
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        return row;
      });
      const requestHash = actionHash('bookmaker', id, {
        version: input.version,
        bookmakerId: input.bookmakerId,
        freebetId: input.freebetId ?? null,
      });
      if (!route.imported_bet_id) {
        // R10 — rascunho ATÔMICO: advisory lock por organização+chave, replay do
        // recibo sob o mesmo lock, efeito + auditoria + outbox + RECIBO na MESMA
        // transação/cliente — queda entre efeito e recibo é impossível.
        return tenant.withOrganizationTransaction(context, async (client) => {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
            [idempotencyKey],
          );
          const lockedReplay = receiptReplay<BookmakerResult>(
            await readReceiptRow(client, idempotencyKey),
            'bookmaker',
            requestHash,
            importBookmakerResultSchema,
          );
          if (lockedReplay) return lockedReplay;
          const saved = await draft.updateDraftWithin(
            client,
            id,
            {
              version: input.version,
              bookmakerId: input.bookmakerId,
              ...(input.freebetId !== undefined ? { freebetId: input.freebetId } : {}),
            },
            actor,
          );
          const name = (
            await client.query<{ name: string }>(
              'select name from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
              [input.bookmakerId],
            )
          ).rows[0];
          const result: BookmakerResult = {
            version: saved.version,
            betState: null,
            bookmakerId: input.bookmakerId,
            bookmakerName: name?.name ?? null,
            freebetCleared: saved.freebetCleared,
          };
          await insertReceiptRow(client, idempotencyKey, 'bookmaker', actor, requestHash, result);
          return result;
        });
      }
      return tenant.withOrganizationTransaction(context, async (client) => {
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0];
        if (!settings) throw new FinanceError('NOT_FOUND');
        // R9 — serializa por chave do cliente e reconfere o recibo sob o lock
        // (corridas concorrentes da MESMA confirmação convergem no replay).
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
          [idempotencyKey],
        );
        const lockedReplay = receiptReplay<BookmakerResult>(
          await readReceiptRow(client, idempotencyKey),
          'bookmaker',
          requestHash,
          importBookmakerResultSchema,
        );
        if (lockedReplay) return lockedReplay;
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        if (!row.imported_bet_id) throw new FinanceError('STATE_CONFLICT');
        if (row.version !== input.version) throw new FinanceError('VERSION_CONFLICT');
        const bet = await getBetRow(client, row.imported_bet_id);
        const command = financeCommandSchema.parse({
          type: 'bet.bookmaker',
          id: bet.id,
          bookmakerId: input.bookmakerId,
          freebetId: input.freebetId ?? null,
          reason: 'Troca de casa pelo Mini App',
          expectedVersion: settings.version,
        });
        // R9 — a chave do comando deriva da OPERAÇÃO do cliente (nunca do
        // alvo): repetir um valor antigo com chave nova aplica de verdade.
        const key = deterministicKey(`import-action:${idempotencyKey}`);
        await executeFinancialCommand(client, actor, key, command, settings);
        const updated = (
          await client.query<{ state: string; bookmaker_id: string }>(
            'select state,bookmaker_id from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [bet.id],
          )
        ).rows[0]!;
        const name = (
          await client.query<{ name: string }>(
            'select name from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [updated.bookmaker_id],
          )
        ).rows[0];
        const fresh = (
          await client.query<{ version: number }>(
            'select version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const result: BookmakerResult = {
          version: fresh.version,
          betState: updated.state,
          bookmakerId: updated.bookmaker_id,
          bookmakerName: name?.name ?? null,
          freebetCleared: false,
        };
        await insertReceiptRow(client, idempotencyKey, 'bookmaker', actor, requestHash, result);
        return result;
      });
    },
    /**
     * STK-G0-19-R8 — troca de origem canônica (real ↔ freebet) com journals
     * compensatórios pós-importação; pré-importação continua no rascunho.
     */
    async applyOrigin(
      context: OrganizationContext,
      id: string,
      input: {
        version: number;
        kind: 'real' | 'freebet' | 'hibrida';
        freebetId?: string | null | undefined;
      },
      actor: string,
      idempotencyKey: string,
    ) {
      const route = await read(context, async (client) => {
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        return row;
      });
      const credit =
        input.kind === 'freebet' || input.kind === 'hibrida' ? (input.freebetId ?? null) : null;
      const requestHash = actionHash('origin', id, {
        version: input.version,
        kind: input.kind,
        freebetId: credit,
      });
      if (!route.imported_bet_id) {
        // R10 — rascunho ATÔMICO (mesmo desenho do bookmaker).
        return tenant.withOrganizationTransaction(context, async (client) => {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
            [idempotencyKey],
          );
          const lockedReplay = receiptReplay<OriginResult>(
            await readReceiptRow(client, idempotencyKey),
            'origin',
            requestHash,
            importOriginResultSchema,
          );
          if (lockedReplay) return lockedReplay;
          const saved = await draft.updateDraftWithin(
            client,
            id,
            { version: input.version, betOrigin: input.kind, freebetId: credit },
            actor,
          );
          const result: OriginResult = {
            version: saved.version,
            betState: null,
            kind: input.kind,
            freebetCleared: saved.freebetCleared,
          };
          await insertReceiptRow(client, idempotencyKey, 'origin', actor, requestHash, result);
          return result;
        });
      }
      return tenant.withOrganizationTransaction(context, async (client) => {
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0];
        if (!settings) throw new FinanceError('NOT_FOUND');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
          [idempotencyKey],
        );
        const lockedReplay = receiptReplay<OriginResult>(
          await readReceiptRow(client, idempotencyKey),
          'origin',
          requestHash,
          importOriginResultSchema,
        );
        if (lockedReplay) return lockedReplay;
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        if (!row.imported_bet_id) throw new FinanceError('STATE_CONFLICT');
        if (row.version !== input.version) throw new FinanceError('VERSION_CONFLICT');
        const bet = await getBetRow(client, row.imported_bet_id);
        const command = financeCommandSchema.parse({
          type: 'bet.origin',
          id: bet.id,
          kind: input.kind,
          freebetId: credit,
          reason: 'Troca de origem pelo Mini App',
          expectedVersion: settings.version,
        });
        const key = deterministicKey(`import-action:${idempotencyKey}`);
        await executeFinancialCommand(client, actor, key, command, settings);
        const updated = (
          await client.query<{ state: string }>(
            'select state from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [bet.id],
          )
        ).rows[0]!;
        const fresh = (
          await client.query<{ version: number }>(
            'select version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const result: OriginResult = {
          version: fresh.version,
          betState: updated.state,
          kind: input.kind,
          freebetCleared: false,
        };
        await insertReceiptRow(client, idempotencyKey, 'origin', actor, requestHash, result);
        return result;
      });
    },
    /**
     * STK-G0-20 B3 — troca de tipster canônica da aposta importada (seleção do
     * Telegram/Mini App/Web). O rascunho sem aposta não possui campo de
     * tipster: a operação exige a aposta registrada (STATE_CONFLICT), com
     * versão otimista da inbox e recibo idempotente na mesma transação — a
     * inbox nunca diverge da aposta e o Telegram é espelhado pela outbox.
     */
    async applyTipster(
      context: OrganizationContext,
      id: string,
      input: { version: number; tipsterId: string },
      actor: string,
      idempotencyKey: string,
    ) {
      const requestHash = actionHash('tipster', id, {
        version: input.version,
        tipsterId: input.tipsterId,
      });
      return tenant.withOrganizationTransaction(context, async (client) => {
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0];
        if (!settings) throw new FinanceError('NOT_FOUND');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
          [idempotencyKey],
        );
        const lockedReplay = receiptReplay<TipsterResult>(
          await readReceiptRow(client, idempotencyKey),
          'tipster',
          requestHash,
          importTipsterResultSchema,
        );
        if (lockedReplay) return lockedReplay;
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        if (!row.imported_bet_id) throw new FinanceError('STATE_CONFLICT');
        if (row.version !== input.version) throw new FinanceError('VERSION_CONFLICT');
        const bet = await getBetRow(client, row.imported_bet_id);
        if (bet.state !== 'open') throw new FinanceError('STATE_CONFLICT');
        const selections = (
          await client.query<{
            id: string;
            event: string;
            sport: string | null;
            market: string;
            selection: string;
            odds: string | null;
            event_date: string | null;
            event_at: Date | null;
            date_status: string;
          }>(
            'select id,event,sport,market,selection,odds::text as odds,event_date::text as event_date,event_at,date_status from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by position',
            [bet.id],
          )
        ).rows;
        const rebuilt = selections.map((item) => ({
          id: item.id,
          event: item.event,
          sport: item.sport,
          market: item.market,
          selection: item.selection,
          odds: item.odds,
          eventDate: item.event_date,
          eventAt: item.event_at ? item.event_at.toISOString() : null,
          dateStatus: item.date_status as 'confirmed' | 'estimated' | 'pending',
        }));
        const command = financeCommandSchema.parse({
          type: 'bet.update',
          id: bet.id,
          tipsterId: input.tipsterId,
          reference: bet.reference,
          selections: rebuilt,
          reason: 'Troca de tipster pelo Telegram',
          expectedVersion: settings.version,
        });
        const key = deterministicKey(`import-action:${idempotencyKey}`);
        await executeFinancialCommand(client, actor, key, command, settings);
        const updated = (
          await client.query<{ state: string; tipster_id: string | null }>(
            'select state,tipster_id from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [bet.id],
          )
        ).rows[0]!;
        const name = (
          await client.query<{ name: string }>(
            'select name from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [input.tipsterId],
          )
        ).rows[0];
        const fresh = (
          await client.query<{ version: number }>(
            'select version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const result: TipsterResult = {
          version: fresh.version,
          betState: updated.state,
          tipsterId: updated.tipster_id ?? input.tipsterId,
          tipsterName: name?.name ?? null,
        };
        await insertReceiptRow(client, idempotencyKey, 'tipster', actor, requestHash, result);
        return result;
      });
    },
    /**
     * STK-G0-19-R8 — data do evento canônica. Pré-importação: rascunho (data
     * global). Pós-importação: comando canônico de evento por SELEÇÃO (nunca
     * uma data global silenciosa em múltipla) via `bet.update` montado aqui.
     */
    async applyEvent(
      context: OrganizationContext,
      id: string,
      input: { version: number; selectionId: string; eventAt: string | null },
      actor: string,
      idempotencyKey: string,
    ) {
      const route = await read(context, async (client) => {
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        return row;
      });
      const requestHash = actionHash('event', id, {
        version: input.version,
        selectionId: input.selectionId,
        eventAt: input.eventAt,
      });
      if (!route.imported_bet_id) {
        // R10 — rascunho ATÔMICO (mesmo desenho do bookmaker).
        return tenant.withOrganizationTransaction(context, async (client) => {
          await client.query(
            'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
            [idempotencyKey],
          );
          const lockedReplay = receiptReplay<EventResult>(
            await readReceiptRow(client, idempotencyKey),
            'event',
            requestHash,
            importEventResultSchema,
          );
          if (lockedReplay) return lockedReplay;
          const saved = await draft.updateDraftWithin(
            client,
            id,
            { version: input.version, eventAt: input.eventAt },
            actor,
          );
          const result: EventResult = { version: saved.version, betState: null };
          await insertReceiptRow(client, idempotencyKey, 'event', actor, requestHash, result);
          return result;
        });
      }
      return tenant.withOrganizationTransaction(context, async (client) => {
        const settings = (
          await client.query<SettingsRow>(
            'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
          )
        ).rows[0];
        if (!settings) throw new FinanceError('NOT_FOUND');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended(current_setting($$app.organization_id$$, true) || $1, 0))',
          [idempotencyKey],
        );
        const lockedReplay = receiptReplay<EventResult>(
          await readReceiptRow(client, idempotencyKey),
          'event',
          requestHash,
          importEventResultSchema,
        );
        if (lockedReplay) return lockedReplay;
        const row = (
          await client.query<{ version: number; imported_bet_id: string | null }>(
            'select version,imported_bet_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        if (!row.imported_bet_id) throw new FinanceError('STATE_CONFLICT');
        if (row.version !== input.version) throw new FinanceError('VERSION_CONFLICT');
        const bet = await getBetRow(client, row.imported_bet_id);
        if (bet.state !== 'open') throw new FinanceError('STATE_CONFLICT');
        const selections = (
          await client.query<{
            id: string;
            position: number;
            event: string;
            sport: string | null;
            market: string;
            selection: string;
            odds: string | null;
            event_date: string | null;
            event_at: Date | null;
            date_status: string;
          }>(
            'select id,position,event,sport,market,selection,odds::text as odds,event_date::text as event_date,event_at,date_status from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by position',
            [bet.id],
          )
        ).rows;
        const target = selections.find((item) => item.id === input.selectionId);
        if (!target) throw new FinanceError('NOT_FOUND');
        const rebuilt = selections.map((item) => ({
          id: item.id,
          event: item.event,
          sport: item.sport,
          market: item.market,
          selection: item.selection,
          odds: item.odds,
          eventDate:
            item.id === input.selectionId
              ? input.eventAt
                ? input.eventAt.slice(0, 10)
                : null
              : item.event_date,
          eventAt:
            item.id === input.selectionId
              ? input.eventAt
              : item.event_at
                ? item.event_at.toISOString()
                : null,
          dateStatus:
            item.id === input.selectionId
              ? input.eventAt
                ? ('confirmed' as const)
                : ('pending' as const)
              : (item.date_status as 'confirmed' | 'estimated' | 'pending'),
        }));
        const command = financeCommandSchema.parse({
          type: 'bet.update',
          id: bet.id,
          tipsterId: bet.tipster_id,
          reference: bet.reference,
          selections: rebuilt,
          reason: 'Correção de data pelo Mini App',
          expectedVersion: settings.version,
        });
        const key = deterministicKey(`import-action:${idempotencyKey}`);
        await executeFinancialCommand(client, actor, key, command, settings);
        const updated = (
          await client.query<{ state: string }>(
            'select state from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [bet.id],
          )
        ).rows[0]!;
        const fresh = (
          await client.query<{ version: number }>(
            'select version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0]!;
        const result: EventResult = { version: fresh.version, betState: updated.state };
        await insertReceiptRow(client, idempotencyKey, 'event', actor, requestHash, result);
        return result;
      });
    },
    /**
     * STK-G0-19-R9 — créditos freebet válidos PARA A CASA DE DESTINO (a lista
     * do rascunho é da casa antiga e impedia trocar a casa de uma aposta
     * freebet pela interface). Filtro integral no servidor: organização, casa
     * solicitada, valor exato da stake, disponibilidade e validade em São
     * Paulo; o crédito já consumido nunca aparece; quantidade limitada.
     */
    async credits(context: OrganizationContext, id: string, bookmakerId: string) {
      return read(context, async (client) => {
        const row = (
          await client.query<{ imported_bet_id: string | null; extraction: unknown }>(
            'select imported_bet_id,extraction from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        const house = (
          await client.query<{ id: string }>(
            'select id from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and kind=$2 and active',
            [bookmakerId, 'bookmaker'],
          )
        ).rows[0];
        if (!house) return { credits: [] };
        let stake: string | null;
        if (row.imported_bet_id) {
          stake =
            (
              await client.query<{ stake: string }>(
                'select stake from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
                [row.imported_bet_id],
              )
            ).rows[0]?.stake ?? null;
        } else {
          const payload =
            row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
              ? (row.extraction as { extraction: unknown }).extraction
              : row.extraction;
          const parsed = ticketExtractionSchema.safeParse(payload);
          stake = parsed.success ? parsed.data.stake : null;
        }
        if (!stake) return { credits: [] };
        const credits = (
          await client.query<{
            id: string;
            bookmaker_id: string;
            amount: string;
            expires_on: string;
            stake_returned: boolean;
          }>(
            "select id,bookmaker_id,amount::text as amount,expires_on::text as expires_on,stake_returned from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and bookmaker_id=$1 and amount=$2 and used_by is null and expires_on >= (now() at time zone 'America/Sao_Paulo')::date order by expires_on, id limit 20",
            [bookmakerId, stake],
          )
        ).rows;
        return {
          credits: credits.map((credit) => ({
            id: credit.id,
            bookmakerId: credit.bookmaker_id,
            amount: credit.amount,
            expiresOn: credit.expires_on,
            stakeReturned: credit.stake_returned,
          })),
        };
      });
    },
    async image(context: OrganizationContext, id: string) {
      return read(context, async (client) => {
        const row = (
          await client.query<{ attachment_id: string }>(
            'select attachment_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row) throw new FinanceError('NOT_FOUND');
        return attachments.read(client, row.attachment_id);
      });
    },
  };
}
export type ImportService = ReturnType<typeof createImportService>;
