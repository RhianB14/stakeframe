// STK-F1-10 — docker secrets de telemetria.
//
// Os serviços resolvem os *_FILE para os docker secrets com os nomes EXATOS
// provisionados na VPS (sentry_dsn_api/worker/web, posthog_project_api_key,
// betterstack_source_token). Renderização apenas: o `docker compose config` não
// lê os arquivos nem fala com o daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const execute = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const digest = `sha256:${'0'.repeat(64)}`;
const ENVIRONMENT = {
  DEPLOYMENT_ID: 'ci-validation',
  SECRET_DIRECTORY: '/tmp/stakeframe-telemetry-secrets',
  APP_DOMAIN: 'ci.invalid',
  ACME_EMAIL: 'ci@ci.invalid',
  GOOGLE_CLIENT_ID: 'ci.invalid',
  AUTHORIZED_GOOGLE_EMAIL: 'ci@ci.invalid',
  AUTHORIZED_GOOGLE_SUB: 'ci-subject',
  MIGRATE_IMAGE: `ghcr.io/example/stakeframe-migrate@${digest}`,
  API_IMAGE: `ghcr.io/example/stakeframe-api@${digest}`,
  WORKER_IMAGE: `ghcr.io/example/stakeframe-worker@${digest}`,
  WEB_IMAGE: `ghcr.io/example/stakeframe-web-production@${digest}`,
  OPERATIONS_IMAGE: `ghcr.io/example/stakeframe-operations@${digest}`,
  BACKUP_CONFIRM: 'ci-validation',
  R2_ACCOUNT_ID: '0'.repeat(32),
  R2_ATTACHMENTS_BUCKET: 'ci-attachments-bucket',
  R2_BACKUP_ACCOUNT_ID: '0'.repeat(32),
  R2_BACKUP_BUCKET: 'ci-backup-bucket',
  B2_BACKUP_BUCKET: 'stakeframe-backup-ci',
  TELEGRAM_MINIAPP_URL: 'https://ci.invalid',
  // A janela real da VPS define os mesmos flags e instala os arquivos.
  SENTRY_ENABLED: 'true',
  POSTHOG_ENABLED: 'true',
  BETTER_STACK_ENABLED: 'true',
  POSTHOG_ID: 'ci-project',
  BETTER_STACK_INGESTING_URL: 'https://in.logs.betterstack.com',
};

const TELEMETRY_SECRETS = [
  'sentry_dsn_web',
  'sentry_dsn_api',
  'sentry_dsn_worker',
  'posthog_project_api_key',
  'betterstack_source_token',
];

const dockerAvailable = async () => {
  try {
    await execute('docker', ['compose', 'version']);
    return true;
  } catch {
    return false;
  }
};

test(
  'telemetry secrets resolve to the mounted docker secrets',
  { skip: (await dockerAvailable()) ? false : 'docker compose unavailable' },
  async () => {
    const { stdout } = await execute(
      'docker',
      [
        'compose',
        '-f',
        resolve(root, 'compose.production.yml'),
        '-f',
        resolve(root, 'compose.integrations.yml'),
        '--profile',
        'migration',
        'config',
        '--format',
        'json',
      ],
      { env: { ...process.env, ...ENVIRONMENT }, maxBuffer: 32 * 1024 * 1024 },
    );
    const config = JSON.parse(stdout);

    for (const name of TELEMETRY_SECRETS) {
      assert.ok(config.secrets[name], `missing top-level secret ${name}`);
      assert.equal(config.secrets[name].file, `${ENVIRONMENT.SECRET_DIRECTORY}/${name}`);
    }

    const sources = (service) =>
      (config.services[service].secrets ?? []).map((secret) => secret.source);
    const telemetryOf = (service) =>
      sources(service).filter((name) => TELEMETRY_SECRETS.includes(name));
    assert.deepEqual(telemetryOf('api').sort(), [
      'betterstack_source_token',
      'posthog_project_api_key',
      'sentry_dsn_api',
      'sentry_dsn_web',
    ]);
    assert.deepEqual(telemetryOf('worker').sort(), [
      'betterstack_source_token',
      'posthog_project_api_key',
      'sentry_dsn_worker',
    ]);

    const api = config.services.api.environment;
    assert.equal(api.SENTRY_DSN_FILE, '/run/secrets/sentry_dsn_api');
    assert.equal(api.SENTRY_PUBLIC_DSN_FILE, '/run/secrets/sentry_dsn_web');
    assert.equal(api.POSTHOG_KEY_FILE, '/run/secrets/posthog_project_api_key');
    assert.equal(api.BETTER_STACK_SOURCE_TOKEN_FILE, '/run/secrets/betterstack_source_token');
    const worker = config.services.worker.environment;
    assert.equal(worker.SENTRY_DSN_FILE, '/run/secrets/sentry_dsn_worker');
    assert.equal(worker.POSTHOG_KEY_FILE, '/run/secrets/posthog_project_api_key');
    assert.equal(worker.BETTER_STACK_SOURCE_TOKEN_FILE, '/run/secrets/betterstack_source_token');
    const migrate = config.services.migrate.environment;
    for (const key of ['SENTRY_DSN_FILE', 'POSTHOG_KEY_FILE', 'BETTER_STACK_SOURCE_TOKEN_FILE'])
      assert.equal(migrate[key], undefined);

    // Flags não-secretos chegam pelo runtime (x-runtime) com os valores da janela.
    assert.equal(api.SENTRY_ENABLED, 'true');
    assert.equal(api.POSTHOG_ID, 'ci-project');
    assert.equal(api.BETTER_STACK_INGESTING_URL, 'https://in.logs.betterstack.com');
  },
);
