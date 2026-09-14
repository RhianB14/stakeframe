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
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+_IMAGE)=(.+)$/.exec(line.trim());
    if (!match) continue;
    const service = ENV_KEYS[match[1]];
    if (!service) continue;
    // A repeated key would otherwise silently accept the last occurrence; the pin set
    // must be unambiguous, so duplicates are refused outright.
    if (keys.has(match[1])) throw new TraceabilityError(`PIN_DUPLICATE_KEY ${match[1]}`);
    keys.add(match[1]);
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
 * The operational default set is exactly the five services; a deployment.env (or a
 * rollback source) that does not pin all of them is refused as a whole. Callers pass a
 * specific refusal code so failures name the file that was incomplete.
 */
export function requireCompletePins(pins, code = 'PINS_INCOMPLETE deployment.env') {
  const missing = DEFAULT_SERVICES.filter((service) => !pins.has(service));
  if (missing.length > 0) throw new TraceabilityError(`${code} missing=${missing.join(',')}`);
}

/**
 * Compares the current and previous pinned sets and returns one entry per service in the
 * current set. Both sets must pin exactly the five services: a partial current or
 * previous set is refused before any plan is produced.
 */
export function rollbackPlan({
  currentText,
  previousText,
  repositoryPrefix = DEFAULT_REPOSITORY_PREFIX,
}) {
  const current = parsePinnedImages(currentText, { repositoryPrefix });
  requireCompletePins(current, 'ROLLBACK_CURRENT_INCOMPLETE');
  const previous = parsePinnedImages(previousText, { repositoryPrefix });
  requireCompletePins(previous, 'ROLLBACK_PREVIOUS_INCOMPLETE');
  const services = [];
  for (const [service, pin] of current) {
    const target = previous.get(service);
    // Defence in depth: unreachable while both sets are complete, kept so a future
    // relaxation of completeness still cannot produce a half-applied plan.
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
 * `skipContainers` is only used by the explicit `--services` verification mode, where
 * the operator opted out of the container inspection; the pin must still exist for
 * every listed service.
 */
export function traceabilityFailures({
  pins,
  services,
  expected,
  containers = {},
  app = null,
  skipContainers = false,
}) {
  assertValidExpectation(expected);
  const failures = [];
  for (const service of services) {
    const pin = pins.get(service);
    if (!pin) {
      failures.push(`PIN_MISSING ${service}`);
      continue;
    }
    if (skipContainers) continue;
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
