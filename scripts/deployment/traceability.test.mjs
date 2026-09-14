import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPOSITORY_PREFIX,
  TraceabilityError,
  parsePinnedImages,
  requireCompletePins,
  rollbackCommands,
  rollbackPlan,
  traceabilityFailures,
} from './traceability.mjs';

const COMMIT = 'a'.repeat(40);
const VERSION = '0.1.0-beta.1';
const digest = (character) => `sha256:${character.repeat(64)}`;
const pinFile = (entries = {}) =>
  Object.entries(entries)
    .map(
      ([service, character]) =>
        `${service.toUpperCase()}_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-${service}@${digest(character)}`,
    )
    .join('\n');
const fullSet = { api: '1', worker: '2', migrate: '3', web: '4', operations: '5' };
const observations = (overrides = {}) => ({
  containers: Object.fromEntries(
    Object.keys(fullSet).map((service) => [
      service,
      {
        image: `${DEFAULT_REPOSITORY_PREFIX}-${service}@${digest(fullSet[service])}`,
        version: VERSION,
        revision: COMMIT,
      },
    ]),
  ),
  app: { version: VERSION, commit: COMMIT },
  ...overrides,
});

test('parses only digest-pinned images of this project and refuses anything else', () => {
  const pins = parsePinnedImages(pinFile(fullSet));
  assert.equal(pins.size, 5);
  assert.equal(pins.get('web').digest, digest('4'));
  const refusals = [
    [`API_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-api:latest`, 'PIN_NOT_DIGEST api'],
    [`API_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-api@sha256:short`, 'PIN_DIGEST_REQUIRED api'],
    [`API_IMAGE=ghcr.io/other/repo@${digest('1')}`, 'PIN_REPOSITORY_REFUSED api'],
  ];
  for (const [line, code] of refusals)
    assert.throws(
      () => parsePinnedImages(line),
      (error) => error instanceof TraceabilityError && error.code === code,
    );
  assert.throws(() => parsePinnedImages('# empty'), /PIN_FILE_EMPTY/);
});

test('rejects a duplicated *_IMAGE key instead of silently taking the last value', () => {
  const duplicated = `${pinFile(fullSet)}\nAPI_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-api@${digest('9')}\n`;
  assert.throws(
    () => parsePinnedImages(duplicated),
    (error) => error instanceof TraceabilityError && error.code === 'PIN_DUPLICATE_KEY API_IMAGE',
  );
});

test('requires exactly the five pinned services for the operational default set', () => {
  requireCompletePins(parsePinnedImages(pinFile(fullSet)));
  assert.throws(
    () => requireCompletePins(parsePinnedImages(pinFile({ api: '1' }))),
    /PINS_INCOMPLETE deployment\.env missing=worker,migrate,web,operations/,
  );
  const four = { ...fullSet };
  delete four.web;
  assert.throws(
    () => requireCompletePins(parsePinnedImages(pinFile(four))),
    /PINS_INCOMPLETE deployment\.env missing=web/,
  );
});

test('rollback requires complete current and previous sets', () => {
  const full = pinFile(fullSet);
  assert.throws(
    () => rollbackPlan({ currentText: pinFile({ api: 'a' }), previousText: full }),
    /ROLLBACK_CURRENT_INCOMPLETE missing=worker,migrate,web,operations/,
  );
  assert.throws(
    () => rollbackPlan({ currentText: full, previousText: pinFile({ api: '1' }) }),
    /ROLLBACK_PREVIOUS_INCOMPLETE missing=worker,migrate,web,operations/,
  );
});

test('verifies containers, labels and the application against the expected release', () => {
  const pins = parsePinnedImages(pinFile(fullSet));
  const services = [...pins.keys()];
  const expected = { version: VERSION, commit: COMMIT };
  assert.deepEqual(traceabilityFailures({ pins, services, expected, ...observations() }), []);
  const cases = [
    [{ containers: {} }, 'CONTAINER_MISSING web'],
    [
      {
        containers: {
          ...observations().containers,
          api: { image: 'ghcr.io/other@' + digest('9'), version: VERSION, revision: COMMIT },
        },
      },
      'IMAGE_MISMATCH api',
    ],
    [
      {
        containers: {
          ...observations().containers,
          worker: {
            image: `${DEFAULT_REPOSITORY_PREFIX}-worker@${digest('2')}`,
            version: 'unversioned',
            revision: COMMIT,
          },
        },
      },
      'LABEL_VERSION_MISMATCH worker',
    ],
    [
      {
        containers: {
          ...observations().containers,
          migrate: {
            image: `${DEFAULT_REPOSITORY_PREFIX}-migrate@${digest('3')}`,
            version: VERSION,
            revision: 'unknown',
          },
        },
      },
      'LABEL_REVISION_MISMATCH migrate',
    ],
    [{ app: null }, 'APP_UNREACHABLE'],
    [{ app: { version: '0.2.0-beta.1', commit: COMMIT } }, 'APP_VERSION_MISMATCH'],
    [{ app: { version: VERSION, commit: 'b'.repeat(40) } }, 'APP_COMMIT_MISMATCH'],
  ];
  for (const [override, code] of cases) {
    const failures = traceabilityFailures({ pins, services, expected, ...observations(override) });
    assert.ok(failures.includes(code), `${code} missing from ${failures.join(',')}`);
  }
  assert.throws(
    () => traceabilityFailures({ pins, services, expected: { version: '1.0', commit: COMMIT } }),
    /EXPECTATION_INVALID/,
  );
  // Explicit container-skip mode still requires the pin to exist and verifies the app.
  assert.deepEqual(
    traceabilityFailures({
      pins,
      services,
      expected,
      containers: {},
      app: { version: VERSION, commit: COMMIT },
      skipContainers: true,
    }),
    [],
  );
  assert.deepEqual(
    traceabilityFailures({
      pins: parsePinnedImages(pinFile({ api: '1' })),
      services: ['api', 'worker'],
      expected,
      containers: {},
      app: { version: VERSION, commit: COMMIT },
      skipContainers: true,
    }),
    ['PIN_MISSING worker'],
  );
});

test('rolls back only known services and builds digest-only commands', () => {
  const currentText = pinFile({ ...fullSet, api: 'a' });
  const previousText = pinFile(fullSet);
  const services = rollbackPlan({ currentText, previousText });
  const changed = services.filter((entry) => entry.changed);
  assert.deepEqual(
    changed.map((entry) => entry.service),
    ['api'],
  );
  assert.equal(changed[0].from, `${DEFAULT_REPOSITORY_PREFIX}-api@${digest('a')}`);
  assert.equal(changed[0].to, `${DEFAULT_REPOSITORY_PREFIX}-api@${digest('1')}`);
  const commands = rollbackCommands({ services, envFilePath: '/etc/stakeframe/deployment.env' });
  assert.equal(commands.length, 1);
  assert.match(
    commands[0],
    /^docker compose --env-file \/etc\/stakeframe\/deployment\.env -f compose\.production\.yml -f compose\.integrations\.yml -f compose\.operations\.yml up -d --no-deps api$/,
  );
  assert.deepEqual(
    rollbackPlan({ currentText, previousText: currentText }).filter((entry) => entry.changed),
    [],
  );
  assert.throws(
    () => rollbackPlan({ currentText, previousText: pinFile({ api: '1' }) }),
    /ROLLBACK_PREVIOUS_INCOMPLETE missing=worker,migrate,web,operations/,
  );
});
