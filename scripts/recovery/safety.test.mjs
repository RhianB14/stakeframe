import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertLocalEndpoint,
  assertOwnedResources,
  assertWithinWorkspace,
  assertKnownFiles,
} from './runtime.mjs';
import { resolve, join, dirname } from 'node:path';
import { mkdtemp, mkdir, writeFile, unlink, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadR2Configuration, r2Repository } from './r2.mjs';

test('recovery runner accepts only local Docker transports', () => {
  assertLocalEndpoint('unix:///var/run/docker.sock');
  assertLocalEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine');
  for (const endpoint of [
    'ssh://vps.example.test',
    'tcp://127.0.0.1:2375',
    'https://docker.example.test',
    'npipe:////remote-host/pipe/docker_engine',
    'unix://remote-host/docker.sock',
    'unix:///',
    '',
    undefined,
  ]) {
    assert.throws(() => assertLocalEndpoint(endpoint), /RECOVERY_LOCAL_DOCKER_REQUIRED/);
  }
});

test('cleanup requires the generated project name and both ownership labels on every resource', () => {
  const project = 'stk-recovery-0123456789abcdef0123456789abcdef';
  const labels = { 'com.docker.compose.project': project, 'io.stakeframe.recovery-run': project };
  assertOwnedResources(project, [{ Config: { Labels: labels } }, { Labels: labels }]);
  for (const resources of [
    [{}],
    [{ Labels: { 'com.docker.compose.project': project } }],
    [{ Labels: { ...labels, 'io.stakeframe.recovery-run': 'other' } }],
    [{ Labels: labels }, {}],
  ]) {
    assert.throws(
      () => assertOwnedResources(project, resources),
      /RECOVERY_RESOURCE_OWNERSHIP_MISMATCH/,
    );
  }
  assert.throws(() => assertOwnedResources('stakeframe-local', []), /RECOVERY_PROJECT_REFUSED/);
});

test('temporary directory cleanup rejects workspace root and path traversal', () => {
  const workspace = resolve('fixture-workspace');
  assertWithinWorkspace(workspace, resolve(workspace, '.cache', 'recovery-drill', 'owned'));
  assert.throws(() => assertWithinWorkspace(workspace, workspace), /RECOVERY_DIRECTORY_REFUSED/);
  assert.throws(
    () => assertWithinWorkspace(workspace, resolve(workspace, '..', 'other')),
    /RECOVERY_DIRECTORY_REFUSED/,
  );
});

test('cleanup refuses unknown files and never accepts nested paths', () => {
  assertKnownFiles([
    'source_password',
    'target_password',
    'repository_password',
    'wrong_password',
    'empty.env',
  ]);
  assertKnownFiles([]);
  for (const name of ['notes.txt', '../source_password', 'nested/source_password']) {
    assert.throws(() => assertKnownFiles([name]), /RECOVERY_UNEXPECTED_PRIVATE_FILE/);
  }
});

test('R2 destination requires canonical HTTPS, fixed bucket and a generated test prefix', () => {
  const endpoint = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
  const project = `stk-recovery-${'b'.repeat(32)}`;
  assert.equal(
    r2Repository(endpoint, project),
    `s3:${endpoint}/stakeframe-backups/m0-rehearsals/${project}`,
  );
  for (const bad of [
    endpoint.replace('https:', 'http:'),
    `${endpoint}:443`,
    `${endpoint}/`,
    `${endpoint}?redirect=https://other.example`,
    `${endpoint}.other.example`,
    endpoint.replace('https://', 'https://user:password@'),
    'https://127.0.0.1',
    'https://other.example',
    undefined,
  ])
    assert.throws(() => r2Repository(bad, project), /RECOVERY_R2_ENDPOINT_REFUSED/);
  for (const bad of ['', 'stakeframe-production', `${project}/..`, `${project}/other`, undefined])
    assert.throws(() => r2Repository(endpoint, bad), /RECOVERY_PROJECT_REFUSED/);
});

async function r2Fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'stakeframe-r2-test-'));
  const directory = join(base, 'private');
  const workspace = join(base, 'workspace');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(workspace);
  const endpoint = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
  const files = {
    endpoint: `${endpoint}\n`,
    access_key_id: `${'b'.repeat(32)}\r\n`,
    secret_access_key: `${'c'.repeat(64)}\n`,
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(join(directory, name), value, { mode: 0o600 });
  t.after(async () => {
    for (const name of Object.keys(files)) await unlink(join(directory, name));
    await rmdir(directory);
    await rmdir(workspace);
    await rmdir(base);
  });
  return { directory, workspace, endpoint };
}

test('R2 private config accepts CRLF, returns no credentials and refuses paths inside Git', async (t) => {
  const fixture = await r2Fixture(t);
  const config = await loadR2Configuration(fixture.directory, fixture.workspace);
  assert.equal(config.endpoint, fixture.endpoint);
  assert.deepEqual(Object.keys(config).sort(), ['directory', 'endpoint']);
  await assert.rejects(
    loadR2Configuration(fixture.directory, dirname(fixture.directory)),
    /RECOVERY_R2_CONFIGURATION_REFUSED/,
  );
  await assert.rejects(
    loadR2Configuration('relative-private-directory', fixture.workspace),
    /RECOVERY_R2_CONFIGURATION_REFUSED/,
  );
});

test('R2 rejects malformed, multiline and oversized credentials with a sanitized error', async (t) => {
  const fixture = await r2Fixture(t);
  for (const value of ['private-bad-value', `${'c'.repeat(64)}\n\n`, 'd'.repeat(5000)]) {
    await writeFile(join(fixture.directory, 'secret_access_key'), value);
    await assert.rejects(loadR2Configuration(fixture.directory, fixture.workspace), {
      message: 'RECOVERY_R2_CONFIGURATION_REFUSED',
    });
  }
});

test(
  'R2 refuses symbolic link credential files',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await r2Fixture(t);
    const secret = join(fixture.directory, 'secret_access_key');
    await unlink(secret);
    await symlink(join(fixture.directory, 'access_key_id'), secret);
    await assert.rejects(loadR2Configuration(fixture.directory, fixture.workspace), {
      message: 'RECOVERY_R2_CONFIGURATION_REFUSED',
    });
  },
);
