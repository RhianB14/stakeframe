import { createServer } from 'node:http';
import {
  createDatabase,
  requireDatabaseUrl,
  readDatabaseConfig,
  assertRecoveryReviewed,
} from '@stakeframe/db';
import { PROBE_QUEUE, resolveReleaseInfo } from '@stakeframe/shared';
import { startWorker } from './worker.js';
import { startIntegrations } from './integrations.js';
import { startMonthlyUnits } from './monthly-unit.js';
import { startAttachments } from './attachments.js';
import { startAccountPurge } from './account-purge.js';
import { startEventSearch } from './event-providers.js';
import { startFreebetAlerts } from './freebet-alerts.js';
import { startReportCadence } from './report-cadence.js';
import { readTelegramConfig } from './telegram.js';
import { createBudgetProbe } from './budget.js';
import { initTelemetry, readTelemetryConfig } from './telemetry.js';

async function main() {
  const telemetry = initTelemetry(
    readTelemetryConfig(process.env),
    resolveReleaseInfo(process.env),
  );
  const connectionString = requireDatabaseUrl(readDatabaseConfig(process.env));
  const database = createDatabase(connectionString);
  if (![undefined, 'true', 'false'].includes(process.env.MONITORING_ENABLED))
    throw new Error('MONITORING_CONFIGURATION_INVALID');
  const budget =
    process.env.MONITORING_ENABLED === 'true' ? createBudgetProbe(process.env) : undefined;
  let boss;
  let integrations = { stop: async () => {}, check: () => {} };
  let monthlyUnits = { stop: async () => {}, check: () => {} };
  let attachments = { stop: async () => {}, check: () => {} };
  let accountPurge = { stop: async () => {}, check: () => {} };
  let events = { stop: async () => {}, check: () => {} };
  let freebets = { stop: async () => {}, check: () => {} };
  // STK-F2-08: a cadência do relatório só existe quando o Telegram existe — o
  // canal é o ÚNICO destino do relatório (o card exclui e-mail, PDF e PNG). Sem
  // Telegram configurado, o job é um no-op declarado, e o relatório continua
  // disponível na página privada da conta.
  const telegram = readTelegramConfig(process.env);
  const reports = telegram ? startReportCadence(database, telegram) : undefined;
  try {
    await assertRecoveryReviewed(database);
    boss = await startWorker(connectionString, 'pgboss', (error) => {
      telemetry.captureError(error, { stage: 'queue' });
    });
    integrations = await startIntegrations(
      database,
      boss,
      process.env,
      fetch,
      budget?.requireBudget,
    );
    monthlyUnits = await startMonthlyUnits(database);
    attachments = startAttachments(database, process.env);
    accountPurge = startAccountPurge(database);
    events = startEventSearch(database, process.env);
    freebets = startFreebetAlerts(database, process.env);
  } catch (error) {
    await integrations.stop();
    await monthlyUnits.stop();
    await attachments.stop();
    await accountPurge.stop();
    await events.stop();
    await freebets.stop();
    await reports?.stop();
    await boss?.stop({ graceful: false });
    await database.close();
    telemetry.captureError(error, { stage: 'startup' });
    throw new Error('WORKER_START_FAILED', { cause: error });
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && request.url === '/budget') {
          const status = budget ? await budget.read() : 'disabled';
          response
            .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ status }));
          return;
        }
        await database.check();
        integrations.check();
        monthlyUnits.check();
        attachments.check();
        events.check();
        freebets.check();
        reports?.check();
        if (!(await boss.getQueue(PROBE_QUEUE))) throw new Error('QUEUE_MISSING');
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}');
      } catch {
        response.writeHead(503).end('{"status":"unavailable"}');
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(9091, '0.0.0.0', resolve);
    });
  } catch (error) {
    await integrations.stop();
    await monthlyUnits.stop();
    await attachments.stop();
    await accountPurge.stop();
    await events.stop();
    await freebets.stop();
    await boss.stop({ graceful: false });
    await database.close();
    telemetry.captureError(error, { stage: 'startup' });
    throw new Error('WORKER_START_FAILED', { cause: error });
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void integrations
      .stop()
      .then(() => monthlyUnits.stop())
      .then(() => attachments.stop())
      .then(() => accountPurge.stop())
      .then(() => events.stop())
      .then(() => freebets.stop())
      .then(() => reports?.stop())
      .then(() => boss.stop({ graceful: true, timeout: 10_000 }))
      .finally(async () => {
        await telemetry.shutdown();
        await database.close();
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.info('WORKER_READY');
}

void main().catch(() => {
  console.error('WORKER_START_FAILED: verify runtime configuration');
  process.exitCode = 1;
});
