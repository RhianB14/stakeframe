import { PgBoss } from 'pg-boss';
import { PROBE_QUEUE, probeSchema } from '@stakeframe/shared';

export async function startWorker(
  connectionString: string,
  schema = 'pgboss',
  onError?: (error: unknown) => void,
) {
  const boss = new PgBoss({ connectionString, schema, connectionTimeoutMillis: 3_000, max: 3 });
  boss.on('error', (error) => {
    console.error('QUEUE_CONNECTION_ERROR');
    onError?.(error);
  });
  try {
    await boss.start();
    await boss.createQueue(PROBE_QUEUE, {
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: 30,
      retentionSeconds: 3600,
    });
    await boss.work(PROBE_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
      const job = jobs[0];
      const result = probeSchema.safeParse(job?.data);
      if (!result.success) throw new Error('INVALID_SYSTEM_PROBE');
      return { nonce: result.data.nonce, handledBy: 'stakeframe-worker' };
    });
    return boss;
  } catch {
    await boss.stop({ graceful: false });
    throw new Error('WORKER_START_FAILED');
  }
}
