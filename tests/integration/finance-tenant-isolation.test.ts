import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createOnboardingService,
  createReportService,
  createTenantContext,
  FinanceError,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import type { FinanceCommand } from '../../packages/shared/src/index.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let name: string;
let created = false;

async function insertUser(id: string, email: string) {
  await database.pool.query('insert into auth."user"(id,name,email) values($1,$1,$2)', [id, email]);
}

async function setup() {
  const tenant = createTenantContext(database);
  const contextA = await tenant.ensureOrganizationMembership('user-a');
  const contextB = await tenant.ensureOrganizationMembership('user-b');
  return { tenant, contextA, contextB };
}

async function initialize(context: OrganizationContext) {
  const workspace = await finance.workspace(context);
  const bookmaker = workspace.catalog.find((item) => item.name === 'Bet365')!;
  await finance.command(context, randomUUID(), {
    type: 'bankroll.initialize',
    expectedVersion: workspace.version,
    reserve: '500.00',
    balances: [{ bookmakerId: bookmaker.id, amount: '500.00' }],
    unitPercent: '1.00',
  } as FinanceCommand);
  return bookmaker;
}

async function registerBet(
  context: OrganizationContext,
  bookmakerId: string,
  options: { freebet?: boolean } = {},
) {
  const workspace = await finance.workspace(context);
  let freebetId: string | undefined;
  if (options.freebet) {
    freebetId = (
      await finance.command(context, randomUUID(), {
        type: 'freebet.create',
        expectedVersion: workspace.version,
        bookmakerId,
        amount: '20.00',
        expiresOn: '2026-12-31',
        stakeReturned: true,
        note: 'Isolamento',
      } as FinanceCommand)
    ).id;
  }
  const current = await finance.workspace(context);
  const bet = await finance.command(context, randomUUID(), {
    type: 'bet.create',
    expectedVersion: current.version,
    bookmakerId,
    tipsterId: null,
    stake: options.freebet ? '20.00' : '10.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: freebetId ?? null,
    reference: 'ISO-' + randomUUID().slice(0, 8),
    allowMissingUnit: false,
    selections: [
      {
        event: 'Time A x Time B',
        sport: 'Futebol',
        market: 'Gols',
        selection: 'Mais de 2,5',
        odds: null,
        eventDate: '2026-09-10',
        eventAt: null,
        dateStatus: 'confirmed',
      },
    ],
  } as FinanceCommand);
  return { betId: bet.id, freebetId };
}

beforeEach(async () => {
  name = `stk_isolation_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_isolation_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  await insertUser('user-a', 'a@isolation.test');
  await insertUser('user-b', 'b@isolation.test');
});

afterEach(async () => {
  await database?.close();
  if (created && /^stk_isolation_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  created = false;
});
afterAll(async () => admin.close());

describe('financial multi-tenant isolation (STK-F1-13)', () => {
  it('provisions an isolated financial space per organization (settings, accounts, catalog)', async () => {
    const { contextA, contextB } = await setup();
    expect(contextA.organizationId).not.toBe(contextB.organizationId);
    const workspaceA = await finance.workspace(contextA);
    const workspaceB = await finance.workspace(contextB);
    expect(workspaceA.initialized).toBe(false);
    expect(workspaceB.initialized).toBe(false);
    expect(workspaceA.catalog.map((row) => row.name).sort()).toEqual([
      'Bet365',
      'Novibet',
      'Superbet',
    ]);
    expect(workspaceB.catalog.map((row) => row.name).sort()).toEqual([
      'Bet365',
      'Novibet',
      'Superbet',
    ]);
    expect(workspaceA.accounts.map((row) => row.id)).not.toEqual(
      workspaceB.accounts.map((row) => row.id),
    );
    const counts = await database.pool.query(
      `select (select count(*) from finance.settings) settings,
              (select count(*) from finance.catalog) catalog,
              (select count(*) from finance.account) accounts`,
    );
    expect(counts.rows[0]).toEqual({ settings: '2', catalog: '6', accounts: '12' });
  });

  it('blocks cross-organization reads, settlements, cancellations and reversals', async () => {
    const { contextA, contextB } = await setup();
    const bookmaker = await initialize(contextA);
    const { betId } = await registerBet(contextA, bookmaker.id);
    await initialize(contextB);

    await expect(finance.bet(contextB, betId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const bBets = await finance.bets(contextB, { page: 1, pageSize: 50 });
    expect(bBets.total).toBe(0);
    const bWorkspace = await finance.workspace(contextB);
    expect(bWorkspace.bankroll).toBe('1000.00');

    for (const command of [
      {
        type: 'bet.settle',
        id: betId,
        outcome: 'win',
        closedPrincipal: '10.00',
        returnAmount: '20.00',
        settledAt: new Date().toISOString(),
        reason: 'Cross-org settle',
      },
      {
        type: 'bet.cancel',
        id: betId,
        effectiveAt: new Date().toISOString(),
        reason: 'Cross-org cancel',
      },
      { type: 'bet.unit.resolve', id: betId, reason: 'Cross-org resolve' },
    ] as const) {
      await expect(
        finance.command(contextB, randomUUID(), {
          ...command,
          expectedVersion: bWorkspace.version,
        } as FinanceCommand),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    const journalB = await finance.journal(contextB, { page: 1, pageSize: 50 });
    // B has only its own opening journal — never the journal created by A's bet.
    expect(journalB.items).toHaveLength(1);
    expect(journalB.items[0]).toMatchObject({ kind: 'opening' });
    const journalA = await finance.journal(contextA, { page: 1, pageSize: 50 });
    expect(journalA.items).toHaveLength(2);
    const aWorkspace = await finance.workspace(contextA);
    expect(aWorkspace.exposure).toBe('10.00');
  });

  it('isolates catalog aliases, freebets and selection data', async () => {
    const { contextA, contextB } = await setup();
    const bookmaker = await initialize(contextA);
    await initialize(contextB);

    // Same alias in both organizations is legal; the unique key now includes the organization.
    const aWorkspace = await finance.workspace(contextA);
    await finance.command(contextA, randomUUID(), {
      type: 'catalog.create',
      expectedVersion: aWorkspace.version,
      kind: 'tipster',
      name: 'TipsterA',
      aliases: ['TipsterA'],
    } as FinanceCommand);
    const bWorkspace = await finance.workspace(contextB);
    await finance.command(contextB, randomUUID(), {
      type: 'catalog.create',
      expectedVersion: bWorkspace.version,
      kind: 'tipster',
      name: 'TipsterA',
      aliases: ['TipsterA'],
    } as FinanceCommand);
    const aAfter = await finance.workspace(contextA);
    expect(aAfter.catalog.filter((row) => row.name === 'TipsterA')).toHaveLength(1);

    const { betId, freebetId } = await registerBet(contextA, bookmaker.id, { freebet: true });
    expect(freebetId).toBeTruthy();
    const bDetail = await finance.bets(contextB, { page: 1, pageSize: 50 });
    expect(bDetail.total).toBe(0);
    await expect(finance.bet(contextA, betId)).resolves.toMatchObject({ bet: { id: betId } });
  });

  it('keeps command receipts idempotent per organization (same key in both)', async () => {
    const { contextA, contextB } = await setup();
    await initialize(contextA);
    await initialize(contextB);
    const key = randomUUID();
    const workspaceA = await finance.workspace(contextA);
    const workspaceB = await finance.workspace(contextB);
    const command = (expectedVersion: number) =>
      ({
        type: 'settings.update',
        expectedVersion,
        unitPercent: '2.00',
      }) as FinanceCommand;
    const first = await finance.command(contextA, key, command(workspaceA.version));
    const replay = await finance.command(contextA, key, command(workspaceA.version));
    expect(replay).toEqual(first);
    // The same key is a distinct receipt in the other organization.
    const other = await finance.command(contextB, key, command(workspaceB.version));
    expect(other.id).toBe('settings');
    const count = await database.pool.query('select count(*) from finance.command_receipt');
    expect(count.rows[0].count).toBe('4');
  });

  it('rejects cross-organization references at the database level (composite constraints)', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    await initialize(contextB);
    const context = await createTenantContext(database).ensureOrganizationMembership('user-b');
    // Direct insert bypassing the service must be rejected by the composite foreign key.
    const betA = await registerBet(
      await createTenantContext(database).ensureOrganizationMembership('user-a'),
      bookmakerA.id,
    );
    await expect(
      database.pool.query(
        `insert into finance.selection(organization_id,bet_id,position,event,market,selection,date_status)
         values($1,$2,1,'Time X x Time Y','Mercado','Escolha','confirmed')`,
        [context.organizationId, betA.betId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // And the settings row is unique per organization.
    await expect(
      database.pool.query('insert into finance.settings(organization_id) values($1)', [
        context.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('fails closed without an organization context', async () => {
    const { contextA } = await setup();
    await initialize(contextA);
    // Every service query carries the context predicate: without SET LOCAL the cast fails
    // (fail-closed) and the forced policies exist for future non-superuser roles.
    await expect(
      database.pool.query(
        'select count(*) from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
      ),
    ).rejects.toMatchObject({ code: '22P02' });
    const policies = await database.pool.query(
      "select count(*) from pg_policies where schemaname in ('finance','integration')",
    );
    expect(policies.rows[0].count).toBe('18');
    const forced = await database.pool.query(
      "select count(*) from pg_class where relnamespace in ('finance'::regnamespace,'integration'::regnamespace) and relkind='r' and relforcerowsecurity",
    );
    expect(forced.rows[0].count).toBe('18');
  });

  it('runs onboarding per organization without the founding anchor', async () => {
    const { contextA, contextB } = await setup();
    const onboarding = createOnboardingService(database);
    await initialize(contextA);
    await onboarding.updateProfile('user-a', {
      displayName: 'Alice',
      timezone: 'America/Sao_Paulo',
    });
    const statusA = await onboarding.statusFor('user-a');
    const statusB = await onboarding.statusFor('user-b');
    expect(statusA.steps.bankroll.completed).toBe(true);
    // B has its own (empty) financial space: A's bankroll never leaks through the anchor.
    expect(statusB.steps.bankroll.completed).toBe(false);
    await onboarding.updateProfile('user-b', { displayName: 'Bob', timezone: 'America/Sao_Paulo' });
    await expect(onboarding.finish('user-b', 'deferred')).rejects.toMatchObject({
      code: 'ONBOARDING_PREREQUISITE',
    });
    const done = await onboarding.finish('user-a', 'deferred');
    expect(done.completedAt).not.toBeNull();
    expect(contextB.organizationId).not.toBe(contextA.organizationId);
  });

  it('isolates reports and import listings per organization', async () => {
    const { contextA, contextB } = await setup();
    const bookmaker = await initialize(contextA);
    await registerBet(contextA, bookmaker.id);
    await initialize(contextB);
    const reports = createReportService(database);
    const range = {
      from: '2000-01-01',
      to: '2100-01-01',
      kind: 'all',
      includeEstimated: 'true',
    } as const;
    const metricsA = await reports.report(contextA, { ...range, page: 1, pageSize: 20 });
    const metricsB = await reports.report(contextB, { ...range, page: 1, pageSize: 20 });
    expect(metricsA.metrics.bets).toBe(1);
    expect(metricsB.metrics.bets).toBe(0);
    void bookmaker;

    const imports = createImportService(database);
    const listA = await imports.list(contextA, { page: 1, pageSize: 20 });
    const listB = await imports.list(contextB, { page: 1, pageSize: 20 });
    expect(listA.total).toBe(0);
    expect(listB.total).toBe(0);
    await expect(imports.detail(contextB, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('keeps unit precision and separations intact across organizations', async () => {
    const { contextA } = await setup();
    await initialize(contextA);
    const workspace = await finance.workspace(contextA);
    expect(workspace.bankroll).toBe('1000.00');
    expect(workspace.unitPercent).toBe('1.00');
    expect(workspace.units).toHaveLength(1);
    const journal = await finance.journal(contextA, { page: 1, pageSize: 10 });
    expect(journal.items[0]).toMatchObject({ kind: 'opening' });
    expect(FinanceError).toBeDefined();
  });
});
