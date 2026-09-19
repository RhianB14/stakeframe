import { createHash } from 'node:crypto';
import {
  createFinanceService,
  createImportService,
  createTenantContext,
  systemOrganizationContext,
  type Database,
} from '@stakeframe/db';
import {
  createTelegramClient,
  telegramCatalogButtons,
  telegramDeleteConfirmButtons,
  telegramResultButtons,
  telegramStatusButtons,
  type TelegramCallback,
  type TelegramConfig,
} from './telegram.js';

// STK-G0-19-R6/R7 / STK-G0-20 B3/B4 — tratamento de callback_query dos botões
// da mensagem final: Casa/Tipster (teclados de cadastros ATIVOS), Alterar
// Status (teclado inline próprio — NUNCA abre o Mini App) e a EXCLUSÃO em dois
// toques, que remove a aposta registrada (cancelamento canônico) ou descarta a
// importação, sempre com limpeza do Telegram.
// A importação NUNCA é identificada por payload: resolve-se pelo vínculo
// canônico (chat + id da mensagem de resultado), com isolamento por organização
// (contexto de sistema da organização fundadora, única consumidora do bot no
// beta). Toda ação é idempotente via chave determinística do comando; nada
// aqui fala com o Telegram real fora dos testes.

type Client = ReturnType<typeof createTelegramClient>;

// Chave idempotente DETERMINÍSTICA por importação, em formato UUID (o
// serviço financeiro exige UUID na idempotency-key).
const discardKey = (inboxId: string) => {
  const digest = createHash('sha256').update(`telegram:discard:${inboxId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

// STK-G0-20 B4 — chave idempotente DETERMINÍSTICA do cancelamento (exclusão
// da aposta registrada pelo Telegram): repetir o evento converge no mesmo
// recibo, nunca num segundo efeito financeiro.
const cancelKey = (inboxId: string) => {
  const digest = createHash('sha256').update(`telegram:cancel:${inboxId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

// STK-G0-20 B3 — chave idempotente DETERMINÍSTICA por importação + cadastro:
// repetir a mesma seleção converge no recibo gravado (nunca duplica efeito).
const selectionKey = (inboxId: string, kind: string, catalogId: string) => {
  const digest = createHash('sha256')
    .update(`telegram:${kind}:${inboxId}:${catalogId}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

export function createTelegramCallbackHandler(
  database: Database,
  client: Client,
  config: TelegramConfig,
) {
  const tenant = createTenantContext(database);
  const finance = createFinanceService(database);
  const imports = createImportService(database);
  return async function handle(query: TelegramCallback): Promise<void> {
    const founder = await tenant.founderOrganizationId();
    if (!founder) return;
    const context = systemOrganizationContext(founder);
    const row = await tenant.withOrganizationTransaction(context, async (db) => {
      return (
        await db.query<{
          id: string;
          state: string;
          version: number;
          imported_bet_id: string | null;
          bet_state: string | null;
        }>(
          'select i.id,i.state,i.version,i.imported_bet_id,b.state as bet_state from integration.inbox i left join finance.bet b on b.id=i.imported_bet_id and b.organization_id=i.organization_id where i.organization_id=current_setting($$app.organization_id$$, true)::uuid and i.telegram_chat_id=$1 and i.telegram_result_message_id=$2 and i.telegram_deleted_at is null',
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
    // STK-G0-20 B3 — Casa de aposta e Tipster: o botão abre SOMENTE o teclado
    // inline do respectivo cadastro (ATIVOS da organização); a seleção
    // atualiza a aposta/registro canônico com revalidação no servidor e o
    // espelho do Telegram vem da outbox (versão otimista + recibo).
    if (query.action === 'bookmaker' || query.action === 'tipster') {
      const kind = query.action;
      if (!query.catalogId) {
        const catalog = (await finance.workspace(context)).catalog.filter(
          (item) => item.kind === kind && item.active,
        );
        await client.answerCallbackQuery(query.callbackId, {
          text: kind === 'bookmaker' ? 'Escolha a casa de aposta.' : 'Escolha o tipster.',
        });
        await client.editMessageReplyMarkup(
          Number(config.chatId),
          query.messageId,
          telegramCatalogButtons(kind, catalog),
        );
        return;
      }
      try {
        const key = selectionKey(row.id, kind, query.catalogId);
        if (kind === 'bookmaker')
          await imports.applyBookmaker(
            context,
            row.id,
            { version: row.version, bookmakerId: query.catalogId },
            'telegram:bot',
            key,
          );
        else
          await imports.applyTipster(
            context,
            row.id,
            { version: row.version, tipsterId: query.catalogId },
            'telegram:bot',
            key,
          );
        await client.answerCallbackQuery(query.callbackId, {
          text: kind === 'bookmaker' ? 'Casa de aposta atualizada.' : 'Tipster atualizado.',
        });
      } catch {
        await client.answerCallbackQuery(query.callbackId, {
          text: 'Não foi possível atualizar agora.',
        });
      }
      return;
    }
    // STK-G0-20 B4 — Alterar Status: o botão abre SOMENTE o teclado inline de
    // status (nunca o Mini App); a seleção aplica a transição pelo comando
    // financeiro canônico (versão otimista). Sair de pendente enfileira a
    // limpeza do Telegram (foto, processamento e mensagem final) na MESMA
    // transação; repetir o mesmo evento converge sem duplicar efeito.
    if (query.action === 'status') {
      if (!query.statusAction) {
        await client.answerCallbackQuery(query.callbackId, { text: 'Escolha o novo status.' });
        await client.editMessageReplyMarkup(
          Number(config.chatId),
          query.messageId,
          telegramStatusButtons(),
        );
        return;
      }
      try {
        await imports.setStatus(
          context,
          row.id,
          { version: row.version, action: query.statusAction },
          'telegram:bot',
        );
        await client.answerCallbackQuery(query.callbackId, {
          text:
            query.statusAction === 'pending'
              ? 'A aposta permanece pendente.'
              : 'Liquidação registrada.',
        });
      } catch {
        await client.answerCallbackQuery(query.callbackId, {
          text: 'Não foi possível atualizar o status agora.',
        });
      }
      return;
    }
    if (query.action === 'back') {
      await client.answerCallbackQuery(query.callbackId, { text: 'Voltar.' });
      await client.editMessageReplyMarkup(
        Number(config.chatId),
        query.messageId,
        telegramResultButtons(config.miniAppUrl, row.id),
      );
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
    // Qualquer outra ação não é exclusão: nada acontece (nunca descartar por
    // engano — o parser já restringe as ações válidas).
    if (query.action !== 'delete_confirm') return;
    // delete_confirm — exclusão explícita, idempotente e sanitizada.
    if (row.state === 'discarded') {
      // Repetição do evento após a exclusão: mesmo resultado, nenhuma ação.
      await client.answerCallbackQuery(query.callbackId, { text: 'Importação descartada.' });
      return;
    }
    // STK-G0-20 B4 — aposta registrada: excluir = cancelamento canônico (sai
    // da Web) com a limpeza do Telegram na mesma transação. A repetição do
    // evento converge no mesmo resultado; aposta já liquidada não é revertida
    // por aqui (resposta sanitizada, nenhum efeito).
    if (row.state === 'imported') {
      if (!row.imported_bet_id) {
        await client.answerCallbackQuery(query.callbackId, {
          text: 'Não foi possível excluir agora.',
        });
        return;
      }
      if (row.bet_state === 'cancelled') {
        await client.answerCallbackQuery(query.callbackId, { text: 'Aposta excluída.' });
        return;
      }
      try {
        await finance.command(context, cancelKey(row.id), {
          type: 'bet.cancel',
          id: row.imported_bet_id,
          effectiveAt: new Date().toISOString(),
          reason: 'Excluída pelo Telegram',
          expectedVersion: (await finance.workspace(context)).version,
        });
        await client.answerCallbackQuery(query.callbackId, { text: 'Aposta excluída.' });
      } catch {
        await client.answerCallbackQuery(query.callbackId, {
          text: 'Não foi possível excluir agora.',
        });
      }
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
