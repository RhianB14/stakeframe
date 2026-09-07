import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, rename } from 'node:fs/promises';
import { createDatabase, createR2Storage, claimExpiredAttachmentsForBackup } from '@stakeframe/db';
import { run } from './process.mjs';
import {
  BACKUP_HOST,
  BACKUP_TAG,
  BUNDLE,
  MAX_BUNDLE_BYTES,
  MAX_DUMP_BYTES,
  MAX_METADATA_BYTES,
  CYCLE_TIMEOUT_MS,
  SHA,
  readStatus,
} from './config.mjs';
import {
  prepareBundle,
  clearBundle,
  hashFile,
  writeJson,
  writeImage,
  tableCounts,
  financialIntegrity,
  roles,
  attachmentMetadata,
  validateMetadata,
} from './bundle.mjs';

export function restic(config, signal) {
  return (args, options = {}) => {
    if (config.readOnly && !['snapshots', 'dump', 'check'].includes(args[0]))
      throw new Error('OPS_READ_ONLY_REPOSITORY');
    return run(
      'restic',
      ['--no-cache', ...(config.readOnly ? ['--no-lock'] : ['--retry-lock', '30s']), ...args],
      {
        env: config.resticEnv,
        signal,
        ...options,
      },
    );
  };
}

export async function snapshots(command, { complete = true, cycle } = {}) {
  const tags = [BACKUP_TAG, ...(complete ? ['complete'] : []), ...(cycle ? [cycle] : [])].join(',');
  const args = ['snapshots', '--json', '--host', BACKUP_HOST, '--tag', tags];
  const all = JSON.parse((await command(args)).stdout);
  assert.ok(Array.isArray(all) && all.length <= 5000);
  for (const snapshot of all) {
    assert.ok(
      SHA.test(snapshot.id) &&
        snapshot.hostname === BACKUP_HOST &&
        snapshot.tags.includes(BACKUP_TAG),
    );
    assert.deepEqual(snapshot.paths, [BUNDLE]);
    if (complete) assert.ok(snapshot.tags.includes('complete'));
    if (cycle) assert.ok(snapshot.tags.includes(cycle));
    assert.ok(Number.isFinite(Date.parse(snapshot.time)));
  }
  return all.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export async function saveStatus(status) {
  // Dedicated volume contains operational timestamps and hashes, never credentials.
  const temporary = `/status/backup-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(status) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, '/status/backup.json');
}

export async function expireRecoveryCopies(command, rows) {
  const ids = rows.filter((row) => row.expired).map((row) => row.id);
  if (ids.length) {
    // Images are separate restic files; neither dump nor metadata contains bytes.
    // Rewriting every retained snapshot removes expired copies from old cycles too.
    const excludes = `/work/exclude-${randomUUID()}.txt`;
    const { unlink } = await import('node:fs/promises');
    try {
      await writeFile(excludes, ids.map((id) => `${BUNDLE}/attachments/${id}`).join('\n') + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await command([
        'rewrite',
        '--host',
        BACKUP_HOST,
        '--tag',
        BACKUP_TAG,
        '--exclude-file',
        excludes,
        '--forget',
      ]);
    } finally {
      await unlink(excludes);
    }
  }
  await command([
    'forget',
    '--host',
    BACKUP_HOST,
    '--tag',
    `${BACKUP_TAG},complete`,
    '--group-by',
    'host,paths',
    '--keep-last',
    '1',
    '--keep-within',
    '48h',
    '--keep-within-daily',
    '30d',
  ]);
  await command([
    'forget',
    '--host',
    BACKUP_HOST,
    '--tag',
    `${BACKUP_TAG},incomplete`,
    '--group-by',
    'host,paths',
    '--keep-within',
    '48h',
  ]);
  // Explicit zero tolerance for unused packs also purges expired payload bytes.
  await command(['prune', '--max-unused', '0']);
}

export async function backup(config, env, parentSignal, dependencies = {}) {
  if (config.readOnly) throw new Error('OPS_READ_ONLY_REPOSITORY');
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(CYCLE_TIMEOUT_MS),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  const database = createDatabase(config.connectionString, { statementTimeoutMs: 30_000 });
  const client = database.createMigrationClient();
  client.on('error', () => controller.abort());
  const command = restic(config, signal);
  const previous = await readStatus();
  let acquired = false;
  let status = { ...previous, version: 1, state: 'running', startedAt: new Date().toISOString() };
  const disconnect = () => {
    void client.end().catch(() => {});
  };
  signal.addEventListener('abort', disconnect, { once: true });
  try {
    await client.connect();
    const lock = (await client.query('select pg_try_advisory_lock(782341097) as locked')).rows[0]
      .locked;
    if (!lock) return { skipped: true };
    acquired = true;
    await saveStatus(status);
    // Do not initialize a missing/mistyped repository from the scheduler.
    await command(['cat', 'config']);
    // Share the worker's upload/deletion exclusion and claim expiry atomically
    // before snapshotting, preventing reuse of an ID whose recovery copies expire.
    await client.query('select pg_advisory_lock(782341095)');
    await claimExpiredAttachmentsForBackup(client);
    await client.query('begin isolation level repeatable read read only');
    const snapshot = (
      await client.query(
        "select pg_export_snapshot() as id,now() as cutoff,current_setting('server_version_num') as version",
      )
    ).rows[0];
    assert.match(snapshot.id, /^[A-Fa-f0-9-]{8,80}$/);
    assert.ok(Number(snapshot.version) >= 180000 && Number(snapshot.version) < 190000);
    assert.equal(
      (
        await client.query(
          'select count(*)::text as count from integration.inbox where image is not null',
        )
      ).rows[0].count,
      '0',
    );
    const rows = validateMetadata(await attachmentMetadata(client));
    const totalImages = rows
      .filter((row) => !row.expired)
      .reduce((total, row) => total + row.size, 0);
    assert.ok(
      totalImages + MAX_DUMP_BYTES + 2 * MAX_METADATA_BYTES < MAX_BUNDLE_BYTES,
      'OPS_STAGING_CAPACITY',
    );
    await prepareBundle();
    const manifest = {
      version: 1,
      cycle: randomUUID(),
      cutoff: snapshot.cutoff.toISOString(),
      serverVersion: snapshot.version,
      counts: await tableCounts(client),
      finance: await financialIntegrity(client),
      rolesSha256: await writeJson('roles.json', await roles(client)),
      attachmentsSha256: await writeJson('attachments.json', rows),
      imageCount: rows.filter((row) => !row.expired).length,
      imageBytes: totalImages,
    };
    await run(
      'pg_dump',
      [
        '--no-password',
        '--format=custom',
        '--compress=zstd:3',
        '--lock-wait-timeout=5s',
        '--exclude-table-data=integration.attachment',
        `--snapshot=${snapshot.id}`,
      ],
      {
        env: config.pgEnv,
        signal,
        output: join(BUNDLE, 'database.dump'),
        maxBytes: MAX_DUMP_BYTES,
      },
    );
    await run('pg_restore', ['--list', join(BUNDLE, 'database.dump')], {
      env: config.pgEnv,
      signal,
    });
    manifest.databaseSha256 = await hashFile(join(BUNDLE, 'database.dump'));
    const storage = dependencies.storage ?? createR2Storage(env);
    for (const row of rows) {
      signal.throwIfAborted();
      if (row.expired) continue;
      const local = (
        await client.query('select image from integration.attachment where id=$1', [row.id])
      ).rows[0]?.image;
      const image = local ?? (storage ? await storage.get(row.object_key) : undefined);
      assert.ok(image && image.length === row.size, 'OPS_ATTACHMENT_UNAVAILABLE');
      await writeImage(row.id, image, row.sha256, row.created_at);
    }
    await client.query('commit');
    await client.query('select pg_advisory_unlock(782341095)');
    await writeJson('manifest.json', manifest);
    const cycle = `cycle-${manifest.cycle}`;
    const result = await command([
      'backup',
      '--json',
      '--host',
      BACKUP_HOST,
      '--tag',
      BACKUP_TAG,
      '--tag',
      'incomplete',
      '--tag',
      cycle,
      BUNDLE,
    ]);
    const summary = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((line) => line.message_type === 'summary');
    assert.ok(SHA.test(summary?.snapshot_id ?? ''), 'OPS_SNAPSHOT_MISSING');
    await command(['tag', '--remove', 'incomplete', '--add', 'complete', summary.snapshot_id]);
    const completed = await snapshots(command, { cycle });
    assert.equal(completed.length, 1);
    status = {
      version: 1,
      state: 'ready',
      cutoff: manifest.cutoff,
      completedAt: new Date().toISOString(),
      snapshot: completed[0].id,
      imageCount: manifest.imageCount,
      imageBytes: totalImages,
      retention: false,
    };
    await saveStatus(status);
    await expireRecoveryCopies(command, rows);
    const retained = await snapshots(command, { cycle });
    assert.equal(retained.length, 1);
    status.snapshot = retained[0].id;
    status.retention = true;
    await saveStatus(status);
    return status;
  } catch (cause) {
    if (acquired)
      await saveStatus({ ...status, state: 'failed', failedAt: new Date().toISOString() });
    throw new Error('OPS_BACKUP_FAILED', { cause });
  } finally {
    signal.removeEventListener('abort', disconnect);
    await client.end().catch(() => {});
    await database.close();
    if (acquired) await clearBundle();
  }
}

export async function readSnapshotMetadata(command, snapshot) {
  assert.ok(SHA.test(snapshot.id));
  const source = (
    await command(['dump', snapshot.id, `${BUNDLE}/attachments.json`], {
      maxBytes: MAX_METADATA_BYTES,
    })
  ).stdout;
  const rows = validateMetadata(JSON.parse(source));
  return rows;
}
