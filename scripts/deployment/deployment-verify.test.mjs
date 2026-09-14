import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REPOSITORY_PREFIX } from './traceability.mjs';

const COMMIT = 'a'.repeat(40);
const VERSION = '0.1.0-beta.1';
const digest = (character) => `sha256:${character.repeat(64)}`;
const pinFile = (entries) =>
  Object.entries(entries)
    .map(
      ([service, character]) =>
        `${service.toUpperCase()}_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-${service}@${digest(character)}`,
    )
    .join('\n') + '\n';
const fullSet = { api: '1', worker: '2', migrate: '3', web: '4', operations: '5' };

// execFile (async) keeps the test's local HTTP server able to answer while the CLI runs.
function verifyResult(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/deployment-verify.mjs', ...args],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ status: error ? error.code : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

async function withDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'stk-verify-'));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function serveRelease(version, commit) {
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/system/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ release: { version, commit } }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('refuses a deployment.env holding only API_IMAGE in the default mode', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'deployment.env');
    writeFileSync(file, pinFile({ api: '1' }));
    const result = await verifyResult([
      '--env-file',
      file,
      '--endpoint',
      'http://127.0.0.1:9',
      '--expect-version',
      VERSION,
      '--expect-commit',
      COMMIT,
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /PINS_INCOMPLETE deployment\.env missing=worker,migrate,web,operations/,
    );
  });
});

test('refuses a deployment.env missing one of the five services in the default mode', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'deployment.env');
    const four = { ...fullSet };
    delete four.web;
    writeFileSync(file, pinFile(four));
    const result = await verifyResult([
      '--env-file',
      file,
      '--endpoint',
      'http://127.0.0.1:9',
      '--expect-version',
      VERSION,
      '--expect-commit',
      COMMIT,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PINS_INCOMPLETE deployment\.env missing=web/);
  });
});

test('refuses a duplicated *_IMAGE key instead of silently taking the last value', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'deployment.env');
    writeFileSync(
      file,
      `${pinFile(fullSet)}API_IMAGE=${DEFAULT_REPOSITORY_PREFIX}-api@${digest('9')}\n`,
    );
    const result = await verifyResult([
      '--env-file',
      file,
      '--endpoint',
      'http://127.0.0.1:9',
      '--expect-version',
      VERSION,
      '--expect-commit',
      COMMIT,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PIN_DUPLICATE_KEY API_IMAGE/);
  });
});

test('refuses --skip-docker without an explicit partial --services list', async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, 'deployment.env');
    writeFileSync(file, pinFile(fullSet));
    const result = await verifyResult([
      '--env-file',
      file,
      '--endpoint',
      'http://127.0.0.1:9',
      '--expect-version',
      VERSION,
      '--expect-commit',
      COMMIT,
      '--skip-docker',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SKIP_DOCKER_REQUIRES_SERVICES/);
  });
});

test('verifies an explicitly listed complete set with a reachable application end to end', async () => {
  const { server, port } = await serveRelease(VERSION, COMMIT);
  try {
    await withDirectory(async (directory) => {
      const file = join(directory, 'deployment.env');
      writeFileSync(file, pinFile(fullSet));
      const result = await verifyResult([
        '--env-file',
        file,
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--expect-version',
        VERSION,
        '--expect-commit',
        COMMIT,
        '--services',
        'api,worker,migrate,web,operations',
        '--skip-docker',
      ]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /DEPLOYMENT_TRACEABILITY_VERIFIED version=0\.1\.0-beta\.1/);
      assert.match(result.stdout, /mode=explicit/);
      assert.match(result.stdout, /services=5/);
    });
  } finally {
    server.close();
  }
});

test('explicit partial mode validates only the listed services and reports it', async () => {
  const { server, port } = await serveRelease(VERSION, COMMIT);
  try {
    await withDirectory(async (directory) => {
      const file = join(directory, 'deployment.env');
      writeFileSync(file, pinFile({ api: '1' }));
      const partial = await verifyResult([
        '--env-file',
        file,
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--expect-version',
        VERSION,
        '--expect-commit',
        COMMIT,
        '--services',
        'api',
        '--skip-docker',
      ]);
      assert.equal(partial.status, 0);
      assert.match(partial.stdout, /mode=explicit/);
      assert.match(partial.stdout, /services=1/);
      const defaultMode = await verifyResult([
        '--env-file',
        file,
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--expect-version',
        VERSION,
        '--expect-commit',
        COMMIT,
      ]);
      assert.equal(defaultMode.status, 1);
      assert.match(
        defaultMode.stderr,
        /PINS_INCOMPLETE deployment\.env missing=worker,migrate,web,operations/,
      );
    });
  } finally {
    server.close();
  }
});
