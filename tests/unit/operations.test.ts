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
  OPENROUTER_ALLOW_FALLBACKS: 'false',
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
    const database = createDatabase('postgresql://fixture:fixture@127.0.0.1/fixture');
    databases.push(database);
    const query = vi.spyOn(database.pool, 'query').mockResolvedValue({
      rows: [
        {
          imports_late: false,
          attachments_late: true,
          events_late: false,
          quarantine: false,
          daily: '48',
          monthly: '48',
        },
      ],
    } as never);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith('/status')
          ? {
              backup: 'ready',
              restoreTest: 'ready',
              retention: 'ready',
              lastRun: 'ready',
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
    expect(response.body).not.toMatch(/ignored|private|postgresql|secret/i);
    await app.inject({
      url: '/api/v1/operations/health',
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const financial = await app.inject({
      url: '/api/v1/finance/workspace',
      headers: { authorization: `Bearer ${service.token}` },
    });
    expect(financial.statusCode).not.toBe(200);
  });
  it('does not expose the monitoring endpoint when disabled', async () => {
    const app = createApp({ checkDatabase: async () => {} });
    apps.push(app);
    expect((await app.inject('/api/v1/operations/health')).statusCode).toBe(404);
  });
});
