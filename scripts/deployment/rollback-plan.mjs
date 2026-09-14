// Rollback planner. Given the deployed pin set and a recorded previous pin set, emits the
// exact per-service commands to return the deployment to the previous images. Resolution
// is digest-only; a missing previous image in the local store refuses the plan, so a
// rollback is never attempted towards bytes this host cannot run. Schema migrations are
// forward-only: the printed gate requires the operator to confirm (read-only) that the
// applied migration set is compatible with the target release before executing anything.
//
// Usage:
//   node scripts/deployment/rollback-plan.mjs --current <deployment.env> \
//     --previous <deployment.previous.env> [--check] [--env-file-path /etc/stakeframe/deployment.env]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_REPOSITORY_PREFIX,
  TraceabilityError,
  rollbackCommands,
  rollbackPlan,
} from './traceability.mjs';

function parseArguments(argv) {
  const options = { repositoryPrefix: DEFAULT_REPOSITORY_PREFIX, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new TraceabilityError('ARGUMENT_REQUIRED');
    if (flag === '--current') options.current = value;
    else if (flag === '--previous') options.previous = value;
    else if (flag === '--env-file-path') options.envFilePath = value;
    else if (flag === '--repository-prefix') options.repositoryPrefix = value;
    else throw new TraceabilityError('ARGUMENT_UNKNOWN');
    index += 1;
  }
  if (!options.current || !options.previous) throw new TraceabilityError('ARGUMENT_REQUIRED');
  return options;
}

function imageAvailable(reference) {
  try {
    execFileSync('docker', ['image', 'inspect', reference], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const services = rollbackPlan({
    currentText: readFileSync(options.current, 'utf8'),
    previousText: readFileSync(options.previous, 'utf8'),
    repositoryPrefix: options.repositoryPrefix,
  });
  const changed = services.filter((entry) => entry.changed);
  for (const entry of services)
    console.info(
      entry.changed
        ? `ROLLBACK_STEP ${entry.service} ${entry.from} -> ${entry.to}`
        : `ROLLBACK_UNCHANGED ${entry.service} ${entry.from}`,
    );
  if (options.check)
    for (const entry of changed)
      if (!imageAvailable(entry.to))
        throw new TraceabilityError(`ROLLBACK_IMAGE_MISSING ${entry.service}`);
  if (changed.length === 0) {
    console.info('ROLLBACK_PLAN_READY changed=0');
    return;
  }
  console.info('ROLLBACK_COMMANDS:');
  for (const command of rollbackCommands({ services, envFilePath: options.envFilePath }))
    console.info(command);
  console.info(
    'ROLLBACK_MIGRATION_CHECK_REQUIRED confirm applied migrations are compatible with the target release (docs/ROLLBACK.md) before running the commands',
  );
  console.info(`ROLLBACK_PLAN_READY changed=${changed.length}`);
}

try {
  main();
} catch (error) {
  const code = error instanceof TraceabilityError ? error.code : 'UNEXPECTED_FAILURE';
  console.error(`ROLLBACK_PLAN_REFUSED ${code}`);
  process.exitCode = 1;
}
