import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const runPattern = /^stk-recovery-[a-f0-9]{32}$/;
const secretFiles = ['source_password', 'target_password', 'repository_password', 'wrong_password'];
const inheritedKeys = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemDrive',
  'TMP',
  'TEMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DOCKER_CONFIG',
];
const environment = Object.fromEntries(
  inheritedKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
);

export function assertLocalEndpoint(endpoint) {
  if (
    typeof endpoint !== 'string' ||
    !/^(unix:\/\/\/[^\r\n\0]+|npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+)$/.test(endpoint)
  )
    throw new Error('RECOVERY_LOCAL_DOCKER_REQUIRED');
}

export function assertOwnedResources(project, resources) {
  if (!runPattern.test(project)) throw new Error('RECOVERY_PROJECT_REFUSED');
  for (const resource of resources) {
    const labels = resource.Config?.Labels ?? resource.Labels ?? {};
    if (
      labels['com.docker.compose.project'] !== project ||
      labels['io.stakeframe.recovery-run'] !== project
    ) {
      throw new Error('RECOVERY_RESOURCE_OWNERSHIP_MISMATCH');
    }
  }
}

export function assertWithinWorkspace(workspace, directory) {
  const child = relative(workspace, directory);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error('RECOVERY_DIRECTORY_REFUSED');
}

export function assertKnownFiles(names) {
  if (names.some((name) => ![...secretFiles, 'empty.env'].includes(name)))
    throw new Error('RECOVERY_UNEXPECTED_PRIVATE_FILE');
}

export async function execute(binary, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env: { ...environment, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 180_000)])
        : AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', () => reject(new Error('RECOVERY_PROCESS_FAILED')));
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) resolveResult({ code, stdout, stderr });
      else
        reject(
          new Error(
            stderr.match(/^RECOVERY_[A-Z_]+$/m)?.[0] ??
              options.failureCode ??
              'RECOVERY_COMMAND_FAILED',
          ),
        );
    });
  });
}

export async function createDrill() {
  if (process.env.DOCKER_HOST) assertLocalEndpoint(process.env.DOCKER_HOST);
  const context = (await execute('docker', ['context', 'show'])).stdout.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) throw new Error('RECOVERY_CONTEXT_REFUSED');
  const endpoint = JSON.parse(
    (
      await execute('docker', [
        'context',
        'inspect',
        context,
        '--format',
        '{{json .Endpoints.docker.Host}}',
      ])
    ).stdout,
  );
  assertLocalEndpoint(endpoint);
  const project = `stk-recovery-${randomUUID().replaceAll('-', '')}`;
  const runDirectory = join(root, '.cache', 'recovery-drill', project);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  try {
    assertWithinWorkspace(await realpath(root), await realpath(runDirectory));
    if (process.platform === 'win32') {
      const identity = (await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'])).stdout.match(
        /S-1-5-[\d-]+/,
      );
      if (!identity) throw new Error('RECOVERY_LOCAL_IDENTITY_UNAVAILABLE');
      await execute('icacls.exe', [
        runDirectory,
        '/inheritance:r',
        '/grant:r',
        `*${identity[0]}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
      ]);
    }
    for (const name of secretFiles) {
      await writeFile(join(runDirectory, name), `${randomBytes(32).toString('hex')}\n`, {
        flag: 'wx',
        mode: process.platform === 'win32' ? 0o600 : 0o444,
      });
    }
    // Explicit empty env file prevents Compose from loading any developer .env file.
    await writeFile(join(runDirectory, 'empty.env'), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await removeRunDirectory(runDirectory, project);
    throw error;
  }
  const controller = new AbortController();
  const docker = (args, options) => execute('docker', ['--context', context, ...args], options);
  const compose = (args, options = {}) =>
    docker(
      [
        'compose',
        '--env-file',
        join(runDirectory, 'empty.env'),
        '--project-name',
        project,
        '-f',
        join(root, 'compose.recovery.yml'),
        '--profile',
        'tools',
        ...args,
      ],
      {
        ...options,
        signal: options.ignoreAbort ? undefined : controller.signal,
        env: {
          RECOVERY_RUN_ID: project,
          RECOVERY_SECRET_DIR: runDirectory.replaceAll('\\', '/'),
          ...options.env,
        },
      },
    );
  const command = (action, args = [], options) =>
    compose(['run', '--rm', '--no-deps', '-T', 'tools', action, ...args], options);
  async function ownedResources(kind) {
    const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
    const names = (
      await docker([...args, '--filter', `label=com.docker.compose.project=${project}`])
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    if (!names.length) return [];
    const resources = JSON.parse((await docker([kind, 'inspect', ...names])).stdout);
    assertOwnedResources(project, resources);
    return resources;
  }
  async function cleanup() {
    // Refuse cleanup if any matching resource lacks both independent labels.
    await Promise.all(['container', 'volume', 'network'].map(ownedResources));
    await compose(['down', '--volumes', '--timeout', '5'], {
      ignoreAbort: true,
      failureCode: 'RECOVERY_CLEANUP_FAILED',
    });
    const remaining = await Promise.all(['container', 'volume', 'network'].map(ownedResources));
    if (remaining.some((resources) => resources.length))
      throw new Error('RECOVERY_RESOURCES_REMAIN');
    await removeRunDirectory(runDirectory, project);
  }
  return {
    project,
    runDirectory,
    compose,
    command,
    ownedResources,
    cleanup,
    abort: () => controller.abort(),
  };
}

async function removeRunDirectory(directory, project) {
  if (!runPattern.test(project) || basename(directory) !== project)
    throw new Error('RECOVERY_DIRECTORY_REFUSED');
  const expectedParent = resolve(root, '.cache', 'recovery-drill');
  const actual = await realpath(directory);
  assertWithinWorkspace(await realpath(root), actual);
  if (
    (await lstat(directory)).isSymbolicLink() ||
    dirname(actual) !== (await realpath(expectedParent))
  )
    throw new Error('RECOVERY_DIRECTORY_REFUSED');
  const child = relative(expectedParent, actual);
  if (child !== project || child.includes(sep)) throw new Error('RECOVERY_DIRECTORY_REFUSED');
  const entries = await readdir(actual, { withFileTypes: true });
  assertKnownFiles(entries.map((entry) => entry.name));
  if (entries.some((entry) => !entry.isFile())) throw new Error('RECOVERY_UNEXPECTED_PRIVATE_FILE');
  // Only delete the known files created by this run; never recurse through user content.
  for (const entry of entries) await unlink(join(actual, entry.name));
  await rmdir(actual);
}

export async function writeReport(report) {
  const directory = join(root, '.cache', 'recovery-reports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${report.project}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}
