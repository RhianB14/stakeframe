import { createHash } from 'node:crypto';
import {
  createFinanceService,
  createTenantContext,
  systemOrganizationContext,
  type Database,
} from '@stakeframe/db';
import {
  createTelegramClient,
  telegramDeleteConfirmButtons,
  telegramResultButtons,
  type TelegramCallback,
  type TelegramConfig,
} from './telegram.js';

// STK-G0-19-R6/R7 — tratamento de callback_query dos botões da resposta final.
// Status e casa NÃO passam mais por aqui (botões web_app com seções reais do
// Mini App); só a EXCLUSÃO em dois toques permanece como callback.
// A importação NUNCA é identificada por payload: resolve-se pelo vínculo
// canônico (chat + id da mensagem de resultado), com isolamento por organização
// (contexto de sistema da organização fundadora, única consumidora do bot no
// beta). A exclusão exige confirmação explícita e é idempotente via chave fixa
// do comando; nada aqui fala com o Telegram real fora dos testes.

type Client = ReturnType<typeof createTelegramClient>;

// Chave idempotente DETERMINÍSTICA por importação, em formato UUID (o
// serviço financeiro exige UUID na idempotency-key).
const discardKey = (inboxId: string) => {
  const digest = createHash('sha256').update(`telegram:discard:${inboxId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

export function createTelegramCallbackHandler(
  database: Database,
  client: Client,
  config: TelegramConfig,
) {
  const tenant = createTenantContext(database);
  const finance = createFinanceService(database);
  return async function handle(query: TelegramCallback): Promise<void> {
    const founder = await tenant.founderOrganizationId();
    if (!founder) return;
    const context = systemOrganizationContext(founder);
    const row = await tenant.withOrganizationTransaction(context, async (db) => {
      return (
        await db.query<{ id: string; state: string; version: number }>(
          'select id,state,version from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and telegram_chat_id=$1 and telegram_result_message_id=$2 and telegram_deleted_at is null',
          [config.chatId, query.messageId],
        )
      ).rows[0];
    });
    if (!row) {
      // Mensagem desconhecida/alheia: resposta sanitizada, nenhuma ação.
      await client.answerCallbackQuery(query.callbackId, {
        text: 'Importação não encontrada nesta conversa.',
      });
      return;
    }
    // STK-G0-19-R7: status e casa são ações REAIS no Mini App (botões web_app
    // com seções dedicadas) — não existem mais callbacks que apenas respondem
    // texto. O único callback sobrevivente é a exclusão em dois toques.
    if (query.action === 'delete') {
      await client.answerCallbackQuery(query.callbackId, {
        text: 'Confirme a exclusão desta importação.',
      });
      await client.editMessageReplyMarkup(
        Number(config.chatId),
        query.messageId,
        telegramDeleteConfirmButtons(),
      );
      return;
    }
    if (query.action === 'delete_cancel') {
      await client.answerCallbackQuery(query.callbackId, { text: 'Exclusão cancelada.' });
      await client.editMessageReplyMarkup(
        Number(config.chatId),
        query.messageId,
        telegramResultButtons(config.miniAppUrl, row.id),
      );
      return;
    }
    // delete_confirm — exclusão explícita, idempotente e sanitizada.
    if (row.state === 'discarded') {
      // Repetição do evento após a exclusão: mesmo resultado, nenhuma ação.
      await client.answerCallbackQuery(query.callbackId, { text: 'Importação descartada.' });
      return;
    }
    try {
      await finance.command(context, discardKey(row.id), {
        type: 'import.discard',
        importId: row.id,
        expectedInboxVersion: row.version,
        expectedVersion: (await finance.workspace(context)).version,
        reason: 'Descartada pelo Telegram',
      });
      await client.answerCallbackQuery(query.callbackId, { text: 'Importação descartada.' });
    } catch {
      // Repetição/estado divergente não vaza detalhe nem desfaz nada.
      await client.answerCallbackQuery(query.callbackId, {
        text: 'Não foi possível excluir agora.',
      });
    }
  };
}
