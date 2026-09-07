import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nextBackupAt, backupHealth, restoreTestHealth } from '../../apps/ops/src/config.mjs';
import { validateMetadata } from '../../apps/ops/src/bundle.mjs';
import { snapshots, restic } from '../../apps/ops/src/backup.mjs';
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
