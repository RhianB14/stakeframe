import { dirname, resolve } from 'node:path';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execute, root } from './recovery/runtime.mjs';
import { assertDeploymentConfig } from './deployment/config.mjs';
import { inspectSecretDirectories } from './deployment/secrets.mjs';

try {
  const [file, ...extra] = process.argv.slice(2);
  if (
    !file ||
    extra.some(
      (value) => !['--integrations', '--tavily', '--automatic', '--operations'].includes(value),
    ) ||
    new Set(extra).size !== extra.length
  )
    throw new Error();
  const options = {
    integrations: extra.includes('--integrations'),
    tavily: extra.includes('--tavily'),
    automatic: extra.includes('--automatic'),
    operations: extra.includes('--operations'),
  };
  const overlays = [];
  for (const [enabled, filename] of [
    [options.integrations, 'compose.integrations.yml'],
    [options.tavily, 'compose.tavily.yml'],
    [options.automatic, 'compose.automatic-import.yml'],
    [options.operations, 'compose.operations.yml'],
  ])
    if (enabled) overlays.push('-f', resolve(root, filename));
  // Configuration rendering only: no daemon, image pull, migration or service startup.
  const result = await execute('docker', [
    'compose',
    '--env-file',
    resolve(file),
    '-f',
    resolve(root, 'compose.production.yml'),
    ...overlays,
    '--profile',
    'migration',
    ...(options.operations ? ['--profile', 'operations'] : []),
    'config',
    '--format',
    'json',
  ]);
  const config = assertDeploymentConfig(JSON.parse(result.stdout), options);
  for (const secret of Object.values(config.secrets)) {
    const info = await lstat(secret.file);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error();
    await access(secret.file, constants.R_OK);
  }
  // The directory holding each secret must not expose names or metadata to
  // group or other users. Repeated directories are verified exactly once.
  await inspectSecretDirectories(
    Object.values(config.secrets).map((secret) => dirname(secret.file)),
  );
  if (options.automatic) {
    const file = config.services.worker.volumes[0].source;
    const info = await lstat(file);
    if (!info.isFile() || info.size < 1 || info.size > 32768) throw new Error();
    await access(file, constants.R_OK);
  }
  console.info('DEPLOYMENT_CONFIGURATION_VERIFIED');
} catch {
  console.error('DEPLOYMENT_CONFIGURATION_REFUSED');
  process.exitCode = 1;
}
