import assert from 'node:assert/strict';

export function assertRestoreConfig(config, project) {
  assert.match(project, /^stk-restore-[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(config.services).sort(), ['restore', 'restore-postgres']);
  assert.equal(config.networks['restore-private'].internal, true);
  assert.deepEqual(Object.keys(config.networks).sort(), ['restore-egress', 'restore-private']);
  for (const network of Object.values(config.networks)) {
    assert.ok(!network.external);
    assert.equal(network.labels['io.stakeframe.restore'], project);
  }
  for (const service of Object.values(config.services)) {
    assert.match(service.image, /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
    assert.equal(service.ports, undefined);
    assert.ok(!service.build && !service.privileged && !service.network_mode);
    assert.equal(service.labels['io.stakeframe.restore'], project);
  }
  const target = config.services['restore-postgres'];
  assert.deepEqual(Object.keys(target.networks), ['restore-private']);
  assert.equal(target.environment.POSTGRES_DB, 'stakeframe');
  assert.equal(target.environment.POSTGRES_PASSWORD_FILE, '/run/secrets/postgres_password');
  assert.equal(target.environment.POSTGRES_PASSWORD, undefined);
  const restore = config.services.restore;
  assert.deepEqual(Object.keys(restore.networks).sort(), ['restore-egress', 'restore-private']);
  assert.deepEqual(restore.command, ['src/server.mjs', 'restore']);
  assert.equal(restore.read_only, true);
  assert.ok(
    restore.cap_drop.includes('ALL') && restore.security_opt.includes('no-new-privileges:true'),
  );
  assert.equal(restore.environment.BACKUP_READ_ONLY, 'true');
  assert.equal(restore.environment.RESTORE_CONFIRM, 'new-isolated-cluster');
  assert.equal(restore.environment.OPS_REHEARSAL, undefined);
  assert.equal(restore.environment.RESTIC_REPOSITORY, undefined);
  assert.equal(restore.environment.RESTIC_PASSWORD_FILE, '/run/secrets/recovery_key');
  assert.equal(
    restore.environment.R2_BACKUP_ACCESS_KEY_ID_FILE,
    '/run/secrets/r2_backup_restore_access_key',
  );
  assert.equal(
    restore.environment.R2_BACKUP_SECRET_ACCESS_KEY_FILE,
    '/run/secrets/r2_backup_restore_secret_key',
  );
  assert.deepEqual(restore.secrets.map((secret) => secret.source).sort(), [
    'db_password',
    'r2_backup_restore_access_key',
    'r2_backup_restore_secret_key',
    'recovery_key',
  ]);
  assert.equal(restore.volumes.length, 1);
  assert.equal(restore.volumes[0].type, 'volume');
  assert.equal(restore.volumes[0].source, 'restore-status');
  assert.equal(restore.volumes[0].target, '/status');
  assert.deepEqual(Object.keys(config.volumes).sort(), ['restore-database', 'restore-status']);
  for (const volume of Object.values(config.volumes)) {
    assert.ok(!volume.external);
    assert.equal(volume.labels['io.stakeframe.restore'], project);
  }
  return config;
}
