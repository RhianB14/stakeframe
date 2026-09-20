import { setTimeout as delay } from 'node:timers/promises';
import type { PgBoss } from 'pg-boss';
import {
  createInboxStore,
  createImportDraftService,
  createR2Storage,
  createAutomaticImportService,
  createTenantContext,
  assertRecoveryReviewed,
  systemOrganizationContext,
  type Database,
  type PoolClient,
  type ObjectStorage,
} from '@stakeframe/db';
import { readAiConfig, extractTicket } from './openrouter.js';
import {
  createTelegramClient,
  pollTelegramOnce,
  readTelegramConfig,
  type TelegramImage,
} from './telegram.js';
import { createTelegramCallbackHandler } from './telegram-callbacks.js';
import { IntegrationError } from './http.js';
import { startTelegramOutbox } from './telegram-outbox.js';
import { readAutomaticPolicy } from './automatic-config.js';
import { extractConfiguredOcr, readOcrProvidersConfig } from './ocr-providers.js';

export const EXTRACTION_QUEUE = 'ticket-extraction';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readExtractionJob(data: unknown): { inboxId: string; organizationId: string } {
  const payload = data as { nonce?: unknown; organizationId?: unknown } | null | undefined;
  if (
    typeof payload?.nonce !== 'string' ||
    !UUID_PATTERN.test(payload.nonce) ||
    typeof payload.organizationId !== 'string' ||
    !UUID_PATTERN.test(payload.organizationId)
  )
    throw new IntegrationError('INVALID_EXTRACTION_JOB');
  return { inboxId: payload.nonce, organizationId: payload.organizationId };
}

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
    async (client, id, organizationId) => {
      const queued = await boss.send(
        EXTRACTION_QUEUE,
        { nonce: id, organizationId },
        { id, db: { executeSql: (text, values) => client.query(text, values) } },
      );
      if (!queued) throw new IntegrationError('EXTRACTION_ENQUEUE_FAILED');
    },
    storage,
  );
}

/**
 * Dispatches one pending extraction request to the queue, iterating organizations (the request
 * belongs to one tenant; without context it is invisible). Atomic: the queue insertion and the
 * request deletion commit with the same organization transaction.
 */
export async function drainExtractionRequest(database: Database, boss: PgBoss) {
  const tenant = createTenantContext(database);
  for (const context of await tenant.listOrganizations()) {
    const progressed = await tenant.withOrganizationTransaction(context, async (client) => {
      const row = (
        await client.query<{ id: string; inbox_id: string }>(
          'select id,inbox_id from integration.extraction_request where organization_id=current_setting($$app.organization_id$$, true)::uuid order by created_at limit 1 for update skip locked',
        )
      ).rows[0];
      if (!row) return false;
      const queued = await boss.send(
        EXTRACTION_QUEUE,
        { nonce: row.inbox_id, organizationId: context.organizationId },
        { id: row.id, db: { executeSql: (text, values) => client.query(text, values) } },
      );
      if (!queued) throw new IntegrationError('EXTRACTION_ENQUEUE_FAILED');
      await client.query(
        'delete from integration.extraction_request where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
        [row.id],
      );
      return true;
    });
    if (progressed) return true;
  }
  return false;
}

export async function startIntegrations(
  database: Database,
  boss: PgBoss,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  requireBudget?: () => Promise<void>,
) {
  const ai = readAiConfig(env);
  const ocrProviders = readOcrProvidersConfig(env);
  if (ocrProviders && !ai) throw new IntegrationError('OCR_REQUIRES_AI');
  const automaticPolicy = readAutomaticPolicy(env);
  const automatic = createAutomaticImportService(
    database,
    automaticPolicy.state === 'approved' ? automaticPolicy.policy : null,
  );
  const draft = createImportDraftService(database);
  const telegram = readTelegramConfig(env);
  if (!ai && !telegram) return { stop: async () => {}, check: () => {} };
  await assertRecoveryReviewed(database);
  // The Telegram consumer predates per-organization bindings: it serves the founding organization.
  const tenant = createTenantContext(database);
  const founder = telegram ? await tenant.founderOrganizationId() : null;
  if (telegram && !founder) throw new IntegrationError('TELEGRAM_FOUNDING_ORGANIZATION_MISSING');
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
      for (const context of await tenant.listOrganizations())
        await store.recoverInterrupted(context);
      await boss.work(EXTRACTION_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
        const { inboxId, organizationId } = readExtractionJob(jobs[0]?.data);
        const context = systemOrganizationContext(organizationId);
        const claim = await store.claim(context, inboxId);
        if (!claim) return { state: 'unchanged' };
        try {
          if (requireBudget) await requireBudget();
          // Fail-closed: when OCR is enabled, its failure aborts the job before
          // the multimodal request. Only the explicitly configured provider
          // failover is allowed; there is no silent OCR-less paid call.
          const ocr = ocrProviders
            ? await extractConfiguredOcr({
                config: ocrProviders,
                image: claim.image,
                fetchImpl,
                signal: controller.signal,
              })
            : undefined;
          const result = await extractTicket({
            apiKey: ai.apiKey,
            image: claim.image,
            fetchImpl,
            signal: controller.signal,
            ...(ocr ? { ocr: ocr.result } : {}),
          });
          const completed = await automatic.complete(context, inboxId, claim.attempt, result);
          // R5: a resposta final é enfileirada somente após o rascunho persistido;
          // sem vínculo Telegram é no-op e nunca duplica mensagem.
          if (completed.state === 'review' || completed.state === 'imported')
            await draft.queueResultMessage(context, inboxId);
          return completed;
        } catch (error) {
          const code = error instanceof IntegrationError ? error.code : 'AI_OUTCOME_UNCERTAIN';
          await store.fail(context, inboxId, claim.attempt, code);
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
      const telegramContext = systemOrganizationContext(founder!);
      // R6: callbacks dos botões são resolvidos pelo vínculo canônico
      // (chat + id da mensagem); nunca por identificador no payload.
      const telegramClient = createTelegramClient(telegram, fetchImpl);
      const handleCallback = createTelegramCallbackHandler(database, telegramClient, telegram);
      const inbox = {
        offset: store.offset,
        advance: store.advance,
        callback: handleCallback,
        async accept(image: TelegramImage, download: () => Promise<Buffer>) {
          const inboxId = await store.accept(
            telegramContext,
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
          // R5: vínculo privado com a mensagem de origem + temporária imediata
          // (enfileirada na fonte canônica; a entrega é da outbox).
          await draft.attachTelegram(telegramContext, inboxId, {
            chatId: Number(telegram.chatId),
            sourceMessageId: image.messageId,
            receivedAt: image.receivedAt,
          });
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
      // R5: executor idempotente da outbox (mocks nos testes; zero operação real aqui).
      const stopOutbox = startTelegramOutbox(database, telegram, fetchImpl);
      tasks.push(
        new Promise<void>((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              stopOutbox();
              resolve();
            },
            { once: true },
          );
        }),
      );
    }
    tasks.push(
      (async () => {
        while (!controller.signal.aborted) {
          await delay(60_000, undefined, { signal: controller.signal }).catch(() => undefined);
          if (controller.signal.aborted) break;
          try {
            for (const context of await tenant.listOrganizations())
              await store.recoverInterrupted(context);
          } catch {
            console.warn('INTEGRATION_RECOVERY_FAILED');
          }
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
