import { createHash } from 'node:crypto';
import {
  createFinanceService,
  createImportService,
  createTenantContext,
  systemOrganizationContext,
  type Database,
  type OrganizationContext,
  type TelegramTicketService,
} from '@stakeframe/db';
import { createTelegramTicketService } from '@stakeframe/db';
import {
  TelegramOperationError,
  createTelegramClient,
  telegramPreviewButtons,
  type TelegramConfig,
} from './telegram.js';
import { buildPreviewMessage, type PreviewMessageRow } from './telegram-preview-message.js';

/**
 * STK-F2-05 — o worker drena a fila do Telegram UMA FOTO POR VEZ e publica o
 * PREVIEW antes de qualquer escrita financeira.
 *
 * O laço é deliberadamente sequencial: enquanto existe um bilhete `admitted`,
 * nenhuma outra foto é admitida. A fila é drenada por `admitNext`, que devolve
 * `null` quando há uma foto em voo — não existe "processar em paralelo para
 * ganhar tempo", porque o produto pediu uma foto por vez.
 *
 * Nenhuma aposta é criada ao publicar o preview. O worker admite, extrai,
 * publica e avisa; a DECISÃO (confirmar, editar ou descartar) é do usuário, e a
 * escrita financeira nasce do `import.confirm` que essa decisão dispara.
 *
 * Retry é EXPLÍCITO: quando a extração não fica disponível, a vaga volta para
 * a fila e o bilhete fica `failed` com `retry` no preview. Não existe
 * temporizador que repete chamada paga.
 *
 * NADA DE CONTEÚDO VAI AO LOG. Bilhetes reais aparecem no preview, então todo
 * erro sai como código sanitizado, sem legenda, extração, valor, nome ou
 * identificador de mensagem.
 */

type Client = ReturnType<typeof createTelegramClient>;
/** Cadência da drenagem quando não há foto admitida. */
const IDLE_POLL_MS = 2_000;
/** Falha contínua no drain não pode virar loop apertado. */
const FAILURE_BACKOFF_MS = 5_000;

/** Chave idempotente determinística da decisão, por importação + versão. */
export const telegramPreviewDecisionKey = (inboxId: string, version: number) => {
  const digest = createHash('sha256')
    .update(`telegram:preview:${inboxId}:${version}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

export function createTelegramPreviewFlow(
  database: Database,
  client: Client,
  config: TelegramConfig,
  tickets: TelegramTicketService = createTelegramTicketService(database),
) {
  const tenant = createTenantContext(database);
  const finance = createFinanceService(database);
  const imports = createImportService(database);

  /** Fotografia mínima do rascunho para a mensagem de preview (sem PII extra). */
  async function readMessageRow(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<PreviewMessageRow | null> {
    return tenant.withOrganizationTransaction(
      context,
      async (db) => {
        const row = (
          await db.query<{
            telegram_chat_id: string | null;
            telegram_source_message_id: string | null;
            telegram_processing_message_id: string | null;
          }>(
            `select telegram_chat_id,telegram_source_message_id,telegram_processing_message_id
               from integration.inbox
              where organization_id=current_setting($1, true)::uuid and id=$2`,
            ['app.organization_id', inboxId],
          )
        ).rows[0];
        if (!row) return null;
        // O bigint chega como string: a conversão só acontece para a chamada
        // ao Telegram, e um id fora de `number` seguro vira `null` (a foto
        // continua decidível pelo Mini App).
        const toId = (value: string | null) => {
          if (value === null) return null;
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) ? parsed : null;
        };
        return {
          chatId: toId(row.telegram_chat_id),
          sourceMessageId: toId(row.telegram_source_message_id),
          processingMessageId: toId(row.telegram_processing_message_id),
        } satisfies PreviewMessageRow;
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Publica o preview no chat.
   *
   * A entrega é idempotente porNatureza: se o envio falhar, o preview continua
   * decidível pelo Mini App e a temporária de processamento permanece — só é
   * removida DEPOIS que o preview foi entregue. Falha de Telegram nunca desfaz
   * registro nem escreve no financeiro.
   */
  async function announcePreview(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<{ delivered: boolean }> {
    const preview = await tickets.publishPreview(context, inboxId);
    const row = await readMessageRow(context, inboxId);
    if (!row) return { delivered: false };
    const chatId = row.chatId ?? Number(config.chatId);
    const text = buildPreviewMessage({ ...row, preview });
    try {
      const sent = await client.sendMessage(chatId, text, {
        ...(row.sourceMessageId === null ? {} : { replyToMessageId: Number(row.sourceMessageId) }),
        buttons: telegramPreviewButtons(config.miniAppUrl, inboxId),
      });
      // STK-F2-07 — o botão Confirmar/Descartar do preview só é decidível se o
      // servidor souber qual mensagem o carrega. Esse id mora em `metadata`
      // (jsonb) e NÃO em `telegram_result_message_id`: aquela coluna é a da
      // mensagem de resultado, e a outbox a usa para decidir se já entregou —
      // gravá-la aqui faria a outbox pular a resposta final após a importação.
      await tenant.withOrganizationTransaction(context, async (db) => {
        await db.query(
          `update integration.inbox
              set metadata=jsonb_set(metadata,'{telegramPreviewMessageId}',to_jsonb($3::bigint),true),
                  updated_at=now()
            where organization_id=current_setting($1, true)::uuid and id=$2`,
          ['app.organization_id', inboxId, String(sent.messageId)],
        );
      });
    } catch (error) {
      if (!(error instanceof TelegramOperationError)) throw error;
      console.warn(`TELEGRAM_PREVIEW_SEND_FAILED ${error.code}`);
      return { delivered: false };
    }
    await dropProcessingMessage(context, inboxId, row);
    return { delivered: true };
  }

  /** Remove a temporária de processamento depois que o preview foi entregue. */
  async function dropProcessingMessage(
    context: OrganizationContext,
    inboxId: string,
    row: PreviewMessageRow,
  ): Promise<void> {
    if (row.processingMessageId === null) return;
    try {
      await client.deleteMessage(
        row.chatId ?? Number(config.chatId),
        Number(row.processingMessageId),
      );
    } catch (error) {
      if (!(error instanceof TelegramOperationError)) throw error;
      console.warn(`TELEGRAM_PREVIEW_CLEANUP_FAILED ${error.code}`);
      return;
    }
    await tenant.withOrganizationTransaction(context, async (db) => {
      await db.query(
        `update integration.inbox set telegram_processing_message_id=null, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2`,
        ['app.organization_id', inboxId],
      );
    });
  }

  /**
   * Drena UM bilhete por vez. Devolve `true` quando houve trabalho, para que o
   * chamador siga admitindo em vez de dormir.
   */
  async function drainOnce(context: OrganizationContext): Promise<boolean> {
    const inboxId = await tickets.admitNext(context);
    if (!inboxId) return false;
    try {
      // O preview é publicado a partir do rascunho JÁ extraído pela fila de OCR;
      // o worker não chama o modelo aqui. Se a extração ainda não existe, a
      // vaga volta e o bilhete espera a extração/retry explícito.
      const preview = await tickets.preview(context, inboxId);
      if (preview.state === 'pending' || preview.state === 'processing') {
        await tickets.releaseAdmission(context, inboxId);
        return true;
      }
      await announcePreview(context, inboxId);
      return true;
    } catch (error) {
      // Nenhum detalhe do bilhete sai daqui: só o nome do erro.
      await tickets.releaseAdmission(context, inboxId);
      console.warn(
        `TELEGRAM_TICKET_DRAIN_FAILED ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return false;
    }
  }

  /**
   * Confirmação pelo botão do preview.
   *
   * O botão Confirmar NÃO cria aposta sozinho: ele chama o MESMO
   * `confirmDraft` que o Mini App usa, que monta o comando `import.confirm` a
   * partir do rascunho canônico e o entrega ao serviço financeiro — que
   * revalida casa, origem, crédito, campos e duplicata no servidor. Se algo
   * faltar, a resposta é `incomplete` e o preview continua aberto para edição.
   */
  async function confirm(
    context: OrganizationContext,
    inboxId: string,
    version: number,
  ): Promise<
    | { state: 'confirmed'; betId: string; version: number }
    | { state: 'already' | 'discarded' | 'duplicate' | 'incomplete'; blockedReason?: string }
  > {
    const preview = await tickets.preview(context, inboxId);
    if (preview.state === 'imported') return { state: 'already' };
    if (preview.state === 'discarded') return { state: 'discarded' };
    if (preview.duplicate.detected)
      return { state: 'duplicate', blockedReason: 'DUPLICATE_REVIEW_REQUIRED' };
    if (!preview.stake || !preview.odds || preview.blockedReason)
      return { state: 'incomplete', blockedReason: preview.blockedReason ?? 'FIELDS_PENDING' };
    const settings = await finance.workspace(context);
    if (!settings.initialized) return { state: 'incomplete', blockedReason: 'NOT_INITIALIZED' };
    const applied = await imports.confirmDraft(
      context,
      inboxId,
      { version },
      'telegram:bot',
      telegramPreviewDecisionKey(inboxId, version),
    );
    return { state: 'confirmed', betId: applied.betId, version: applied.version };
  }

  /**
   * Descarte com ARQUIVO recuperável de 30 dias. Não apaga nada e não manda
   * "desfazer": o registro continua endereçável pela API durante a janela.
   */
  async function discard(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<{ recoverableUntil: string }> {
    const preview = await tickets.preview(context, inboxId);
    if (preview.archive.archived) {
      // Já arquivado: o prazo vigente é o do arquivo vivo, sem segunda janela.
      return { recoverableUntil: preview.archive.recoverableUntil ?? new Date(0).toISOString() };
    }
    return tickets.archive(context, inboxId, 'discarded');
  }

  /**
   * Recuperação dentro da janela. Devolve o bilhete à fila — nunca cria uma
   * aposta por reenvio.
   */
  async function restore(context: OrganizationContext, archiveId: string) {
    return tickets.restore(context, archiveId);
  }

  return { drainOnce, announcePreview, confirm, discard, restore, preview: tickets.preview };
}

export type TelegramPreviewFlow = ReturnType<typeof createTelegramPreviewFlow>;
export { IDLE_POLL_MS as telegramPreviewIdleMs, FAILURE_BACKOFF_MS as telegramPreviewBackoffMs };
export { systemOrganizationContext };
