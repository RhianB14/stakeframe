import { resolve } from 'node:path';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execute, root } from './recovery/runtime.mjs';
import { assertDeploymentConfig } from './deployment/config.mjs';

try {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error();
  // Configuration rendering only: no daemon, image pull, migration or service startup.
  const result = await execute('docker', [
    'compose',
    '--env-file',
    resolve(file),
    '-f',
    resolve(root, 'compose.production.yml'),
    '--profile',
    'migration',
    'config',
    '--format',
    'json',
  ]);
  const config = assertDeploymentConfig(JSON.parse(result.stdout));
  for (const secret of Object.values(config.secrets)) {
    const info = await lstat(secret.file);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error();
    await access(secret.file, constants.R_OK);
  }
  console.info('DEPLOYMENT_CONFIGURATION_VERIFIED');
} catch {
  console.error('DEPLOYMENT_CONFIGURATION_REFUSED');
  process.exitCode = 1;
}
