import { setTimeout as delay } from 'node:timers/promises';
import type { PgBoss } from 'pg-boss';
import {
  createInboxStore,
  createR2Storage,
  createAutomaticImportService,
  type Database,
  type PoolClient,
  type ObjectStorage,
} from '@stakeframe/db';
import { probeSchema } from '@stakeframe/shared';
import { readAiConfig, extractTicket } from './openrouter.js';
import { pollTelegramOnce, readTelegramConfig, type TelegramImage } from './telegram.js';
import { IntegrationError } from './http.js';
import { readAutomaticLayouts } from './automatic-config.js';

export const EXTRACTION_QUEUE = 'ticket-extraction';

export async function prepareExtractionQueue(boss: PgBoss) {
  // A failed or uncertain paid call is never retried by the queue.
  await boss.createQueue(EXTRACTION_QUEUE, {
    retryLimit: 0,
    expireInSeconds: 120,
    retentionSeconds: 30 * 86400,
  });
}

export function integrationStore(database: Database, boss: PgBoss, storage?: ObjectStorage) {
  return createInboxStore(
    database,
    async (client, id) => {
      const queued = await boss.send(
        EXTRACTION_QUEUE,
        { nonce: id },
        { id, db: { executeSql: (text, values) => client.query(text, values) } },
      );
      if (!queued) throw new IntegrationError('EXTRACTION_ENQUEUE_FAILED');
    },
    storage,
  );
}

export async function drainExtractionRequest(database: Database, boss: PgBoss) {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    const row = (
      await client.query<{ id: string; inbox_id: string }>(
        'select id,inbox_id from integration.extraction_request order by created_at limit 1 for update skip locked',
      )
    ).rows[0];
    if (!row) {
      await client.query('commit');
      return false;
    }
    const queued = await boss.send(
      EXTRACTION_QUEUE,
      { nonce: row.inbox_id },
      { id: row.id, db: { executeSql: (text, values) => client.query(text, values) } },
    );
    if (!queued) throw new IntegrationError('EXTRACTION_ENQUEUE_FAILED');
    await client.query('delete from integration.extraction_request where id=$1', [row.id]);
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function startIntegrations(
  database: Database,
  boss: PgBoss,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
) {
  const ai = readAiConfig(env);
  const layouts = readAutomaticLayouts(env);
  const automatic = createAutomaticImportService(database, layouts);
  const telegram = readTelegramConfig(env);
  if (!ai && !telegram) return { stop: async () => {}, check: () => {} };
  await prepareExtractionQueue(boss);
  const store = integrationStore(database, boss, createR2Storage(env));
  const controller = new AbortController();
  const tasks: Promise<void>[] = [];
  let leader: PoolClient | undefined;
  try {
    if (ai) {
      tasks.push(
        (async () => {
          while (!controller.signal.aborted) {
            try {
              if (await drainExtractionRequest(database, boss)) continue;
            } catch {
              console.warn('EXTRACTION_DISPATCH_FAILED');
            }
            await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
          }
        })(),
      );
      await store.recoverInterrupted();
      await boss.work(EXTRACTION_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
        const parsed = probeSchema.safeParse(jobs[0]?.data);
        if (!parsed.success) throw new IntegrationError('INVALID_EXTRACTION_JOB');
        const id = parsed.data.nonce;
        const claim = await store.claim(id);
        if (!claim) return { state: 'unchanged' };
        try {
          const result = await extractTicket({
            apiKey: ai.apiKey,
            image: claim.image,
            fetchImpl,
            signal: controller.signal,
            layouts,
          });
          return await automatic.complete(id, claim.attempt, result);
        } catch (error) {
          const code = error instanceof IntegrationError ? error.code : 'AI_OUTCOME_UNCERTAIN';
          await store.fail(id, claim.attempt, code);
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
