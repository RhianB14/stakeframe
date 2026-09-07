import { readSecret } from '@stakeframe/db';
import {
  MAX_IMAGE_BYTES,
  telegramMessageSchema,
  telegramUpdateIdSchema,
  parseCaption,
} from '@stakeframe/shared';
import { IntegrationError, readBounded, readJson } from './http.js';
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
    async download(image: TelegramImage, stop: AbortSignal) {
      const file = object(await call('getFile', { file_id: image.fileId }, stop));
      if (
        !file ||
        typeof file.file_path !== 'string' ||
        !/^(photos|documents)\/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$/.test(file.file_path) ||
        typeof file.file_size !== 'number' ||
        !Number.isSafeInteger(file.file_size) ||
        file.file_size <= 0 ||
        file.file_size > MAX_IMAGE_BYTES
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
