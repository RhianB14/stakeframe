import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rmdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareRuntimeRoot,
  removeRuntimeRoot,
  sanitizeFailureCode,
  assertRootOwnedDirectory,
  RESTORE_RUNTIME_ROOT_REFUSED,
  RESTORE_INDIVIDUAL_DIRECTORY_REFUSED,
  RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  RESTORE_FAILURE_GENERIC,
} from '../../scripts/deployment/restore-runtime-root.mjs';

const project = `stk-restore-${'ab'.repeat(16)}`;
const posix = process.platform !== 'win32';
const relaxedPolicy = (info, code) => assert.ok(info.isDirectory() && !info.isSymbolicLink(), code);

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
    t.skip('symlink creation unavailable on this platform');
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
  await assert.rejects(
    prepareRuntimeRoot({ rootPath: root, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_REFUSED,
  );
});

test('root:root 0700 policy rejects divergent owner, group, mode and type deterministically', () => {
  const safe = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    mode: 0o40700,
    uid: 0,
    gid: 0,
  };
  assert.doesNotThrow(() => assertRootOwnedDirectory(safe, RESTORE_RUNTIME_ROOT_REFUSED));
  const divergent = [
    { ...safe, uid: 1000 },
    { ...safe, gid: 1000 },
    { ...safe, mode: 0o40755 },
    { ...safe, mode: 0o41700 },
    { ...safe, isSymbolicLink: () => true },
    { ...safe, isDirectory: () => false },
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

test('cleanup refuses a changed inode or identity and keeps the root', async (t) => {
  const base = await tempBase(t);
  const root = join(base, 'stakeframe-restore');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assert.rejects(
    removeRuntimeRoot({ rootPath: root, createdRoot: true, ino: 1, dev: 2, policy: relaxedPolicy }),
    (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  );
  if (posix) {
    await assert.rejects(
      removeRuntimeRoot({ rootPath: root, createdRoot: true }),
      (error) => error.message === RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
    );
  }
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
