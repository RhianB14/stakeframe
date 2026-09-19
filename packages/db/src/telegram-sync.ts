import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  parseCaption,
  telegramOperationSchema,
  ticketExtractionSchema,
  type TelegramOperation,
} from '@stakeframe/shared';
import { automaticPolicyNotice } from './layout-policy.js';
import type { Database } from './index.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { FinanceError } from './finance-core.js';

// STK-G0-19-R5 — sincronização Telegram/Web.
// O banco é a fonte canônica; esta fila idempotente transporta as operações de
// espelhamento para o Telegram (envio/edição/exclusão) executadas pelo worker
// depois do commit. Chave idempotente por organização + importação + versão +
// operação; a versão veta eventos antigos que tentariam sobrescrever conteúdo
// mais novo. Nenhuma resposta bruta ou token entra no banco ou nos logs.

const normalizeAlias = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

// STK-G0-19-R10 — operação interna do rascunho sobre um cliente/transação JÁ
// existentes (sem abrir transação própria): lock da inbox (FOR UPDATE), versão
// otimista, revalidação de casa/crédito, auditoria e outbox no MESMO PoolClient.
// O chamador é dono da transação — e do recibo idempotente gravado nela.
type DraftPatch = {
  version: number;
  betOrigin?: 'real' | 'freebet' | 'hibrida' | null | undefined;
  freebetId?: string | null | undefined;
  eventAt?: string | null | undefined;
  bookmakerId?: string | null | undefined;
};

async function applyDraftUpdate(
  client: PoolClient,
  id: string,
  patch: DraftPatch,
  actor: string,
): Promise<{ version: number; freebetCleared: boolean }> {
  {
    const row = (
      await client.query<{
        version: number;
        state: string;
        bet_origin: string | null;
        freebet_id: string | null;
        event_at: string | null;
        telegram_chat_id: string | null;
        telegram_result_message_id: string | null;
        telegram_deleted_at: string | null;
        caption: string;
        extraction: unknown;
        bookmaker_override_id: string | null;
      }>(
        'select version,state,bet_origin,freebet_id,event_at,telegram_chat_id,telegram_result_message_id,telegram_deleted_at,caption,extraction,bookmaker_override_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 for update',
        [id],
      )
    ).rows[0];
    if (!row) throw new FinanceError('NOT_FOUND');
    if (row.version !== patch.version) throw new FinanceError('VERSION_CONFLICT');
    if (!['pending', 'review', 'failed'].includes(row.state))
      throw new FinanceError('STATE_CONFLICT');
    let nextOrigin: string | null = row.bet_origin;
    if (patch.betOrigin !== undefined) nextOrigin = patch.betOrigin;
    let nextFreebet: string | null = row.freebet_id;
    if (patch.freebetId !== undefined) nextFreebet = patch.freebetId;
    if (nextOrigin === 'real' || nextOrigin === null) nextFreebet = null;
    // STK-G0-19-R7 — casa declarada pelo usuário (seção "Alterar Casa"):
    // validada sob lock contra o catálogo ATIVO da organização; a casa
    // nunca vem do cliente sem revalidação.
    let nextBookmakerOverride = row.bookmaker_override_id;
    if (patch.bookmakerId !== undefined) {
      if (patch.bookmakerId === null) nextBookmakerOverride = null;
      else {
        const house = (
          await client.query<{ id: string }>(
            'select id from finance.catalog where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and active',
            [patch.bookmakerId],
          )
        ).rows[0];
        if (!house) throw new FinanceError('NOT_FOUND');
        nextBookmakerOverride = house.id;
      }
    }
    // Resolução efetiva do rascunho: escolha declarada > legenda > leitura visual.
    const labels = parseCaption(row.caption);
    const evidence =
      row.extraction && typeof row.extraction === 'object' && 'extraction' in row.extraction
        ? (row.extraction as { extraction: unknown }).extraction
        : row.extraction;
    const parsedExtraction = ticketExtractionSchema.safeParse(evidence);
    const extraction = parsedExtraction.success ? parsedExtraction.data : null;
    const aliases = (
      await client.query<{ catalog_id: string; kind: string; label: string }>(
        'select a.catalog_id,a.kind,a.label from finance.catalog_alias a join finance.catalog c on c.id=a.catalog_id and c.organization_id=a.organization_id where a.organization_id=current_setting($$app.organization_id$$, true)::uuid and c.active',
      )
    ).rows;
    const matchBookmaker = (label: string | null) =>
      label
        ? (aliases.find(
            (alias) =>
              alias.kind === 'bookmaker' && normalizeAlias(alias.label) === normalizeAlias(label),
          )?.catalog_id ?? null)
        : null;
    const effectiveBookmakerId =
      nextBookmakerOverride ??
      matchBookmaker(labels.bookmaker) ??
      matchBookmaker(extraction?.bookmaker ?? null);
    const stake = extraction?.stake ?? null;
    // R7: troca de casa NUNCA preserva crédito incompatível em silêncio —
    // casa divergente, consumido ou expirado ⇒ crédito removido e a
    // origem volta a "não informada" (nova escolha explícita obrigatória).
    let freebetCleared = false;
    if (row.freebet_id && patch.freebetId === undefined) {
      const existing = (
        await client.query<{ bookmaker_id: string; used_by: string | null; valid: boolean }>(
          "select bookmaker_id,used_by,(expires_on >= (now() at time zone 'America/Sao_Paulo')::date) as valid from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
          [row.freebet_id],
        )
      ).rows[0];
      if (
        !existing ||
        existing.used_by !== null ||
        !existing.valid ||
        existing.bookmaker_id !== effectiveBookmakerId
      ) {
        freebetCleared = true;
        nextFreebet = null;
        nextOrigin = null;
      }
    }
    if (nextOrigin === 'freebet' || nextOrigin === 'hibrida') {
      if (!nextFreebet) throw new FinanceError('FREEBET_UNRESOLVED');
      // STK-G0-19-R7: a DECLARAÇÃO valida apenas o crédito da própria
      // organização (casa efetiva, validade, disponibilidade). A política
      // automática não participa desta validação — a declaração nunca é
      // bloqueada por ausência de política; a automação é que permanece
      // fail-closed. G0-20 B2b: freebet pura exige crédito com o valor EXATO
      // da stake; híbrida exige crédito com valor DIFERENTE (a modalidade
      // deriva do par stake/crédito).
      if (!effectiveBookmakerId || !stake) throw new FinanceError('FREEBET_UNRESOLVED');
      const credit = (
        await client.query<{ id: string }>(
          `select id from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and bookmaker_id=$2 and ${nextOrigin === 'freebet' ? 'amount=$3' : 'amount<>$3'} and used_by is null and expires_on >= (now() at time zone 'America/Sao_Paulo')::date for update`,
          [nextFreebet, effectiveBookmakerId, stake],
        )
      ).rows[0];
      if (!credit) throw new FinanceError('FREEBET_UNRESOLVED');
    }
    const nextEventAt = patch.eventAt === undefined ? row.event_at : patch.eventAt;
    const updated = await client.query<{ version: number }>(
      "update integration.inbox set bet_origin=$2,freebet_id=$3,event_at=$4,event_date_status=$5,bookmaker_override_id=$6,version=version+1,updated_at=now(),telegram_sync_state=case when telegram_chat_id is null then telegram_sync_state else 'pending' end where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 returning version",
      [
        id,
        nextOrigin,
        nextFreebet,
        nextEventAt,
        nextEventAt ? 'confirmed' : 'pending',
        nextBookmakerOverride,
      ],
    );
    const version = updated.rows[0]!.version;
    await client.query(
      "insert into finance.audit(type,actor,entity_id,after) values('import.draft_update',$2,$1,$3)",
      [
        id,
        actor,
        JSON.stringify({
          betOrigin: nextOrigin,
          freebetSelected: !!nextFreebet,
          eventDateStatus: nextEventAt ? 'confirmed' : 'pending',
          bookmakerDeclared: !!nextBookmakerOverride,
          freebetCleared,
        }),
      ],
    );
    if (row.telegram_chat_id && row.telegram_result_message_id && !row.telegram_deleted_at)
      await enqueueOutbox(client, id, 'edit_result_message', version);
    return { version, freebetCleared };
  }
}

export async function enqueueOutbox(
  client: PoolClient,
  inboxId: string,
  operation: TelegramOperation,
  version: number,
) {
  telegramOperationSchema.parse(operation);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('INVALID_OUTBOX_VERSION');
  await client.query(
    'insert into integration.telegram_outbox(id,inbox_id,operation,version,idempotency_key) values($1,$2,$3,$4,$5) on conflict(organization_id,idempotency_key) do nothing',
    [randomUUID(), inboxId, operation, version, `${inboxId}:${version}:${operation}`],
  );
}

/**
 * Espelha alterações de uma aposta importada na mensagem do Telegram.
 * `cleanup` enfileira as exclusões (foto, resposta e temporária sobrevivente)
 * quando o estado deixa de ser pendente; caso contrário edita a resposta final.
 * Nunca edita mensagem já excluída; a limpeza é idempotente.
 */
export async function enqueueBetSync(
  client: PoolClient,
  betId: string,
  options: { cleanup?: boolean } = {},
) {
  const rows = (
    await client.query<{
      id: string;
      version: number;
      result_id: string | null;
      source_id: string | null;
      processing_id: string | null;
      deleted_at: Date | null;
    }>(
      'select id,version,telegram_result_message_id as result_id,telegram_source_message_id as source_id,telegram_processing_message_id as processing_id,telegram_deleted_at as deleted_at from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and imported_bet_id=$1 and telegram_chat_id is not null for update',
      [betId],
    )
  ).rows;
  for (const row of rows) {
    const updated = await client.query<{ version: number }>(
      "update integration.inbox set version=version+1,telegram_sync_state='pending',updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 returning version",
      [row.id],
    );
    const version = updated.rows[0]!.version;
    if (options.cleanup) {
      if (row.deleted_at) continue;
      if (row.source_id) await enqueueOutbox(client, row.id, 'delete_source_message', version);
      if (row.result_id) await enqueueOutbox(client, row.id, 'delete_result_message', version);
      if (row.processing_id)
        await enqueueOutbox(client, row.id, 'delete_processing_message', version);
    } else if (row.result_id && !row.deleted_at) {
      await enqueueOutbox(client, row.id, 'edit_result_message', version);
    }
  }
  return rows.length;
}

export const enqueueCleanupForBet = (client: PoolClient, betId: string) =>
  enqueueBetSync(client, betId, { cleanup: true });

/** Espelha mudanças de seleção (ex.: data do evento) na mensagem da aposta. */
export async function enqueueSyncForSelection(client: PoolClient, selectionId: string) {
  const bet = (
    await client.query<{ bet_id: string }>(
      'select bet_id from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [selectionId],
    )
  ).rows[0];
  if (bet) await enqueueBetSync(client, bet.bet_id);
}

export function createImportDraftService(database: Database) {
  const tenant = createTenantContext(database);
  const withOrg = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action);
  return {
    /**
     * Atualização canônica do rascunho: origem financeira, crédito escolhido e
     * data do evento. Versão otimista, auditoria sanitizada e outbox na mesma
     * transação; a web/Mini App refletem o mesmo registro.
     */
    /**
     * STK-G0-19-R10 — operação interna sobre um cliente/transação existentes:
     * usada pelos serviços de ação (bookmaker/origin/event) para gravar efeito,
     * auditoria, outbox e RECIBO na mesma transação (nunca aninhando transações).
     */
    async updateDraftWithin(client: PoolClient, id: string, patch: DraftPatch, actor: string) {
      return applyDraftUpdate(client, id, patch, actor);
    },
    /**
     * Atualização canônica do rascunho: origem financeira, crédito escolhido,
     * casa declarada e data do evento. Versão otimista, auditoria sanitizada e
     * outbox na mesma transação; a web/Mini App refletem o mesmo registro.
     */
    async updateDraft(context: OrganizationContext, id: string, patch: DraftPatch, actor: string) {
      const saved = await withOrg(context, async (client) =>
        applyDraftUpdate(client, id, patch, actor),
      );
      return { ...saved, automaticPolicy: automaticPolicyNotice() };
    },
    /**
     * Vínculo privado com o Telegram no recebimento da foto (idempotente) e o
     * pedido da mensagem temporária de processamento.
     */
    async attachTelegram(
      context: OrganizationContext,
      id: string,
      meta: { chatId: number; sourceMessageId: number; receivedAt: Date },
    ) {
      return withOrg(context, async (client) => {
        const updated = await client.query<{ version: number }>(
          "update integration.inbox set telegram_chat_id=$2,telegram_source_message_id=$3,telegram_received_at=$4,telegram_sync_state='pending',version=version+1,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and telegram_source_message_id is null returning version",
          [id, meta.chatId, meta.sourceMessageId, meta.receivedAt],
        );
        if (!updated.rowCount) return;
        await enqueueOutbox(client, id, 'send_processing_message', updated.rows[0]!.version);
      });
    },
    /**
     * Depois da extração concluída (estado review): enfileira a resposta final.
     * Só quando o rascunho veio do Telegram e ainda não há resposta enviada.
     */
    async queueResultMessage(context: OrganizationContext, id: string) {
      return withOrg(context, async (client) => {
        const row = (
          await client.query<{
            state: string;
            version: number;
            telegram_chat_id: string | null;
            telegram_result_message_id: string | null;
          }>(
            'select state,version,telegram_chat_id,telegram_result_message_id from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
            [id],
          )
        ).rows[0];
        if (!row || !row.telegram_chat_id || row.telegram_result_message_id) return false;
        if (row.state !== 'review' && row.state !== 'imported') return false;
        await enqueueOutbox(client, id, 'send_result_message', row.version);
        return true;
      });
    },
  };
}

/** Reivindica uma operação devida dentro da organização do contexto. */
export async function claimOutboxItem(client: PoolClient) {
  const row = (
    await client.query<{
      id: string;
      inbox_id: string;
      operation: TelegramOperation;
      version: number;
      attempts: number;
    }>(
      "select id,inbox_id,operation,version,attempts from integration.telegram_outbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and state='pending' and next_attempt_at <= now() order by created_at asc, id asc limit 1 for update skip locked",
    )
  ).rows[0];
  if (!row) return null;
  await client.query(
    "update integration.telegram_outbox set state='processing',attempts=attempts+1,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
    [row.id],
  );
  return row;
}

export async function finishOutboxItem(
  client: PoolClient,
  id: string,
  outcome:
    { type: 'done' } | { type: 'skipped' } | { type: 'failed'; code: string; retryAt: Date | null },
) {
  if (outcome.type === 'failed') {
    if (!/^[A-Z0-9_]{3,60}$/.test(outcome.code)) throw new Error('INVALID_OUTBOX_ERROR');
    if (outcome.retryAt)
      await client.query(
        "update integration.telegram_outbox set state='pending',next_attempt_at=$3,last_error=$2,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
        [id, outcome.code, outcome.retryAt],
      );
    else
      await client.query(
        "update integration.telegram_outbox set state='failed',last_error=$2,completed_at=now(),updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
        [id, outcome.code],
      );
    return;
  }
  await client.query(
    'update integration.telegram_outbox set state=$2,completed_at=now(),updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
    [id, outcome.type === 'done' ? 'done' : 'skipped'],
  );
}
