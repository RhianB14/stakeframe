import {
  claimOutboxItem,
  createTenantContext,
  enqueueOutbox,
  finishOutboxItem,
  type Database,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  TELEGRAM_RESULT_BUTTONS,
  TelegramOperationError,
  createTelegramClient,
  type TelegramConfig,
} from './telegram.js';
import { buildImportMessage, type ImportMessageRow } from './telegram-message.js';

type TelegramClient = ReturnType<typeof createTelegramClient>;

// STK-G0-19-R5 — executor da outbox Telegram.
// A outbox é idempotente: claim por linha, retry com backoff apenas em falhas
// transitórias (429 respeita retry_after), 400/403 permanentes sem loop,
// evento antigo nunca sobrescreve versão mais nova. Nenhum token, payload
// privado ou resposta bruta é registrado — somente códigos sanitizados.

const MAX_ATTEMPTS = 5;
const backoffMs = (attempts: number) =>
  Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);

type OutboxItem = {
  id: string;
  inbox_id: string;
  operation: string;
  version: number;
  attempts: number;
};

type InboxRow = ImportMessageRow & {
  telegram_chat_id: string | null;
  telegram_source_message_id: string | null;
  telegram_processing_message_id: string | null;
  telegram_result_message_id: string | null;
  telegram_synced_version: number | null;
  telegram_deleted_at: Date | null;
  version: number;
};

export function createTelegramOutboxService(
  database: Database,
  config: TelegramConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const tenant = createTenantContext(database);
  const client: TelegramClient = createTelegramClient(config, fetchImpl);

  const setSync = (
    db: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    id: string,
    sql: string,
    values: unknown[] = [],
  ) =>
    db.query(
      `update integration.inbox set ${sql},updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1`,
      [id, ...values],
    );

  async function execute(
    db: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
    item: OutboxItem,
  ) {
    const row = (
      await db.query(
        'select id,state,version,caption,extraction,bet_origin,event_at,event_date_status,telegram_received_at,telegram_chat_id,telegram_source_message_id,telegram_processing_message_id,telegram_result_message_id,telegram_synced_version,telegram_deleted_at from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [item.inbox_id],
      )
    ).rows[0] as InboxRow | undefined;
    if (!row || row.telegram_chat_id === null) return; // nada a operar (nunca recriar)
    const chatId = Number(row.telegram_chat_id);

    switch (item.operation) {
      case 'send_processing_message': {
        if (row.telegram_processing_message_id) return; // já enviada: idempotente
        const reference = row.id.slice(0, 8).toUpperCase();
        const result = await client.sendMessage(
          chatId,
          [
            'Bilhete recebido!',
            `Protocolo: ${reference}`,
            'O processamento está em andamento; você pode acompanhar pela fila no app.',
          ].join('\n'),
          {
            ...(row.telegram_source_message_id !== null
              ? { replyToMessageId: Number(row.telegram_source_message_id) }
              : {}),
          },
        );
        await setSync(db, row.id, 'telegram_processing_message_id=$2', [result.messageId]);
        return;
      }
      case 'send_result_message': {
        if (row.telegram_result_message_id) return; // já entregue: idempotente
        const result = await client.sendMessage(chatId, buildImportMessage(row), {
          ...(row.telegram_source_message_id !== null
            ? { replyToMessageId: Number(row.telegram_source_message_id) }
            : {}),
          buttons: TELEGRAM_RESULT_BUTTONS,
        });
        await setSync(
          db,
          row.id,
          "telegram_result_message_id=$2,telegram_synced_version=$3,telegram_sync_state='synced'",
          [result.messageId, item.version],
        );
        // Somente depois da entrega final confirmada a temporária é removida.
        if (row.telegram_processing_message_id)
          await enqueueOutbox(db as never, row.id, 'delete_processing_message', item.version);
        return;
      }
      case 'edit_result_message': {
        if (row.telegram_deleted_at) return; // nunca editar mensagem já excluída
        if (!row.telegram_result_message_id) return;
        // Evento antigo nunca sobrescreve versão mais nova.
        if (item.version !== row.version) return;
        if (row.telegram_synced_version === item.version) return;
        await client.editMessageText(
          chatId,
          Number(row.telegram_result_message_id),
          buildImportMessage(row),
          {
            buttons: TELEGRAM_RESULT_BUTTONS,
          },
        );
        await setSync(
          db,
          row.id,
          "telegram_edited_at=now(),telegram_synced_version=$2,telegram_sync_state=case when telegram_deleted_at is null then 'synced' else telegram_sync_state end",
          [item.version],
        );
        return;
      }
      case 'delete_processing_message': {
        if (!row.telegram_processing_message_id) return; // ausente: sucesso idempotente
        await client.deleteMessage(chatId, Number(row.telegram_processing_message_id));
        await setSync(db, row.id, 'telegram_processing_message_id=null');
        return;
      }
      case 'delete_source_message': {
        if (!row.telegram_source_message_id) return;
        await client.deleteMessage(chatId, Number(row.telegram_source_message_id));
        await setSync(
          db,
          row.id,
          "telegram_deleted_at=coalesce(telegram_deleted_at,now()),telegram_sync_state='deleted'",
        );
        return;
      }
      case 'delete_result_message': {
        if (!row.telegram_result_message_id) return;
        await client.deleteMessage(chatId, Number(row.telegram_result_message_id));
        await setSync(
          db,
          row.id,
          "telegram_deleted_at=coalesce(telegram_deleted_at,now()),telegram_sync_state='deleted'",
        );
        return;
      }
      default:
        return;
    }
  }

  async function processContext(context: OrganizationContext): Promise<boolean> {
    return tenant.withOrganizationTransaction(context, async (db) => {
      const item = (await claimOutboxItem(db)) as OutboxItem | null;
      if (!item) return false;
      try {
        await execute(db as never, item);
        await finishOutboxItem(db, item.id, { type: 'done' });
        return true;
      } catch (error) {
        const info = error instanceof TelegramOperationError ? error.info : {};
        const exhausted = !info.permanent && item.attempts >= MAX_ATTEMPTS;
        const retryAt =
          info.permanent || exhausted
            ? null
            : new Date(
                Date.now() +
                  Math.max(
                    info.retryAfterSeconds ? info.retryAfterSeconds * 1_000 : 0,
                    backoffMs(item.attempts),
                  ),
              );
        const code = error instanceof TelegramOperationError ? error.code : 'TELEGRAM_UNKNOWN';
        await finishOutboxItem(db, item.id, { type: 'failed', code, retryAt });
        if (info.permanent || exhausted) {
          // Falha permanente não desfaz nada no financeiro; marca para
          // reconciliação operacional e mantém o registro canônico intacto.
          await db.query(
            "update integration.inbox set telegram_sync_state='failed',updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
            [item.inbox_id],
          );
        }
        console.warn(`TELEGRAM_OUTBOX_FAILED ${item.operation} ${code}`);
        return true;
      }
    });
  }

  async function processOnce(): Promise<boolean> {
    for (const context of await tenant.listOrganizations()) {
      if (await processContext(context)) return true;
    }
    return false;
  }

  return { processOnce };
}

export function startTelegramOutbox(
  database: Database,
  config: TelegramConfig,
  fetchImpl: typeof fetch = fetch,
  intervalMs = 3_000,
): () => void {
  const service = createTelegramOutboxService(database, config, fetchImpl);
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      let progressed = true;
      while (progressed && !stopped) progressed = await service.processOnce();
    } catch (error) {
      console.warn(
        `TELEGRAM_OUTBOX_TICK_FAILED ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    if (!stopped) setTimeout(tick, intervalMs).unref?.();
  };
  void tick();
  return () => {
    stopped = true;
  };
}
