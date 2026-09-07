import assert from 'node:assert/strict';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, readdir, unlink, rmdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execute, root, assertLocalEndpoint, assertWithinWorkspace } from './recovery/runtime.mjs';
import { assertDeploymentConfig } from './deployment/config.mjs';
import { assertRestoreConfig } from './deployment/restore-config.mjs';

const project = `stk-deploy-${randomUUID().replaceAll('-', '')}`;
const directory = join(root, '.cache', 'deployment-rehearsal', project);
const knownFiles = [
  'postgres_password',
  'db_password',
  'auth_secret',
  'google_client_secret',
  'openrouter_api_key',
  'telegram_bot_token',
  'telegram_owner_user_id',
  'telegram_owner_chat_id',
  'r2_reader_access_key',
  'r2_reader_secret_key',
  'r2_writer_access_key',
  'r2_writer_secret_key',
  'tavily_api_key',
  'automatic-import.json',
  'recovery_key',
  'r2_backup_access_key',
  'r2_backup_secret_key',
  'monitor_token',
  'empty.env',
  'deployment.env',
];
const origin = 'https://stakeframe.example.test';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let docker;
let compose;
let stage = 'initialize';
let createdDirectory = false;
const report = { project, checks: [], status: 'running' };
const checked = (name) => {
  report.checks.push(name);
  console.info(`DEPLOYMENT_REHEARSAL_PASSED ${name}`);
};

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
    assert.equal(labels['io.stakeframe.deployment'], project);
  }
  return values;
}

async function cleanup() {
  if (compose) {
    await Promise.all(['container', 'volume', 'network'].map(resources));
    await compose(['down', '--volumes', '--timeout', '5'], { ignoreAbort: true });
    const remaining = await Promise.all(['container', 'volume', 'network'].map(resources));
    assert.ok(remaining.every((values) => values.length === 0));
  }
  if (!createdDirectory) return;
  const actual = await realpath(directory);
  assertWithinWorkspace(await realpath(root), actual);
  assert.equal(basename(actual), project);
  assert.equal(dirname(actual), await realpath(join(root, '.cache', 'deployment-rehearsal')));
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  const entries = await readdir(actual, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile() && knownFiles.includes(entry.name)));
  for (const entry of entries) await unlink(join(actual, entry.name));
  await rmdir(actual);
}

function https(port, ca, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        servername: 'stakeframe.example.test',
        ca,
        rejectUnauthorized: true,
        path,
        method,
        timeout: 5000,
        headers: { host: 'stakeframe.example.test', ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.end();
  });
}

async function main() {
  if (process.env.DOCKER_HOST) assertLocalEndpoint(process.env.DOCKER_HOST);
  const context = (await execute('docker', ['context', 'show'])).stdout.trim();
  assert.match(context, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  docker = (args, options = {}) =>
    execute('docker', ['--context', context, ...args], {
      ...options,
      signal: options.ignoreAbort ? undefined : controller.signal,
    });
  const inspected = JSON.parse((await docker(['context', 'inspect', context])).stdout);
  assertLocalEndpoint(inspected[0].Endpoints.docker.Host);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  createdDirectory = true;
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
  for (const file of knownFiles)
    await writeFile(
      join(directory, file),
      file.endsWith('.env')
        ? ''
        : randomBytes(32).toString('hex') + (file === 'db_password' ? '\r\n' : '\n'),
      {
        flag: 'wx',
        mode: file.endsWith('.env') || process.platform === 'win32' ? 0o600 : 0o444,
      },
    );
  stage = 'build';
  const images = {};
  for (const target of ['api', 'worker', 'migrate', 'web-production']) {
    const tag = `${project}-${target}`;
    await docker(['build', '--target', target, '--tag', tag, '.'], { timeoutMs: 600000 });
    images[target] = JSON.parse((await docker(['image', 'inspect', tag])).stdout)[0].Id;
    console.info(`DEPLOYMENT_REHEARSAL_IMAGE_READY ${target}`);
  }
  const environment = {
    DEPLOYMENT_ID: project,
    SECRET_DIRECTORY: directory.replaceAll('\\', '/'),
    API_IMAGE: images.api,
    WORKER_IMAGE: images.worker,
    MIGRATE_IMAGE: images.migrate,
    WEB_IMAGE: images['web-production'],
    APP_DOMAIN: 'stakeframe.example.test',
    ACME_EMAIL: 'operator@example.test',
    GOOGLE_CLIENT_ID: 'rehearsal-client',
    AUTHORIZED_GOOGLE_EMAIL: 'owner@example.test',
    AUTHORIZED_GOOGLE_SUB: '111111111111111111111',
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_ATTACHMENTS_BUCKET: 'fictional-attachments',
    R2_BACKUP_ACCOUNT_ID: 'a'.repeat(32),
    R2_BACKUP_BUCKET: 'fictional-backups',
    BACKUP_CONFIRM: 'production-with-retention',
    OPERATIONS_IMAGE: images.api,
    AUTOMATIC_IMPORT_POLICIES_FILE: join(directory, 'automatic-import.json').replaceAll('\\', '/'),
  };
  const publishedShape = { ...environment };
  // Syntax fixture only; these are not published digests and are never pulled.
  for (const name of ['API', 'WORKER', 'MIGRATE', 'WEB', 'OPERATIONS'])
    publishedShape[`${name}_IMAGE`] =
      `example.invalid/stakeframe-${name.toLowerCase()}@${environment[`${name}_IMAGE`]}`;
  const checkFile = join(directory, 'deployment.env');
  await writeFile(
    checkFile,
    Object.entries(publishedShape)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
  );
  await execute(process.execPath, ['scripts/deployment-check.mjs', checkFile]);
  // Rendering only: these fake provider secrets are never used for network requests.
  for (const flags of [
    ['--integrations'],
    ['--integrations', '--tavily'],
    ['--integrations', '--tavily', '--automatic'],
    ['--integrations', '--operations'],
    ['--integrations', '--tavily', '--automatic', '--operations'],
  ])
    await execute(process.execPath, ['scripts/deployment-check.mjs', checkFile, ...flags]);
  const restoreProject = `stk-restore-${randomUUID().replaceAll('-', '')}`;
  const restoreShape = JSON.parse(
    (
      await docker(
        [
          'compose',
          '--env-file',
          checkFile,
          '-f',
          join(root, 'compose.restore.yml'),
          'config',
          '--format',
          'json',
        ],
        {
          env: {
            RESTORE_RUN: restoreProject,
            RESTORE_TEMP_DIRECTORY: directory.replaceAll('\\', '/'),
          },
        },
      )
    ).stdout,
  );
  assertRestoreConfig(restoreShape, restoreProject);
  for (const mutate of [
    (value) => {
      value.services.restore.environment.BACKUP_READ_ONLY = 'false';
    },
    (value) => {
      value.networks['restore-private'].external = true;
    },
    (value) => {
      value.services['restore-postgres'].ports = [{ target: 5432 }];
    },
    (value) => {
      value.volumes['restore-database'].external = true;
    },
    (value) => {
      value.services.restore.volumes.push({
        type: 'bind',
        source: '/var/run/docker.sock',
        target: '/var/run/docker.sock',
      });
    },
  ]) {
    const invalid = structuredClone(restoreShape);
    mutate(invalid);
    assert.throws(() => assertRestoreConfig(invalid, restoreProject));
  }
  checked('integration-operations-and-isolated-restore-configuration');
  const integrated = JSON.parse(
    (
      await docker([
        'compose',
        '--env-file',
        checkFile,
        '-f',
        join(root, 'compose.production.yml'),
        '-f',
        join(root, 'compose.integrations.yml'),
        '--profile',
        'migration',
        'config',
        '--format',
        'json',
      ])
    ).stdout,
  );
  assertDeploymentConfig(integrated, { integrations: true });
  for (const mutate of [
    (value) => {
      value.services.worker.environment.OPENROUTER_ALLOW_FALLBACKS = 'true';
    },
    (value) => {
      value.services.worker.environment.OPENROUTER_API_KEY = 'private';
    },
    (value) => {
      value.services.api.secrets.push({
        source: 'openrouter_api_key',
        target: 'openrouter_api_key',
      });
    },
    (value) => {
      value.services.api.environment.R2_ATTACHMENTS_ACCESS_KEY_ID_FILE =
        '/run/secrets/r2_writer_access_key';
    },
    (value) => {
      delete value.services.worker.networks['provider-egress'];
    },
    (value) => {
      value.services.worker.environment.AUTOMATIC_IMPORT_ENABLED = 'true';
    },
    (value) => {
      value.services.worker.environment.TAVILY_ENABLED = 'true';
    },
  ]) {
    const unsafe = structuredClone(integrated);
    mutate(unsafe);
    assert.throws(() => assertDeploymentConfig(unsafe, { integrations: true }));
  }
  assert.throws(() => assertDeploymentConfig(integrated));
  checked('provider-overlays-and-secret-consumer-isolation');
  // A dangling secret path is rejected without reading or printing secret values.
  await writeFile(
    checkFile,
    Object.entries({ ...publishedShape, SECRET_DIRECTORY: join(directory, 'missing') })
      .map(([name, value]) => `${name}=${value}`)
      .join('\n') + '\n',
  );
  const missingSecret = await execute(
    process.execPath,
    ['scripts/deployment-check.mjs', checkFile],
    { allowFailure: true },
  );
  assert.notEqual(missingSecret.code, 0);
  assert.equal(missingSecret.stderr.trim(), 'DEPLOYMENT_CONFIGURATION_REFUSED');
  checked('immutable-config-and-missing-secret-checks');
  compose = (args, options = {}) =>
    docker(
      [
        'compose',
        '--env-file',
        join(directory, 'empty.env'),
        '--project-name',
        project,
        '-f',
        join(root, 'compose.production.yml'),
        '-f',
        join(root, 'compose.rehearsal.yml'),
        '--profile',
        'migration',
        ...args,
      ],
      { ...options, env: { ...environment, ...options.env } },
    );
  stage = 'config';
  const config = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  assertDeploymentConfig(config, { rehearsal: true });
  // The production checker must reject the rehearsal's daemon-local image IDs.
  assert.throws(() => assertDeploymentConfig(config), /IMMUTABLE_IMAGE_REQUIRED/);
  for (const mutate of [
    (value) => {
      value.services.api.ports = [{ target: 3000, published: '3000' }];
    },
    (value) => {
      value.services.web.ports[0].host_ip = '0.0.0.0';
    },
    (value) => {
      value.services.api.environment.BETTER_AUTH_SECRET = 'forbidden';
    },
    (value) => {
      value.services.api.environment.AUTH_ENABLED = 'false';
    },
    (value) => {
      value.networks.backend.internal = false;
    },
  ]) {
    const unsafe = structuredClone(config);
    mutate(unsafe);
    assert.throws(() => assertDeploymentConfig(unsafe, { rehearsal: true }));
  }
  checked('isolated-compose-and-images');
  stage = 'database';
  await compose(['up', '-d', '--wait', 'postgres']);
  stage = 'migration';
  const refused = await compose(['run', '--rm', '--no-deps', '-T', 'migrate'], {
    allowFailure: true,
  });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /MIGRATION_FAILED/);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '-e',
    'MIGRATION_CONFIRM=production',
    'migrate',
  ]);
  await compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '-e',
    'MIGRATION_CONFIRM=production',
    'migrate',
  ]);
  checked('explicit-and-repeatable-migration');
  stage = 'startup';
  await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'api', 'worker', 'web']);
  const containers = await resources('container');
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    assert.equal(container.State.Health.Status, 'healthy');
    if (service !== 'web')
      assert.ok(Object.keys(container.HostConfig.PortBindings ?? {}).length === 0);
    if (service !== 'postgres') {
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.ok(['node', '1000:1000'].includes(container.Config.User));
    }
    assert.ok(
      container.Config.Env.every(
        (value) =>
          !/^(DB_PASSWORD|DATABASE_URL|BETTER_AUTH_SECRET|GOOGLE_CLIENT_SECRET|POSTGRES_PASSWORD)=/.test(
            value,
          ),
      ),
    );
  }
  checked('healthy-private-services-and-file-secrets');
  const dbCommand = async (sql) => {
    const source = `import {createDatabase,readDatabaseConfig} from '@stakeframe/db';const db=createDatabase(readDatabaseConfig(process.env));try{console.info(JSON.stringify((await db.pool.query(${JSON.stringify(sql)})).rows))}finally{await db.close()}`;
    return JSON.parse(
      (await compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', source])).stdout,
    );
  };
  const [role] = await dbCommand(
    'SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user',
  );
  assert.deepEqual(role, {
    current_user: 'stakeframe_app',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  });
  await dbCommand(
    'CREATE TABLE public.rehearsal_marker (id integer PRIMARY KEY, value text NOT NULL)',
  );
  await dbCommand("INSERT INTO public.rehearsal_marker VALUES (1, 'preserved')");
  checked('non-superuser-database-role');
  stage = 'tls';
  const ca = (
    await compose(['exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt'])
  ).stdout;
  const fingerprint = new X509Certificate(ca).fingerprint256;
  const portOutput = (await compose(['port', 'web', '8443'])).stdout.trim();
  assert.match(portOutput, /^127\.0\.0\.1:\d+$/);
  let port = Number(portOutput.split(':').at(-1));
  const httpPort = (await compose(['port', 'web', '8080'])).stdout.trim();
  assert.match(httpPort, /^127\.0\.0\.1:\d+$/);
  const redirect = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(httpPort.split(':').at(-1)),
        path: '/health/ready',
        headers: { host: 'stakeframe.example.test' },
        timeout: 5000,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.end();
  });
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, `${origin}/health/ready`);
  await assert.rejects(https(port, undefined, '/health/ready'));
  const ready = await https(port, ca, '/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await https(port, ca, '/')).status, 200);
  const status = JSON.parse((await https(port, ca, '/api/v1/system/status')).body);
  assert.equal(status.stage, 'production-setup');
  assert.equal(status.authentication, 'google');
  assert.equal(status.productEnabled, true);
  assert.equal((await https(port, ca, '/api/v1/me')).status, 401);
  assert.equal(
    (
      await https(port, ca, '/api/auth/sign-in/google', 'POST', {
        origin: 'https://attacker.example.test',
      })
    ).status,
    403,
  );
  const signin = await https(port, ca, '/api/auth/sign-in/google', 'POST', { origin });
  assert.equal(signin.status, 200);
  const authorization = new URL(JSON.parse(signin.body).url);
  assert.equal(authorization.hostname, 'accounts.google.com');
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    `${origin}/api/auth/callback/google`,
  );
  const cookies = signin.headers['set-cookie'];
  assert.ok(
    cookies?.length &&
      cookies.every((cookie) => /; Secure/i.test(cookie) && /; HttpOnly/i.test(cookie)),
  );
  checked('trusted-tls-auth-denials-and-secure-oauth-cookies');
  stage = 'restart';
  await compose(['restart', 'postgres', 'api', 'worker', 'web']);
  stage = 'restart-ready';
  await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'api', 'worker', 'web']);
  stage = 'restart-https';
  // Docker may allocate a different ephemeral host port when restarting the container.
  const restartedPort = (await compose(['port', 'web', '8443'])).stdout.trim();
  assert.match(restartedPort, /^127\.0\.0\.1:\d+$/);
  port = Number(restartedPort.split(':').at(-1));
  assert.equal((await https(port, ca, '/health/ready')).status, 200);
  stage = 'restart-certificate';
  const restoredCa = (
    await compose(['exec', '-T', 'web', 'cat', '/data/caddy/pki/authorities/local/root.crt'])
  ).stdout;
  assert.equal(new X509Certificate(restoredCa).fingerprint256, fingerprint);
  stage = 'restart-database';
  assert.deepEqual(await dbCommand('SELECT value FROM public.rehearsal_marker WHERE id=1'), [
    { value: 'preserved' },
  ]);
  checked('database-and-certificate-persistence-after-restart');
  report.status = 'passed';
}

try {
  await main();
} catch (error) {
  report.status = 'failed';
  report.failedStage = stage;
  report.failureType = error.code ?? error.name;
  process.exitCode = 1;
  console.error(`DEPLOYMENT_REHEARSAL_FAILED ${stage} ${report.failureType}`);
} finally {
  try {
    await cleanup();
    checked('owned-resource-cleanup');
  } catch {
    report.status = 'failed';
    report.cleanup = 'failed';
    process.exitCode = 1;
    console.error('DEPLOYMENT_REHEARSAL_CLEANUP_FAILED');
  }
  const reports = join(root, '.cache', 'deployment-reports');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  await writeFile(join(reports, `${project}.json`), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.info(`DEPLOYMENT_REHEARSAL_REPORT ${project} ${report.status}`);
}
