import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertLocalEndpoint,
  assertOwnedResources,
  assertWithinWorkspace,
  assertKnownFiles,
} from './runtime.mjs';
import { resolve } from 'node:path';

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
