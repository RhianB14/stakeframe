import { setTimeout as delay } from 'node:timers/promises';
import type { PgBoss } from 'pg-boss';
import { createInboxStore, type Database, type PoolClient } from '@stakeframe/db';
import { probeSchema } from '@stakeframe/shared';
import { readAiConfig, extractTicket } from './openrouter.js';
import { pollTelegramOnce, readTelegramConfig, type TelegramImage } from './telegram.js';
import { IntegrationError } from './http.js';

export const EXTRACTION_QUEUE = 'ticket-extraction';

export async function prepareExtractionQueue(boss: PgBoss) {
  // A failed or uncertain paid call is never retried by the queue.
  await boss.createQueue(EXTRACTION_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 30 * 86400,
  });
}

export function integrationStore(database: Database, boss: PgBoss) {
  return createInboxStore(database, async (client, id) => {
    const queued = await boss.send(
      EXTRACTION_QUEUE,
      { nonce: id },
      { id, db: { executeSql: (text, values) => client.query(text, values) } },
    );
    if (!queued) throw new IntegrationError('EXTRACTION_ENQUEUE_FAILED');
  });
}

export async function startIntegrations(
  database: Database,
  boss: PgBoss,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
) {
  const ai = readAiConfig(env);
  const telegram = readTelegramConfig(env);
  if (!ai && !telegram) return { stop: async () => {}, check: () => {} };
  await prepareExtractionQueue(boss);
  const store = integrationStore(database, boss);
  const controller = new AbortController();
  const tasks: Promise<void>[] = [];
  let leader: PoolClient | undefined;
  try {
    if (ai) {
      await store.recoverInterrupted();
      await boss.work(EXTRACTION_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
        const parsed = probeSchema.safeParse(jobs[0]?.data);
        if (!parsed.success) throw new IntegrationError('INVALID_EXTRACTION_JOB');
        const id = parsed.data.nonce;
        const image = await store.claim(id);
        if (!image) return { state: 'unchanged' };
        try {
          const result = await extractTicket({
            apiKey: ai.apiKey,
            image,
            fetchImpl,
            signal: controller.signal,
          });
          await store.complete(id, result);
          return { state: 'review' };
        } catch (error) {
          const code = error instanceof IntegrationError ? error.code : 'AI_OUTCOME_UNCERTAIN';
          await store.fail(id, code);
          return { state: 'failed', code };
        }
      });
    }
    if (telegram) {
      leader = await database.pool.connect();
      const lock = await leader.query<{ locked: boolean }>(
        'select pg_try_advisory_lock(782341094) as locked',
      );
      if (!lock.rows[0]?.locked) throw new IntegrationError('TELEGRAM_CONSUMER_ALREADY_RUNNING');
      // Losing this session invalidates leadership immediately, including an in-flight poll.
      leader.on('error', () => controller.abort());
      const inbox = {
        offset: store.offset,
        advance: store.advance,
        async accept(image: TelegramImage, download: () => Promise<Buffer>) {
          await store.accept(
            {
              sourceKey: `telegram:${telegram.userId}:${image.messageId}`,
              caption: image.caption,
              metadata: {
                source: 'telegram',
                updateId: image.updateId,
                messageId: image.messageId,
                fileUniqueId: image.fileUniqueId,
                receivedAt: image.receivedAt.toISOString(),
                labels: image.labels,
              },
            },
            download,
          );
        },
      };
      tasks.push(
        (async () => {
          while (!controller.signal.aborted) {
            try {
              await pollTelegramOnce(telegram, inbox, controller.signal, fetchImpl);
            } catch {
              if (controller.signal.aborted) break;
              console.warn('TELEGRAM_POLL_FAILED');
              await delay(15_000, undefined, { signal: controller.signal }).catch(() => undefined);
            }
          }
        })(),
      );
    }
    tasks.push(
      (async () => {
        while (!controller.signal.aborted) {
          await delay(60_000, undefined, { signal: controller.signal }).catch(() => undefined);
          if (controller.signal.aborted) break;
          await store.recoverInterrupted().catch(() => console.warn('INTEGRATION_RECOVERY_FAILED'));
        }
      })(),
    );
    return {
      check() {
        if (controller.signal.aborted) throw new IntegrationError('INTEGRATIONS_STOPPED');
      },
      async stop() {
        controller.abort();
        await Promise.allSettled(tasks);
        leader?.release(true);
      },
    };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    leader?.release(true);
    throw error;
  }
}
