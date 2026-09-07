import { createServer } from 'node:http';
import {
  createDatabase,
  requireDatabaseUrl,
  readDatabaseConfig,
  assertRecoveryReviewed,
} from '@stakeframe/db';
import { PROBE_QUEUE } from '@stakeframe/shared';
import { startWorker } from './worker.js';
import { startIntegrations } from './integrations.js';
import { startMonthlyUnits } from './monthly-unit.js';
import { startAttachments } from './attachments.js';
import { startEventSearch } from './event-providers.js';
import { createBudgetProbe } from './budget.js';

async function main() {
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
  let events = { stop: async () => {}, check: () => {} };
  try {
    await assertRecoveryReviewed(database);
    boss = await startWorker(connectionString);
    integrations = await startIntegrations(
      database,
      boss,
      process.env,
      fetch,
      budget?.requireBudget,
    );
    monthlyUnits = await startMonthlyUnits(database);
    attachments = startAttachments(database, process.env);
    events = startEventSearch(database, process.env);
  } catch {
    await integrations.stop();
    await monthlyUnits.stop();
    await attachments.stop();
    await events.stop();
    await boss?.stop({ graceful: false });
    await database.close();
    throw new Error('WORKER_START_FAILED');
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
  } catch {
    await integrations.stop();
    await monthlyUnits.stop();
    await attachments.stop();
    await events.stop();
    await boss.stop({ graceful: false });
    await database.close();
    throw new Error('WORKER_START_FAILED');
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
      .then(() => events.stop())
      .then(() => boss.stop({ graceful: true, timeout: 10_000 }))
      .finally(database.close)
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
