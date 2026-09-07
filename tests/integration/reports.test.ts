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
const admin = createDatabase(source);
let database: Database;
let finance: FinanceService;
let reports: ReportService;
let name: string;
let bookmakerId: string;
type Input = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: Input) =>
  finance.command('fixture-owner', randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace()).version,
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
async function settle(
  id: string,
  outcome: 'win' | 'loss' | 'void' | 'half_win' | 'cashout' | 'partial_cashout' = 'win',
  amount = '200.00',
) {
  return run({
    type: 'bet.settle',
    id,
    outcome,
    returnAmount: amount,
    closedPrincipal: outcome === 'partial_cashout' ? '40.00' : '100.00',
    settledAt: new Date().toISOString(),
    reason: 'Liquidação de teste',
  });
}
async function exported(kind: 'csv' | 'json') {
  const stream = await reports.export(kind, kind === 'csv' ? query : undefined);
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
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
  reports = createReportService(database);
  bookmakerId = (await finance.workspace()).catalog.find((row) => row.name === 'Bet365')!.id;
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

describe('performance cohorts and portability', () => {
  it('bounds the final supported calendar year without looping past four-digit dates', async () => {
    const report = await reports.report({ ...query, from: '9999-12-31', to: '9999-12-31' });
    expect(report.timeline.map((row) => row.date)).toEqual(['9999-12-31']);
    expect(report.metrics.bets).toBe(0);
  });
  it('counts multiples once at the last event and reconciles dimensions, detail and CSV', async () => {
    const first = await bet({
      selections: [selection, { ...selection, event: 'Outro evento', eventDate: '2026-09-06' }],
    });
    await settle(first.id);
    await bet({ stake: '50.00', selections: [{ ...selection, sport: 'TÊNIS' }] });
    const report = await reports.report(query);
    expect(report.metrics).toMatchObject({
      bets: 2,
      settledBets: 1,
      realStake: '150.00',
      profit: '100.00',
      profitUnits: '1.000000',
      exposure: '50.00',
      roiReal: '100.00',
      hitRateReal: '100.00',
    });
    expect(report.timeline).toHaveLength(30);
    expect(report.timeline.find((row) => row.date === '2026-09-06')?.metrics.profit).toBe('100.00');
    expect(report.byBookmaker[0]?.metrics).toEqual(report.metrics);
    expect(report.bySport.map((row) => row.key).sort()).toEqual(['sport:futebol', 'sport:tenis']);
    expect((await reports.bets({ ...query, page: 1, pageSize: 25 })).total).toBe(2);
    expect((await exported('csv')).split('\r\n')).toHaveLength(4);
  });
  it('excludes unknown and estimated dates explicitly, including partially dated multiples', async () => {
    await bet({
      selections: [selection, { ...selection, eventDate: null, dateStatus: 'pending' }],
    });
    await bet({ selections: [{ ...selection, dateStatus: 'estimated' }] });
    await bet({ selections: [{ ...selection, eventDate: '2026-08-31' }] });
    const result = await reports.report(query);
    expect(result.metrics.bets).toBe(0);
    expect(result.exclusions).toEqual({ unknownDateBets: 1, estimatedDateBets: 1 });
    expect(result.previous.metrics.bets).toBe(1);
    expect((await reports.report({ ...query, includeEstimated: 'true' })).metrics.bets).toBe(1);
  });
  it('separates promotions, excludes reversed settlements and cashout from hit rate', async () => {
    const real = await bet();
    await settle(real.id, 'loss', '0.00');
    const cash = await bet();
    await settle(cash.id, 'cashout', '80.00');
    const partial = await bet();
    await settle(partial.id, 'partial_cashout', '30.00');
    const award = await run({
      type: 'freebet.create',
      bookmakerId,
      amount: '100.00',
      expiresOn: '2099-01-01',
      stakeReturned: false,
      note: 'Promoção',
    });
    const promo = await bet({ freebetId: award.id });
    await settle(promo.id, 'win', '100.00');
    const result = await reports.report(query);
    expect(result.metrics).toMatchObject({
      realProfit: '-130.00',
      freebetProfit: '100.00',
      profit: '-30.00',
      realPrincipalClosed: '240.00',
      roiReal: '-54.17',
      hitRateReal: '0.00',
      hitEligibleReal: 1,
      exposure: '60.00',
    });
    const detail = await finance.bet(real.id);
    await run({
      type: 'settlement.reverse',
      id: detail.settlements[0]!.id,
      reason: 'Correção de teste',
      effectiveAt: new Date().toISOString(),
    });
    expect((await reports.report(query)).metrics).toMatchObject({
      realProfit: '-30.00',
      hitRateReal: null,
      hitEligibleReal: 0,
      exposure: '160.00',
    });
  });
  it('keeps missing units explicit until the owner attaches the frozen historical unit', async () => {
    const historic = await bet({ placedAt: '2025-01-03T12:00:00Z', allowMissingUnit: true });
    await settle(historic.id);
    expect((await reports.report(query)).metrics).toMatchObject({
      profitUnits: null,
      knownProfitUnits: '0.000000',
      missingUnitBets: 1,
    });
    await run({
      type: 'unit.set',
      month: '2025-01',
      amount: '20.00',
      reason: 'Unidade histórica comprovada',
    });
    expect((await reports.report(query)).metrics.profitUnits).toBeNull();
    await run({
      type: 'bet.unit.resolve',
      id: historic.id,
      reason: 'Associar unidade histórica conferida',
    });
    expect((await reports.report(query)).metrics).toMatchObject({
      profitUnits: '5.000000',
      missingUnitBets: 0,
    });
    await expect(
      run({ type: 'bet.unit.resolve', id: historic.id, reason: 'Não pode sobrescrever' }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
  it('exports all structured records without sessions or attachment bytes and escapes CSV formulas', async () => {
    await bet({
      reference: '  =HYPERLINK("https://invalid")',
      selections: [{ ...selection, event: 'Campo, com "aspas"\ne quebra' }],
    });
    const csv = await exported('csv');
    expect(csv).toContain('"\'=HYPERLINK(""https://invalid"")"');
    const json = JSON.parse(await exported('json'));
    expect(json['finance.bet']).toHaveLength(1);
    expect(json['finance.bet'][0].reference).toBe('=HYPERLINK("https://invalid")');
    expect(json['finance.selection'][0].event_date).toBe('2026-09-05');
    expect(json['finance.posting'].length).toBeGreaterThan(0);
    expect(Object.keys(json)).not.toContain('auth.session');
    expect(JSON.stringify(json)).not.toMatch(
      /object_key|creation_transaction|access_token|refresh_token/,
    );
    const held = await reports.export('json');
    await expect(reports.export('json')).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await new Promise<void>((resolve) => {
      held.once('close', resolve);
      held.destroy();
    });
    await exported('json');
  });
  it('requires a session before validating filters or starting a download', async () => {
    // Match the package instance used by the API, including its domain error class.
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
      expect((await app.inject('/api/v1/exports/csv?from=invalid')).statusCode).toBe(401);
      expect((await app.inject('/api/v1/exports/json')).statusCode).toBe(401);
      vi.mocked(auth.getOwner).mockResolvedValue({ user: { id: 'fixture-owner' } } as Awaited<
        ReturnType<OwnerAuth['getOwner']>
      >);
      const response = await app.inject('/api/v1/exports/json');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().schemaVersion).toBe(1);
      expect((await app.inject('/api/v1/reports?from=2026-09-30&to=2026-09-01')).statusCode).toBe(
        400,
      );
    } finally {
      await app.close();
    }
  });
  it('keeps JSON at one version while financial commands commit concurrently', async () => {
    const first = await bet();
    const version = (await finance.workspace()).version;
    const stream = await reports.export('json');
    const iterator = stream[Symbol.asyncIterator]();
    const chunk = await iterator.next();
    await bet({ reference: 'Criada depois do início da exportação' });
    let output = String(chunk.value);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      output += String(next.value);
    }
    const json = JSON.parse(output);
    expect(json.financialVersion).toBe(version);
    expect(json['finance.bet'].map((row: { id: string }) => row.id)).toEqual([first.id]);
    expect((await reports.report(query)).metrics.bets).toBe(2);
  });
  it('does not assign partial sport labels or multiply mixed sport tickets, and excludes cancelled records', async () => {
    await bet({ selections: [selection, { ...selection, sport: null }] });
    await bet({ selections: [selection, { ...selection, sport: 'Tênis' }] });
    const cancelled = await bet();
    await run({
      type: 'bet.cancel',
      id: cancelled.id,
      effectiveAt: new Date().toISOString(),
      reason: 'Registro cancelado de teste',
    });
    const all = await reports.report(query);
    expect(all.metrics).toMatchObject({ bets: 2, realStake: '200.00', exposure: '200.00' });
    expect(all.bySport.map((row) => row.key).sort()).toEqual(['mixed', 'unknown']);
    expect((await reports.report({ ...query, sport: 'sport:futebol' })).metrics.bets).toBe(0);
    expect((await reports.report({ ...query, sport: 'mixed' })).metrics.bets).toBe(1);
    expect((await reports.report({ ...query, tipsterId: 'none' })).metrics.bets).toBe(2);
    await run({
      type: 'money.move',
      kind: 'deposit',
      targetAccountId: null,
      accountId: (await finance.workspace()).accounts.find((row) => row.kind === 'reserve')!.id,
      amount: '500.00',
      effectiveAt: new Date().toISOString(),
      reason: 'Aporte sem desempenho',
    });
    expect((await reports.report(query)).metrics.profit).toBe('0.00');
  });
  it('exports beyond a batch boundary with complete bet, posting and composite alias keys', async () => {
    const template = await bet();
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `with journals as (
        insert into finance.journal(kind,effective_at,actor,reason)
        select 'bet_stake',now(),'fixture-owner','Export pagination fixture' from generate_series(1,510) returning id
      ), bets as (
        insert into finance.bet(bookmaker_id,stake,odds,placed_at,reference,remaining,unit_month,unit_amount,stake_journal_id)
        select b.bookmaker_id,b.stake,b.odds,b.placed_at,'batch-'||j.id,b.stake,b.unit_month,b.unit_amount,j.id
        from journals j cross join finance.bet b where b.id=$1 returning stake_journal_id,stake,bookmaker_id
      ) insert into finance.posting(journal_id,account_id,amount)
        select b.stake_journal_id,a.id,case when a.kind='exposure' then b.stake else -b.stake end
        from bets b join finance.account a on a.kind='exposure' or a.bookmaker_id=b.bookmaker_id`,
        [template.id],
      );
      await client.query(`insert into finance.selection(bet_id,position,event,sport,market,selection,event_date,date_status)
        select id,0,'Fixture em lote','Futebol','Resultado','Aurora','2026-09-05','confirmed'
        from finance.bet where reference like 'batch-%'`);
      await client.query(
        `insert into finance.catalog_alias(kind,alias,label,catalog_id)
        select 'bookmaker','pagination-'||n,'Pagination '||n,$1 from generate_series(1,510) n`,
        [bookmakerId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    expect((await reports.report(query)).metrics).toMatchObject({
      bets: 511,
      realStake: '51100.00',
      exposure: '51100.00',
    });
    const csv = await exported('csv');
    expect(csv.split('\r\n')).toHaveLength(513);
    const json = JSON.parse(await exported('json'));
    expect(json['finance.bet']).toHaveLength(511);
    expect(new Set(json['finance.bet'].map((row: { id: string }) => row.id)).size).toBe(511);
    expect(json['finance.posting']).toHaveLength(1025);
    expect(
      new Set(
        json['finance.posting'].map(
          (row: { journal_id: string; account_id: string }) =>
            `${row.journal_id}:${row.account_id}`,
        ),
      ).size,
    ).toBe(1025);
    expect(
      json['finance.catalog_alias'].filter((row: { alias: string }) =>
        row.alias.startsWith('pagination-'),
      ),
    ).toHaveLength(510);
  });
});
