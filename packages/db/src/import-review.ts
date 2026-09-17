import { createHash } from 'node:crypto';
import {
  parseCaption,
  ticketExtractionSchema,
  automaticDecisionSchema,
  financeCommandSchema,
  type BetInput,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { createInboxStore } from './inbox.js';
import { createAttachmentStore, type ObjectStorage } from './attachments.js';
import { FinanceError, type SettingsRow } from './finance-core.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { createImportDraftService } from './telegram-sync.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { automaticPolicyNotice } from './layout-policy.js';

// stake (até 2 casas) × odds (até 4 casas), arredondamento half-up em centavos.
// Espelha o mesmo cálculo exibido na mensagem do Telegram (fonte única da
// semântica `potentialReturn = stake × odd`).
function grossReturn(stake: string, odds: string): string | null {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(stake) || !/^\d{1,12}(\.\d{1,4})?$/.test(odds)) return null;
  const scale = (value: string, decimals: number) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(`${fraction}0000`.slice(0, decimals));
  };
  const centsValue = scale(stake, 2);
  const scaledOdds = scale(odds, 4);
  const total = (centsValue * scaledOdds + 5000n) / 10000n;
  const whole = total / 100n;
  const fraction = (total % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

// Chave de idempotência determinística (formato uuid) para repetições do mesmo
// pedido — nunca duplica efeitos financeiros.
function deterministicKey(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

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
        betOrigin?: 'real' | 'freebet' | null | undefined;
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
              }>(
                'select id,state,stake,odds,remaining from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
                [row.imported_bet_id],
              )
            ).rows[0] ?? null)
          : null;
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
      input: { version: number; action: 'win' | 'loss' },
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
          await client.query<{ id: string; state: string; remaining: string; odds: string }>(
            'select id,state,remaining,odds from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
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
        // Valor derivado calculado no servidor (stake/odd canônicas): a vitória
        // devolve o bruto `remaining × odds`; a derrota devolve zero.
        const returnAmount =
          input.action === 'win' ? (grossReturn(bet.remaining, bet.odds) ?? '0.00') : '0.00';
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
