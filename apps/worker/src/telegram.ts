import { readSecret } from '@stakeframe/db';
import {
  MAX_IMAGE_BYTES,
  telegramMessageSchema,
  telegramUpdateIdSchema,
  parseCaption,
  parseTelegramCallbackData,
} from '@stakeframe/shared';
import { IntegrationError, readBounded, readJson } from './http.js';
// Botões da resposta final (R6/G0-20 B4): somente '✏️ Editar' abre o Mini App
// pelo botão web_app com a URL HTTPS configurada e o UUID opaco do registro
// canônico; os demais usam callback_data sem NENHUM identificador —
// a importação é resolvida no servidor por chat + id da mensagem de resultado.
// Cada botão abre SOMENTE o teclado/seção da sua ação: Alterar Status NUNCA
// abre o Mini App (teclado inline próprio), Casa/Tipster abrem os teclados
// dos cadastros ATIVOS da organização, Cashout orienta o usuário a entrar por
// Editar para informar o valor, e Excluir segue em dois toques.
export function telegramResultButtons(miniAppUrl: string, importId: string) {
  const base = miniAppUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  // Caminho dedicado para que o proxy aplique a política de iframe do
  // Telegram somente ao Mini App; o fragmento continua carregando o UUID
  // opaco e nunca contém token ou dado privado.
  const miniApp = () => `${base}/miniapp#miniapp?import=${importId}`;
  return [
    [{ text: '✏️ Editar', web_app: { url: miniApp() } }],
    [{ text: '📚 Alterar Status', callback_data: 'sf:v1:status' }],
    [
      { text: '🏠 Alterar Casa', callback_data: 'sf:v1:bookmaker' },
      { text: '🗣️ Alterar Tipster', callback_data: 'sf:v1:tipster' },
    ],
    [{ text: '💸 Cashout', callback_data: 'sf:v1:cashout' }],
    [{ text: '🗑️ Excluir', callback_data: 'sf:v1:delete' }],
  ];
}

// STK-G0-20 B4 — teclado de status: exatamente as sete opções do produto; a
// transição carrega SOMENTE a ação (revalidada no servidor) e '◀️ Voltar para
// o bilhete' restaura o teclado principal da mensagem final.
export function telegramStatusButtons() {
  return [
    [
      { text: '✅ Ganha', callback_data: 'sf:v1:status:win' },
      { text: '❌ Perdida', callback_data: 'sf:v1:status:loss' },
    ],
    [{ text: '⏳ Pendente', callback_data: 'sf:v1:status:pending' }],
    [
      { text: '🌗 Meio-Ganha', callback_data: 'sf:v1:status:half_win' },
      { text: '🌗 Meio-Perdida', callback_data: 'sf:v1:status:half_loss' },
    ],
    [{ text: '💱 Reembolsada', callback_data: 'sf:v1:status:void' }],
    [{ text: '◀️ Voltar para o bilhete', callback_data: 'sf:v1:back' }],
  ];
}

// STK-G0-20 B3 — teclado de seleção com os cadastros ATIVOS da organização;
// '◀️ Voltar' restaura o teclado principal da mensagem final.
export function telegramCatalogButtons(
  kind: 'bookmaker' | 'tipster',
  items: { id: string; name: string }[],
) {
  return [
    ...items.map((item) => [{ text: item.name, callback_data: `sf:v1:${kind}:${item.id}` }]),
    [{ text: '◀️ Voltar', callback_data: 'sf:v1:back' }],
  ];
}

export function telegramDeleteConfirmButtons() {
  return [
    [{ text: 'Confirmar exclusão', callback_data: 'sf:v1:delete:confirm' }],
    [{ text: 'Cancelar', callback_data: 'sf:v1:delete:cancel' }],
  ];
}

// Falha de operação Telegram classificada: transitória (retry/backoff),
// permanente (400/403 sem loop) ou idempotente (mensagem ausente/'não
// modificada' equivalem a sucesso). Nenhuma resposta bruta é propagada.
export class TelegramOperationError extends IntegrationError {
  constructor(
    code: string,
    public readonly info: {
      retryAfterSeconds?: number;
      missing?: boolean;
      permanent?: boolean;
    } = {},
  ) {
    super(code);
    this.name = 'TelegramOperationError';
  }
}

function classifyFailure(payload: Record<string, unknown>): {
  missing: boolean;
  unchanged: boolean;
} {
  const status = typeof payload.error_code === 'number' ? payload.error_code : null;
  const description =
    typeof payload.description === 'string' ? payload.description.toLowerCase() : '';
  if (status === 429) {
    const parameters = object(payload.parameters);
    const retry =
      parameters &&
      typeof parameters.retry_after === 'number' &&
      Number.isFinite(parameters.retry_after)
        ? Math.max(1, Math.ceil(parameters.retry_after))
        : 1;
    throw new TelegramOperationError('TELEGRAM_RATE_LIMITED', { retryAfterSeconds: retry });
  }
  if (description.includes('not modified')) return { missing: false, unchanged: true };
  if (description.includes('not found') || description.includes('message_id_invalid'))
    return { missing: true, unchanged: false };
  if (status !== null && status >= 400 && status < 500)
    throw new TelegramOperationError('TELEGRAM_PERMANENT', { permanent: true });
  throw new TelegramOperationError('TELEGRAM_CONNECTION_FAILED');
}
import { imageMime } from './openrouter.js';

export type TelegramConfig = {
  token: string;
  userId: string;
  chatId: string;
  /** URL base HTTPS do Mini App (validada; nunca carrega token nem initData). */
  miniAppUrl: string;
};

export function validMiniAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function readTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | null {
  if (env.TELEGRAM_ENABLED === undefined || env.TELEGRAM_ENABLED === 'false') return null;
  if (env.TELEGRAM_ENABLED !== 'true') throw new IntegrationError('TELEGRAM_CONFIGURATION_INVALID');
  const token = readSecret(env, 'TELEGRAM_BOT_TOKEN');
  const userId = readSecret(env, 'TELEGRAM_OWNER_USER_ID');
  const chatId = readSecret(env, 'TELEGRAM_OWNER_CHAT_ID');
  // A URL do Mini App é informação pública (nunca um segredo): env simples.
  const miniAppUrl =
    typeof env.TELEGRAM_MINIAPP_URL === 'string' ? env.TELEGRAM_MINIAPP_URL.trim() : '';
  if (
    !token ||
    !/^\d{5,16}:[A-Za-z0-9_-]{30,80}$/.test(token) ||
    !userId ||
    !/^[1-9]\d{0,15}$/.test(userId) ||
    !Number.isSafeInteger(Number(userId)) ||
    chatId !== userId ||
    !miniAppUrl ||
    !validMiniAppUrl(miniAppUrl)
  )
    throw new IntegrationError('TELEGRAM_CONFIGURATION_INVALID');
  return { token, userId, chatId, miniAppUrl };
}

export function authorizedImage(update: unknown, config: TelegramConfig) {
  const parsed = telegramMessageSchema.safeParse(update);
  if (!parsed.success) return null;
  const { message, update_id: updateId } = parsed.data;
  if (String(message.from.id) !== config.userId || String(message.chat.id) !== config.chatId)
    return null;
  const file =
    message.document ??
    message.photo?.reduce((best, current) =>
      current.width * current.height > best.width * best.height ? current : best,
    );
  if (!file) return null;
  return {
    updateId,
    messageId: message.message_id,
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    receivedAt: new Date(message.date * 1000),
    caption: message.caption ?? '',
    labels: parseCaption(message.caption ?? ''),
  };
}
export type TelegramImage = NonNullable<ReturnType<typeof authorizedImage>>;

// STK-G0-19-R6 — callback_query autorizado: usuário e chat precisam ser os
// configurados; o payload só carrega a AÇÃO (nunca UUID/identificador) e o
// vínculo com a importação é resolvido no servidor por chat + message_id.
export function authorizedCallback(update: unknown, config: TelegramConfig) {
  const root = object(update);
  if (!root || typeof root.update_id !== 'number' || !Number.isSafeInteger(root.update_id))
    return null;
  const query = object(root.callback_query);
  if (!query) return null;
  if (typeof query.id !== 'string' || query.id.length < 1 || query.id.length > 200) return null;
  const from = object(query.from);
  if (!from || String(from.id) !== config.userId) return null;
  const message = object(query.message);
  if (!message) return null;
  const chat = object(message.chat);
  if (!chat || String(chat.id) !== config.chatId) return null;
  const messageId = message.message_id;
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) return null;
  const action = typeof query.data === 'string' ? parseTelegramCallbackData(query.data) : null;
  if (!action) return null;
  return {
    updateId: root.update_id,
    callbackId: query.id,
    action: action.action,
    catalogId: action.catalogId,
    statusAction: action.statusAction ?? null,
    messageId,
  };
}
export type TelegramCallback = NonNullable<ReturnType<typeof authorizedCallback>>;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createTelegramClient(config: TelegramConfig, fetchImpl: typeof fetch = fetch) {
  async function call(method: 'getUpdates' | 'getFile', body: object, stop: AbortSignal) {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(40_000)]);
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IntegrationError('TELEGRAM_HTTP_FAILED');
      }
      const payload = object(await readJson(response, 1_048_576));
      if (payload?.ok !== true) throw new IntegrationError('TELEGRAM_API_FAILED');
      return payload.result;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError('TELEGRAM_CONNECTION_FAILED');
    }
  }
  async function mutate(
    method: string,
    body: object,
    stop?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const signal = stop
      ? AbortSignal.any([stop, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        let failure: Record<string, unknown> | null = null;
        try {
          failure = object(await readJson(response, 16_384));
        } catch {
          failure = null;
        }
        if (response.status === 429) {
          const parameters = failure ? object(failure.parameters) : null;
          const retry =
            parameters && typeof parameters.retry_after === 'number'
              ? Math.max(1, Math.ceil(parameters.retry_after))
              : 1;
          throw new TelegramOperationError('TELEGRAM_RATE_LIMITED', { retryAfterSeconds: retry });
        }
        if (failure) {
          const classified = classifyFailure(failure);
          if (classified.missing) return { __missing: true };
          if (classified.unchanged) return { __unchanged: true };
        }
        if (response.status >= 500) throw new TelegramOperationError('TELEGRAM_CONNECTION_FAILED');
        throw new TelegramOperationError('TELEGRAM_PERMANENT', { permanent: true });
      }
      const payload = object(await readJson(response, 262_144));
      if (!payload) throw new TelegramOperationError('TELEGRAM_CONNECTION_FAILED');
      if (payload.ok === true) return object(payload.result) ?? {};
      const classified = classifyFailure(payload);
      if (classified.missing) return { __missing: true };
      if (classified.unchanged) return { __unchanged: true };
      throw new TelegramOperationError('TELEGRAM_API_FAILED');
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new TelegramOperationError('TELEGRAM_CONNECTION_FAILED');
    }
  }
  return {
    async updates(offset: number, signal: AbortSignal) {
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new IntegrationError('TELEGRAM_OFFSET_INVALID');
      const result = await call(
        'getUpdates',
        { offset, limit: 25, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        signal,
      );
      if (
        !Array.isArray(result) ||
        result.length > 25 ||
        result.some((value) => !telegramUpdateIdSchema.safeParse(value).success)
      )
        throw new IntegrationError('TELEGRAM_UPDATES_INVALID');
      return result as unknown[];
    },
    /** Métodos mutadores do Bot API (usados somente pela outbox e em testes mockados). */
    async sendMessage(
      chatId: number,
      text: string,
      options: { replyToMessageId?: number; buttons?: unknown; stop?: AbortSignal } = {},
    ) {
      const result = await mutate(
        'sendMessage',
        {
          chat_id: chatId,
          text,
          ...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId } : {}),
          ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
          link_preview_options: { is_disabled: true },
        },
        options.stop,
      );
      const messageId = result && typeof result.message_id === 'number' ? result.message_id : null;
      if (!messageId || !Number.isSafeInteger(messageId))
        throw new IntegrationError('TELEGRAM_RESULT_INVALID');
      return { messageId };
    },
    async editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      options: { buttons?: unknown; stop?: AbortSignal } = {},
    ) {
      await mutate(
        'editMessageText',
        {
          chat_id: chatId,
          message_id: messageId,
          text,
          ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
          link_preview_options: { is_disabled: true },
        },
        options.stop,
      );
    },
    /** Responde um callback_query (toast/alert curto; nunca dados privados). */
    async answerCallbackQuery(
      callbackId: string,
      options: { text?: string; showAlert?: boolean } = {},
    ) {
      await mutate('answerCallbackQuery', {
        callback_query_id: callbackId,
        ...(options.text ? { text: options.text } : {}),
        ...(options.showAlert ? { show_alert: true } : {}),
      });
    },
    /** Troca apenas o teclado inline (ex.: confirmação de exclusão). */
    async editMessageReplyMarkup(chatId: number, messageId: number, buttons: unknown) {
      await mutate('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
      });
    },
    async deleteMessage(chatId: number, messageId: number, stop?: AbortSignal) {
      const result = await mutate(
        'deleteMessage',
        { chat_id: chatId, message_id: messageId },
        stop,
      );
      // 'mensagem não encontrada' é sucesso idempotente; restrições
      // permanentes (idade/permissão) lançam e ficam para reconciliação.
      return { missing: result?.__missing === true };
    },
    async download(image: TelegramImage, stop: AbortSignal) {
      const file = object(await call('getFile', { file_id: image.fileId }, stop));
      if (
        !file ||
        typeof file.file_path !== 'string' ||
        !/^(photos|documents)\/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$/.test(file.file_path) ||
        (file.file_size !== undefined &&
          (typeof file.file_size !== 'number' ||
            !Number.isSafeInteger(file.file_size) ||
            file.file_size <= 0 ||
            file.file_size > MAX_IMAGE_BYTES))
      )
        throw new IntegrationError('TELEGRAM_FILE_INVALID');
      try {
        const response = await fetchImpl(
          `https://api.telegram.org/file/bot${config.token}/${file.file_path}`,
          {
            redirect: 'error',
            signal: AbortSignal.any([stop, AbortSignal.timeout(30_000)]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new IntegrationError('TELEGRAM_DOWNLOAD_FAILED');
        }
        const bytes = await readBounded(response, MAX_IMAGE_BYTES);
        imageMime(bytes);
        return bytes;
      } catch (error) {
        if (error instanceof IntegrationError) throw error;
        throw new IntegrationError('TELEGRAM_DOWNLOAD_FAILED');
      }
    },
  };
}

export interface TelegramInbox {
  offset(): Promise<number>;
  // Must commit idempotently before returning. Persist bytes and metadata together.
  accept(image: TelegramImage, download: () => Promise<Buffer>): Promise<void>;
  /** Trata callback_query autorizado; ausente = callbacks são ignorados. */
  callback?(query: TelegramCallback): Promise<void>;
  advance(nextOffset: number): Promise<void>;
}

export async function pollTelegramOnce(
  config: TelegramConfig,
  inbox: TelegramInbox,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  const client = createTelegramClient(config, fetchImpl);
  let offset = await inbox.offset();
  const updates = await client.updates(offset, signal);
  for (const update of updates) {
    const { update_id: id } = telegramUpdateIdSchema.parse(update);
    if (id < offset) continue;
    const image = authorizedImage(update, config);
    if (image) await inbox.accept(image, () => client.download(image, signal));
    else {
      const callback = authorizedCallback(update, config);
      if (callback && inbox.callback) await inbox.callback(callback);
    }
    // No sender data or content from rejected messages is persisted.
    await inbox.advance(id + 1);
    offset = id + 1;
  }
}
