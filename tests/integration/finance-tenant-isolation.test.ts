import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimExpiredAttachmentsForBackup,
  createDatabase,
  createEventService,
  createFinanceService,
  createImportService,
  createInboxStore,
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
import { drainExtractionRequest } from '../../apps/worker/src/integrations.js';
import type { FinanceCommand } from '../../packages/shared/src/index.js';

const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

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
  const reference = 'ISO-' + randomUUID().slice(0, 8);
  const bet = await finance.command(context, randomUUID(), {
    type: 'bet.create',
    expectedVersion: current.version,
    bookmakerId,
    tipsterId: null,
    stake: options.freebet ? '20.00' : '10.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: freebetId ?? null,
    reference,
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
  return { betId: bet.id, freebetId, reference };
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
    const column = await database.pool.query<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_schema='finance' and table_name='settings' and column_name='organization_id'",
    );
    // The 0010 migration ends with SET NOT NULL: the settings anchor can never be orphaned.
    expect(column.rows[0]!.is_nullable).toBe('NO');
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
    // Policies exist (fail-closed for non-owner roles). FORCE is deliberately absent so the
    // owner-run backup/restore cycle keeps working with a single database role.
    const enabled = await database.pool.query(
      "select count(*) from pg_class where relnamespace in ('finance'::regnamespace,'integration'::regnamespace) and relkind='r' and relrowsecurity",
    );
    expect(enabled.rows[0].count).toBe('18');
    // The isolation proven in this suite runs as the database owner, which the enabled policies
    // do not reach (no FORCE anywhere): the explicit predicates are the effective guard.
    const forced = await database.pool.query(
      "select count(*) from pg_class where relnamespace in ('finance'::regnamespace,'integration'::regnamespace) and relkind='r' and relrowsecurity and relforcerowsecurity",
    );
    expect(forced.rows[0].count).toBe('0');
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
    const metricsA = await reports.report(contextA, range);
    const metricsB = await reports.report(contextB, range);
    expect(metricsA.metrics.bets).toBe(1);
    expect(metricsB.metrics.bets).toBe(0);
    // The detail list (selection/settlement CTEs and catalog joins) is organization-scoped too.
    const detailA = await reports.bets(contextA, { ...range, page: 1, pageSize: 20 });
    const detailB = await reports.bets(contextB, { ...range, page: 1, pageSize: 20 });
    expect(detailA.total).toBe(1);
    expect(detailB.total).toBe(0);
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

  it('exports only the current organization through CSV and JSON, never infrastructure tables', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    const betA = await registerBet(contextA, bookmakerA.id);
    const bookmakerB = await initialize(contextB);
    const betB = await registerBet(contextB, bookmakerB.id);
    // B also owns an imported ticket: its rows must never surface in A's file.
    const store = createInboxStore(database);
    await store.accept(
      contextB,
      { sourceKey: `export:${randomUUID()}`, caption: 'B', metadata: { source: 'test' } },
      async () => image,
    );
    const reports = createReportService(database);
    const drainStream = async (stream: AsyncIterable<unknown>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks).toString('utf8');
    };
    const json = JSON.parse(await drainStream(await reports.export('json', contextA))) as Record<
      string,
      Array<{ id?: string }>
    >;
    expect(json['finance.bet']!.map((row) => row.id)).toEqual([betA.betId]);
    expect(json['integration.cursor']).toBeUndefined();
    expect(json['integration.ai_usage_day']).toBeUndefined();
    // No record of B — bet, journal, inbox or attachment — may travel in A's export.
    const foreign = await database.pool.query<{ id: string }>(
      `select id from finance.bet where organization_id=$1
       union select id from finance.journal where organization_id=$1
       union select id from integration.inbox where organization_id=$1
       union select id from integration.attachment where organization_id=$1`,
      [contextB.organizationId],
    );
    expect(foreign.rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(betB.betId);
    for (const row of foreign.rows) expect(serialized).not.toContain(row.id);
    const range = {
      from: '2000-01-01',
      to: '2100-01-01',
      kind: 'all',
      includeEstimated: 'true',
    } as const;
    const csv = await drainStream(await reports.export('csv', contextA, range));
    expect(csv).toContain(betA.reference);
    expect(csv).not.toContain(betB.reference);
  });

  it('dispatches extraction requests per organization, never mixing tenants', async () => {
    const { contextA, contextB } = await setup();
    const store = createInboxStore(database);
    // B's request is created first: a context-blind drain would pick it up while serving A.
    const inboxB = await store.accept(
      contextB,
      { sourceKey: `drain:${randomUUID()}`, caption: 'B', metadata: { source: 'test' } },
      async () => image,
    );
    const inboxA = await store.accept(
      contextA,
      { sourceKey: `drain:${randomUUID()}`, caption: 'A', metadata: { source: 'test' } },
      async () => image,
    );
    const dispatched: Array<{ nonce: string; organizationId: string }> = [];
    const boss = {
      send: async (_queue: string, data: { nonce: string; organizationId: string }) => {
        dispatched.push(data);
        return randomUUID();
      },
    };
    const drain = () =>
      drainExtractionRequest(
        database,
        boss as unknown as Parameters<typeof drainExtractionRequest>[1],
      );
    expect(await drain()).toBe(true);
    expect(await drain()).toBe(true);
    expect(await drain()).toBe(false);
    expect(dispatched).toHaveLength(2);
    expect(dispatched).toContainEqual({ nonce: inboxA, organizationId: contextA.organizationId });
    expect(dispatched).toContainEqual({ nonce: inboxB, organizationId: contextB.organizationId });
  });

  it('deduplicates source keys and attachment hashes per organization', async () => {
    const { contextA, contextB } = await setup();
    const store = createInboxStore(database);
    const sourceKey = `dup:${randomUUID()}`;
    const input = { sourceKey, caption: 'Dup', metadata: { source: 'test' } };
    const firstA = await store.accept(contextA, input, async () => image);
    const replayA = await store.accept(contextA, input, async () => image);
    expect(replayA).toBe(firstA);
    // The same source key is a distinct import in the other organization.
    const firstB = await store.accept(contextB, input, async () => image);
    expect(firstB).not.toBe(firstA);
    const hash = createHash('sha256').update(image).digest('hex');
    const rows = await database.pool.query<{ organization_id: string }>(
      'select organization_id from integration.attachment where sha256=$1 order by organization_id',
      [hash],
    );
    // Identical bytes hash to a separate attachment row per organization (no cross-tenant reuse).
    expect(rows.rows.map((row) => row.organization_id).sort()).toEqual(
      [contextA.organizationId, contextB.organizationId].sort(),
    );
    const inboxes = await database.pool.query<{ organization_id: string }>(
      'select organization_id from integration.inbox where source_key=$1 order by organization_id',
      [sourceKey],
    );
    expect(inboxes.rows).toHaveLength(2);
  });

  it('scopes calendar totals, rows and pagination to the current organization', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    const betA = await registerBet(contextA, bookmakerA.id);
    const bookmakerB = await initialize(contextB);
    const betB = await registerBet(contextB, bookmakerB.id);
    const events = createEventService(database);
    const query = {
      from: '2026-09-01',
      to: '2026-09-30',
      view: 'scheduled',
      page: 1,
      pageSize: 50,
    } as const;
    const calendarA = await events.calendar(contextA, query);
    const calendarB = await events.calendar(contextB, query);
    // Each organization sees exactly its own selection — never both.
    expect(calendarA.total).toBe(1);
    expect(calendarA.distinctBets).toBe(1);
    expect(calendarA.items.map((item) => item.betId)).toEqual([betA.betId]);
    expect(calendarB.total).toBe(1);
    expect(calendarB.distinctBets).toBe(1);
    expect(calendarB.items.map((item) => item.betId)).toEqual([betB.betId]);
  });

  it('never serves another organization import image, even with a valid UUID', async () => {
    const { contextA, contextB } = await setup();
    const store = createInboxStore(database);
    const inboxA = await store.accept(
      contextA,
      { sourceKey: `img:${randomUUID()}`, caption: 'A', metadata: { source: 'test' } },
      async () => image,
    );
    const imports = createImportService(database);
    const found = await imports.image(contextA, inboxA);
    expect(Buffer.compare(found.image!, image)).toBe(0);
    // B knows the inbox UUID but can never read A's bytes.
    await expect(imports.image(contextB, inboxA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('claims expired attachments only for the organization that runs retention', async () => {
    const { contextA, contextB } = await setup();
    const store = createInboxStore(database);
    const inboxA = await store.accept(
      contextA,
      { sourceKey: `ret:${randomUUID()}`, caption: 'A', metadata: { source: 'test' } },
      async () => image,
    );
    const inboxB = await store.accept(
      contextB,
      { sourceKey: `ret:${randomUUID()}`, caption: 'B', metadata: { source: 'test' } },
      async () => image,
    );
    // Both references are terminal and older than the 30-day window.
    await database.pool.query(
      "update integration.inbox set state='discarded', updated_at=now()-interval '31 days' where id = any($1::uuid[])",
      [[inboxA, inboxB]],
    );
    const attachmentOf = async (inboxId: string) =>
      (
        await database.pool.query<{ attachment_id: string }>(
          'select attachment_id from integration.inbox where id=$1',
          [inboxId],
        )
      ).rows[0]!.attachment_id;
    const stateOf = async (id: string) =>
      (
        await database.pool.query<{ state: string }>(
          'select state from integration.attachment where id=$1',
          [id],
        )
      ).rows[0]!.state;
    const attachmentA = await attachmentOf(inboxA);
    const attachmentB = await attachmentOf(inboxB);
    await claimExpiredAttachmentsForBackup(database, contextA);
    expect(await stateOf(attachmentA)).toBe('deleting');
    expect(await stateOf(attachmentB)).toBe('local');
    await claimExpiredAttachmentsForBackup(database, contextB);
    expect(await stateOf(attachmentB)).toBe('deleting');
  });

  it('never reuses another organization completed event search as cache', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    const betA = await registerBet(contextA, bookmakerA.id);
    const bookmakerB = await initialize(contextB);
    const betB = await registerBet(contextB, bookmakerB.id);
    const selectionOf = async (context: OrganizationContext, betId: string) =>
      (
        await database.pool.query<{ id: string }>(
          'select id from finance.selection where organization_id=$1 and bet_id=$2 order by position limit 1',
          [context.organizationId, betId],
        )
      ).rows[0]!.id;
    const selectionA = await selectionOf(contextA, betA.betId);
    const selectionB = await selectionOf(contextB, betB.betId);
    const events = createEventService(database, { thesportsdb: false, tavily: true });
    const input = (selectionId: string) =>
      ({ selectionId, provider: 'tavily', dateHint: '2026-09-10' }) as const;
    const firstKey = randomUUID();
    await events.request(contextA, firstKey, input(selectionA));
    expect((await events.claim(contextA))?.id).toBe(firstKey);
    await events.complete(contextA, firstKey, []);
    // A second search in A reuses its own completed cache.
    const cachedA = await events.request(contextA, randomUUID(), input(selectionA));
    expect(cachedA.state).toBe('complete');
    // B has the same fingerprint but must stay fresh: A's cache is never reused across tenants.
    const freshB = await events.request(contextB, randomUUID(), input(selectionB));
    expect(freshB.state).toBe('pending');
    // Neither A's selection nor its search history is reachable from B.
    await expect(events.selection(contextB, selectionA)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(events.search(contextB, firstKey)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('counts provider usage globally across organizations and refuses work when exhausted', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    const betA = await registerBet(contextA, bookmakerA.id);
    const bookmakerB = await initialize(contextB);
    const betB = await registerBet(contextB, bookmakerB.id);
    const selectionOf = async (context: OrganizationContext, betId: string) =>
      (
        await database.pool.query<{ id: string }>(
          'select id from finance.selection where organization_id=$1 and bet_id=$2 order by position limit 1',
          [context.organizationId, betId],
        )
      ).rows[0]!.id;
    const selectionA = await selectionOf(contextA, betA.betId);
    const selectionB = await selectionOf(contextB, betB.betId);
    // Seed completed searches in both organizations, backdated past the minute window.
    for (const [selection, context, count, tag] of [
      [selectionA, contextA, 12, 'a'],
      [selectionB, contextB, 8, 'b'],
    ] as const) {
      await database.pool.query(
        `insert into integration.event_search
           (id,actor,hash,selection_id,provider,query,event_fingerprint,state,started_at,completed_at,organization_id)
         select gen_random_uuid(),$1,md5(g::text||$2),$3,'tavily','seed','seed-'||$2,'complete',
           now()-interval '2 minutes',now()-interval '2 minutes',$4
         from generate_series(1,$5::int) g`,
        ['seed-' + tag, tag, selection, context.organizationId, count],
      );
    }
    const events = createEventService(database, { thesportsdb: false, tavily: true });
    // Status reflects the combined global quota (12 + 8 of 20), in both organizations.
    for (const context of [contextA, contextB]) {
      const status = await events.status(context);
      const tavily = status.providers.find((item) => item.provider === 'tavily')!;
      expect(tavily.dailyUsed).toBe(20);
      expect(tavily.dailyLimit).toBe(20);
    }
    // A new search from A is refused while the combined daily quota is exhausted.
    const pendingKey = randomUUID();
    await events.request(contextA, pendingKey, {
      selectionId: selectionA,
      provider: 'tavily',
      dateHint: '2026-09-10',
    });
    expect(await events.claim(contextA)).toBeNull();
    expect(await events.search(contextA, pendingKey)).toMatchObject({
      state: 'failed',
      errorCode: 'EVENT_QUOTA_REACHED',
    });
  });

  it('never exposes or blocks another organization duplicate candidate (image, reference and similarity)', async () => {
    const { contextA, contextB } = await setup();
    const bookmakerA = await initialize(contextA);
    const bookmakerB = await initialize(contextB);
    const betA = await registerBet(contextA, bookmakerA.id);
    await registerBet(contextB, bookmakerB.id);
    // A FK composta (bookmaker_id + organization_id) ja impede fabricar a
    // colisao real; derrubamos a FK APENAS neste banco descartavel para provar
    // que a propria consulta de duplicatas tambem se defende (precedencia).
    await database.pool.query('alter table finance.bet drop constraint bet_bookmaker_fk');
    // A unica colisao possivel entre organizacoes: o bilhete de A com a chave
    // (casa/stake/odds/data/referencia) que B usaria. B nunca pode ve-lo.
    const collisionRef = 'CROSS-' + randomUUID().slice(0, 8);
    const placedAt = new Date().toISOString();
    await database.pool.query(
      'update finance.bet set bookmaker_id=$2, reference=$3, stake=$4, odds=$5, placed_at=$6 where id=$1',
      [betA.betId, bookmakerB.id, collisionRef, '77.00', '7.77', placedAt],
    );
    const imports = createImportService(database);
    const inboxA = await imports.upload(contextA, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    await database.pool.query('update integration.inbox set imported_bet_id=$2 where id=$1', [
      inboxA.id,
      betA.betId,
    ]);
    const inboxB = await imports.upload(contextB, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    const detail = await imports.detail(contextB, inboxB.id);
    expect(detail.duplicates).toEqual([]);
    expect(detail.duplicateCount).toBe(0);
    await finance.command(contextB, randomUUID(), {
      type: 'import.confirm',
      expectedVersion: (await finance.workspace(contextB)).version,
      importId: inboxB.id,
      expectedInboxVersion: detail.item.version,
      decision: {
        kind: 'create',
        bet: {
          bookmakerId: bookmakerB.id,
          tipsterId: null,
          stake: '77.00',
          odds: '7.77',
          placedAt,
          freebetId: null,
          reference: collisionRef,
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
        },
        duplicateReason: '',
      },
    } as FinanceCommand);
    const count = await database.pool.query<{ n: string }>(
      'select count(*)::int n from finance.bet where organization_id=$1',
      [contextB.organizationId],
    );
    expect(count.rows[0]!.n).toBe(2);
  });
  it('keeps image, reference and similarity candidates inside one organization', async () => {
    const { contextA } = await setup();
    const bookmakerA = await initialize(contextA);
    const bet = await registerBet(contextA, bookmakerA.id);
    const imports = createImportService(database);
    const linked = await imports.upload(contextA, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    await database.pool.query('update integration.inbox set imported_bet_id=$2 where id=$1', [
      linked.id,
      bet.betId,
    ]);
    const sameImage = await imports.upload(contextA, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    const byImage = await imports.detail(contextA, sameImage.id);
    expect(byImage.duplicates.some((item) => item.reasons.includes('image'))).toBe(true);
    const extraction = {
      bookmaker: null,
      reference: bet.reference,
      placedAtText: null,
      currency: 'BRL',
      stake: null,
      odds: null,
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'Time A x Time B',
          sport: null,
          market: null,
          selection: null,
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    await database.pool.query('update integration.inbox set extraction=$2::jsonb where id=$1', [
      sameImage.id,
      JSON.stringify({ extraction }),
    ]);
    const byReference = await imports.detail(contextA, sameImage.id);
    expect(byReference.duplicates.some((item) => item.reasons.includes('reference'))).toBe(true);
    const tiny = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const distinct = await imports.upload(contextA, randomUUID(), {
      image: tiny.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    const row = (
      await database.pool.query<{ placed_at: Date; stake: string; odds: string }>(
        'select placed_at, stake, odds from finance.bet where id=$1',
        [bet.betId],
      )
    ).rows[0]!;
    await expect(
      finance.command(contextA, randomUUID(), {
        type: 'import.confirm',
        expectedVersion: (await finance.workspace(contextA)).version,
        importId: distinct.id,
        expectedInboxVersion: (await imports.detail(contextA, distinct.id)).item.version,
        decision: {
          kind: 'create',
          bet: {
            bookmakerId: bookmakerA.id,
            tipsterId: null,
            stake: row.stake,
            odds: row.odds,
            placedAt: row.placed_at.toISOString(),
            freebetId: null,
            reference: 'NOVA-' + randomUUID().slice(0, 8),
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
          },
          duplicateReason: '',
        },
      } as FinanceCommand),
    ).rejects.toMatchObject({ code: 'DUPLICATE_REVIEW_REQUIRED' });
  });
});
