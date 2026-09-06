import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../apps/api/src/config.js';
import {
  readRuntime,
  readSecret,
  readDatabaseConfig,
} from '../../packages/db/src/runtime-config.js';

const directory = mkdtempSync(join(tmpdir(), 'stk-config-test-'));
const files = ['db', 'auth', 'google', 'crlf', 'multiline', 'oversized'];
for (const name of files)
  writeFileSync(
    join(directory, name),
    name === 'multiline'
      ? 'first\nsecond'
      : name === 'oversized'
        ? 'a'.repeat(4097)
        : 'a'.repeat(64) + (name === 'crlf' ? '\r\n' : '\n'),
    { mode: 0o600, flag: 'wx' },
  );
afterAll(() => {
  for (const name of files) unlinkSync(join(directory, name));
  rmdirSync(directory);
});
const environment = {
  STAKEFRAME_RUNTIME: 'production',
  NODE_ENV: 'production',
  AUTH_ENABLED: 'true',
  APP_ORIGIN: 'https://stakeframe.example.test',
  GOOGLE_CLIENT_ID: 'test-client',
  AUTHORIZED_GOOGLE_EMAIL: 'owner@example.test',
  AUTHORIZED_GOOGLE_SUB: '123456789',
  DB_PASSWORD_FILE: join(directory, 'db'),
  BETTER_AUTH_SECRET_FILE: join(directory, 'auth'),
  GOOGLE_CLIENT_SECRET_FILE: join(directory, 'google'),
};

describe('production configuration boundaries', () => {
  it('uses the private PostgreSQL service and a non-administrative application role', () => {
    const config = readConfig(environment);
    expect(config.runtime).toBe('production');
    expect(config.auth.enabled).toBe(true);
    expect(config.databaseUrl).toBe(
      `postgresql://stakeframe_app:${'a'.repeat(64)}@postgres:5432/stakeframe`,
    );
  });
  it.each([undefined, 'false', 'yes'])('requires authentication (%s)', (AUTH_ENABLED) => {
    expect(() => readConfig({ ...environment, AUTH_ENABLED })).toThrow('PRODUCTION_AUTH_REQUIRED');
  });
  it.each([
    'http://stakeframe.example.test',
    'http://127.0.0.1',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://app.localhost',
    'https://app.example.test:444',
    'https://app.example.test/path',
    'https://user:secret@app.example.test',
  ])('refuses an unsafe public origin (%s)', (APP_ORIGIN) => {
    expect(() => readConfig({ ...environment, APP_ORIGIN })).toThrow();
  });
  it('requires production NODE_ENV and rejects an alternate database URL', () => {
    expect(() => readRuntime({ ...environment, NODE_ENV: 'development' })).toThrow(
      'INVALID_RUNTIME_CONFIGURATION',
    );
    expect(() =>
      readDatabaseConfig({
        ...environment,
        DATABASE_URL: 'postgresql://private:secret@elsewhere/db',
      }),
    ).toThrow('PRODUCTION_DATABASE_URL_REFUSED');
  });
  it.each(['DB_PASSWORD', 'BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_SECRET'])(
    'requires only a secret file for %s',
    (name) => {
      expect(() => readConfig({ ...environment, [name]: 'private-secret' })).toThrow(
        'AMBIGUOUS_SECRET_CONFIGURATION',
      );
      expect(() =>
        readConfig({ ...environment, [`${name}_FILE`]: undefined, [name]: 'private-secret' }),
      ).toThrow('SECRET_FILE_REQUIRED');
    },
  );
  it.each(['missing', 'multiline', 'oversized'])(
    'sanitizes invalid secret file errors (%s)',
    (file) => {
      expect(() => readSecret({ SECRET_FILE: join(directory, file) }, 'SECRET')).toThrow(
        'SECRET_FILE_INVALID',
      );
    },
  );
  it('refuses relative paths and strips only the final line ending', () => {
    expect(() => readSecret({ SECRET_FILE: 'private-path' }, 'SECRET')).toThrow(
      'SECRET_FILE_INVALID',
    );
    expect(readSecret({ SECRET_FILE: join(directory, 'db') }, 'SECRET')).toBe('a'.repeat(64));
    expect(readSecret({ SECRET_FILE: join(directory, 'crlf') }, 'SECRET')).toBe('a'.repeat(64));
  });
});
