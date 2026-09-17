import { readSecret } from '@stakeframe/db';
import {
  MAX_IMAGE_BYTES,
  telegramMessageSchema,
  telegramUpdateIdSchema,
  parseCaption,
} from '@stakeframe/shared';
import { IntegrationError, readBounded, readJson } from './http.js';
// Botões da resposta final (callback tokens opacos; nenhum identificador
// interno, segredo ou dado privado viaja no payload).
export const TELEGRAM_RESULT_BUTTONS = [
  [{ text: 'Editar', callback_data: 'sf:v1:edit' }],
  [
    { text: 'Alterar Status', callback_data: 'sf:v1:status' },
    { text: 'Alterar Casa', callback_data: 'sf:v1:bookmaker' },
  ],
  [{ text: 'Excluir', callback_data: 'sf:v1:delete' }],
] as const;

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

export type TelegramConfig = { token: string; userId: string; chatId: string };
export function readTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | null {
  if (env.TELEGRAM_ENABLED === undefined || env.TELEGRAM_ENABLED === 'false') return null;
  if (env.TELEGRAM_ENABLED !== 'true') throw new IntegrationError('TELEGRAM_CONFIGURATION_INVALID');
  const token = readSecret(env, 'TELEGRAM_BOT_TOKEN');
  const userId = readSecret(env, 'TELEGRAM_OWNER_USER_ID');
  const chatId = readSecret(env, 'TELEGRAM_OWNER_CHAT_ID');
  if (
    !token ||
    !/^\d{5,16}:[A-Za-z0-9_-]{30,80}$/.test(token) ||
    !userId ||
    !/^[1-9]\d{0,15}$/.test(userId) ||
    !Number.isSafeInteger(Number(userId)) ||
    chatId !== userId
  )
    throw new IntegrationError('TELEGRAM_CONFIGURATION_INVALID');
  return { token, userId, chatId };
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
        { offset, limit: 25, timeout: 25, allowed_updates: ['message'] },
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
    // No sender data or content from rejected messages is persisted.
    await inbox.advance(id + 1);
    offset = id + 1;
  }
}
