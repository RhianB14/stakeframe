// Pure deployment traceability helpers (no I/O) shared by the post-deploy verifier and
// the rollback planner. Every invalid input is refused with a stable code so a divergent
// deployment fails closed instead of being reported as verified.
export const DEFAULT_REPOSITORY_PREFIX = 'ghcr.io/rhianb14/stakeframe';
export const DEFAULT_SERVICES = ['api', 'worker', 'migrate', 'web', 'operations'];
const ENV_KEYS = {
  API_IMAGE: 'api',
  WORKER_IMAGE: 'worker',
  MIGRATE_IMAGE: 'migrate',
  WEB_IMAGE: 'web',
  OPERATIONS_IMAGE: 'operations',
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class TraceabilityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function assertValidExpectation({ version, commit }) {
  if (!VERSION_PATTERN.test(version ?? '') || !COMMIT_PATTERN.test(commit ?? ''))
    throw new TraceabilityError('EXPECTATION_INVALID');
}

export function parsePinnedImages(text, { repositoryPrefix = DEFAULT_REPOSITORY_PREFIX } = {}) {
  const pins = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+_IMAGE)=(.+)$/.exec(line.trim());
    if (!match) continue;
    const service = ENV_KEYS[match[1]];
    if (!service) continue;
    const reference = match[2].trim();
    const separator = reference.lastIndexOf('@');
    if (separator === -1) throw new TraceabilityError(`PIN_NOT_DIGEST ${service}`);
    const repository = reference.slice(0, separator);
    const digest = reference.slice(separator + 1);
    if (repository !== `${repositoryPrefix}-${service}`)
      throw new TraceabilityError(`PIN_REPOSITORY_REFUSED ${service}`);
    if (!DIGEST_PATTERN.test(digest)) throw new TraceabilityError(`PIN_DIGEST_REQUIRED ${service}`);
    pins.set(service, { reference, repository, digest });
  }
  if (pins.size === 0) throw new TraceabilityError('PIN_FILE_EMPTY');
  return pins;
}

/**
 * Compares the current and previous pinned sets and returns one entry per service in the
 * current set. A previous set missing a service present in the current set is refused:
 * a partial rollback source must never produce a half-applied plan.
 */
export function rollbackPlan({
  currentText,
  previousText,
  repositoryPrefix = DEFAULT_REPOSITORY_PREFIX,
}) {
  const current = parsePinnedImages(currentText, { repositoryPrefix });
  const previous = parsePinnedImages(previousText, { repositoryPrefix });
  const services = [];
  for (const [service, pin] of current) {
    const target = previous.get(service);
    if (!target) throw new TraceabilityError(`ROLLBACK_TARGET_MISSING ${service}`);
    services.push({
      service,
      changed: pin.reference !== target.reference,
      from: pin.reference,
      to: target.reference,
    });
  }
  return services;
}

export function rollbackCommands({
  services,
  envFilePath = '/etc/stakeframe/deployment.env',
  projectFiles = ['compose.production.yml', 'compose.integrations.yml', 'compose.operations.yml'],
}) {
  const changed = services.filter((entry) => entry.changed);
  const base = ['docker', 'compose', '--env-file', envFilePath];
  for (const file of projectFiles) base.push('-f', file);
  return changed.map((entry) => [...base, 'up', '-d', '--no-deps', entry.service].join(' '));
}

/**
 * Evaluates one observation set against the expected release. `containers` maps service
 * to { image, version, revision } (undefined when the container was not observed) and
 * `app` to the release metadata reported by the running application endpoint.
 */
export function traceabilityFailures({ pins, services, expected, containers = {}, app = null }) {
  assertValidExpectation(expected);
  const failures = [];
  for (const service of services) {
    const pin = pins.get(service);
    if (!pin) {
      failures.push(`PIN_MISSING ${service}`);
      continue;
    }
    const container = containers[service];
    if (!container) {
      failures.push(`CONTAINER_MISSING ${service}`);
      continue;
    }
    if (container.image !== pin.reference) failures.push(`IMAGE_MISMATCH ${service}`);
    if (container.version !== expected.version) failures.push(`LABEL_VERSION_MISMATCH ${service}`);
    if (container.revision !== expected.commit) failures.push(`LABEL_REVISION_MISMATCH ${service}`);
  }
  if (!app) failures.push('APP_UNREACHABLE');
  else {
    if (app.version !== expected.version) failures.push('APP_VERSION_MISMATCH');
    if (app.commit !== expected.commit) failures.push('APP_COMMIT_MISMATCH');
  }
  return failures;
}
