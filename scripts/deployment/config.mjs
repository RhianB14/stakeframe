import assert from 'node:assert/strict';

const digest = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export function assertDeploymentConfig(
  config,
  {
    rehearsal = false,
    integrations = false,
    tavily = false,
    automatic = false,
    operations = false,
  } = {},
) {
  assert.ok(integrations || (!tavily && !automatic && !operations), 'INTEGRATIONS_REQUIRED');
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(), [
    'api',
    'migrate',
    ...(operations ? ['operations'] : []),
    'postgres',
    'web',
    'worker',
  ]);
  for (const [name, service] of Object.entries(services)) {
    assert.ok(
      digest.test(service.image) || (rehearsal && imageId.test(service.image)),
      'IMMUTABLE_IMAGE_REQUIRED',
    );
    assert.ok(
      !service.build && !service.privileged && !service.network_mode,
      'SERVICE_ISOLATION_REQUIRED',
    );
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
    if (name !== 'web') assert.equal(service.ports, undefined, 'PRIVATE_SERVICE_PORT_REFUSED');
    if (name !== 'postgres') {
      assert.equal(service.read_only, true);
      assert.ok(service.cap_drop.includes('ALL'));
    }
  }
  assert.equal(config.networks.backend.internal, true);
  assert.deepEqual(Object.keys(services.postgres.networks), ['backend']);
  assert.deepEqual(
    Object.keys(services.worker.networks).sort(),
    integrations ? ['backend', 'provider-egress'] : ['backend'],
  );
  assert.deepEqual(Object.keys(services.migrate.networks), ['backend']);
  for (const name of ['api', 'worker', 'migrate', ...(operations ? ['operations'] : [])]) {
    const environment = services[name].environment;
    assert.equal(environment.STAKEFRAME_RUNTIME, 'production');
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.DB_PASSWORD_FILE, '/run/secrets/db_password');
    for (const key of [
      'DATABASE_URL',
      'DB_PASSWORD',
      'BETTER_AUTH_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'OPENROUTER_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_OWNER_USER_ID',
      'TELEGRAM_OWNER_CHAT_ID',
      'R2_ATTACHMENTS_ACCESS_KEY_ID',
      'R2_ATTACHMENTS_SECRET_ACCESS_KEY',
      'TAVILY_API_KEY',
      'RESTIC_PASSWORD',
      'R2_BACKUP_ACCESS_KEY_ID',
      'R2_BACKUP_SECRET_ACCESS_KEY',
      'MONITOR_TOKEN',
    ])
      assert.equal(environment[key], undefined, 'PLAINTEXT_SECRET_REFUSED');
  }
  const expectedSecrets = {
    postgres: ['postgres_password', 'db_password'],
    migrate: ['db_password'],
    api: ['db_password', 'auth_secret', 'google_client_secret'],
    worker: ['db_password'],
    web: [],
  };
  const worker = services.worker.environment;
  if (operations) {
    const ops = services.operations;
    assert.deepEqual(ops.profiles, ['operations']);
    assert.deepEqual(Object.keys(ops.networks).sort(), ['backend', 'backup-egress']);
    assert.ok(config.networks['backup-egress'] && !config.networks['backup-egress'].internal);
    assert.equal(ops.environment.BACKUP_CONFIRM, 'production-with-retention');
    assert.equal(ops.environment.OPS_REHEARSAL, undefined);
    assert.equal(ops.environment.RESTIC_REPOSITORY, undefined);
    assert.equal(ops.environment.RESTIC_PASSWORD_FILE, '/run/secrets/recovery_key');
    assert.equal(ops.environment.R2_BACKUP_ACCESS_KEY_ID_FILE, '/run/secrets/r2_backup_access_key');
    assert.equal(
      ops.environment.R2_BACKUP_SECRET_ACCESS_KEY_FILE,
      '/run/secrets/r2_backup_secret_key',
    );
    assert.match(ops.environment.R2_BACKUP_ACCOUNT_ID, /^[a-f0-9]{32}$/);
    assert.match(ops.environment.R2_BACKUP_BUCKET, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
    assert.notEqual(ops.environment.R2_BACKUP_BUCKET, ops.environment.R2_ATTACHMENTS_BUCKET);
    assert.equal(ops.environment.R2_ATTACHMENTS_ENABLED, 'true');
    for (const key of [
      'R2_ACCOUNT_ID',
      'R2_ATTACHMENTS_BUCKET',
      'R2_ATTACHMENTS_ACCESS_KEY_ID_FILE',
      'R2_ATTACHMENTS_SECRET_ACCESS_KEY_FILE',
    ])
      assert.equal(ops.environment[key], services.api.environment[key]);
    assert.ok(ops.tmpfs.some((mount) => mount === '/work:size=4g,uid=1000,gid=1000,mode=0700'));
    assert.equal(String(ops.mem_limit), '5368709120');
    assert.equal(ops.volumes.length, 1);
    assert.equal(ops.volumes[0].type, 'volume');
    assert.equal(ops.volumes[0].source, 'operations-status');
    assert.equal(ops.volumes[0].target, '/status');
    assert.ok(config.volumes['operations-status']);
    assert.equal(services.api.environment.MONITORING_ENABLED, 'true');
    assert.equal(worker.MONITORING_ENABLED, 'true');
    assert.equal(services.api.environment.MONITOR_TOKEN_FILE, '/run/secrets/monitor_token');
    expectedSecrets.api.push('monitor_token');
    expectedSecrets.operations = [
      'db_password',
      'recovery_key',
      'r2_backup_access_key',
      'r2_backup_secret_key',
      'r2_reader_access_key',
      'r2_reader_secret_key',
    ];
  } else {
    assert.equal(services.api.environment.MONITORING_ENABLED, undefined);
    assert.equal(worker.MONITORING_ENABLED, undefined);
  }
  if (integrations) {
    assert.ok(config.networks['provider-egress'] && !config.networks['provider-egress'].internal);
    for (const [name, value] of Object.entries({
      AI_ENABLED: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_MODEL: 'google/gemini-3.8-flash',
      OPENROUTER_ALLOW_FALLBACKS: 'false',
      OPENROUTER_MAX_OUTPUT_TOKENS: '2048',
      OPENROUTER_REASONING_EFFORT: 'low',
      OPENROUTER_TIMEOUT_MS: '60000',
      TELEGRAM_ENABLED: 'true',
    }))
      assert.equal(worker[name], value, 'INTEGRATION_POLICY_REQUIRED');
    for (const [name, secret] of Object.entries({
      OPENROUTER_API_KEY: 'openrouter_api_key',
      TELEGRAM_BOT_TOKEN: 'telegram_bot_token',
      TELEGRAM_OWNER_USER_ID: 'telegram_owner_user_id',
      TELEGRAM_OWNER_CHAT_ID: 'telegram_owner_chat_id',
    })) {
      assert.equal(worker[`${name}_FILE`], `/run/secrets/${secret}`);
      expectedSecrets.worker.push(secret);
    }
    for (const [service, scope] of [
      ['api', 'reader'],
      ['worker', 'writer'],
    ]) {
      const env = services[service].environment;
      assert.equal(env.R2_ATTACHMENTS_ENABLED, 'true');
      assert.match(env.R2_ACCOUNT_ID, /^[a-f0-9]{32}$/);
      assert.match(env.R2_ATTACHMENTS_BUCKET, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
      assert.equal(env.R2_ATTACHMENTS_ACCESS_KEY_ID_FILE, `/run/secrets/r2_${scope}_access_key`);
      assert.equal(
        env.R2_ATTACHMENTS_SECRET_ACCESS_KEY_FILE,
        `/run/secrets/r2_${scope}_secret_key`,
      );
      expectedSecrets[service].push(`r2_${scope}_access_key`, `r2_${scope}_secret_key`);
      assert.equal(env.THESPORTSDB_ENABLED, 'true');
      assert.equal(env.TAVILY_ENABLED, tavily ? 'true' : undefined);
    }
    assert.equal(services.api.environment.R2_ACCOUNT_ID, worker.R2_ACCOUNT_ID);
    assert.equal(services.api.environment.R2_ATTACHMENTS_BUCKET, worker.R2_ATTACHMENTS_BUCKET);
    assert.equal(worker.AUTOMATIC_IMPORT_ENABLED, automatic ? 'true' : 'false');
    if (tavily) {
      assert.equal(worker.TAVILY_API_KEY_FILE, '/run/secrets/tavily_api_key');
      expectedSecrets.worker.push('tavily_api_key');
    }
    if (automatic) {
      assert.equal(worker.AUTOMATIC_IMPORT_POLICIES_FILE, '/run/policies/automatic-import.json');
      const mounts = services.worker.volumes ?? [];
      assert.equal(mounts.length, 1);
      assert.equal(mounts[0].type, 'bind');
      assert.equal(mounts[0].target, worker.AUTOMATIC_IMPORT_POLICIES_FILE);
      assert.equal(mounts[0].read_only, true);
      assert.equal(mounts[0].bind.create_host_path, false);
    } else assert.equal(services.worker.volumes, undefined);
  } else {
    for (const service of ['api', 'worker'])
      for (const name of [
        'AI_ENABLED',
        'TELEGRAM_ENABLED',
        'R2_ATTACHMENTS_ENABLED',
        'THESPORTSDB_ENABLED',
        'TAVILY_ENABLED',
        'AUTOMATIC_IMPORT_ENABLED',
      ])
        assert.ok([undefined, 'false'].includes(services[service].environment[name]));
  }
  for (const [name, secrets] of Object.entries(expectedSecrets)) {
    const mounted = services[name].secrets ?? [];
    assert.deepEqual(mounted.map((secret) => secret.source).sort(), [...secrets].sort());
    for (const secret of mounted)
      assert.ok([secret.source, `/run/secrets/${secret.source}`].includes(secret.target));
  }
  assert.deepEqual(
    Object.keys(config.secrets).sort(),
    [...new Set(Object.values(expectedSecrets).flat())].sort(),
  );
  const auth = services.api.environment;
  assert.equal(auth.AUTH_ENABLED, 'true');
  assert.equal(auth.BETTER_AUTH_SECRET_FILE, '/run/secrets/auth_secret');
  assert.equal(auth.GOOGLE_CLIENT_SECRET_FILE, '/run/secrets/google_client_secret');
  assert.equal(auth.APP_ORIGIN, `https://${services.web.environment.APP_DOMAIN}`);
  assert.match(auth.APP_ORIGIN, /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
  assert.ok(!auth.APP_ORIGIN.endsWith('.localhost'));
  assert.equal(
    services.postgres.environment.POSTGRES_PASSWORD_FILE,
    '/run/secrets/postgres_password',
  );
  assert.equal(services.postgres.environment.POSTGRES_PASSWORD, undefined);
  assert.deepEqual(services.migrate.profiles, ['migration']);
  assert.ok(!services.api.depends_on.migrate, 'AUTOMATIC_MIGRATION_REFUSED');
  const ports = services.web.ports;
  assert.equal(ports.length, 2);
  assert.deepEqual(ports.map((port) => port.target).sort(), [8080, 8443]);
  for (const port of ports) {
    if (rehearsal) assert.equal(port.host_ip, '127.0.0.1', 'REHEARSAL_LOOPBACK_REQUIRED');
    else assert.equal(String(port.published), port.target === 8080 ? '80' : '443');
  }
  for (const secret of ['postgres_password', 'db_password', 'auth_secret', 'google_client_secret'])
    assert.equal(typeof config.secrets[secret].file, 'string');
  for (const name of ['database', 'caddy-data', 'caddy-config']) assert.ok(config.volumes[name]);
  assert.ok(
    services.web.volumes.some((volume) => volume.type === 'volume' && volume.target === '/data'),
  );
  return config;
}
