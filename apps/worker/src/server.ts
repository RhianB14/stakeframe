import { createServer } from 'node:http';
import { createDatabase, requireDatabaseUrl } from '@stakeframe/db';
import { PROBE_QUEUE } from '@stakeframe/shared';
import { startWorker } from './worker.js';

async function main() {
  if (process.env.STAKEFRAME_RUNTIME !== 'local') throw new Error('LOCAL_RUNTIME_REQUIRED');
  const connectionString = requireDatabaseUrl(process.env.DATABASE_URL);
  const database = createDatabase(connectionString);
  let boss;
  try {
    boss = await startWorker(connectionString);
  } catch {
    await database.close();
    throw new Error('WORKER_START_FAILED');
  }
  const server = createServer((_request, response) => {
    void (async () => {
      try {
        await database.check();
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
    await boss.stop({ graceful: false });
    await database.close();
    throw new Error('WORKER_START_FAILED');
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void boss
      .stop({ graceful: true, timeout: 10_000 })
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
  console.error('WORKER_START_FAILED: verify local configuration');
  process.exitCode = 1;
});
