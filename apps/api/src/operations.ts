import { timingSafeEqual } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createTenantContext, readSecret, type Database } from '@stakeframe/db';
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
  sync: operationStateSchema,
  integrity: operationStateSchema,
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

// The TLS probe reads the certificate served by the web service (SNI from
// APP_ORIGIN) between containers: no public fetch and no external dependency.
// Trust is not the signal here — the public edge verifies the chain on every
// monitor cycle — so the handshake only needs the certificate readable; the
// expiry is compared against the thresholds below.
const TLS_PROBE_HOST = 'web';
const TLS_PROBE_PORT = 8_443;
const TLS_PROBE_TIMEOUT_MS = 2_500;

// Thresholds are additive observability settings: an invalid value falls back
// to the documented default instead of blocking the API start — the same
// lenient policy used by the monitor hysteresis.
function readTlsThreshold(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const days = Number(value);
  return days >= 1 && days <= 3_650 ? days : fallback;
}

// Returns the served certificate expiry, or null when there is no configured
// target to monitor — the check reports 'disabled' then. Monitoring itself
// being off means no endpoint at all, decided in createOperationsService.
async function readServedCertificate(env: NodeJS.ProcessEnv): Promise<Date | null> {
  const origin = env.APP_ORIGIN;
  if (!origin) return null;
  let servername: string;
  try {
    servername = new URL(origin).hostname;
  } catch {
    return null;
  }
  return await new Promise<Date>((resolve, reject) => {
    const socket = tlsConnect({
      host: TLS_PROBE_HOST,
      port: TLS_PROBE_PORT,
      servername,
      // An expired or otherwise untrusted certificate must still expose its
      // validity instead of failing the handshake.
      rejectUnauthorized: false,
      timeout: TLS_PROBE_TIMEOUT_MS,
    });
    socket.once('secureConnect', () => {
      const expiresAt = Date.parse(socket.getPeerCertificate()?.valid_to ?? '');
      socket.destroy();
      if (Number.isFinite(expiresAt)) resolve(new Date(expiresAt));
      else reject(new Error('CERTIFICATE_UNREADABLE'));
    });
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('CERTIFICATE_TIMEOUT'));
    });
  });
}

export function createOperationsService(
  database: Database,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  options: { probeDeadlineMs?: number; readCertificate?: () => Promise<Date | null> } = {},
): OperationsService | undefined {
  if (env.MONITORING_ENABLED === undefined || env.MONITORING_ENABLED === 'false') return undefined;
  if (env.MONITORING_ENABLED !== 'true') throw new Error('MONITORING_CONFIGURATION_INVALID');
  const token = readSecret(env, 'MONITOR_TOKEN');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('MONITORING_SECRET_INVALID');
  const probeDeadlineMs = options.probeDeadlineMs ?? 6_500;
  if (!Number.isInteger(probeDeadlineMs) || probeDeadlineMs < 1 || probeDeadlineMs > 30_000)
    throw new Error('INVALID_MONITOR_DEADLINE');
  const tlsWarnDays = readTlsThreshold(env, 'TLS_EXPIRY_WARN_DAYS', 21);
  const tlsFailDays = readTlsThreshold(env, 'TLS_EXPIRY_FAIL_DAYS', 7);
  const readCertificate = options.readCertificate ?? (() => readServedCertificate(env));
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
          backupSync: 'failed',
          backupIntegrity: 'failed',
          restoreTest: 'failed',
          retention: 'failed',
          disk: 'failed',
          importQueue: 'failed',
          attachments: 'failed',
          aiQuota: 'failed',
          aiBudget: 'failed',
          eventQueue: 'failed',
          recovery: 'failed',
          tls: 'failed',
        };
        const probes = Promise.allSettled([
          (async () => {
            // Infrastructure probes: global tables directly, tenant tables by iterating
            // organizations (RLS returns nothing without a context).
            type GlobalRow = { quarantine: boolean; daily: string; monthly: string };
            const global = (
              await database.pool.query<GlobalRow>(`select
            exists(select 1 from integration.cursor where name='recovery-quarantine' and next_offset<>0) as quarantine,
            coalesce(sum(requests) filter(where day=to_char(now() at time zone 'UTC','YYYY-MM-DD')),0)::text as daily,
            coalesce(sum(requests),0)::text as monthly
            from integration.ai_usage_day where day>=to_char(now() at time zone 'UTC','YYYY-MM')||'-01'
              and day<to_char(now() at time zone 'UTC','YYYY-MM')||'-32'`)
            ).rows[0]!;
            const tenantContext = createTenantContext(database);
            let importsLate = false;
            let attachmentsLate = false;
            let eventsLate = false;
            for (const context of await tenantContext.listOrganizations()) {
              const row = await tenantContext.withOrganizationTransaction(
                context,
                async (client) => {
                  return (
                    await client.query<{
                      imports_late: boolean;
                      attachments_late: boolean;
                      events_late: boolean;
                    }>(`select
            exists(select 1 from integration.inbox where organization_id=current_setting($$app.organization_id$$, true)::uuid and ((state='pending' and updated_at<now()-interval '5 minutes') or (state='processing' and updated_at<now()-interval '3 minutes'))) as imports_late,
            exists(select 1 from integration.attachment where organization_id=current_setting($$app.organization_id$$, true)::uuid and state in ('local','deleting') and updated_at<now()-interval '15 minutes') as attachments_late,
            exists(select 1 from integration.event_search where organization_id=current_setting($$app.organization_id$$, true)::uuid and state in ('pending','processing') and created_at<now()-interval '5 minutes') as events_late`)
                  ).rows[0]!;
                },
              );
              importsLate = importsLate || row.imports_late;
              attachmentsLate = attachmentsLate || row.attachments_late;
              eventsLate = eventsLate || row.events_late;
            }
            checks.database = 'ready';
            checks.importQueue = importsLate ? 'failed' : 'ready';
            checks.attachments = attachmentsLate ? 'failed' : 'ready';
            checks.eventQueue = eventsLate ? 'failed' : 'ready';
            checks.recovery = global.quarantine ? 'failed' : 'ready';
            const ratio = Math.max(Number(global.daily) / 60, Number(global.monthly) / 1500);
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
            checks.backupSync = result.sync;
            checks.backupIntegrity = result.integrity;
            checks.retention = result.retention;
            checks.disk = result.disk;
            checks.restoreTest = result.restoreTest;
          })(),
          (async () => {
            const expiresAt = await readCertificate();
            if (expiresAt === null) {
              checks.tls = 'disabled';
              return;
            }
            const daysRemaining = (expiresAt.getTime() - Date.now()) / 86_400_000;
            checks.tls =
              daysRemaining < tlsFailDays
                ? 'failed'
                : daysRemaining < tlsWarnDays
                  ? 'warning'
                  : 'ready';
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
