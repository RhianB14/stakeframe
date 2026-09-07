import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, statfs } from 'node:fs/promises';
import { createDatabase } from '@stakeframe/db';
import {
  readOpsConfig,
  readStatus,
  nextBackupAt,
  backupHealth,
  readRestoreTestHealth,
} from './config.mjs';
import { backup, restic } from './backup.mjs';
import { restore } from './restore.mjs';

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!['backup', 'daemon', 'init', 'restore', 'resume'].includes(command) || extra.length)
    throw new Error('OPS_COMMAND_REFUSED');
  const config = readOpsConfig(process.env);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  if (command === 'init') {
    if (process.env.BACKUP_CONFIRM !== 'initialize-encrypted-repository')
      throw new Error('OPS_CONFIRMATION_REQUIRED');
    await restic(
      config,
      AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
    )(['init', '--repository-version', '2']);
    console.info('OPS_REPOSITORY_INITIALIZED');
    return;
  }
  if (command === 'restore') {
    if (process.env.RESTORE_CONFIRM !== 'new-isolated-cluster')
      throw new Error('OPS_CONFIRMATION_REQUIRED');
    const report = await restore(
      config,
      process.env.RESTORE_SNAPSHOT,
      AbortSignal.any([controller.signal, AbortSignal.timeout(4 * 3600_000)]),
    );
    await writeFile('/status/restore.json', JSON.stringify(report) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.info('OPS_RESTORE_VERIFIED');
    return;
  }
  if (command === 'resume') {
    if (process.env.RESTORE_CONFIRM !== 'reviewed-recovery-and-telegram-backlog')
      throw new Error('OPS_CONFIRMATION_REQUIRED');
    const offset = process.env.RECOVERY_TELEGRAM_NEXT_OFFSET;
    if (!/^(0|[1-9]\d{0,15})$/.test(offset ?? '') || !Number.isSafeInteger(Number(offset)))
      throw new Error('OPS_CURSOR_REFUSED');
    const database = createDatabase(config.connectionString);
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      const quarantine = (
        await client.query(
          "select next_offset from integration.cursor where name='recovery-quarantine' for update",
        )
      ).rows[0];
      if (!quarantine || Number(quarantine.next_offset) !== 1)
        throw new Error('OPS_QUARANTINE_REQUIRED');
      await client.query(
        "insert into integration.cursor(name,next_offset) values('telegram',$1) on conflict(name) do update set next_offset=greatest(integration.cursor.next_offset,excluded.next_offset)",
        [offset],
      );
      await client.query(
        "update integration.cursor set next_offset=0 where name='recovery-quarantine'",
      );
      await client.query(
        "insert into finance.audit(type,actor,entity_id,after) values('recovery.resumed','owner','recovery-quarantine',$1)",
        [JSON.stringify({ telegramNextOffset: offset, uncertainImportsRequireManualRetry: true })],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
      await database.close();
    }
    console.info('OPS_IMPORTS_RESUMED_AFTER_REVIEW');
    return;
  }
  if (process.env.BACKUP_CONFIRM !== 'production-with-retention')
    throw new Error('OPS_CONFIRMATION_REQUIRED');
  if (command === 'backup') {
    await backup(config, process.env, controller.signal);
    console.info('OPS_BACKUP_VERIFIED');
    return;
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/health/live') {
      response.writeHead(200).end('ready');
      return;
    }
    if (request.url !== '/status') {
      response.writeHead(404).end();
      return;
    }
    void readStatus()
      .then(async (status) => {
        const fs = await statfs('/status', { bigint: true });
        const free = fs.bavail * fs.bsize;
        const percent = fs.blocks > 0n ? (fs.bavail * 100n) / fs.blocks : 0n;
        const disk =
          free < 1024n ** 3n || percent < 5n
            ? 'failed'
            : free < 5n * 1024n ** 3n || percent < 15n
              ? 'warning'
              : 'ready';
        response
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(
            JSON.stringify({
              ...backupHealth(status),
              disk,
              restoreTest: await readRestoreTestHealth(),
            }),
          );
      })
      .catch(() => response.writeHead(503).end());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(9092, '0.0.0.0', resolve);
  });
  console.info('OPS_SCHEDULER_READY');
  try {
    while (!controller.signal.aborted) {
      try {
        await backup(config, process.env, controller.signal);
        console.info('OPS_BACKUP_VERIFIED');
      } catch {
        console.warn('OPS_BACKUP_FAILED');
      }
      const wait = nextBackupAt(Date.now()) - Date.now();
      await delay(Math.max(1, wait), undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    server.close();
  }
}

void main().catch(() => {
  console.error('OPS_OPERATION_FAILED');
  process.exitCode = 1;
});
