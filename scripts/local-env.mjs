import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const content = [
  '# Generated for disposable/local development only. Never commit this file.',
  `LOCAL_DB_PASSWORD=${randomBytes(24).toString('hex')}`,
  'LOCAL_DB_PORT=55432',
  'LOCAL_WEB_PORT=8088',
  '',
].join('\n');

try {
  writeFileSync(new URL('../.env.local', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.info('Created .env.local. Local credentials were not printed.');
} catch (error) {
  if (error.code === 'EEXIST')
    console.info('.env.local already exists; preserved without changes.');
  else throw error;
}
