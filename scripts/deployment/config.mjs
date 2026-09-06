import assert from 'node:assert/strict';

const digest = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
export function assertDeploymentConfig(config, { rehearsal = false } = {}) {
  const services = config.services;
  assert.deepEqual(Object.keys(services).sort(), ['api', 'migrate', 'postgres', 'web', 'worker']);
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
  assert.deepEqual(Object.keys(services.worker.networks), ['backend']);
  assert.deepEqual(Object.keys(services.migrate.networks), ['backend']);
  for (const name of ['api', 'worker', 'migrate']) {
    const environment = services[name].environment;
    assert.equal(environment.STAKEFRAME_RUNTIME, 'production');
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.DB_PASSWORD_FILE, '/run/secrets/db_password');
    for (const key of ['DATABASE_URL', 'DB_PASSWORD', 'BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_SECRET'])
      assert.equal(environment[key], undefined, 'PLAINTEXT_SECRET_REFUSED');
  }
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
