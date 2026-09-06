import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, requireDatabaseUrl } from '../../packages/db/src/index.js';
import { PROBE_QUEUE } from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { startWorker } from '../../apps/worker/src/worker.js';

// An explicit test URL is mandatory. Each run owns only its random queue schema.
const connectionString = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const schema = `stk_test_${randomUUID().replaceAll('-', '')}`;
const database = createDatabase(connectionString);
let boss: Awaited<ReturnType<typeof startWorker>> | undefined;
async function removeTestSchema() {
  if (!/^stk_test_[a-f0-9]{32}$/.test(schema)) throw new Error('INVALID_TEST_SCHEMA');
  await database.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

beforeAll(async () => {
  boss = await startWorker(connectionString, schema);
});
afterAll(async () => {
  try {
    await boss?.stop({ graceful: true, timeout: 5_000 });
  } finally {
    try {
      await removeTestSchema();
    } finally {
      await database.close();
    }
  }
});

describe('PostgreSQL and worker', () => {
  it('executes Drizzle against PostgreSQL 18 and serves real readiness', async () => {
    await database.check();
    const version = await database.pool.query<{ server_version_num: string }>(
      'SHOW server_version_num',
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(190000);
    const app = createApp({ checkDatabase: database.check });
    try {
      expect((await app.inject('/health/ready')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it('consumes a durable job and persists its result', async () => {
    if (!boss) throw new Error('WORKER_NOT_STARTED');
    const nonce = randomUUID();
    const id = await boss.send(PROBE_QUEUE, { nonce });
    expect(id).toBeTruthy();
    await expect
      .poll(async () => (await boss?.getJobById(PROBE_QUEUE, id!))?.state, { timeout: 10_000 })
      .toBe('completed');
    expect((await boss.getJobById(PROBE_QUEUE, id!))?.output).toEqual({
      nonce,
      handledBy: 'stakeframe-worker',
    });
  });
  it('retries invalid payloads within the configured limit and records failure', async () => {
    if (!boss) throw new Error('WORKER_NOT_STARTED');
    const id = await boss.send(PROBE_QUEUE, { nonce: 'invalid' });
    expect(id).toBeTruthy();
    await expect
      .poll(async () => (await boss?.getJobById(PROBE_QUEUE, id!))?.state, { timeout: 15_000 })
      .toBe('failed');
    const job = await boss.getJobById(PROBE_QUEUE, id!);
    expect(job?.retryCount).toBe(2);
    expect(job?.output).toMatchObject({ message: 'INVALID_SYSTEM_PROBE' });
  });
});
