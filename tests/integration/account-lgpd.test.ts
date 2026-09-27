import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createAccountDeletionService,
  createAccountExportService,
  createDatabase,
  createFinanceService,
  createReportService,
  requireDatabaseUrl,
  attachmentExpiredSql,
  type AccountDeletionService,
  type AccountExportService,
  type Database,
  type FinanceService,
  type OrganizationContext,
  type ReportService,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import type { FinanceCommand, BetInput } from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let tenantContext: OrganizationContext;
let reports: ReportService;
let deletion: AccountDeletionService;
let exportsService: AccountExportService;
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
async function settle(id: string, outcome: 'win' = 'win', amount = '200.00') {
  return run({
    type: 'bet.settle',
    id,
    outcome,
    returnAmount: amount,
    closedPrincipal: '100.00',
    settledAt: new Date().toISOString(),
    reason: 'Liquidação de teste',
  });
}
async function drain(stream: NodeJS.ReadableStream) {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}
beforeEach(async () => {
  name = `stk_account_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_account_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
  deletion = createAccountDeletionService(database);
  exportsService = createAccountExportService(database);
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
  if (/^stk_account_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

const appWith = (auth: OwnerAuth) =>
  createApp({
    checkDatabase: database.check,
    logger: true,
    ownerAuth: auth,
    reports,
    account: { deletion, exports: exportsService },
  });
const ownerAuth = () => {
  const auth = { getOwner: vi.fn(async () => null) } as unknown as OwnerAuth;
  vi.mocked(auth.getOwner).mockResolvedValue({
    status: 'ok',
    user: { id: 'fixture-owner', name: 'Fixture Owner' },
    organization: { id: tenantContext.organizationId, role: 'owner' },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as Awaited<ReturnType<OwnerAuth['getOwner']>>);
  return auth;
};

describe('account export (STK-F1-08 §7.3/§15)', () => {
  it('exports the complete account file with account rows and history, never credentials', async () => {
    const open = await bet({ reference: 'ABERTA' });
    const settled = await bet({ reference: 'GANHA' });
    await settle(settled.id);
    await database.pool.query(
      `insert into auth.session(id,token,user_id,expires_at,ip_address,user_agent,created_at,updated_at)
       values('session-fixture','token-fixture','fixture-owner',now()+interval '1 day','127.0.0.1','vitest',now(),now())`,
    );
    const body = JSON.parse(await drain(await exportsService.json(tenantContext, 'fixture-owner')));
    expect(body.schemaVersion).toBe(1);
    expect(body.account.user).toMatchObject({
      id: 'fixture-owner',
      email: 'fixture-owner@stk.test',
    });
    expect(body.account.organization.id).toBe(tenantContext.organizationId);
    expect(body.account.membership.role).toBe('owner');
    expect(body.account.sessions).toHaveLength(1);
    expect(body.account.sessions[0].id).toBe('session-fixture');
    expect(JSON.stringify(body.account)).not.toContain('token-fixture');
    expect(body.account.providers).toEqual([]);
    // The history carries the same portability tables as the report export.
    expect(body.history['finance.bet']).toHaveLength(2);
    expect(
      body.history['finance.bet'].map((row: { reference: string }) => row.reference).sort(),
    ).toEqual(['ABERTA', 'GANHA']);
    expect(body.history['finance.settings']).toHaveLength(1);
    // The export itself leaves an audit trail (ttrail) with no payloads.
    const audit = await database.pool.query<{ n: string }>(
      "select count(*)::text as n from finance.audit where organization_id=$1 and type='account.export'",
      [tenantContext.organizationId],
    );
    expect(Number(audit.rows[0]!.n)).toBe(1);
    expect(open.id).toBeTruthy();
  });
  it('exports every bet in the BETS-02 column order with the approved semantics', async () => {
    const single = await bet({ reference: 'SIMPLES' });
    await settle(single.id);
    await bet({
      reference: 'MULTIPLA',
      selections: [selection, { ...selection, event: 'Outro evento', eventDate: '2026-09-06' }],
    });
    const csv = await drain(await exportsService.betsCsv(tenantContext, 'fixture-owner'));
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      '"Nº do bilhete","Data do jogo","Hora do jogo","Evento","Aposta/seleção","Mercado","Tipo da aposta","Tipster","Casa de aposta","Valor apostado","Odd","Retorno recebido","Resultado/status","ID técnico"',
    );
    const rows = lines.slice(1, -1);
    expect(rows).toHaveLength(2);
    const settledRow = rows.find((row) => row.includes('"Ganha"'))!;
    expect(settledRow).toContain('"05/09/2026"');
    expect(settledRow).toContain('"Aurora × Central"');
    expect(settledRow).toContain('"Resultado"');
    expect(settledRow).toContain('"Simples"');
    expect(settledRow).toContain('"Sem tipster"');
    expect(settledRow).toContain('"Bet365"');
    expect(settledRow).toContain('"100.00"');
    expect(settledRow).toContain('"2.0000"');
    expect(settledRow).toContain('"200.00"');
    expect(settledRow).toContain('"Ganha"');
    const multipleRow = rows.find((row) => row.includes('"Múltipla"'))!;
    expect(multipleRow).toContain('"Múltipla"');
    expect(multipleRow).toContain('"Vários jogos/horários"');
    expect(multipleRow).toContain('"—"');
    expect(multipleRow).toContain('"Pendente"');
  });
});

describe('account exclusion (STK-F1-08 §7.3/§15)', () => {
  it('blocks immediately on request and invalidates every live session', async () => {
    await database.pool.query(
      `insert into auth.session(id,token,user_id,expires_at,created_at,updated_at)
       values('session-live','token-live','fixture-owner',now()+interval '1 day',now(),now())`,
    );
    const app = appWith(ownerAuth());
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/account/exclusion-request',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { deletion: { state: string; expiresAt: string } };
      expect(body.deletion.state).toBe('pending');
      const remaining = Math.round((Date.parse(body.deletion.expiresAt) - Date.now()) / 86_400_000);
      expect(remaining).toBe(30);
      // Immediate block: no session survives the request and the gate refuses the user.
      expect(await deletion.isBlocked('fixture-owner')).toBe(true);
      const sessions = await database.pool.query<{ n: string }>(
        "select count(*)::text as n from auth.session where user_id='fixture-owner'",
      );
      expect(Number(sessions.rows[0]!.n)).toBe(0);
    } finally {
      await app.close();
    }
  });
  it('cancels inside the grace window and restores access', async () => {
    const app = appWith(ownerAuth());
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/account/exclusion-request' })).statusCode,
      ).toBe(200);
      const cancelled = await app.inject({
        method: 'POST',
        url: '/api/v1/account/exclusion-cancel',
      });
      expect(cancelled.statusCode).toBe(200);
      expect((cancelled.json() as { deletion: { state: string } }).deletion.state).toBe(
        'cancelled',
      );
      expect(await deletion.isBlocked('fixture-owner')).toBe(false);
      // A second cancel without a pending request is a stable conflict.
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/account/exclusion-cancel' })).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('purges after the grace window (simulated clock), erases the data and converges on retry', async () => {
    await bet();
    await deletion.request('fixture-owner', tenantContext.organizationId);
    // Simulated clock: the window closes without waiting 30 real days.
    await database.pool.query(
      "update core.account_deletion set expires_at=now()-interval '1 day' where user_id='fixture-owner'",
    );
    const due = await deletion.duePurges();
    expect(due.map((row) => row.userId)).toEqual(['fixture-owner']);
    expect(await deletion.purge('fixture-owner')).toBe(true);
    // Retry converges: the row is no longer pending, so nothing is erased again.
    expect(await deletion.purge('fixture-owner')).toBe(false);
    const counts = await database.pool.query<{
      bets: string;
      users: string;
      organizations: string;
      sessions: string;
    }>(
      `select (select count(*)::text from finance.bet) bets,
              (select count(*)::text from core.membership) users,
              (select count(*)::text from core.organization) organizations,
              (select count(*)::text from auth.session) sessions`,
    );
    expect(counts.rows[0]).toEqual({ bets: '0', users: '0', organizations: '0', sessions: '0' });
    const trail = await deletion.status('fixture-owner');
    expect(trail).toMatchObject({ state: 'purged' });
    expect(trail?.purgedAt).toBeTruthy();
    expect(await deletion.isBlocked('fixture-owner')).toBe(true);
  });
  it('keeps private attachments for 90 days after the purge, then expires them', async () => {
    const attachmentId = randomUUID();
    await database.pool.query(
      `insert into integration.attachment(id,organization_id,sha256,mime,size,state,object_key)
       values($1,$2,'sha-fixture','image/png',1024,'remote','objects/fixture.png')`,
      [attachmentId, tenantContext.organizationId],
    );
    const expired = async () =>
      (
        await database.pool.query<{ expired: boolean }>(
          `select (${attachmentExpiredSql}) as expired from integration.attachment a where a.id=$1`,
          [attachmentId],
        )
      ).rows[0]!.expired;
    await deletion.request('fixture-owner', tenantContext.organizationId);
    await database.pool.query(
      "update core.account_deletion set expires_at=now()-interval '1 day' where user_id='fixture-owner'",
    );
    expect(await deletion.purge('fixture-owner')).toBe(true);
    // Inside the 90-day post-purge retention the orphan attachment must not expire.
    expect(await expired()).toBe(false);
    await database.pool.query(
      "update core.account_deletion set purged_at=now()-interval '91 days' where user_id='fixture-owner'",
    );
    expect(await expired()).toBe(true);
  });
  it('rate-limits the export routes to one request per user and route per minute', async () => {
    await bet();
    const app = appWith(ownerAuth());
    try {
      expect((await app.inject('/api/v1/account/export/bets.csv')).statusCode).toBe(200);
      expect((await app.inject('/api/v1/account/export/bets.csv')).statusCode).toBe(429);
      // The JSON route has its own bucket: still available once, then throttled.
      expect((await app.inject('/api/v1/account/export.json')).statusCode).toBe(200);
      expect((await app.inject('/api/v1/account/export.json')).statusCode).toBe(429);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/account/exclusion-request',
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
