import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { join, isAbsolute, relative, sep } from 'node:path';
import {
  lstat,
  realpath,
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  rmdir,
  statfs,
} from 'node:fs/promises';
import { execute, root, assertLocalEndpoint } from './recovery/runtime.mjs';
import { assertRestoreConfig } from './deployment/restore-config.mjs';
import { restoreDiskReady } from './deployment/restore-capacity.mjs';
import { publishRestoreStatus } from './deployment/restore-status.mjs';

// Host-side monthly runner. Activation, secret provisioning and timer installation
// require the reviewed production authorization. No Docker socket enters a container.
const project = `stk-restore-${randomUUID().replaceAll('-', '')}`;
const directory = `/run/stakeframe-restore/${project}`;
const reports = '/var/lib/stakeframe/restore-reports';
const known = ['postgres_password', 'db_password', 'empty.env', 'restore.json'];
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());
let docker;
let compose;
let created = false;
let image;
let capacityTimer;
let report = { version: 1, project, status: 'failed', startedAt: new Date().toISOString() };

async function owned(kind) {
  const ids = (
    await docker(
      [
        ...(kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q']),
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ],
      { ignoreAbort: true },
    )
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.length) return [];
  const values = JSON.parse(
    (await docker([kind, 'inspect', ...ids], { ignoreAbort: true })).stdout,
  );
  for (const value of values) {
    const labels = value.Config?.Labels ?? value.Labels;
    assert.equal(labels['com.docker.compose.project'], project);
    assert.equal(labels['io.stakeframe.restore'], project);
  }
  return values;
}

try {
  const [file, ...extra] = process.argv.slice(2);
  assert.ok(file && !extra.length && isAbsolute(file));
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.RESTORE_REHEARSAL_CONFIRM, 'monthly-isolated-recovery');
  const info = await lstat(file);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= 16384 && (info.mode & 0o077) === 0,
  );
  const path = await realpath(file);
  const within = relative(await realpath(root), path);
  assert.ok(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within));
  const privateConfig = parseEnv(await readFile(path, 'utf8'));
  image = privateConfig.OPERATIONS_IMAGE;
  const deployment = privateConfig.DEPLOYMENT_ID;
  assert.match(image ?? '', /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
  assert.match(deployment ?? '', /^[a-z0-9][a-z0-9-]{1,80}$/);
  assert.match(privateConfig.R2_BACKUP_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/);
  assert.match(privateConfig.R2_BACKUP_BUCKET ?? '', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.ok(isAbsolute(privateConfig.SECRET_DIRECTORY ?? ''));
  if (process.env.DOCKER_HOST) assertLocalEndpoint(process.env.DOCKER_HOST);
  const context = (await execute('docker', ['context', 'show'])).stdout.trim();
  assert.match(context, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  assertLocalEndpoint(
    JSON.parse((await execute('docker', ['context', 'inspect', context])).stdout)[0].Endpoints
      .docker.Host,
  );
  docker = (args, options = {}) =>
    execute('docker', ['--context', context, ...args], {
      ...options,
      signal: options.ignoreAbort ? undefined : controller.signal,
    });
  await mkdir(directory, { mode: 0o700 });
  created = true;
  assert.equal(await realpath(directory), directory);
  for (const name of ['postgres_password', 'db_password'])
    await writeFile(join(directory, name), randomBytes(32).toString('hex') + '\n', {
      flag: 'wx',
      mode: 0o444,
    });
  await writeFile(join(directory, 'empty.env'), '', { flag: 'wx', mode: 0o600 });
  const env = {
    OPERATIONS_IMAGE: image,
    RESTORE_RUN: project,
    RESTORE_TEMP_DIRECTORY: directory,
    SECRET_DIRECTORY: privateConfig.SECRET_DIRECTORY,
    R2_BACKUP_ACCOUNT_ID: privateConfig.R2_BACKUP_ACCOUNT_ID,
    R2_BACKUP_BUCKET: privateConfig.R2_BACKUP_BUCKET,
  };
  compose = (args, options = {}) =>
    docker(
      [
        'compose',
        '--env-file',
        join(directory, 'empty.env'),
        '--project-name',
        project,
        '-f',
        join(root, 'compose.restore.yml'),
        ...args,
      ],
      { ...options, env },
    );
  const config = assertRestoreConfig(
    JSON.parse((await compose(['config', '--format', 'json'])).stdout),
    project,
  );
  for (const secret of Object.values(config.secrets)) {
    const stat = await lstat(secret.file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4096);
  }
  const dataRoot = (await docker(['info', '--format', '{{.DockerRootDir}}'])).stdout.trim();
  assert.ok(isAbsolute(dataRoot));
  assert.ok(restoreDiskReady(await statfs(dataRoot, { bigint: true }), true));
  capacityTimer = setInterval(() => {
    void statfs(dataRoot, { bigint: true })
      .then((stat) => {
        if (!restoreDiskReady(stat)) controller.abort();
      })
      .catch(() => controller.abort());
  }, 5000).unref();
  await compose(['pull'], { timeoutMs: 600000 });
  await compose(['up', '-d', '--wait', 'restore-postgres']);
  const result = await compose(['run', '--name', `${project}-run`, '--no-deps', '-T', 'restore'], {
    timeoutMs: 3.75 * 3600_000,
    allowFailure: true,
  });
  assert.equal(result.code, 0);
  await docker(['cp', `${project}-run:/status/restore.json`, join(directory, 'restore.json')]);
  const restored = JSON.parse(await readFile(join(directory, 'restore.json'), 'utf8'));
  assert.ok(
    restored.version === 1 &&
      restored.countsVerified &&
      restored.financeVerified &&
      restored.rolesVerified &&
      restored.permissionsVerified &&
      restored.importsPaused &&
      restored.sessionsRevoked,
  );
  assert.match(restored.snapshot, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isFinite(Date.parse(restored.completedAt)) &&
      Number.isFinite(Date.parse(restored.cutoff)),
  );
  report = {
    ...report,
    status: 'passed',
    snapshot: restored.snapshot,
    cutoff: restored.cutoff,
    completedAt: restored.completedAt,
    durationMs: restored.durationMs,
    countsVerified: true,
    financeVerified: true,
    rolesVerified: true,
    permissionsVerified: true,
    importsPaused: true,
    sessionsRevoked: true,
  };
} catch {
  process.exitCode = 1;
  report.status = 'failed';
  report.completedAt = new Date().toISOString();
  console.error('RESTORE_REHEARSAL_FAILED');
} finally {
  clearInterval(capacityTimer);
  try {
    if (compose) {
      await Promise.all(['container', 'volume', 'network'].map(owned));
      for (const container of await owned('container'))
        if (container.Config.Labels['com.docker.compose.oneoff'] === 'True')
          await docker(['container', 'rm', '--force', '--volumes', container.Id], {
            ignoreAbort: true,
          });
      await compose(['down', '--volumes', '--timeout', '5'], { ignoreAbort: true });
      assert.ok(
        (await Promise.all(['container', 'volume', 'network'].map(owned))).every(
          (items) => items.length === 0,
        ),
      );
    }
    if (created) {
      assert.equal(await realpath(directory), directory);
      const entries = await readdir(directory, { withFileTypes: true });
      assert.ok(entries.every((entry) => entry.isFile() && known.includes(entry.name)));
      for (const entry of entries) await unlink(join(directory, entry.name));
      await rmdir(directory);
    }
    report.cleanup = 'passed';
  } catch {
    report.cleanup = 'failed';
    report.status = 'failed';
    process.exitCode = 1;
  }
  if (
    process.platform === 'linux' &&
    process.env.RESTORE_REHEARSAL_CONFIRM === 'monthly-isolated-recovery'
  ) {
    try {
      await mkdir(reports, { recursive: true, mode: 0o700 });
      await writeFile(join(reports, `${project}.json`), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      report.status = 'failed';
      report.persistence = 'failed';
      process.exitCode = 1;
    }
    try {
      await publishRestoreStatus(report);
    } catch {
      console.error('RESTORE_REHEARSAL_STATUS_FAILED');
      process.exitCode = 1;
    }
  }
  console.info(`RESTORE_REHEARSAL_${report.status.toUpperCase()}`);
}
