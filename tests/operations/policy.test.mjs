import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nextBackupAt,
  backupHealth,
  restoreTestHealth,
  syncHealth,
  integrityHealth,
  readOpsConfig,
} from '../../apps/ops/src/config.mjs';
import { validateMetadata } from '../../apps/ops/src/bundle.mjs';
import { snapshots, restic } from '../../apps/ops/src/backup.mjs';
import { replicate, retentionForgetArgs } from '../../apps/ops/src/replicate.mjs';
import { restoreDiskReady } from '../../scripts/deployment/restore-capacity.mjs';

test('reserves host disk capacity before restore and aborts before exhausting it', () => {
  const disk = (free, total) => ({
    bavail: BigInt(free),
    blocks: BigInt(total),
    bsize: 1024n ** 3n,
  });
  assert.equal(restoreDiskReady(disk(12, 50), true), true);
  assert.equal(restoreDiskReady(disk(9, 50), true), false);
  assert.equal(restoreDiskReady(disk(12, 100), true), false);
  assert.equal(restoreDiskReady(disk(6, 50)), true);
  assert.equal(restoreDiskReady(disk(4, 50)), false);
  assert.equal(restoreDiskReady(disk(6, 100)), false);
  assert.equal(restoreDiskReady(disk(0, 0)), false);
});

test('requires a successful monthly restore including cleanup and flags overdue evidence', () => {
  const now = Date.parse('2026-09-07T12:12:00Z');
  const status = {
    version: 1,
    status: 'passed',
    cleanup: 'passed',
    completedAt: new Date(now).toISOString(),
  };
  assert.equal(restoreTestHealth(status, now), 'ready');
  assert.equal(restoreTestHealth(status, now + 32 * 86400_000), 'warning');
  assert.equal(restoreTestHealth(status, now + 35 * 86400_000), 'failed');
  for (const change of [
    { status: 'failed' },
    { cleanup: 'failed' },
    { completedAt: new Date(now + 120000).toISOString() },
  ])
    assert.equal(restoreTestHealth({ ...status, ...change }, now), 'failed');
  assert.equal(restoreTestHealth(undefined, now), 'failed');
});

test('read-only recovery refuses repository mutations before invoking restic', () => {
  const command = restic({ readOnly: true });
  for (const action of ['init', 'backup', 'forget', 'prune', 'rewrite', 'tag', 'unlock'])
    assert.throws(() => command([action]), /OPS_READ_ONLY_REPOSITORY/);
});

test('aligns backups to 30 minutes and measures RPO from the snapshot cutoff', () => {
  const now = Date.parse('2026-09-07T12:12:00Z');
  assert.equal(nextBackupAt(now), Date.parse('2026-09-07T12:30:00Z'));
  assert.equal(nextBackupAt(nextBackupAt(now)), Date.parse('2026-09-07T13:00:00Z'));
  const status = {
    state: 'ready',
    cutoff: new Date(now - 3600001).toISOString(),
    completedAt: new Date(now).toISOString(),
    retention: true,
  };
  assert.equal(backupHealth(status, now).backup, 'overdue');
  assert.equal(
    backupHealth({ ...status, cutoff: new Date(now - 1800000).toISOString() }, now).backup,
    'ready',
  );
  assert.equal(
    backupHealth({ ...status, cutoff: new Date(now + 120000).toISOString() }, now).backup,
    'overdue',
  );
  assert.equal(backupHealth({}, now).retention, 'failed');
});

test('refuses traversal, unexpected object names, duplicate metadata and oversized bytes', () => {
  const id = randomUUID();
  const row = {
    id,
    sha256: 'a'.repeat(64),
    size: 10,
    state: 'local',
    mime: 'image/png',
    object_key: `tickets/${id}`,
    expired: false,
    created_at: '2026-09-07T12:00:00Z',
    updated_at: '2026-09-07T12:00:00Z',
  };
  assert.equal(validateMetadata([row]).length, 1);
  for (const change of [
    { id: '../secret' },
    { object_key: '/private' },
    { size: 8388609 },
    { image: 'private-payload' },
    { created_at: 'unknown' },
  ])
    assert.throws(() => validateMetadata([{ ...row, ...change }]));
  assert.throws(() => validateMetadata([row, row]));
});

test('combines complete-cycle filters as AND and refuses unrelated snapshots', async () => {
  const command = async (args) => {
    assert.deepEqual(args, [
      'snapshots',
      '--json',
      '--host',
      'stakeframe-production',
      '--tag',
      'stakeframe-bundle-v1,complete,cycle-fixture',
    ]);
    return { stdout: '[]' };
  };
  assert.deepEqual(await snapshots(command, { cycle: 'cycle-fixture' }), []);
  await assert.rejects(
    snapshots(async () => ({
      stdout: JSON.stringify([
        {
          id: 'a'.repeat(64),
          hostname: 'other-service',
          paths: ['/private'],
          tags: ['stakeframe-bundle-v1', 'complete'],
        },
      ]),
    })),
  );
});

test('converges retention on both destinations after every sync (14/8/12, incomplete 48h)', () => {
  assert.deepEqual(retentionForgetArgs(true), [
    'forget',
    '--host',
    'stakeframe-production',
    '--tag',
    'stakeframe-bundle-v1,complete',
    '--group-by',
    'host,paths',
    '--keep-daily',
    '14',
    '--keep-weekly',
    '8',
    '--keep-monthly',
    '12',
    '--prune',
  ]);
  assert.deepEqual(retentionForgetArgs(false), [
    'forget',
    '--host',
    'stakeframe-production',
    '--tag',
    'stakeframe-bundle-v1,incomplete',
    '--group-by',
    'host,paths',
    '--keep-within',
    '48h',
  ]);
});

test('mirrors through restic copy, keeps both destinations retained, and measures dedup', async () => {
  const calls = [];
  const execute = async (binary, args, options) => {
    assert.equal(binary, 'restic');
    calls.push({ args, env: options.env });
    if (args.includes('stats')) {
      const mode = args[args.indexOf('--mode') + 1];
      return {
        stdout:
          mode === 'raw-data'
            ? JSON.stringify({ total_size: 100, total_blob_count: 5 })
            : JSON.stringify({ total_size: 350, total_file_count: 12 }),
      };
    }
    return { stdout: '{}' };
  };
  const primary = `s3:https://${'0'.repeat(32)}.r2.cloudflarestorage.com/backup-bucket/stakeframe-v1`;
  const password = 'a'.repeat(64);
  const config = {
    rehearsal: false,
    readOnly: false,
    resticEnv: {
      RESTIC_REPOSITORY: primary,
      RESTIC_PASSWORD: password,
      AWS_ACCESS_KEY_ID: 'b'.repeat(32),
      AWS_SECRET_ACCESS_KEY: 'c'.repeat(64),
    },
    b2: {
      repository: 'b2:stakeframe-backup:stakeframe-v1',
      env: { B2_ACCOUNT_ID: 'd'.repeat(24), B2_ACCOUNT_KEY: 'e'.repeat(24) },
    },
  };
  const saved = [];
  const status = await replicate(config, undefined, {
    run: execute,
    readStatus: async () => null,
    saveStatus: async (value) => {
      saved.push(value);
    },
  });
  // The copy reads from the primary repository and writes to the second provider.
  assert.deepEqual(calls[0].args, ['--no-cache', '--retry-lock', '30s', 'copy']);
  assert.equal(calls[0].env.RESTIC_FROM_REPOSITORY, primary);
  assert.equal(calls[0].env.RESTIC_FROM_PASSWORD, password);
  assert.equal(calls[0].env.RESTIC_REPOSITORY, config.b2.repository);
  assert.equal(calls[0].env.B2_ACCOUNT_ID, config.b2.env.B2_ACCOUNT_ID);
  // Retention converges on both destinations: second provider first, then primary.
  const forgets = calls.filter((call) => call.args.includes('forget'));
  assert.equal(forgets.length, 4);
  assert.deepEqual(
    forgets.map((call) => call.env.RESTIC_REPOSITORY),
    [config.b2.repository, config.b2.repository, primary, primary],
  );
  assert.ok(forgets[0].args.includes('stakeframe-bundle-v1,incomplete'));
  assert.ok(forgets[1].args.includes('stakeframe-bundle-v1,complete'));
  assert.ok(forgets[1].args.includes('--prune'));
  // Dedup is measured on the primary repository only.
  const stats = calls.filter((call) => call.args.includes('stats'));
  assert.equal(stats.length, 2);
  assert.ok(stats.every((call) => call.env.RESTIC_REPOSITORY === primary));
  // The weekly integrity check runs against both destinations with a bounded subset.
  const checks = calls.filter((call) => call.args.includes('check'));
  assert.equal(checks.length, 2);
  assert.deepEqual(
    checks.map((call) => call.env.RESTIC_REPOSITORY),
    [config.b2.repository, primary],
  );
  assert.ok(checks.every((call) => call.args.includes('--read-data-subset')));
  assert.equal(status.sync.state, 'ready');
  assert.equal(status.integrity.state, 'ready');
  assert.equal(status.dedup.ratio, 3.5);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dedup.ratio, 3.5);
});

test('records a failed sync without touching the last integrity evidence', async () => {
  const saved = [];
  const previous = {
    version: 1,
    sync: { state: 'ready', at: '2026-09-20T00:00:00.000Z' },
    integrity: {
      state: 'ready',
      at: '2026-09-20T00:00:00.000Z',
      attemptAt: '2026-09-20T00:00:00.000Z',
    },
    dedup: { ratio: 3.5, at: '2026-09-20T00:00:00.000Z' },
  };
  await assert.rejects(
    replicate(
      {
        rehearsal: false,
        readOnly: false,
        resticEnv: { RESTIC_REPOSITORY: 's3:primary', RESTIC_PASSWORD: 'a'.repeat(64) },
        b2: { repository: 'b2:stakeframe-backup:stakeframe-v1', env: {} },
      },
      undefined,
      {
        run: async () => {
          throw new Error('provider-unavailable');
        },
        readStatus: async () => previous,
        saveStatus: async (value) => {
          saved.push(value);
        },
      },
    ),
    /OPS_REPLICATION_FAILED/,
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sync.state, 'failed');
  assert.deepEqual(saved[0].integrity, previous.integrity);
  assert.deepEqual(saved[0].dedup, previous.dedup);
});

test('flags sync freshness and dedup anomalies without leaking repository details', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const healthy = {
    version: 1,
    sync: { state: 'ready', at: iso(now - 60_000) },
    integrity: { state: 'ready', at: iso(now - 86400_000), attemptAt: iso(now - 86400_000) },
    dedup: { ratio: 3.5, at: iso(now - 60_000) },
  };
  assert.equal(syncHealth(healthy, now), 'ready');
  assert.equal(
    syncHealth({ ...healthy, sync: { state: 'ready', at: iso(now - 5_400_000) } }, now),
    'warning',
  );
  assert.equal(
    syncHealth({ ...healthy, sync: { state: 'ready', at: iso(now - 3 * 3_600_000) } }, now),
    'failed',
  );
  assert.equal(
    syncHealth({ ...healthy, sync: { state: 'failed', at: iso(now - 60_000) } }, now),
    'failed',
  );
  assert.equal(syncHealth(null, now), 'failed');
  assert.equal(syncHealth({ ...healthy, dedup: { ratio: 1.01, at: iso(now) } }, now), 'warning');
  assert.equal(syncHealth({ ...healthy, dedup: { ratio: 1.05, at: iso(now) } }, now), 'ready');
  assert.equal(integrityHealth(healthy, now), 'ready');
  assert.equal(
    integrityHealth(
      { ...healthy, integrity: { state: 'ready', at: iso(now - 9 * 86400_000) } },
      now,
    ),
    'warning',
  );
  assert.equal(
    integrityHealth(
      { ...healthy, integrity: { state: 'ready', at: iso(now - 15 * 86400_000) } },
      now,
    ),
    'failed',
  );
  assert.equal(
    integrityHealth({ ...healthy, integrity: { state: 'failed', at: iso(now - 60_000) } }, now),
    'failed',
  );
});

test('requires file-backed deployment secrets for the second provider and refuses unknown sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stakeframe-ops-'));
  const secret = async (name, value) => writeFile(join(directory, name), `${value}\n`);
  await secret('db_password', 'a'.repeat(64));
  await secret('restic_password', 'b'.repeat(64));
  await secret('r2_backup_access_key', 'c'.repeat(32));
  await secret('r2_backup_secret_key', 'd'.repeat(64));
  const base = {
    NODE_ENV: 'production',
    STAKEFRAME_RUNTIME: 'production',
    DB_PASSWORD_FILE: join(directory, 'db_password'),
    RESTIC_PASSWORD_FILE: join(directory, 'restic_password'),
    R2_BACKUP_ACCESS_KEY_ID_FILE: join(directory, 'r2_backup_access_key'),
    R2_BACKUP_SECRET_ACCESS_KEY_FILE: join(directory, 'r2_backup_secret_key'),
    R2_BACKUP_ACCOUNT_ID: 'e'.repeat(32),
    R2_BACKUP_BUCKET: 'backup-bucket',
    B2_BACKUP_BUCKET: 'stakeframe-backup',
  };
  // Missing second-provider key files fail closed before anything runs.
  assert.throws(() => readOpsConfig(base), /SECRET_FILE_REQUIRED/);
  await secret('b2_backup_account_id', 'f'.repeat(24));
  await secret('b2_backup_application_key', 'g'.repeat(24));
  const configured = {
    ...base,
    B2_BACKUP_ACCOUNT_ID_FILE: join(directory, 'b2_backup_account_id'),
    B2_BACKUP_APPLICATION_KEY_FILE: join(directory, 'b2_backup_application_key'),
  };
  const config = readOpsConfig(configured);
  assert.equal(config.b2.repository, 'b2:stakeframe-backup:stakeframe-v1');
  assert.equal(config.b2.env.B2_ACCOUNT_ID, 'f'.repeat(24));
  assert.equal(config.restoreSource, 'r2');
  assert.equal(readOpsConfig({ ...configured, RESTORE_SOURCE: 'b2' }).restoreSource, 'b2');
  assert.throws(
    () => readOpsConfig({ ...configured, RESTORE_SOURCE: 'gcs' }),
    /OPS_RUNTIME_REFUSED/,
  );
  for (const value of ['', 'short', 'with spaces or slashes/here']) {
    assert.throws(
      () =>
        readOpsConfig({
          ...configured,
          B2_BACKUP_ACCOUNT_ID_FILE: join(directory, 'b2_backup_application_key'),
          B2_BACKUP_APPLICATION_KEY_FILE: join(directory, 'b2_backup_application_key'),
          B2_BACKUP_BUCKET: value,
        }),
      /OPS_SECOND_PROVIDER_REFUSED|SECRET_FILE_INVALID/,
      `bucket=${value}`,
    );
  }
  // Rehearsal keeps the primary repository only; recovery with an explicit
  // second-provider source is refused when it is not configured.
  const rehearsal = readOpsConfig({
    ...base,
    OPS_REHEARSAL: 'true',
    RESTIC_REPOSITORY: '/repository',
    R2_BACKUP_ACCOUNT_ID: undefined,
    R2_BACKUP_BUCKET: undefined,
    B2_BACKUP_BUCKET: undefined,
  });
  assert.equal(rehearsal.b2, null);
});
