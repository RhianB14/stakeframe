// Executed through stdin inside a disposable, networkless runtime container.
import assert from 'node:assert/strict';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const target = process.env.IMAGE_TARGET;
assert.ok(['api', 'worker', 'migrate'].includes(target));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, process.env.EXPECTED_NODE_ARCH);
assert.equal(process.version, 'v24.20.0');
assert.notEqual(process.getuid(), 0);
assert.equal(process.cwd(), '/app');
const packageName = target === 'migrate' ? 'db' : target;
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.name, `@stakeframe/${packageName}`);
for (const path of ['src', 'tests', '.git', '.env.local', '.env', 'tsconfig.json', '/workspace']) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

const forbidden = new Set([
  'typescript',
  'typescript-eslint',
  'eslint',
  'vitest',
  'vite',
  'playwright',
  'playwright-core',
  '@playwright/test',
  'drizzle-kit',
  'esbuild',
  'prettier',
]);
const seen = new Set();
async function inspectModules(directory) {
  const actual = await realpath(directory);
  assert.ok(!relative('/app', actual).startsWith('..'), 'External workspace dependency');
  if (seen.has(actual)) return;
  seen.add(actual);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if ((await stat(path)).isDirectory()) await inspectModules(path);
    else if (entry.name === 'package.json') {
      const dependency = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(!forbidden.has(dependency.name), `Development dependency: ${dependency.name}`);
    }
  }
}
await inspectModules('node_modules');

if (target === 'api') {
  const { createApp } = await import('./dist/app.js');
  const app = createApp({ checkDatabase: async () => undefined });
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    assert.equal((await app.inject('/api/v1/me')).statusCode, 503);
    assert.equal((await app.inject('/api/openapi.json')).json().openapi, '3.0.3');
  } finally {
    await app.close();
  }
} else if (target === 'worker') {
  const { startWorker } = await import('./dist/worker.js');
  assert.equal(typeof startWorker, 'function');
  assert.equal(typeof (await import('pg-boss')).PgBoss, 'function');
} else {
  const { migrateLocalDatabase } = await import('./dist/migrate.js');
  assert.equal(typeof migrateLocalDatabase, 'function');
  const journal = JSON.parse(await readFile('migrations/meta/_journal.json', 'utf8'));
  assert.ok(journal.entries.length > 0);
  for (const entry of journal.entries) await access(`migrations/${entry.tag}.sql`);
}
// Resolve workspace dependencies from the deployed package, never from the host.
if (target !== 'migrate')
  assert.ok(import.meta.resolve('@stakeframe/db').startsWith('file:///app/'));
console.info(`RUNTIME_IMAGE_PASSED ${target} ${process.arch}`);
