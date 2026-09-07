import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  readdir,
  lstat,
  unlink,
  rmdir,
} from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { execute, root, assertLocalEndpoint, assertWithinWorkspace } from './recovery/runtime.mjs';

const project = `stk-ops-${randomUUID().replaceAll('-', '')}`;
const directory = join(root, '.cache', 'operations-rehearsal', project);
const known = [
  'postgres_password',
  'db_password',
  'target_db_password',
  'recovery_key',
  'empty.env',
  'report.json',
];
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let docker;
let compose;
let created = false;
let stage = 'initialize';
let report = { project, status: 'running' };
async function resources(kind) {
  const list = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
  const ids = (
    await docker([...list, '--filter', `label=com.docker.compose.project=${project}`], {
      ignoreAbort: true,
    })
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
    assert.equal(labels['io.stakeframe.operations'], project);
  }
  return values;
}
try {
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
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  created = true;
  assertWithinWorkspace(await realpath(root), await realpath(directory));
  if (process.platform === 'win32') {
    const identity = (await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'])).stdout.match(
      /S-1-5-[\d-]+/,
    );
    assert.ok(identity);
    await execute('icacls.exe', [
      directory,
      '/inheritance:r',
      '/grant:r',
      `*${identity[0]}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
    ]);
  }
  for (const name of known.filter((name) => name !== 'report.json'))
    await writeFile(
      join(directory, name),
      name === 'empty.env' ? '' : randomBytes(32).toString('hex') + '\n',
      { flag: 'wx', mode: process.platform === 'win32' ? 0o600 : 0o444 },
    );
  stage = 'build';
  const tag = `${project}-operations`;
  await docker(['build', '--target', 'operations', '--tag', tag, '.'], { timeoutMs: 600000 });
  const image = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0];
  assert.equal(image.Config.User, '1000:1000');
  assert.equal(image.Architecture, process.arch === 'arm64' ? 'arm64' : 'amd64');
  const env = {
    OPERATIONS_RUN: project,
    OPERATIONS_SECRET_DIRECTORY: directory.replaceAll('\\', '/'),
    OPERATIONS_IMAGE: image.Id,
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
        join(root, 'compose.operations-rehearsal.yml'),
        ...args,
      ],
      { ...options, env },
    );
  stage = 'isolation';
  const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  assert.equal(config.networks.private.internal, true);
  for (const service of Object.values(config.services)) {
    assert.equal(service.ports, undefined);
    assert.deepEqual(Object.keys(service.networks), ['private']);
  }
  stage = 'clusters';
  await compose(['up', '-d', '--wait', 'postgres', 'restore-postgres']);
  stage = 'backup-restore';
  const result = await compose(
    ['run', '--name', `${project}-drill`, '--no-deps', '-T', 'tools', 'drill.mjs'],
    { timeoutMs: 360000, allowFailure: true },
  );
  process.stdout.write(result.stdout);
  const startupCode = result.stderr.match(/ERR_[A-Z_]+|SyntaxError|ReferenceError/)?.[0];
  if (startupCode) console.error(`OPERATIONS_STARTUP_FAILED ${startupCode}`);
  // Only the fixture's fixed diagnostics, never a runtime exception/SQL payload.
  if (result.stderr.includes('OPERATIONS_REHEARSAL_FAILED'))
    console.error('OPERATIONS_REHEARSAL_FAILED');
  await docker(['cp', `${project}-drill:/status/rehearsal.json`, join(directory, 'report.json')]);
  report = {
    project,
    ...JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')),
    imageBytes: image.Size,
    architecture: image.Architecture,
  };
  assert.equal(result.code, 0);
  assert.equal(report.status, 'passed');
} catch (error) {
  report.status = 'failed';
  report.failedStage = stage;
  report.failureType = error.code ?? error.name;
  process.exitCode = 1;
  console.error(`OPERATIONS_REHEARSAL_FAILED ${stage} ${report.failureType}`);
} finally {
  try {
    if (compose) {
      await Promise.all(['container', 'volume', 'network'].map(resources));
      // Compose down leaves one-off run containers behind. Validate and remove
      // our own one-off first, including only its anonymous image-declared volume.
      for (const container of await resources('container'))
        if (container.Config.Labels['com.docker.compose.oneoff'] === 'True')
          await docker(['container', 'rm', '--force', '--volumes', container.Id], {
            ignoreAbort: true,
          });
      await compose(['down', '--volumes', '--timeout', '5'], { ignoreAbort: true });
      assert.ok(
        (await Promise.all(['container', 'volume', 'network'].map(resources))).every(
          (values) => values.length === 0,
        ),
      );
    }
    if (created) {
      const actual = await realpath(directory);
      assertWithinWorkspace(await realpath(root), actual);
      assert.equal(basename(actual), project);
      assert.equal(dirname(actual), await realpath(join(root, '.cache', 'operations-rehearsal')));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      const entries = await readdir(actual, { withFileTypes: true });
      assert.ok(entries.every((entry) => entry.isFile() && known.includes(entry.name)));
      for (const entry of entries) await unlink(join(actual, entry.name));
      await rmdir(actual);
    }
    report.cleanup = 'passed';
  } catch {
    report.cleanup = 'failed';
    report.status = 'failed';
    process.exitCode = 1;
  }
  const output = join(root, '.cache', 'operations-reports');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, `${project}.json`), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.info(`OPERATIONS_REHEARSAL_REPORT ${project} ${report.status}`);
}
