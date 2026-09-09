import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Runtime root for the monthly restore rehearsal. The documented manual command
// runs without systemd RuntimeDirectory provisioning, so the runner must create
// it itself; the systemd unit (mutation E) also provisions it with 0700 root:root.
export const RESTORE_RUNTIME_ROOT = '/run/stakeframe-restore';
// Fixed sanitized codes. They are the only strings allowed to reach the private
// report: never a system message, a stack trace or a caller-provided path.
export const RESTORE_RUNTIME_ROOT_REFUSED = 'RESTORE_RUNTIME_ROOT_REFUSED';
export const RESTORE_INDIVIDUAL_DIRECTORY_REFUSED = 'RESTORE_INDIVIDUAL_DIRECTORY_REFUSED';
export const RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED = 'RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED';
export const RESTORE_FAILURE_GENERIC = 'RESTORE_FAILURE_GENERIC';

// Strict allowlist for the private report: this module's codes plus the fixed
// codes already defined by the recovery runtime the runner depends on.
const failureCodeAllowlist = [
  RESTORE_RUNTIME_ROOT_REFUSED,
  RESTORE_INDIVIDUAL_DIRECTORY_REFUSED,
  RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED,
  'RECOVERY_LOCAL_DOCKER_REQUIRED',
  'RECOVERY_LOCAL_IDENTITY_UNAVAILABLE',
  'RECOVERY_PROCESS_FAILED',
  'RECOVERY_COMMAND_FAILED',
  'RECOVERY_CONTEXT_REFUSED',
  'RECOVERY_DIRECTORY_REFUSED',
  'RECOVERY_PROJECT_REFUSED',
  'RECOVERY_RESOURCE_OWNERSHIP_MISMATCH',
  'RECOVERY_RESOURCES_REMAIN',
  'RECOVERY_UNEXPECTED_PRIVATE_FILE',
];

export function sanitizeFailureCode(error) {
  return typeof error?.message === 'string' && failureCodeAllowlist.includes(error.message)
    ? error.message
    : RESTORE_FAILURE_GENERIC;
}

// Pure mode enforcement shared by the production policy and tests: exactly
// 0700 effective, rejecting setuid/setgid/sticky and wider permissions.
export function assertSafeDirectoryMode(info, code) {
  if ((info.mode & 0o7777) !== 0o700) throw new Error(code);
}

// Production policy, pure so tests exercise it deterministically with synthetic
// stat objects, without root and on any platform: a real directory (never a
// symlink), exactly 0700, owned by root:root (UID/GID 0).
export function assertRootOwnedDirectory(info, code) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
  assertSafeDirectoryMode(info, code);
  if (info.uid !== 0 || info.gid !== 0) throw new Error(code);
}

// Pure identity comparison anchored to the stat captured when the run created
// the root: every revalidation read must describe that same object.
export function assertSameIdentity(info, identity, code) {
  if (info.ino !== identity.ino || info.dev !== identity.dev) throw new Error(code);
}

// Structural-only policy for the internal rollback of a just-created root
// whose validation failed: the production policy already refused that root by
// definition, so the rollback proves bare structure, emptiness and identity.
export function assertStructuralDirectory(info, code) {
  assertDirectoryShape(info, code);
}

// Compose a cleanup failure into the private report: the cleanup gets its own
// sanitized code beside — never over — the main failure code, and the run is
// failed even when the restore itself had passed.
export function applyCleanupFailure(report, error) {
  return {
    ...report,
    cleanup: 'failed',
    status: 'failed',
    cleanupFailureCode: sanitizeFailureCode(error),
  };
}

// Structural checks applied to every accepted directory on every platform.
// Identity and mode stay in the policy so CI can exercise the real filesystem
// without root while production keeps enforcing UID/GID 0.
function assertDirectoryShape(info, code) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
}

// The directory must resolve to itself: never a symlink, and the literal final
// name inside its real parent. Ancestor canonicalization (Windows 8.3 short
// names, /tmp links) is tolerated; a redirect of the leaf itself is not.
async function assertExactRealpath(path, code) {
  const real = await realpath(path);
  if (real === path) return;
  const realParent = await realpath(dirname(path));
  if (join(realParent, basename(path)) !== real) throw new Error(code);
}

async function prepareProjectDirectory({ rootPath, project, policy }) {
  const code = RESTORE_INDIVIDUAL_DIRECTORY_REFUSED;
  if (!/^stk-restore-[a-f0-9]{32}$/.test(project)) throw new Error(code);
  const directory = join(rootPath, project);
  let existing;
  try {
    existing = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(code, { cause: error });
    existing = undefined;
  }
  if (existing !== undefined) throw new Error(code);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch {
    throw new Error(code);
  }
  const info = await lstat(directory);
  assertDirectoryShape(info, code);
  policy(info, code);
  await assertExactRealpath(directory, code);
  return { directory };
}

export async function prepareRuntimeRoot({
  rootPath = RESTORE_RUNTIME_ROOT,
  project,
  mode = 0o700,
  policy = assertRootOwnedDirectory,
} = {}) {
  const code = RESTORE_RUNTIME_ROOT_REFUSED;
  let info;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(code, { cause: error });
    info = undefined;
  }
  let createdRoot = false;
  let initialIdentity;
  if (info === undefined) {
    // Non-recursive creation of the exact leaf: no intermediate path is created
    // or followed. A missing parent (or anything else) is refused.
    try {
      await mkdir(rootPath, { recursive: false, mode });
    } catch {
      throw new Error(code);
    }
    createdRoot = true;
    try {
      info = await lstat(rootPath);
      initialIdentity = { ino: info.ino, dev: info.dev };
      assertDirectoryShape(info, code);
      policy(info, code);
      await assertExactRealpath(rootPath, code);
    } catch (error) {
      // The root was created by this call but failed validation: remove it
      // only if it is still the same object just created (structural policy
      // plus the identity captured above), empty, and nothing else.
      await removeRuntimeRoot({
        rootPath,
        createdRoot: true,
        ...(initialIdentity ? { ino: initialIdentity.ino, dev: initialIdentity.dev } : {}),
        policy: assertStructuralDirectory,
      }).catch(() => {});
      throw error;
    }
  } else {
    assertDirectoryShape(info, code);
    policy(info, code);
    await assertExactRealpath(rootPath, code);
  }
  const root = { createdRoot, ino: info.ino, dev: info.dev };
  if (project === undefined) return { ...root, directory: undefined };
  return { ...root, ...(await prepareProjectDirectory({ rootPath, project, policy })) };
}

export async function removeRuntimeRoot({
  rootPath = RESTORE_RUNTIME_ROOT,
  createdRoot = false,
  ino,
  dev,
  policy = assertRootOwnedDirectory,
} = {}) {
  // A runtime root provided by systemd (or any earlier execution) is never
  // removed here; only a root created by the same run may be. Removal is
  // refused unless the caller proves it knows the exact object it created:
  // ino and dev are required whenever createdRoot is true.
  if (!createdRoot) return false;
  const code = RESTORE_RUNTIME_ROOT_CLEANUP_REFUSED;
  if (ino === undefined || dev === undefined) throw new Error(code);
  const identity = { ino, dev };
  let info;
  try {
    info = await lstat(rootPath);
  } catch {
    throw new Error(code);
  }
  assertDirectoryShape(info, code);
  policy(info, code);
  await assertExactRealpath(rootPath, code);
  // Every revalidation read must describe the same object this run created.
  assertSameIdentity(info, identity, code);
  let entries;
  try {
    entries = await readdir(rootPath);
  } catch {
    throw new Error(code);
  }
  // Never recursive: any remaining entry refuses the removal entirely.
  if (entries.length) throw new Error(code);
  // Last read immediately before rmdir, anchored to the same original
  // identity. A swap after this read cannot be fully ruled out, but rmdir
  // itself refuses a non-empty replacement; the anchored reads are the
  // guarantee actually implemented, no more.
  const before = await lstat(rootPath);
  assertSameIdentity(before, identity, code);
  try {
    await rmdir(rootPath);
  } catch {
    throw new Error(code);
  }
  return true;
}
