// Legacy deploy resolves workspace file references again. Reject any package
// version that was not present in the preceding frozen-lockfile installation.
import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

async function inventory(root) {
  const seen = new Set();
  const packages = new Set();
  async function visit(directory, mode = 'modules') {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (seen.has(actual)) return;
    seen.add(actual);
    if (mode === 'package') {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      packages.add(`${manifest.name}@${manifest.version}`);
      await visit(join(directory, 'node_modules'));
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.name === '.pnpm') {
        for (const virtual of await readdir(path, { withFileTypes: true })) {
          if (virtual.isDirectory())
            await visit(
              join(path, virtual.name, virtual.name === 'node_modules' ? '' : 'node_modules'),
            );
        }
      } else if (entry.name.startsWith('@')) await visit(path);
      else if (!entry.name.startsWith('.')) await visit(path, 'package');
    }
  }
  await visit(join(root, 'node_modules'));
  return packages;
}

const [source, ...destinations] = process.argv.slice(2);
assert.ok(source && destinations.length > 0);
const installed = await inventory(source);
assert.ok(installed.size > 0);
for (const destination of destinations) {
  const deployed = await inventory(destination);
  assert.ok(deployed.size > 0);
  for (const identifier of deployed)
    assert.ok(installed.has(identifier), `DEPLOY_VERSION_DRIFT ${identifier}`);
  console.info(`DEPLOY_VERSIONS_VERIFIED ${destination} ${deployed.size}`);
}
