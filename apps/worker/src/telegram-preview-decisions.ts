import { createTenantContext, systemOrganizationContext, type Database } from '@stakeframe/db';
import { createTelegramClient, type TelegramConfig } from './telegram.js';
import { createTelegramPreviewFlow } from './telegram-preview.js';
import { createTelegramTextRegistration } from './telegram-text-registration.js';

/**
 * STK-F2-07 — a decisão sobre o PREVIEW, que a F2-2-05 criou e não implementou.
 *
 * Os botões `Confirmar` e `Descartar` do preview já existiam e já tinham
 * `callback_data` parserizado desde a F2-05, mas nenhum caminho os tratava: o
 * callback do worker resolvia a importação por `telegram_result_message_id`,
 * e a mensagem de preview nunca gravou esse id. Este módulo é o tratamento que
 * faltava, e ele resolve o rascunho pela MESMA chave canônica do resto do
 * worker — chat + id da mensagem — nunca por payload.
 *
 * Duas surfaces compartilham a decisão, e é o que a tornaria duplicada se não
 * fossem o MESMO serviço:
 *
 *  - o PREVIEW de uma FOTO (F2-05), e
 *  - o PREVIEW de um REGISTRO POR TEXTO (F2-07).
 *
 * A diferença entre as duas está no rascunho (imagem × texto), não na decisão.
 * Por isso este handler resolve a importação da mensagem e pergunta ao serviço
 * correspondente; e a resposta ao usuário é sempre a mesma, qualquer que seja a
 * origem. Nenhuma das duas escreve aposta sem o toque — e nenhuma outra coisa
 * escreve.
 */

type Client = ReturnType<typeof createTelegramClient>;

export function createTelegramPreviewDecisionHandler(
  database: Database,
  client: Client,
  config: TelegramConfig,
  deps: { apiKey: string | null; fetchImpl?: typeof fetch },
) {
  const tenant = createTenantContext(database);
  const photo = createTelegramPreviewFlow(database, client, config);
  const text = createTelegramTextRegistration(database, client, config, {
    apiKey: deps.apiKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  /**
   * Resolve o rascunho pela mensagem que carrega o botão. A organização é a da
   * DONA do bot, resolvida pelo vínculo — nunca um id do payload, e nunca um id
   * de ambiente. Um `payload` com identificador seria falsificável; o chat e o
   * id da mensagem não são, porque o Telegram os entrega e o servidor os
   * confere.
   *
   * O id do preview mora em `metadata.telegramPreviewMessageId` e não em
   * `telegram_result_message_id` por um motivo concreto: aquela coluna é a da
   * MENSAGEM DE RESULTADO, e a outbox a usa para decidir se já entregou. Gravar
   * nela no momento do preview faria a outbox pular a resposta final depois da
   * importação. `metadata` é jsonb da organização, aceita sem migração, e é
   * onde a F2-05 já guarda os overrides do rascunho.
   */
  async function resolveDraft(messageId: number): Promise<{
    inboxId: string;
    version: number;
    context: ReturnType<typeof systemOrganizationContext>;
    isText: boolean;
  } | null> {
    const founder = await tenant.founderOrganizationId();
    if (!founder) return null;
    const context = systemOrganizationContext(founder);
    const row = await tenant.withOrganizationTransaction(
      context,
      async (db) =>
        (
          await db.query<{ id: string; version: number; source: string | null }>(
            `select id,version,metadata->>'source' as source from integration.inbox
              where organization_id=current_setting($1, true)::uuid
                and telegram_chat_id=$2
                and metadata->>'telegramPreviewMessageId'=$3`,
            ['app.organization_id', config.chatId, String(messageId)],
          )
        ).rows[0],
      { isolation: 'repeatable read' },
    );
    if (!row) return null;
    return {
      inboxId: row.id,
      version: row.version,
      context,
      isText: row.source === 'telegram-text',
    };
  }

  return async function handle(input: {
    callbackId: string;
    messageId: number;
    action: 'preview_confirm' | 'preview_discard';
  }): Promise<void> {
    const draft = await resolveDraft(input.messageId);
    if (!draft) {
      // Mensagem desconhecida ou alheia: resposta sanitizada, nenhuma ação.
      await client.answerCallbackQuery(input.callbackId, {
        text: 'Este rascunho não está mais disponível.',
      });
      return;
    }
    const service = draft.isText ? text : photo;
    try {
      if (input.action === 'preview_discard') {
        const archived = await service.discard(draft.context, draft.inboxId);
        await client.answerCallbackQuery(input.callbackId, {
          text: `Rascunho arquivado. Recuperável até ${archived.recoverableUntil.slice(0, 10)}.`,
        });
        return;
      }
      const result = await service.confirm(draft.context, draft.inboxId, draft.version);
      if (result.state === 'confirmed') {
        await client.answerCallbackQuery(input.callbackId, {
          text: 'Aposta registrada.',
        });
        return;
      }
      if (result.state === 'already') {
        await client.answerCallbackQuery(input.callbackId, {
          text: 'Este rascunho já foi confirmado.',
        });
        return;
      }
      if (result.state === 'discarded') {
        await client.answerCallbackQuery(input.callbackId, {
          text: 'Este rascunho foi descartado.',
        });
        return;
      }
      if (result.state === 'duplicate') {
        await client.answerCallbackQuery(input.callbackId, {
          text: 'Isto parece duplicata. Confira antes de confirmar.',
        });
        return;
      }
      // `incomplete`: o rascunho continua aberto para edição. A mensagem diz o
      // QUE falta, nunca o erro interno — `blockedReason` é um código, e o
      // usuário precisa da orientação, não do diagnóstico.
      const guidance: Record<string, string> = {
        FIELDS_PENDING: 'Faltam valor e odd. Abra Editar para completar antes de confirmar.',
        NOT_INITIALIZED:
          'A banca ainda não foi inicializada. Configure no site antes de registrar.',
        DUPLICATE_REVIEW_REQUIRED: 'Isto parece duplicata. Confira antes de confirmar.',
        TELEGRAM_TICKET_NOT_FOUND: 'Este rascunho não está mais disponível.',
      };
      await client.answerCallbackQuery(input.callbackId, {
        text: guidance[result.blockedReason ?? ''] ?? 'Confira os campos antes de confirmar.',
      });
    } catch {
      // Repetição, estado divergente ou falha do serviço: a resposta é sempre a
      // mesma e nada é desfeito. O rascunho continua decidível.
      await client.answerCallbackQuery(input.callbackId, {
        text: 'Não foi possível concluir agora. Tente de novo em instantes.',
      });
    }
  };
}
