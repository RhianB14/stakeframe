// Post-deploy traceability verifier. Compares the pinned digests, the running containers
// and the release metadata reported by the application endpoint against one expected
// release. Any divergence refuses with DEPLOYMENT_TRACEABILITY_REFUSED and exit code 1.
//
// Modes:
// - default (full): the deployment.env must pin exactly the five services
//   (api, worker, migrate, web, operations); missing pins or duplicated keys refuse the
//   whole check, and the container inspection cannot be skipped.
// - explicit (--services a,b,...): the operator declares the services to verify. This is
//   the only way to run a partial check (documented in docs/RELEASE-TRACEABILITY.md);
//   each listed service must be known and pinned, --skip-docker is allowed here and the
//   output is marked mode=explicit so a partial run is never mistaken for a full one.
//
// Usage (on the VPS, after an authorized deployment):
//   node scripts/deployment-verify.mjs --env-file /etc/stakeframe/deployment.env \
//     --endpoint http://127.0.0.1:8080 --expect-version 0.1.0-beta.1 --expect-commit <sha>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_REPOSITORY_PREFIX,
  DEFAULT_SERVICES,
  TraceabilityError,
  assertValidExpectation,
  parsePinnedImages,
  requireCompletePins,
  traceabilityFailures,
} from './deployment/traceability.mjs';

function parseArguments(argv) {
  const options = {
    repositoryPrefix: DEFAULT_REPOSITORY_PREFIX,
    project: 'stakeframe-production',
    services: undefined,
    skipDocker: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--skip-docker') {
      options.skipDocker = true;
      continue;
    }
    if (flag === '--docker') {
      options.skipDocker = false;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new TraceabilityError('ARGUMENT_REQUIRED');
    if (flag === '--env-file') options.envFile = value;
    else if (flag === '--endpoint') options.endpoint = value;
    else if (flag === '--expect-version') options.version = value;
    else if (flag === '--expect-commit') options.commit = value;
    else if (flag === '--repository-prefix') options.repositoryPrefix = value;
    else if (flag === '--project') options.project = value;
    else if (flag === '--services') options.services = value.split(',').map((name) => name.trim());
    else throw new TraceabilityError('ARGUMENT_UNKNOWN');
    index += 1;
  }
  if (!options.envFile || !options.endpoint || !options.version || !options.commit)
    throw new TraceabilityError('ARGUMENT_REQUIRED');
  assertValidExpectation({ version: options.version, commit: options.commit });
  return options;
}

function observeContainer(project, service) {
  const name = `${project}-${service}-1`;
  let output;
  try {
    output = execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',
        name,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return undefined;
  }
  const [image, version, revision] = output.trim().split('|');
  return {
    image,
    version: version === '<no value>' ? undefined : version,
    revision: revision === '<no value>' ? undefined : revision,
  };
}

async function observeApplication(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/system/status`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    const release = body?.release;
    if (!release || typeof release !== 'object') return null;
    return { version: release.version, commit: release.commit };
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const pins = parsePinnedImages(readFileSync(options.envFile, 'utf8'), {
    repositoryPrefix: options.repositoryPrefix,
  });
  // Default mode is the complete operational set and cannot be partial; skipping the
  // container inspection is only available for an explicit --services list.
  if (!options.services) requireCompletePins(pins);
  if (options.skipDocker && !options.services)
    throw new TraceabilityError('SKIP_DOCKER_REQUIRES_SERVICES');
  const services = options.services ?? DEFAULT_SERVICES;
  for (const service of services)
    if (!DEFAULT_SERVICES.includes(service)) throw new TraceabilityError('SERVICE_UNKNOWN');
  const containers = {};
  if (!options.skipDocker)
    for (const service of services)
      containers[service] = observeContainer(options.project, service);
  const app = await observeApplication(options.endpoint);
  const failures = traceabilityFailures({
    pins,
    services,
    expected: { version: options.version, commit: options.commit },
    containers,
    app,
    skipContainers: options.skipDocker,
  });
  if (failures.length > 0) {
    console.error(`DEPLOYMENT_TRACEABILITY_REFUSED ${failures.join(' ')}`);
    process.exitCode = 1;
    return;
  }
  const mode = options.services ? 'explicit' : 'full';
  const digests = services.map((service) => `${service}:${pins.get(service).digest.slice(0, 19)}`);
  console.info(
    `DEPLOYMENT_TRACEABILITY_VERIFIED version=${options.version} commit=${options.commit.slice(0, 12)} mode=${mode} services=${services.length}`,
  );
  console.info(`DEPLOYMENT_TRACEABILITY_DIGESTS ${digests.join(' ')}`);
}

try {
  await main();
} catch (error) {
  const code = error instanceof TraceabilityError ? error.code : 'UNEXPECTED_FAILURE';
  console.error(`DEPLOYMENT_TRACEABILITY_REFUSED ${code}`);
  process.exitCode = 1;
}
