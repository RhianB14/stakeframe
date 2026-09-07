import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile, chown, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Fixed host bind backs /status in the operations container. Recording a failed
// monthly run never depends on the deployment env file, image or Docker daemon.
export async function publishRestoreStatus(report) {
  const directory = '/var/lib/stakeframe/operations-status';
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
  assert.equal(stat.uid, 1000);
  assert.equal(stat.gid, 1000);
  assert.equal(stat.mode & 0o077, 0);
  const path = join(directory, `restore-${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(path, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 });
    created = true;
    await chown(path, 1000, 1000);
    await rename(path, join(directory, 'restore-latest.json'));
    created = false;
  } finally {
    if (created) await unlink(path);
  }
}
