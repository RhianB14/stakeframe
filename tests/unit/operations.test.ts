import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../../packages/db/src/index.js';
import { OPENROUTER_MODEL, operationsHealthSchema } from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { createOperationsService } from '../../apps/api/src/operations.js';
import { createBudgetProbe } from '../../apps/worker/src/budget.js';

const apps: ReturnType<typeof createApp>[] = [];
const databases: Database[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  vi.restoreAllMocks();
});
const ai = {
  AI_ENABLED: 'true',
  AI_PROVIDER: 'openrouter',
  OPENROUTER_MODEL,
  OPENROUTER_ALLOW_FALLBACKS: 'true',
  OPENROUTER_API_KEY: `sk-or-v1-${'a'.repeat(64)}`,
};
const key = {
  limit: 5,
  limit_remaining: 4,
  limit_reset: 'monthly',
  usage_monthly: 1,
  is_management_key: false,
};

describe('operational monitoring', () => {
  it('uses only the current-key read endpoint and coalesces concurrent budget checks', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      expect(url).toBe('https://openrouter.ai/api/v1/key');
      expect(options?.method).toBeUndefined();
      expect(options?.redirect).toBe('error');
      return Response.json({ data: key });
    });
    let now = 1000;
    const probe = createBudgetProbe(ai, fetchImpl, () => now);
    expect(await Promise.all([probe.read(), probe.read(), probe.read()])).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 300001;
    await probe.requireBudget();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    { limit: 6 },
    { limit_remaining: 0 },
    { limit_reset: null },
    { is_management_key: true },
    { limit_remaining: null },
  ])(
    'refuses generation when budget evidence is missing or outside policy (%j)',
    async (override) => {
      const probe = createBudgetProbe(ai, async () =>
        Response.json({ data: { ...key, ...override } }),
      );
      expect(await probe.read()).toBe('failed');
      await expect(probe.requireBudget()).rejects.toThrow('AI_BUDGET_UNAVAILABLE');
    },
  );
  it('warns at 80 percent and sanitizes provider failures', async () => {
    expect(
      await createBudgetProbe(ai, async () =>
        Response.json({ data: { ...key, limit_remaining: 1 } }),
      ).read(),
    ).toBe('warning');
    const failed = createBudgetProbe(ai, async () => {
      throw new Error('private-key-and-response');
    });
    expect(await failed.read()).toBe('failed');
    const disabledFetch = vi.fn<typeof fetch>();
    expect(await createBudgetProbe({}, disabledFetch).read()).toBe('disabled');
    expect(disabledFetch).not.toHaveBeenCalled();
  });
  it('authenticates before reading signals and returns only the fixed operational schema', async () => {
    const database = createDatabase('postgresql://fixture:***@127.0.0.1/fixture');
    databases.push(database);
    const query = vi.spyOn(database.pool, 'query').mockImplementation(async (text: unknown) => {
      if (String(text).includes('core.organization'))
        return { rows: [{ id: '00000000-0000-0000-0000-000000000001' }] } as never;
      return { rows: [{ quarantine: false, daily: '48', monthly: '48' }] } as never;
    });
    // Tenant checks run inside the organization context (SET LOCAL + RLS): mock the client.
    vi.spyOn(database.pool, 'connect').mockResolvedValue({
      query: async () => ({
        rows: [{ imports_late: false, attachments_late: true, events_late: false }],
      }),
      release: () => {},
    } as never);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith('/status')
          ? {
              backup: 'ready',
              restoreTest: 'ready',
              retention: 'ready',
              lastRun: 'ready',
              sync: 'ready',
              integrity: 'ready',
              disk: 'ready',
              private: 'ignored',
            }
          : { status: 'ready', private: 'ignored' },
      ),
    );
    const service = createOperationsService(
      database,
      { MONITORING_ENABLED: 'true', MONITOR_TOKEN: 'a'.repeat(64) },
      fetchImpl,
    )!;
    const app = createApp({ checkDatabase: async () => {}, operations: service });
    apps.push(app);
    for (const token of [undefined, `Bearer ${'b'.repeat(64)}`, `Bearer ${'é'.repeat(64)}`]) {
      const response = await app.inject({
        url: '/api/v1/operations/health',
        headers: token ? { authorization: token } : {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(query).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/api/v1/operations/health',
      headers: { authorization: `Bearer ${service.token}` },
    });
    const value = operationsHealthSchema.parse(response.json());
    expect(value.status).toBe('attention');
    expect(value.checks.attachments).toBe('failed');
    expect(value.checks.aiQuota).toBe('warning');
    expect(value.checks.backup).toBe('ready');
    expect(value.checks.backupSync).toBe('ready');
    expect(value.checks.backupIntegrity).toBe('ready');
    // Without APP_ORIGIN there is no TLS target to monitor: disabled, quietly.
    expect(value.checks.tls).toBe('disabled');
    expect(response.body).not.toMatch(/ignored|private|postgresql|secret/i);
    await app.inject({
      url: '/api/v1/operations/health',
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const financial = await app.inject({
      url: '/api/v1/finance/workspace',
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(financial.statusCode).not.toBe(200);
  });
  it('answers within the probe deadline when an internal probe hangs', async () => {
    const database = createDatabase('postgresql://fixture:***@127.0.0.1/fixture');
    databases.push(database);
    vi.spyOn(database.pool, 'query').mockImplementation(async (text: unknown) => {
      if (String(text).includes('core.organization')) return { rows: [] } as never;
      return { rows: [{ quarantine: false, daily: '0', monthly: '0' }] } as never;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const target = String(url);
      if (target === 'http://worker:9091/') return new Promise<Response>(() => {});
      if (target.endsWith('/status'))
        return Response.json({
          backup: 'ready',
          restoreTest: 'ready',
          retention: 'ready',
          lastRun: 'ready',
          sync: 'ready',
          integrity: 'ready',
          disk: 'ready',
        });
      return Response.json({ status: 'ready' });
    });
    const service = createOperationsService(
      database,
      { MONITORING_ENABLED: 'true', MONITOR_TOKEN: 'a'.repeat(64) },
      fetchImpl,
      { probeDeadlineMs: 50 },
    )!;
    const app = createApp({ checkDatabase: async () => {}, operations: service });
    apps.push(app);
    const response = await app.inject({
      url: '/api/v1/operations/health',
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(response.statusCode).toBe(200);
    const value = operationsHealthSchema.parse(response.json());
    expect(value.status).toBe('attention');
    expect(value.checks.worker).toBe('failed');
    expect(value.checks.database).toBe('ready');
  });
  it('does not expose the monitoring endpoint when disabled', async () => {
    const app = createApp({ checkDatabase: async () => {} });
    apps.push(app);
    expect((await app.inject('/api/v1/operations/health')).statusCode).toBe(404);
  });
  const tlsEnv = { MONITORING_ENABLED: 'true', MONITOR_TOKEN: 'a'.repeat(64) };
  const monitoringDatabase = () => {
    const database = createDatabase('postgresql://fixture:***@127.0.0.1/fixture');
    databases.push(database);
    vi.spyOn(database.pool, 'query').mockImplementation(async (text: unknown) => {
      if (String(text).includes('core.organization')) return { rows: [] } as never;
      return { rows: [{ quarantine: false, daily: '0', monthly: '0' }] } as never;
    });
    return database;
  };
  const healthyInternalFetch = () =>
    vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith('/status')
          ? {
              backup: 'ready',
              restoreTest: 'ready',
              retention: 'ready',
              lastRun: 'ready',
              sync: 'ready',
              integrity: 'ready',
              disk: 'ready',
            }
          : { status: 'ready' },
      ),
    );
  it('maps second-provider sync and integrity states straight from the operations status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith('/status')
          ? {
              backup: 'ready',
              restoreTest: 'ready',
              retention: 'ready',
              lastRun: 'ready',
              sync: 'warning',
              integrity: 'failed',
              disk: 'ready',
            }
          : { status: 'ready' },
      ),
    );
    const service = createOperationsService(
      monitoringDatabase(),
      { MONITORING_ENABLED: 'true', MONITOR_TOKEN: 'a'.repeat(64) },
      fetchImpl,
    )!;
    const value = await service.read();
    expect(value.checks.backup).toBe('ready');
    expect(value.checks.backupSync).toBe('warning');
    expect(value.checks.backupIntegrity).toBe('failed');
    expect(value.status).toBe('attention');
  });
  it('maps the served certificate validity to TLS states by the configured thresholds', async () => {
    const cases: Array<[number | null, string]> = [
      [3, 'failed'],
      [6.5, 'failed'],
      [8, 'warning'],
      [19.5, 'warning'],
      [22, 'ready'],
      [25, 'ready'],
      [null, 'disabled'],
    ];
    for (const [days, expected] of cases) {
      const service = createOperationsService(
        monitoringDatabase(),
        tlsEnv,
        healthyInternalFetch(),
        {
          readCertificate: async () =>
            days === null ? null : new Date(Date.now() + days * 86_400_000),
        },
      )!;
      expect((await service.read()).checks.tls, `days=${days}`).toBe(expected);
    }
  });
  it('honors TLS threshold overrides and falls back to the default on invalid values', async () => {
    const certificateDays = (days: number) => async () => new Date(Date.now() + days * 86_400_000);
    const warning = createOperationsService(
      monitoringDatabase(),
      { ...tlsEnv, TLS_EXPIRY_WARN_DAYS: '400' },
      healthyInternalFetch(),
      { readCertificate: certificateDays(75) },
    )!;
    expect((await warning.read()).checks.tls).toBe('warning');
    const failing = createOperationsService(
      monitoringDatabase(),
      { ...tlsEnv, TLS_EXPIRY_WARN_DAYS: '400', TLS_EXPIRY_FAIL_DAYS: '100' },
      healthyInternalFetch(),
      { readCertificate: certificateDays(75) },
    )!;
    expect((await failing.read()).checks.tls).toBe('failed');
    const invalid = createOperationsService(
      monitoringDatabase(),
      { ...tlsEnv, TLS_EXPIRY_WARN_DAYS: 'zero' },
      healthyInternalFetch(),
      { readCertificate: certificateDays(75) },
    )!;
    expect((await invalid.read()).checks.tls).toBe('ready');
  });
  it('keeps the TLS check failed on probe errors and disabled without a target', async () => {
    const failed = createOperationsService(monitoringDatabase(), tlsEnv, healthyInternalFetch(), {
      readCertificate: async () => {
        throw new Error('private-tls-target');
      },
    })!;
    const failedValue = await failed.read();
    expect(failedValue.checks.tls).toBe('failed');
    expect(JSON.stringify(failedValue)).not.toMatch(/private-tls-target/);
    const disabled = createOperationsService(monitoringDatabase(), tlsEnv, healthyInternalFetch(), {
      readCertificate: async () => null,
    })!;
    expect((await disabled.read()).checks.tls).toBe('disabled');
  });
});
