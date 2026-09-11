import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rmdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCleanupFailure,
  prepareRuntimeRoot,
  removeRuntimeRoot,
  sanitizeFailureCode,
  assertRootOwnedDirectory,
  assertRootStillSafe,
  assertSafeDirectoryMode,
  assertSameIdentity,
  RESTORE_RUNTIME_ROOT_REFUSED,
  RESTORE_INDIVIDUAL_DIRECTORY_REFUSED,
  RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  RESTORE_FAILURE_GENERIC,
} from '../../scripts/deployment/restore-runtime-root.mjs';

const project = `stk-restore-${'ab'.repeat(16)}`;
const posix = process.platform !== 'win32';
const relaxedPolicy = (info, code) => assert.ok(info.isDirectory() && !info.isSymbolicLink(), code);

// Deterministic identities above Number.MAX_SAFE_INTEGER: exactly
// representable as bigint, yet adjacent values collapse into the same Number
// (Number(M) === Number(M + 1)) — the precision loss behind the historical
// flaky. Synthetic fixtures mirror the production lstat({ bigint: true })
// shape: mode, uid and gid are bigints too.
const M = BigInt(Number.MAX_SAFE_INTEGER);
const MODE = 0o40700n;
const D1 = M + 1n;
const D2 = M + 2n;

const stat = (ino = D1, dev = 2n, mode = MODE, uid = 0n, gid = 0n) => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  mode,
  uid,
  gid,
  ino,
  dev,
});

// Deterministic divergent bigint for a real captured identity: distinct by
// construction, never produced by fragile Number arithmetic.
const divergentOf = (ino) => (ino === D2 ? D1 : D2);

async function tempBase(t) {
  const base = await mkdtemp(join(tmpdir(), 'restore-runtime-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

const repoFile = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('creates a missing runtime root with 0700 and the exclusive individual directory', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, project, policy: relaxedPolicy });
  assert.equal(prepared.createdRoot, true);
  assert.equal(prepared.directory, join(root, project));
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  if (posix) assert.equal(info.mode & 0o777, 0o700);
  const created = await lstat(prepared.directory);
  assert.ok(created.isDirectory() && !created.isSymbolicLink());
  if (posix) assert.equal(created.mode & 0o777, 0o700);
  // Mirror the runner sequence: the individual directory goes first, then the
  // root created by this run.
  await rmdir(prepared.directory);
  assert.equal(
    await removeRuntimeRoot({
      rootPath: root,
      createdRoot: prepared.createdRoot,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: relaxedPolicy,
    }),
    true,
  );
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('refuses to create the runtime root when the parent is missing (no path following)', async (t) => {
  const root = join(await tempBase(t), 'missing-parent', 'stakeframe-restore');
  await assert.rejects(
    prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
});

test('accepts a real, safe, preexisting runtime root without removing it on cleanup', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const prepared = await prepareRuntimeRoot({ rootPath: root, project, policy: relaxedPolicy });
  assert.equal(prepared.createdRoot, false);
  assert.equal(
    await removeRuntimeRoot({ rootPath: root, createdRoot: prepared.createdRoot }),
    false,
  );
  assert.ok((await lstat(root)).isDirectory());
});

test('refuses a symlink at the runtime root', async (t) => {
  const base = await tempBase(t);
  const target = join(base, 'elsewhere');
  const root = join(base, 'stakeframe-restore');
  await mkdir(target, { recursive: true });
  try {
    await symlink(target, root, 'dir');
  } catch {
    return t.skip('symlink creation unavailable on this platform');
  }
  await assert.rejects(
    prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
});

test('refuses a file placed at the runtime root path', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  await writeFile(root, 'not a directory', { flag: 'wx' });
  await assert.rejects(
    prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
});

test('refuses an insecure runtime root mode', { skip: !posix }, async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  // Production mode enforcement against the real filesystem; identity stays
  // neutralized because the test cannot run as root (mode is what is under
  // test). The stat from prepareRuntimeRoot is already bigint-shaped.
  await assert.rejects(
    prepareRuntimeRoot({
      rootPath: root,
      policy: (info, code) => assertRootOwnedDirectory({ ...info, uid: 0n, gid: 0n }, code),
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
});

test('root:root 0700 policy rejects divergent owner, group, mode and type deterministically', () => {
  const safe = stat();
  assert.doesNotThrow(() => assertRootOwnedDirectory(safe, RESTORE_RUNTIME_ROOT_REFUSED));
  const divergent = [
    stat(D1, 2n, MODE, 1000n),
    stat(D1, 2n, MODE, 0n, 1000n),
    stat(D1, 2n, 0o40755n),
    stat(D1, 2n, 0o41700n),
    { ...stat(), isSymbolicLink: () => true },
    { ...stat(), isDirectory: () => false },
  ];
  for (const info of divergent)
    assert.throws(
      () => assertRootOwnedDirectory(info, RESTORE_RUNTIME_ROOT_REFUSED),
      (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
    );
});

test('refuses a preexisting individual directory', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(join(root, project), { recursive: true });
  await assert.rejects(
    prepareRuntimeRoot({ rootPath: root, project, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_INDIVIDUAL_DIRECTORY_REFUSED,
  );
});

test('cleanup removes the runtime root created by this run once empty', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
  assert.equal(prepared.createdRoot, true);
  assert.equal(
    await removeRuntimeRoot({
      rootPath: root,
      createdRoot: prepared.createdRoot,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: relaxedPolicy,
    }),
    true,
  );
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('cleanup preserves a preexisting runtime root', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assert.equal(await removeRuntimeRoot({ rootPath: root, createdRoot: false }), false);
  assert.ok((await lstat(root)).isDirectory());
});

test('cleanup refuses a divergent identity and keeps the root', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Divergence must come from an exact, deterministic bigint — never from
  // ino + 1, which collapses under Number precision for large NTFS file IDs.
  const real = await lstat(root, { bigint: true });
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: true,
      ino: divergentOf(real.ino),
      dev: real.dev,
      policy: relaxedPolicy,
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.ok((await lstat(root)).isDirectory());
});

test('cleanup refuses a non-empty runtime root and keeps the root', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
  await writeFile(join(root, 'leftover'), 'x', { flag: 'wx' });
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: prepared.createdRoot,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: relaxedPolicy,
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.ok((await lstat(root)).isDirectory());
});

test('cleanup without the captured ino or dev refuses before touching the filesystem', async () => {
  const rootPath = join('restore-runtime-root-untouched', 'stakeframe-restore');
  for (const identity of [{ dev: 2n }, { ino: 1n }, {}])
    await assert.rejects(
      removeRuntimeRoot({ rootPath, createdRoot: true, ...identity }),
      (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    );
});

test('assertSameIdentity anchors every revalidation read to the captured object', () => {
  const identity = { ino: 11n, dev: 22n };
  assert.doesNotThrow(() =>
    assertSameIdentity({ ino: 11n, dev: 22n }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
  );
  assert.throws(
    () => assertSameIdentity({ ino: 12n, dev: 22n }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.throws(
    () => assertSameIdentity({ ino: 11n, dev: 23n }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
});

// Incompatible representations are never the same identity, even when a lossy
// Number conversion would collide: the bigint production values reject numeric
// fixtures instead of silently comparing across types.
test('assertSameIdentity refuses mixed numeric and bigint representations', () => {
  const identity = { ino: 11n, dev: 22n };
  assert.throws(
    () => assertSameIdentity({ ino: 11, dev: 22 }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.throws(
    () => assertSameIdentity(identity, { ino: 11, dev: 22 }, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
});

// Deterministic proof of the fixed mechanism: two distinct bigint IDs above
// Number.MAX_SAFE_INTEGER stay distinct in the bigint production path, while
// the same values converted to Number collapse into one — which is exactly the
// precision loss that made the historical identity test accept a divergent
// object on NTFS.
test('bigint identity refuses distinct IDs above Number.MAX_SAFE_INTEGER even when Number collapses them', () => {
  const identity = { ino: D1, dev: 22n };
  const adjacent = { ino: D2, dev: 22n };
  // The collapse that produced the historical flaky, proven on the Number path:
  assert.equal(Number(D1), Number(D2));
  assert.notEqual(D1, D2);
  assert.doesNotThrow(() =>
    assertSameIdentity({ ino: D1, dev: 22n }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
  );
  assert.throws(
    () => assertSameIdentity(adjacent, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.throws(
    () => assertSameIdentity({ ino: D1, dev: 23n }, identity, RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
});

test('assertRootStillSafe runs the production order: shape, policy, realpath, identity', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const calls = [];
  const trackingPolicy = (info, code) => {
    calls.push('policy');
    relaxedPolicy(info, code);
  };
  const info = await lstat(root, { bigint: true });
  await assertRootStillSafe(
    root,
    info,
    { ino: info.ino, dev: info.dev },
    trackingPolicy,
    RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.deepEqual(calls, ['policy']);
  // Identity anchored: a same-shape object with a deterministic, exactly
  // representable divergent ino is refused.
  await assert.rejects(
    assertRootStillSafe(
      root,
      info,
      { ino: divergentOf(info.ino), dev: info.dev },
      trackingPolicy,
      RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    ),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  // A symlink-shaped object is refused before the policy ever runs.
  calls.length = 0;
  await assert.rejects(
    assertRootStillSafe(
      root,
      { isDirectory: () => true, isSymbolicLink: () => true, ino: info.ino, dev: info.dev },
      { ino: info.ino, dev: info.dev },
      trackingPolicy,
      RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    ),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.deepEqual(calls, []);
});

// Deterministic proof that the final pre-rmdir read runs the FULL validation
// (shape, policy, realpath, identity), not only the identity check: the policy
// accepts the first read and refuses the second — the read between the
// emptiness check and rmdir. Owner, mode, type or realpath drift in that
// window is therefore refused; the categories are covered by the synthetic
// matrix below and the redirected-path test.
test('final pre-rmdir read runs the full validation and refuses late drift', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
  let calls = 0;
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: true,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: async (info, code) => {
        calls += 1;
        if (calls === 2) throw new Error(code); // final read: state drifted
        relaxedPolicy(info, code);
      },
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.equal(calls, 2);
  const kept = await lstat(root, { bigint: true });
  assert.ok(kept.isDirectory());
  assert.equal(kept.ino, prepared.ino);
});

// Owner, mode, group and type drift observed on any revalidation read is
// refused by the same helper the final read uses (synthetic stats, no race).
for (const [label, info, policy] of [
  ['mode drift', stat(D1, 2n, 0o40600n), (info, code) => assertSafeDirectoryMode(info, code)],
  ['owner drift', stat(D1, 2n, MODE, 1000n), assertRootOwnedDirectory],
  ['group drift', stat(D1, 2n, MODE, 0n, 1000n), assertRootOwnedDirectory],
  ['type drift', { ...stat(), isDirectory: () => false }, assertRootOwnedDirectory],
]) {
  test(`revalidation refuses ${label}`, async () => {
    // A real existing path so the realpath step itself cannot be the reason:
    // the synthetic stat is what must be refused by the policy category.
    // The identity matches, so only the policy category can refuse here.
    const existing = await realpath(tmpdir());
    await assert.rejects(
      assertRootStillSafe(
        existing,
        info,
        { ino: D1, dev: 2n },
        policy,
        RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
      ),
      (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    );
  });
}

test('revalidation accepts the unchanged safe stat', async () => {
  const existing = await realpath(tmpdir());
  await assert.doesNotReject(
    assertRootStillSafe(
      existing,
      stat(),
      { ino: D1, dev: 2n },
      assertRootOwnedDirectory,
      RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    ),
  );
});

test('cleanup refuses a redirected path and keeps the target intact', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
  await rmdir(root);
  const real = join(base, 'stakeframe-restore-real');
  await mkdir(real, { mode: 0o700 });
  try {
    await symlink(real, root, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return t.skip('symlink/junction creation unavailable on this platform');
  }
  const fresh = await lstat(root, { bigint: true });
  if (!fresh.isSymbolicLink()) return t.skip('junction not reported as a symlink');
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: true,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: relaxedPolicy,
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.ok((await lstat(real)).isDirectory());
});

test(
  'final pre-rmdir revalidation refuses owner drift and keeps the root',
  { skip: !posix },
  async (t) => {
    const root = join(await tempBase(t), 'stakeframe-restore');
    const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
    // Probe the privilege with a round trip first: without it the drift
    // cannot be produced and the test must skip instead of passing vacuously.
    // This read stays a Number because chown itself requires Numbers; it is
    // not an identity anchor.
    const original = await lstat(root);
    try {
      await chown(root, 65534, 65534);
      await chown(root, original.uid, original.gid);
    } catch {
      return t.skip('chown unavailable without privileges');
    }
    let calls = 0;
    const ownerPolicy = async (info, code) => {
      calls += 1;
      if (calls === 1) return relaxedPolicy(info, code);
      // The drift happens inside the cleanup window, between the first read
      // and the final read — the real chown is injected at the second policy
      // call, so the divergence only exists for the pre-rmdir validation.
      // The drift check reads bigint so the comparison against the bigint
      // stat of the anchored read stays exact, never cross-type.
      await chown(root, 65534, 65534);
      const drifted = await lstat(root, { bigint: true });
      if (drifted.uid === info.uid && drifted.gid === info.gid) return relaxedPolicy(info, code); // chown silently ineffective
      throw new Error(code);
    };
    await assert.rejects(
      removeRuntimeRoot({
        rootPath: root,
        createdRoot: true,
        ino: prepared.ino,
        dev: prepared.dev,
        policy: ownerPolicy,
      }),
      (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    );
    assert.equal(calls, 2);
    assert.ok((await lstat(root)).isDirectory());
  },
);

test('cleanup refuses a replaced directory whose later read diverges', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  const prepared = await prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy });
  await rmdir(root);
  await mkdir(root, { mode: 0o700 });
  const fresh = await lstat(root, { bigint: true });
  if (fresh.ino === prepared.ino && fresh.dev === prepared.dev) return;
  // The replacement got a different object identity: cleanup must refuse and
  // keep whatever object now sits at the path.
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: true,
      ino: prepared.ino,
      dev: prepared.dev,
      policy: relaxedPolicy,
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.ok((await lstat(root)).isDirectory());
});

// The rollback of a just-created root whose validation failed uses the exact
// bigint identity captured right after creation: the directory disappears only
// when the rollback reads prove the same object (shape, emptiness and the
// captured dev/ino). A collapsed or wrong identity would keep the root and
// fail this test, so it proves the rollback path runs on exact identity too.
test('a freshly created root failing validation is rolled back without traces', async (t) => {
  const root = join(await tempBase(t), 'stakeframe-restore');
  await assert.rejects(
    prepareRuntimeRoot({
      rootPath: root,
      policy: () => {
        throw new Error(RESTORE_RUNTIME_ROOT_REFUSED);
      },
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

// Deterministic e2e refusal with an exactly representable divergent identity
// above Number.MAX_SAFE_INTEGER — the same magnitude class NTFS issues, whose
// adjacent values Number arithmetic cannot separate.
test('cleanup refuses an exact divergent identity above Number.MAX_SAFE_INTEGER and keeps the root', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const real = await lstat(root, { bigint: true });
  await assert.rejects(
    removeRuntimeRoot({
      rootPath: root,
      createdRoot: true,
      ino: divergentOf(real.ino),
      dev: real.dev,
      policy: relaxedPolicy,
    }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  const kept = await lstat(root, { bigint: true });
  assert.ok(kept.isDirectory());
  assert.equal(kept.ino, real.ino);
});

test('cleanup failure composes its own sanitized code without overwriting the main one', () => {
  const failed = applyCleanupFailure(
    { version: 1, status: 'failed', failureCode: RESTORE_RUNTIME_ROOT_REFUSED },
    new Error('RECOVERY_COMMAND_FAILED'),
  );
  assert.equal(failed.failureCode, RESTORE_RUNTIME_ROOT_REFUSED);
  assert.equal(failed.cleanupFailureCode, 'RECOVERY_COMMAND_FAILED');
  assert.equal(failed.cleanup, 'failed');
  assert.equal(failed.status, 'failed');

  const flipped = applyCleanupFailure(
    { version: 1, status: 'passed', cleanup: 'passed' },
    new Error(`secret leak /private/path ${'a'.repeat(64)}`),
  );
  assert.equal(flipped.status, 'failed');
  assert.equal(flipped.cleanup, 'failed');
  assert.equal(flipped.cleanupFailureCode, RESTORE_FAILURE_GENERIC);
  assert.ok(!JSON.stringify(flipped).includes('/private/path'));
  assert.ok(!JSON.stringify(flipped).includes('secret leak'));
});

test('only allowlisted failure codes reach the report', () => {
  assert.equal(
    sanitizeFailureCode(new Error(RESTORE_RUNTIME_ROOT_REFUSED)),
    RESTORE_RUNTIME_ROOT_REFUSED,
  );
  assert.equal(
    sanitizeFailureCode(new Error(RESTORE_INDIVIDUAL_DIRECTORY_REFUSED)),
    RESTORE_INDIVIDUAL_DIRECTORY_REFUSED,
  );
  assert.equal(
    sanitizeFailureCode(new Error(RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED)),
    RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  assert.equal(
    sanitizeFailureCode(new Error('RECOVERY_COMMAND_FAILED')),
    'RECOVERY_COMMAND_FAILED',
  );
  assert.equal(sanitizeFailureCode(new Error('RECOVERY_BOGUS')), RESTORE_FAILURE_GENERIC);
  assert.equal(
    sanitizeFailureCode(new Error('ENOENT: no such file or directory')),
    RESTORE_FAILURE_GENERIC,
  );
  assert.equal(sanitizeFailureCode('RESTORE_RUNTIME_ROOT_REFUSED'), RESTORE_FAILURE_GENERIC);
  assert.equal(sanitizeFailureCode(undefined), RESTORE_FAILURE_GENERIC);
});

test('unexpected exceptions map to the generic code without leaking their message', () => {
  const leak = new Error(`boom at /secret/path token ${'a'.repeat(64)}`);
  const code = sanitizeFailureCode(leak);
  assert.equal(code, RESTORE_FAILURE_GENERIC);
  assert.ok(!code.includes('/secret/path'));
  assert.ok(!code.includes('boom'));
});

test('the documented manual command includes DOCKER_CONFIG=/etc/stakeframe/docker', async () => {
  for (const doc of ['../../docs/OPERATIONS.md', '../../docs/M0-26-PREFLIGHT.md']) {
    const content = await repoFile(doc);
    assert.match(content, /RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery/);
    assert.match(content, /DOCKER_CONFIG=\/etc\/stakeframe\/docker/);
    assert.match(content, /\/opt\/stakeframe\/scripts\/restore-rehearsal\.mjs/);
    assert.match(content, /\/etc\/stakeframe\/deployment\.env/);
  }
});

test('service and manual command keep RESTORE_REHEARSAL_CONFIRM and DOCKER_CONFIG aligned', async () => {
  const service = await repoFile('../../infra/production/stakeframe-restore.service');
  const confirm = service.match(/^Environment=RESTORE_REHEARSAL_CONFIRM=(.+)$/m)?.[1];
  const dockerConfig = service.match(/^Environment=DOCKER_CONFIG=(.+)$/m)?.[1];
  assert.equal(confirm, 'monthly-isolated-recovery');
  assert.equal(dockerConfig, '/etc/stakeframe/docker');
  for (const doc of ['../../docs/OPERATIONS.md', '../../docs/M0-26-PREFLIGHT.md']) {
    const content = await repoFile(doc);
    assert.match(content, new RegExp(`RESTORE_REHEARSAL_CONFIRM=${confirm}`));
    assert.match(content, new RegExp(`DOCKER_CONFIG=${dockerConfig.replaceAll('/', '\\/')}`));
  }
  assert.match(service, /^RuntimeDirectory=stakeframe-restore$/m);
});
