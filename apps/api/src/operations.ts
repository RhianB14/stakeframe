import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { readSecret, type Database } from '@stakeframe/db';
import {
  apiErrorSchema,
  operationStateSchema,
  operationsHealthSchema,
  type OperationsHealth,
} from '@stakeframe/shared';
import { sendApiError } from './api-errors.js';

export type OperationsService = { token: string; read: () => Promise<OperationsHealth> };
const backupSchema = z.object({
  backup: z.enum(['ready', 'overdue']),
  retention: z.enum(['ready', 'failed']),
  lastRun: z.enum(['ready', 'failed', 'running']),
  disk: operationStateSchema,
  restoreTest: operationStateSchema,
});

async function readInternal(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5500) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error();
  }
  const reader = response.body.getReader();
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += Buffer.from(next.value).toString('utf8');
      if (text.length > 4096) throw new Error();
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

export function createOperationsService(
  database: Database,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  options: { probeDeadlineMs?: number } = {},
): OperationsService | undefined {
  if (env.MONITORING_ENABLED === undefined || env.MONITORING_ENABLED === 'false') return undefined;
  if (env.MONITORING_ENABLED !== 'true') throw new Error('MONITORING_CONFIGURATION_INVALID');
  const token = readSecret(env, 'MONITOR_TOKEN');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('MONITORING_SECRET_INVALID');
  const probeDeadlineMs = options.probeDeadlineMs ?? 6_500;
  if (!Number.isInteger(probeDeadlineMs) || probeDeadlineMs < 1 || probeDeadlineMs > 30_000)
    throw new Error('INVALID_MONITOR_DEADLINE');
  let cached: OperationsHealth | undefined;
  let inflight: Promise<OperationsHealth> | undefined;
  return {
    token,
    async read() {
      if (cached && Date.now() - Date.parse(cached.checkedAt) < 60_000) return cached;
      if (inflight) return inflight;
      inflight = (async () => {
        const checks: OperationsHealth['checks'] = {
          database: 'failed',
          worker: 'failed',
          backup: 'failed',
          restoreTest: 'failed',
          retention: 'failed',
          disk: 'failed',
          importQueue: 'failed',
          attachments: 'failed',
          aiQuota: 'failed',
          aiBudget: 'failed',
          eventQueue: 'failed',
          recovery: 'failed',
        };
        const probes = Promise.allSettled([
          (async () => {
            const row = (
              await database.pool.query<{
                imports_late: boolean;
                attachments_late: boolean;
                events_late: boolean;
                quarantine: boolean;
                daily: string;
                monthly: string;
              }>(`select
            exists(select 1 from integration.inbox where (state='pending' and updated_at<now()-interval '5 minutes') or (state='processing' and updated_at<now()-interval '3 minutes')) as imports_late,
            exists(select 1 from integration.attachment where state in ('local','deleting') and updated_at<now()-interval '15 minutes') as attachments_late,
            exists(select 1 from integration.event_search where state in ('pending','processing') and created_at<now()-interval '5 minutes') as events_late,
            exists(select 1 from integration.cursor where name='recovery-quarantine' and next_offset<>0) as quarantine,
            coalesce(sum(requests) filter(where day=to_char(now() at time zone 'UTC','YYYY-MM-DD')),0)::text as daily,
            coalesce(sum(requests),0)::text as monthly
            from integration.ai_usage_day where day>=to_char(now() at time zone 'UTC','YYYY-MM')||'-01'
              and day<to_char(now() at time zone 'UTC','YYYY-MM')||'-32'`)
            ).rows[0]!;
            checks.database = 'ready';
            checks.importQueue = row.imports_late ? 'failed' : 'ready';
            checks.attachments = row.attachments_late ? 'failed' : 'ready';
            checks.eventQueue = row.events_late ? 'failed' : 'ready';
            checks.recovery = row.quarantine ? 'failed' : 'ready';
            const ratio = Math.max(Number(row.daily) / 60, Number(row.monthly) / 1500);
            checks.aiQuota = ratio >= 1 ? 'failed' : ratio >= 0.8 ? 'warning' : 'ready';
          })(),
          (async () => {
            const response = z
              .object({ status: z.literal('ready') })
              .parse(await readInternal('http://worker:9091/', fetchImpl));
            checks.worker = response.status;
          })(),
          (async () => {
            checks.aiBudget = z
              .object({ status: operationStateSchema })
              .parse(await readInternal('http://worker:9091/budget', fetchImpl)).status;
          })(),
          (async () => {
            const result = backupSchema.parse(
              await readInternal('http://operations:9092/status', fetchImpl),
            );
            checks.backup =
              result.backup === 'ready' && result.lastRun !== 'failed' ? 'ready' : 'failed';
            checks.retention = result.retention;
            checks.disk = result.disk;
            checks.restoreTest = result.restoreTest;
          })(),
        ]);
        // A hung internal probe must not hold the authenticated route past the
        // external monitor's own budget: unresolved checks stay 'failed' and the
        // response is still produced within the deadline.
        await Promise.race([
          probes,
          new Promise<void>((resolve) => {
            setTimeout(resolve, probeDeadlineMs).unref();
          }),
        ]);
        const status = operationsHealthSchema.parse({
          checkedAt: new Date().toISOString(),
          status: Object.values(checks).some((value) => value === 'failed' || value === 'warning')
            ? 'attention'
            : 'ready',
          checks,
        });
        cached = status;
        return status;
      })();
      try {
        return await inflight;
      } finally {
        inflight = undefined;
      }
    },
  };
}

export function registerOperationsRoutes(app: FastifyInstance, service?: OperationsService) {
  app.get(
    '/api/v1/operations/health',
    {
      schema: {
        operationId: 'getOperationsHealth',
        tags: ['Operação'],
        summary: 'Consultar sinais operacionais privados, sem dados de apostas',
        security: [{ operationsMonitor: [] }],
        response: {
          200: operationsHealthSchema,
          401: apiErrorSchema,
          404: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
        },
      },
      onRequest: async (request, reply) => {
        if (!service) return sendApiError(request, reply, 404, 'NOT_FOUND');
        const supplied = request.headers.authorization;
        const expected = `Bearer ${service.token}`;
        if (
          !supplied ||
          !/^Bearer [a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        )
          return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
      },
    },
    async () => service!.read(),
  );
}
