import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { readConfig } from '../../apps/api/src/config.js';
import { apiErrorSchema, systemStatusSchema } from '../../packages/shared/src/index.js';
import { requireDatabaseUrl } from '../../packages/db/src/index.js';

const apps: ReturnType<typeof createApp>[] = [];
function appWithDatabase(available = true) {
  const app = createApp({
    checkDatabase: async () => {
      if (!available) throw new Error('private-db-error');
    },
  });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API local', () => {
  it.each([true, false])('separates liveness from database readiness (%s)', async (available) => {
    const app = appWithDatabase(available);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(available ? 200 : 503);
    expect(ready.json()).toEqual({ status: available ? 'ready' : 'unavailable' });
    const response = await app.inject('/api/v1/system/status');
    const status = systemStatusSchema.parse(response.json());
    expect(status.database).toBe(available ? 'available' : 'unavailable');
    expect(status.productEnabled).toBe(false);
    expect(status.authentication).toBe('not-configured');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('private-db-error');
  });
  it('does not expose product routes or trust a caller request ID', async () => {
    const response = await appWithDatabase().inject({
      url: '/api/v1/bets',
      headers: { 'x-request-id': 'caller-controlled' },
    });
    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    expect(response.body).not.toContain('caller-controlled');
  });
  it('sanitizes unexpected errors without exposing database details', async () => {
    const app = appWithDatabase();
    app.get('/test-error', async () => {
      throw new Error('postgresql://private:secret@private-host/private-db');
    });
    const response = await app.inject('/test-error');
    expect(response.statusCode).toBe(500);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toMatch(/secret|private-host|stack/);
  });
  it('returns the stable error contract for malformed JSON', async () => {
    const app = appWithDatabase();
    app.post('/test-json', async () => ({ ok: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/test-json',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('INVALID_REQUEST');
  });
});

describe('configuration', () => {
  const DATABASE_URL = 'postgresql://localhost/stakeframe_test';
  it.each([undefined, 'production', 'staging'])(
    'refuses a runtime other than explicit local (%s)',
    (runtime) => {
      expect(() =>
        readConfig({ DATABASE_URL, ...(runtime ? { STAKEFRAME_RUNTIME: runtime } : {}) }),
      ).toThrow('STAKEFRAME_RUNTIME=local');
    },
  );
  it.each(['0', '65536', 'abc'])('refuses invalid API ports (%s)', (API_PORT) => {
    expect(() => readConfig({ DATABASE_URL, STAKEFRAME_RUNTIME: 'local', API_PORT })).toThrow();
  });
  it('binds the API to loopback by default', () => {
    expect(readConfig({ DATABASE_URL, STAKEFRAME_RUNTIME: 'local' })).toEqual({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: DATABASE_URL,
      auth: { enabled: false },
    });
  });
  it.each([undefined, '', 'https://private-secret@example.test/db', 'postgresql://localhost'])(
    'rejects invalid database URLs without reflecting input',
    (value) => {
      expect(() => requireDatabaseUrl(value)).toThrow(
        'DATABASE_URL must be a PostgreSQL connection URL',
      );
    },
  );
});
