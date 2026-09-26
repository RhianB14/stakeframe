import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshots } from '../../apps/ops/src/backup.mjs';
import { sample, sampleReason } from '../../apps/ops/src/sample.mjs';
import { BUNDLE } from '../../apps/ops/src/config.mjs';

// STK-F1-11 BUG 5: restic does not guarantee snapshot JSON ordering (B2
// returned oldest-first, R2 newest-first); the sample must always verify the
// newest complete snapshot of each destination.
const HOST = 'stakeframe-production';
const OLDER_ID = '1'.repeat(64);
const NEWER_ID = '2'.repeat(64);
const fixture = (id, time) => ({
  id,
  time,
  hostname: HOST,
  tags: ['stakeframe-bundle-v1', 'complete'],
  paths: [BUNDLE],
});
const OLDER = fixture(OLDER_ID, '2026-09-07T10:00:00.123456789Z');
const NEWER = fixture(NEWER_ID, '2026-09-26T10:00:00.123456789Z');

test('snapshots() returns the newest snapshot first for any restic JSON order', async () => {
  const ascending = await snapshots(() =>
    Promise.resolve({ stdout: JSON.stringify([OLDER, NEWER]) }),
  );
  assert.deepEqual(
    ascending.map((snapshot) => snapshot.id),
    [NEWER_ID, OLDER_ID],
  );
  const descending = await snapshots(() =>
    Promise.resolve({ stdout: JSON.stringify([NEWER, OLDER]) }),
  );
  assert.deepEqual(
    descending.map((snapshot) => snapshot.id),
    [NEWER_ID, OLDER_ID],
  );
});

const ATTACHMENT = Buffer.from('fictional-sample-attachment-bytes');
const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  sha256: createHash('sha256').update(ATTACHMENT).digest('hex'),
  size: ATTACHMENT.length,
  state: 'local',
  mime: 'image/png',
  object_key: 'tickets/11111111-1111-4111-8111-111111111111',
  expired: false,
  created_at: '2026-09-26T09:00:00.000Z',
  updated_at: '2026-09-26T09:00:00.000Z',
};
const MANIFEST = { version: 1, cutoff: '2026-09-26T09:59:00.000Z' };
const CONFIG = {
  resticEnv: { RESTIC_REPOSITORY: 's3:https://r2.example/bucket/stakeframe-v1' },
  b2: { repository: 'b2:stakeframe-backup:stakeframe-v1', env: {} },
};

function fakeRestic({ ascending = false } = {}) {
  return async (binary, args, options = {}) => {
    assert.equal(binary, 'restic');
    if (args.includes('snapshots'))
      return { stdout: JSON.stringify(ascending ? [OLDER, NEWER] : [NEWER, OLDER]) };
    if (args.includes('dump')) {
      const [, id, path] = args.slice(args.indexOf('dump'));
      assert.equal(id, NEWER_ID, 'dump must target the newest snapshot');
      if (path === `${BUNDLE}/manifest.json`) return { stdout: JSON.stringify(MANIFEST) };
      if (path === `${BUNDLE}/attachments.json`) return { stdout: JSON.stringify([ROW]) };
      if (path === `${BUNDLE}/attachments/${ROW.id}`) {
        await writeFile(options.output, ATTACHMENT);
        return { stdout: '' };
      }
    }
    throw new Error(`unexpected restic call: ${args.join(' ')}`);
  };
}

test('sample() verifies each destination from the newest complete snapshot', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'stk-sample-'));
  try {
    // B2 order (oldest-first) for both destinations: selection must not depend on it.
    const report = await sample(CONFIG, undefined, {
      run: fakeRestic({ ascending: true }),
      workdir,
    });
    for (const id of ['r2', 'b2']) {
      assert.equal(report.sources[id].ok, true, report.sources[id].reason);
      assert.equal(report.sources[id].snapshot, NEWER_ID);
      assert.equal(report.sources[id].cutoff, MANIFEST.cutoff);
      assert.equal(report.sources[id].files, 3);
      assert.equal(report.sources[id].bytes, ATTACHMENT.length);
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('sample() reports a sanitized reason when a destination fails', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'stk-sample-'));
  try {
    const failing = async (binary, args, options = {}) => {
      const destination = options.env.RESTIC_REPOSITORY.startsWith('b2:') ? 'b2' : 'r2';
      if (args.includes('snapshots')) return { stdout: JSON.stringify([NEWER, OLDER]) };
      if (destination === 'b2') throw new Error(`raw provider failure at ${BUNDLE}/database.dump`);
      throw new Error('OPS_SAMPLE_CHECKSUM_FAILED');
    };
    const report = await sample(CONFIG, undefined, { run: failing, workdir });
    assert.equal(report.sources.r2.ok, false);
    assert.equal(report.sources.r2.reason, 'OPS_SAMPLE_CHECKSUM_FAILED');
    assert.equal(report.sources.b2.ok, false);
    assert.equal(report.sources.b2.reason, 'OPS_SAMPLE_FAILED');
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test('sampleReason() exposes known codes and collapses everything else', () => {
  assert.equal(sampleReason(new Error('OPS_SAMPLE_CHECKSUM_FAILED')), 'OPS_SAMPLE_CHECKSUM_FAILED');
  // Validation asserts (e.g. a malformed historical snapshot) stay identifiable.
  assert.equal(
    sampleReason(Object.assign(new Error('x'), { code: 'ERR_ASSERTION' })),
    'OPS_SAMPLE_VALIDATION_FAILED',
  );
  assert.equal(
    sampleReason(new Error(`raw provider output at ${BUNDLE}/database.dump`)),
    'OPS_SAMPLE_FAILED',
  );
  assert.equal(sampleReason(undefined), 'OPS_SAMPLE_FAILED');
});
