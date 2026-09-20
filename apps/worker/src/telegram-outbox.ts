import {
  claimOutboxItem,
  createTenantContext,
  enqueueOutbox,
  finishOutboxItem,
  type Database,
  type OrganizationContext,
} from '@stakeframe/db';
import { deriveBetOrigin } from '@stakeframe/shared';
import {
  TelegramOperationError,
  createTelegramClient,
  telegramResultButtons,
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
  // R8 — colunas canônicas do LEFT JOIN (finance.bet/catalog), presentes
  // quando a importação já tem aposta registrada.
  override_bookmaker: string | null;
  override_tipster: string | null;
  override_sport: string | null;
  override_tournament: string | null;
  override_country: string | null;
  bet_id: string | null;
  bet_state: string | null;
  bet_stake: string | null;
  bet_odds: string | null;
  bet_placed_at: Date | null;
  bet_freebet_id: string | null;
  bet_freebet_amount: string | null;
  bet_bookmaker: string | null;
  bet_tipster: string | null;
  draft_freebet_amount: string | null;
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
        `select i.id,i.state,i.version,i.caption,i.extraction,i.bet_origin,i.event_at,i.event_date_status,i.telegram_received_at,i.telegram_chat_id,i.telegram_source_message_id,i.telegram_processing_message_id,i.telegram_result_message_id,i.telegram_synced_version,i.telegram_deleted_at,
                c.name as override_bookmaker,ot.name as override_tipster,
                i.metadata->'userOverrides'->>'sport' as override_sport,
                i.metadata->'userOverrides'->>'tournament' as override_tournament,
                i.metadata->'userOverrides'->>'country' as override_country,
                i.metadata->'userOverrides'->>'ticketKind' as override_kind,
                i.metadata->'userOverrides'->>'stake' as override_stake,
                i.metadata->'userOverrides'->>'odds' as override_odds,
                i.metadata->'userOverrides'->'selections' as override_selections,
                draftf.amount as draft_freebet_amount,
                b.id as bet_id,b.state as bet_state,b.stake as bet_stake,b.odds as bet_odds,b.placed_at as bet_placed_at,b.freebet_id as bet_freebet_id,f.amount as bet_freebet_amount,
                bc.name as bet_bookmaker,t.name as bet_tipster
         from integration.inbox i
          left join finance.catalog c on c.id=i.bookmaker_override_id and c.organization_id=i.organization_id
          left join finance.catalog ot on ot.organization_id=i.organization_id and ot.kind='tipster' and ot.active and ot.id::text=(i.metadata->'userOverrides'->>'tipsterId')
          left join finance.freebet draftf on draftf.id=i.freebet_id and draftf.organization_id=i.organization_id
         left join finance.bet b on b.id=i.imported_bet_id and b.organization_id=i.organization_id
         left join finance.freebet f on f.id=b.freebet_id and f.organization_id=b.organization_id
         left join finance.catalog bc on bc.id=b.bookmaker_id and bc.organization_id=b.organization_id
         left join finance.catalog t on t.id=b.tipster_id and t.organization_id=b.organization_id
         where i.organization_id=current_setting($$app.organization_id$$, true)::uuid and i.id=$1`,
        [item.inbox_id],
      )
    ).rows[0] as InboxRow | undefined;
    if (!row || row.telegram_chat_id === null) return; // nada a operar (nunca recriar)
    const chatId = Number(row.telegram_chat_id);
    // R8 — fonte canônica pós-importação: aposta, casa, tipster, origem e as
    // seleções/datas saem das tabelas financeiras (nunca de dados antigos).
    if (row.bet_id) {
      const selections = (
        await db.query(
          'select event,sport,market,selection,event_at,date_status from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=$1 order by position',
          [row.bet_id],
        )
      ).rows as {
        event: string;
        sport: string | null;
        market: string;
        selection: string;
        event_at: Date | null;
        date_status: string;
      }[];
      row.canonical = {
        state: row.bet_state ?? 'open',
        bookmaker: row.bet_bookmaker,
        tipster: row.bet_tipster,
        // G0-20 B2b — a modalidade deriva do par (stake real, crédito): sem
        // crédito = real; crédito igual à stake = freebet; crédito distinto =
        // híbrida. O valor do crédito alimenta o retorno potencial exibido.
        origin: deriveBetOrigin(row.bet_stake ?? '0.00', row.bet_freebet_amount),
        stake: row.bet_stake ?? '0.00',
        odds: row.bet_odds ?? '1.0000',
        freebetAmount: row.bet_freebet_amount,
        placedAt: row.bet_placed_at,
        selections: selections.map((selection) => ({
          event: selection.event,
          sport: selection.sport,
          market: selection.market,
          selection: selection.selection,
          eventAt: selection.event_at,
          dateStatus: selection.date_status,
        })),
      };
    }

    switch (item.operation) {
      case 'send_processing_message': {
        if (row.telegram_processing_message_id) return; // já enviada: idempotente
        // STK-G0-20 — texto fixo (estrutura e emojis preservados); somente o
        // UUID do processamento varia entre envios.
        const result = await client.sendMessage(
          chatId,
          [
            '🤖 Sua aposta está sendo processada!',
            'Estamos analisando as informações enviadas. Caso ocorra alguma instabilidade, o sistema tentará novamente automaticamente. ⏳⚙️',
            '',
            'ID do processamento:',
            row.id,
            '',
            'Status atual:',
            'Validando informações iniciais da aposta...',
            '',
            'Assim que o processamento for concluído, você receberá uma notificação aqui mesmo. ✅',
            '',
            'Para acompanhar todos os seus processamentos, digite:',
            '👉 /fila 👀',
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
          buttons: telegramResultButtons(config.miniAppUrl, row.id),
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
            buttons: telegramResultButtons(config.miniAppUrl, row.id),
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
