import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createReportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ReportService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  reportQuerySchema,
  type FinanceCommand,
  type BetInput,
} from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let tenantContext: OrganizationContext;
let reports: ReportService;
let name: string;
let bookmakerId: string;
type Input = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: Input) =>
  finance.command(tenantContext, randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace(tenantContext)).version,
  } as FinanceCommand);
const query = reportQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });
const selection = {
  event: 'Aurora × Central',
  sport: 'Futebol',
  market: 'Resultado',
  selection: 'Aurora',
  odds: null,
  eventDate: '2026-09-05',
  eventAt: null,
  dateStatus: 'confirmed' as const,
};
async function bet(input: Partial<BetInput> = {}) {
  return run({
    type: 'bet.create',
    bookmakerId,
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: null,
    reference: 'fixture',
    allowMissingUnit: false,
    selections: [selection],
    ...input,
  });
}
async function settle(id: string) {
  return run({
    type: 'bet.settle',
    id,
    outcome: 'win',
    returnAmount: '200.00',
    closedPrincipal: '100.00',
    settledAt: new Date().toISOString(),
    reason: 'Liquidação de teste',
  });
}

beforeEach(async () => {
  name = `stk_report_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_report_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Fixture Owner','fixture-owner@stk.test') on conflict (id) do nothing",
  );
  tenantContext = await finance.ensureContext('fixture-owner');
  reports = createReportService(database);
  bookmakerId = (await finance.workspace(tenantContext)).catalog.find(
    (row) => row.name === 'Bet365',
  )!.id;
  await run({
    type: 'bankroll.initialize',
    reserve: '5000.00',
    balances: [{ bookmakerId, amount: '5000.00' }],
    unitPercent: '1.00',
  });
});
afterEach(async () => {
  await database?.close();
  if (/^stk_report_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('analytics dashboard (STK-F2-02)', () => {
  it('calcula ROI, P&L, yield e N com precisão e os entrega juntos', async () => {
    const first = await bet();
    await settle(first.id);
    await bet(); // ainda aberta: entra no N e no volume apostado, não no principal encerrado
    const dash = await reports.dashboard(tenantContext, query);
    expect(dash.metrics).toMatchObject({
      bets: 2,
      settledBets: 1,
      openBets: 1,
      profit: '100.00',
      realProfit: '100.00',
      realStake: '200.00',
      realPrincipalClosed: '100.00',
      roiReal: '100.00',
      yieldReal: '50.00',
    });
    // N e métricas derivadas vêm no mesmo payload, com o limiar configurado.
    expect(dash.minSample).toBe(30);
    expect(dash.lowSample).toBe(true);
    expect(dash.metrics.bets).toBeLessThan(dash.minSample);
    expect(dash.filters).toEqual(query);
    // Mesma agregação do relatório: dashboard e relatório não divergem.
    expect((await reports.report(tenantContext, query)).metrics).toEqual(dash.metrics);
  });

  it('arredonda as razões para duas casas sem misturar freebets no denominador', async () => {
    const first = await bet();
    await settle(first.id);
    await bet();
    await bet(); // volume apostado 300, principal encerrado 100
    const dash = await reports.dashboard(tenantContext, query);
    expect(dash.metrics).toMatchObject({
      bets: 3,
      roiReal: '100.00', // 100 × 100,00 / 100,00
      yieldReal: '33.33', // 100 × 100,00 / 300,00
      profit: '100.00',
    });
  });

  it('preserva unknown: sem base real ROI e yield ficam null, nunca zero', async () => {
    const award = await run({
      type: 'freebet.create',
      bookmakerId,
      amount: '100.00',
      expiresOn: '2099-01-01',
      stakeReturned: false,
      note: 'Promoção',
    });
    const promo = await bet({ freebetId: award.id });
    await settle(promo.id);
    const dash = await reports.dashboard(tenantContext, query);
    expect(dash.metrics).toMatchObject({
      bets: 1,
      realStake: '0.00',
      realPrincipalClosed: '0.00',
      freebetProfit: '200.00',
      profit: '200.00',
      roiReal: null,
      yieldReal: null,
      profitUnits: expect.any(String), // unidade existe; o unknown aqui é a base real
    });
    expect(dash.metrics.roiReal).not.toBe('0.00');
    expect(dash.metrics.yieldReal).not.toBe('0.00');
    // Unidade histórica ausente continua `null` no dashboard, não vira zero.
    const historic = await bet({ placedAt: '2025-01-03T12:00:00Z', allowMissingUnit: true });
    await settle(historic.id);
    expect((await reports.dashboard(tenantContext, query)).metrics).toMatchObject({
      missingUnitBets: 1,
      profitUnits: null,
      knownProfitUnits: '2.000000',
    });
  });

  it('marca baixa amostra pelo limiar configurado, com N igual ao mínimo saindo do aviso', async () => {
    await bet();
    await bet();
    const low = await reports.dashboard(tenantContext, query);
    expect(low).toMatchObject({ minSample: 30, lowSample: true });
    const strict = createReportService(database, { dashboardMinSample: 1 });
    expect(await strict.dashboard(tenantContext, query)).toMatchObject({
      minSample: 1,
      lowSample: false,
    });
    const exactly = createReportService(database, { dashboardMinSample: 2 });
    expect(await exactly.dashboard(tenantContext, query)).toMatchObject({
      minSample: 2,
      lowSample: false, // N >= limiar não gera aviso
    });
    await expect(() => createReportService(database, { dashboardMinSample: 0 })).toThrow(
      'INVALID_DASHBOARD_MIN_SAMPLE',
    );
    expect(() => createReportService(database, { dashboardCacheTtlMs: -1 })).toThrow(
      'INVALID_DASHBOARD_CACHE_TTL',
    );
  });

  it('serve o cache curto por versão e invalida a cada movimentação financeira', async () => {
    await bet();
    const first = await reports.dashboard(tenantContext, query);
    const cached = await reports.dashboard(tenantContext, query);
    expect(cached).toBe(first); // mesmo objeto: servido pelo cache, sem nova agregação
    await bet({ reference: 'Depois do cache' });
    const refreshed = await reports.dashboard(tenantContext, query);
    expect(refreshed).not.toBe(first);
    expect(refreshed.metrics.bets).toBe(2);
    expect(refreshed.version).toBeGreaterThan(first.version);
    // Filtro diferente: chave diferente, agregação própria.
    const filtered = await reports.dashboard(tenantContext, { ...query, sport: 'sport:futebol' });
    expect(filtered).not.toBe(refreshed);
    expect(filtered.metrics.bets).toBe(2);
    const otherSport = await reports.dashboard(tenantContext, { ...query, sport: 'sport:tenis' });
    expect(otherSport).not.toBe(filtered);
    expect(otherSport.metrics.bets).toBe(0);
  });

  it('expõe o dashboard na API com a mesma sessão dos relatórios', async () => {
    await bet();
    const { createReportService: createApiReportService } =
      await import('../../packages/db/dist/index.js');
    const auth = {
      origin: 'http://localhost',
      getOwner: vi.fn(async () => null),
    } as unknown as OwnerAuth;
    const app = createApp({
      checkDatabase: database.check,
      ownerAuth: auth,
      reports: createApiReportService(database),
    });
    try {
      const unauthenticated = await app.inject('/api/v1/dashboard?from=2026-09-01&to=2026-09-30');
      expect(unauthenticated.statusCode).toBe(401);
      vi.mocked(auth.getOwner).mockResolvedValue({ user: { id: 'fixture-owner' } } as Awaited<
        ReturnType<OwnerAuth['getOwner']>
      >);
      const response = await app.inject('/api/v1/dashboard?from=2026-09-01&to=2026-09-30');
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.minSample).toBe(30);
      expect(payload.lowSample).toBe(true);
      expect(payload.metrics).toMatchObject({ bets: 1, roiReal: null, yieldReal: '0.00' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject('/api/v1/dashboard?from=2026-09-30&to=2026-09-01')).statusCode).toBe(
        400,
      );
    } finally {
      await app.close();
    }
  });
});
