import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertLocalEndpoint } from './recovery/runtime.mjs';

const [prefix = 'stakeframe-local', architecture = process.arch] = process.argv.slice(2);
assert.match(prefix, /^[a-z0-9][a-z0-9._/-]*$/);
assert.ok(['x64', 'arm64'].includes(architecture));
const context = execFileSync('docker', ['context', 'show'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const docker = (args, options = {}) =>
  execFileSync('docker', ['--context', context, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
const details = JSON.parse(docker(['context', 'inspect', context]));
assertLocalEndpoint(details[0].Endpoints.docker.Host);
const probe = readFileSync(new URL('./runtime-image-probe.mjs', import.meta.url), 'utf8');
for (const target of ['api', 'worker', 'migrate']) {
  const [metadata] = JSON.parse(docker(['image', 'inspect', `${prefix}-${target}`]));
  assert.equal(metadata.Architecture, architecture === 'x64' ? 'amd64' : 'arm64');
  assert.equal(metadata.Config.User, 'node');
  assert.equal(metadata.Config.WorkingDir, '/app');
  assert.deepEqual(metadata.Config.Cmd, [
    'node',
    target === 'migrate' ? 'dist/migrate-cli.js' : 'dist/server.js',
  ]);
  const name = `stk-image-check-${randomUUID().replaceAll('-', '')}`;
  const label = `io.stakeframe.image-check=${name}`;
  try {
    docker([
      'create',
      '--name',
      name,
      '--label',
      label,
      '--interactive',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '64',
      '--memory',
      '256m',
      '--cpus',
      '1',
      '--env',
      `IMAGE_TARGET=${target}`,
      '--env',
      `EXPECTED_NODE_ARCH=${architecture}`,
      '--entrypoint',
      'node',
      metadata.Id,
      '--input-type=module',
    ]);
    process.stdout.write(docker(['start', '--attach', '--interactive', name], { input: probe }));
    const [finished] = JSON.parse(docker(['container', 'inspect', name]));
    assert.equal(finished.State.ExitCode, 0, 'Runtime probe failed');
    assert.equal(finished.HostConfig.ReadonlyRootfs, true);
    console.info(`RUNTIME_IMAGE_SIZE ${target} ${metadata.Size}`);
  } finally {
    // Only remove the uniquely named container after verifying our ownership label.
    const found = docker([
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `name=^/${name}$`,
    ]).trim();
    if (found) {
      const [owned] = JSON.parse(docker(['container', 'inspect', found]));
      assert.equal(owned.Config.Labels['io.stakeframe.image-check'], name);
      assert.equal(owned.Name, `/${name}`);
      docker(['container', 'rm', '--force', owned.Id]);
    }
  }
}
