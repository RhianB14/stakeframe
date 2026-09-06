import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { format, resolveConfig } from 'prettier';
import { createApp } from '../apps/api/dist/app.js';

const destination = new URL('../docs/openapi.json', import.meta.url);
const mode = process.argv[2];
if (!['--write', '--check'].includes(mode) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/openapi.mjs --write|--check');
}
const app = createApp({
  checkDatabase: async () => {
    throw new Error('SPEC_EXPORT_HAS_NO_DATABASE');
  },
});
try {
  await app.ready();
  const document = app.swagger();
  await SwaggerParser.validate(structuredClone(document), {
    resolve: { external: false, file: false, http: false },
  });
  const output = await format(JSON.stringify(document), {
    ...(await resolveConfig(fileURLToPath(destination))),
    parser: 'json',
  });
  if (mode === '--write') {
    await writeFile(destination, output);
    console.info('OPENAPI_EXPORTED');
  } else {
    const current = await readFile(destination, 'utf8');
    if (current.replaceAll('\r\n', '\n') !== output) {
      console.error('OPENAPI_OUTDATED: run pnpm api:spec and review the diff');
      process.exitCode = 1;
    } else console.info('OPENAPI_VALID_AND_CURRENT');
  }
} finally {
  await app.close();
}
