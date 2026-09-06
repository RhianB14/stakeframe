import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDrill, writeReport } from './recovery/runtime.mjs';

const start = performance.now();
const results = [];
let drill;
let failure;
let cleanupFailure;
let restoreMs;
let backupMs;
let interrupted = false;
let r2PrivateDirectory;
let retainedSnapshot;
function onInterrupt() {
  interrupted = true;
  drill?.abort();
}
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);

async function step(name, action) {
  if (interrupted && name !== 'remove-owned-test-resources')
    throw new Error('RECOVERY_DRILL_INTERRUPTED');
  console.info(`RECOVERY_STEP_START ${name}`);
  const started = performance.now();
  const value = await action();
  results.push({ name, status: 'passed', durationMs: Math.round(performance.now() - started) });
  console.info(`RECOVERY_STEP_PASSED ${name}`);
  return value;
}

function expectRefusal(result, code) {
  assert.notEqual(result.code, 0, 'RECOVERY_NEGATIVE_CASE_ACCEPTED');
  assert.ok(result.stderr.includes(code), 'RECOVERY_UNEXPECTED_REFUSAL');
}

try {
  if (process.argv.length !== 2) {
    if (process.argv.length !== 4 || process.argv[2] !== '--r2' || !process.argv[3])
      throw new Error('RECOVERY_ARGUMENTS_REFUSED');
    r2PrivateDirectory = process.argv[3];
  }
  drill = await createDrill({ r2PrivateDirectory });
  if (r2PrivateDirectory)
    await step('verify-external-storage-isolation-config', async () => {
      const config = JSON.parse((await drill.compose(['config', '--format', 'json'])).stdout);
      assert.equal(config.networks.recovery.internal, true);
      for (const name of ['source', 'target']) {
        assert.deepEqual(Object.keys(config.services[name].networks), ['recovery']);
        assert.equal(config.services[name].ports, undefined);
        assert.ok(!config.services[name].secrets.some((secret) => secret.source.startsWith('r2_')));
      }
      assert.deepEqual(Object.keys(config.services.tools.networks).sort(), [
        'recovery',
        'storage-egress',
      ]);
      assert.equal(config.services.tools.ports, undefined);
      for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESTIC_PASSWORD'])
        assert.equal(config.services.tools.environment[key], undefined);
    });
  await step('build-tools', () =>
    drill.compose(['build', 'tools'], { timeoutMs: 300_000, failureCode: 'RECOVERY_BUILD_FAILED' }),
  );
  await step('start-isolated-clusters', async () => {
    // A unique, previously unused project prevents collisions with a running app.
    assert.equal((await drill.ownedResources('container')).length, 0);
    assert.equal((await drill.ownedResources('volume')).length, 0);
    await drill.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'source', 'target']);
    const containers = await drill.ownedResources('container');
    assert.equal(containers.length, 2);
    for (const container of containers) {
      assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
      assert.equal(container.HostConfig.Privileged, false);
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
    }
    const networks = await drill.ownedResources('network');
    // Compose creates storage-egress later, when the first tools container runs.
    assert.equal(networks.length, 1);
    assert.equal(
      networks.find((network) => network.Labels['com.docker.compose.network'] === 'recovery')
        ?.Internal,
      true,
    );
    for (const container of containers) {
      assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1);
      assert.ok(Object.keys(container.NetworkSettings.Networks)[0].endsWith('_recovery'));
      assert.ok(!container.Config.Env.some((value) => value.startsWith('AWS_')));
    }
  });
  const expected = await step('prepare-source-fixture', async () => {
    await drill.command('seed');
    const state = JSON.parse((await drill.command('inspect-source')).stdout);
    assert.equal(state.referenceCount, 2);
    assert.equal(state.readerSelect, true);
    assert.equal(state.readerInsert, false);
    assert.equal(state.membership, true);
    assert.equal(state.sequenceValue, 2);
    return state;
  });
  if (r2PrivateDirectory)
    await step('refuse-credential-access-to-attachments-bucket', () =>
      drill.command('r2-refuse-other-bucket'),
    );
  await step('initialize-encrypted-repository', () => drill.command('init'));
  await step('refuse-partial-dump', async () => {
    expectRefusal(
      await drill.command('failed-dump', [], { allowFailure: true }),
      'RECOVERY_DUMP_FAILED',
    );
    assert.deepEqual(JSON.parse((await drill.command('snapshots')).stdout) ?? [], []);
  });
  const snapshot = await step('backup-full-database-and-roles', async () => {
    const begin = performance.now();
    const result = await drill.command('backup');
    backupMs = Math.round(performance.now() - begin);
    const summary = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .find((line) => line.message_type === 'summary');
    assert.match(summary?.snapshot_id ?? '', /^[a-f0-9]{64}$/);
    const snapshots = JSON.parse((await drill.command('snapshots')).stdout);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, summary.snapshot_id);
    if (r2PrivateDirectory) retainedSnapshot = summary.snapshot_id;
    return summary.snapshot_id;
  });
  await step('verify-encryption-and-all-repository-data', async () => {
    await drill.command('check');
    await drill.command(r2PrivateDirectory ? 'r2-assert-encrypted' : 'assert-encrypted');
  });
  if (r2PrivateDirectory)
    await step('stop-source-before-remote-restoration', () =>
      drill.compose(['stop', '--timeout', '5', 'source']),
    );
  await step('refuse-wrong-key-without-creating-database', async () => {
    expectRefusal(
      await drill.command('wrong-key', [snapshot], { allowFailure: true }),
      'RECOVERY_REPOSITORY_INVALID',
    );
    assert.equal((await drill.command('target-empty')).stdout.trim(), '0');
  });
  await step('refuse-ambiguous-snapshot-selector', async () => {
    expectRefusal(
      await drill.command('restore', ['latest'], { allowFailure: true }),
      'RECOVERY_SNAPSHOT_REFUSED',
    );
    assert.equal((await drill.command('target-empty')).stdout.trim(), '0');
  });
  await step('restore-into-new-cluster-and-compare', async () => {
    const begin = performance.now();
    await drill.command('restore', [snapshot]);
    const actual = JSON.parse((await drill.command('inspect-target')).stdout);
    assert.deepEqual(actual, expected, 'RECOVERY_RESTORED_STATE_DIFFERS');
    assert.equal((await drill.command('target-passwords')).stdout.trim(), '0');
    restoreMs = Math.round(performance.now() - begin);
  });
  await step('refuse-occupied-target-without-changing-data', async () => {
    expectRefusal(
      await drill.command('restore', [snapshot], { allowFailure: true }),
      'RECOVERY_TARGET_OCCUPIED',
    );
    assert.deepEqual(JSON.parse((await drill.command('inspect-target')).stdout), expected);
  });
  await step('exercise-restored-permissions-and-constraints', () =>
    drill.command('assert-permissions'),
  );
  if (r2PrivateDirectory) {
    await step('refuse-corruption-command-for-remote-repository', async () => {
      expectRefusal(
        await drill.command('corrupt-repository', [], { allowFailure: true }),
        'RECOVERY_COMMAND_REFUSED',
      );
    });
  } else {
    await step('detect-corrupted-repository-data', async () => {
      await drill.command('corrupt-repository');
      const result = await drill.command('check', [], { allowFailure: true });
      assert.notEqual(result.code, 0, 'RECOVERY_CORRUPTION_UNDETECTED');
    });
  }
} catch (error) {
  failure = interrupted
    ? 'RECOVERY_DRILL_INTERRUPTED'
    : error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'RECOVERY_DRILL_ASSERTION_FAILED';
} finally {
  if (drill) {
    try {
      await step('remove-owned-test-resources', () => drill.cleanup());
    } catch (error) {
      cleanupFailure =
        error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'RECOVERY_CLEANUP_FAILED';
      failure ??= cleanupFailure;
    }
  }
}

process.removeListener('SIGINT', onInterrupt);
process.removeListener('SIGTERM', onInterrupt);

const report = {
  project: drill?.project ?? 'not-started',
  completedAt: new Date().toISOString(),
  status: failure ? 'failed' : 'passed',
  failure: failure ?? null,
  cleanupFailure: cleanupFailure ?? null,
  nodeVersion: process.version,
  postgresVersion: '18.4',
  resticVersion: '0.19.1',
  durationMs: Math.round(performance.now() - start),
  backupMs,
  restoreAndVerificationMs: restoreMs,
  productionRpoValidated: false,
  productionRtoValidated: false,
  externalStorageValidated: Boolean(r2PrivateDirectory && !failure),
  ...(r2PrivateDirectory
    ? { remoteTestBucket: 'stakeframe-backups', retainedTestSnapshot: retainedSnapshot ?? null }
    : {}),
  steps: results,
};
if (drill) console.info(`RECOVERY_REPORT ${await writeReport(report)}`);
if (drill?.r2Archive)
  await writeFile(join(drill.r2Archive, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
if (failure) {
  console.error(failure);
  if (cleanupFailure && cleanupFailure !== failure) console.error(cleanupFailure);
  process.exitCode = 1;
} else
  console.info(
    `RECOVERY_DRILL_PASSED ${results.length} steps; backup=${backupMs}ms; restore-and-verify=${restoreMs}ms`,
  );
