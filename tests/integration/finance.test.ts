import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  saoPauloDate,
  type FinanceCommand,
  type SelectionInput,
} from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let service: FinanceService;
let name: string;
let created = false;
const now = () => new Date().toISOString();
const selection: SelectionInput = {
  event: 'Time A x Time B',
  sport: 'Futebol',
  market: 'Gols',
  selection: 'Mais de 2,5',
  odds: null,
  eventDate: null,
  eventAt: null,
  dateStatus: 'pending',
};
type CommandInput = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
async function command(input: CommandInput) {
  return service.command('fixture-owner', randomUUID(), {
    ...input,
    expectedVersion: (await service.workspace()).version,
  } as FinanceCommand);
}
async function initialized() {
  const workspace = await service.workspace();
  const bookmaker = workspace.catalog.find((item) => item.name === 'Bet365')!;
  await command({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId: bookmaker.id, amount: '500.00' }],
    unitPercent: '1.00',
  });
  const updated = await service.workspace();
  return {
    bookmakerId: bookmaker.id,
    house: updated.accounts.find((account) => account.bookmakerId === bookmaker.id)!.id,
    reserve: updated.accounts.find((account) => account.kind === 'reserve')!.id,
  };
}
async function createBet(
  bookmakerId: string,
  extra: Partial<Extract<FinanceCommand, { type: 'bet.create' }>> = {},
) {
  return command({
    type: 'bet.create',
    bookmakerId,
    tipsterId: null,
    stake: '100.00',
    odds: '1.85',
    placedAt: now(),
    freebetId: null,
    reference: '',
    selections: [selection],
    allowMissingUnit: false,
    ...extra,
  });
}
beforeEach(async () => {
  name = `stk_finance_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_finance_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  service = createFinanceService(database);
});
afterEach(async () => {
  await database?.close();
  if (created && /^stk_finance_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  created = false;
});
afterAll(async () => admin.close());

describe('financial core with PostgreSQL', () => {
  it('freezes the São Paulo rollover once and excludes late backdated cash from its base', async () => {
    const month = saoPauloDate(new Date()).slice(0, 7);
    const boundary = new Date(`${month}-01T00:00:00-03:00`);
    const before = new Date(boundary.getTime() - 1).toISOString();
    const after = new Date(boundary.getTime() + 1).toISOString();
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        "update finance.settings set initialized=true,unit_percent='2.00',opened_at=$1",
        [before],
      );
      const accounts = (
        await client.query<{ id: string; kind: string }>(
          "select id,kind from finance.account where kind in ('reserve','exposure','counter')",
        )
      ).rows;
      const account = (kind: string) => accounts.find((value) => value.kind === kind)!.id;
      for (const entry of [
        {
          effective: before,
          created: before,
          postings: [
            [account('reserve'), '900.00'],
            [account('exposure'), '100.00'],
            [account('counter'), '-1000.00'],
          ],
        },
        {
          effective: before,
          created: after,
          postings: [
            [account('reserve'), '500.00'],
            [account('counter'), '-500.00'],
          ],
        },
        {
          effective: after,
          created: before,
          postings: [
            [account('reserve'), '250.00'],
            [account('counter'), '-250.00'],
          ],
        },
      ]) {
        const id = randomUUID();
        await client.query(
          "insert into finance.journal(id,kind,effective_at,created_at,actor,reason) values($1,'fixture',$2,$3,'fixture','Rollover fixture')",
          [id, entry.effective, entry.created],
        );
        for (const [accountId, amount] of entry.postings)
          await client.query(
            'insert into finance.posting(journal_id,account_id,amount) values($1,$2,$3)',
            [id, accountId, amount],
          );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await Promise.all([service.ensureCurrentUnit(), service.ensureCurrentUnit()]);
    const workspace = await service.workspace();
    expect(workspace.units).toEqual([
      { month, amount: '20.00', base: '1000.00', percent: '2.00', source: 'automatic' },
    ]);
    expect(workspace.bankroll).toBe('1750.00');
    expect(workspace.version).toBe(2);
    expect(
      (
        await database.pool.query(
          "select count(*)::int as count from finance.audit where type='unit.automatic'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    await database.pool.query("update finance.settings set unit_percent='3.00'");
    await service.ensureCurrentUnit();
    expect((await service.workspace()).units[0]?.amount).toBe('20.00');
  });
  it('conserves the bankroll through transfers and separates cashflows from winnings', async () => {
    const { house, reserve } = await initialized();
    expect((await service.workspace()).bankroll).toBe('1000.00');
    await command({
      type: 'money.move',
      kind: 'transfer',
      accountId: reserve,
      targetAccountId: house,
      amount: '200.00',
      effectiveAt: now(),
      reason: 'Transferência de teste',
    });
    expect((await service.workspace()).bankroll).toBe('1000.00');
    await command({
      type: 'money.move',
      kind: 'deposit',
      accountId: reserve,
      targetAccountId: null,
      amount: '100.00',
      effectiveAt: now(),
      reason: 'Aporte de teste',
    });
    await command({
      type: 'money.move',
      kind: 'withdrawal',
      accountId: house,
      targetAccountId: null,
      amount: '50.00',
      effectiveAt: now(),
      reason: 'Retirada de teste',
    });
    expect((await service.workspace()).bankroll).toBe('1050.00');
    const journals = await service.journal({ page: 1, pageSize: 20 });
    expect(journals.items.map((item) => item.kind)).toContain('deposit');
    expect(
      (
        await database.pool.query(
          'select journal_id from finance.posting group by journal_id having sum(amount)<>0',
        )
      ).rowCount,
    ).toBe(0);
  });
  it('makes repeated and concurrent mutations idempotent and rejects stale versions', async () => {
    const { reserve } = await initialized();
    const workspace = await service.workspace();
    const key = randomUUID();
    const input: FinanceCommand = {
      type: 'money.move',
      kind: 'deposit',
      accountId: reserve,
      targetAccountId: null,
      amount: '25.00',
      effectiveAt: now(),
      reason: 'Aporte repetido',
      expectedVersion: workspace.version,
    };
    const [a, b] = await Promise.all([
      service.command('fixture-owner', key, input),
      service.command('fixture-owner', key, input),
    ]);
    expect(a).toEqual(b);
    expect((await service.workspace()).bankroll).toBe('1025.00');
    await expect(
      service.command('fixture-owner', key, { ...input, amount: '26.00' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(service.command('fixture-owner', randomUUID(), input)).rejects.toThrow(
      'VERSION_CONFLICT',
    );
  });
  it('moves real stake into exposure and closes it only once', async () => {
    const { bookmakerId } = await initialized();
    const bet = await createBet(bookmakerId);
    expect(await service.workspace()).toMatchObject({
      bankroll: '1000.00',
      available: '900.00',
      exposure: '100.00',
    });
    await command({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'win',
      closedPrincipal: '100.00',
      returnAmount: '185.00',
      settledAt: now(),
      reason: 'Resultado conferido',
    });
    expect(await service.workspace()).toMatchObject({ bankroll: '1085.00', exposure: '0.00' });
    expect((await service.bet(bet.id)).bet).toMatchObject({
      profit: '85.00',
      returnAmount: '185.00',
      state: 'settled',
      stakeUnits: '10.000000',
    });
    await expect(
      command({
        type: 'bet.settle',
        id: bet.id,
        outcome: 'win',
        closedPrincipal: '100.00',
        returnAmount: '185.00',
        settledAt: now(),
        reason: 'Repetição de resultado',
      }),
    ).rejects.toThrow('STATE_CONFLICT');
  });
  it('tracks partial cashout principal independently from payout and reverses without deleting history', async () => {
    const { bookmakerId } = await initialized();
    const bet = await createBet(bookmakerId);
    const partial = await command({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'partial_cashout',
      closedPrincipal: '40.00',
      returnAmount: '25.00',
      settledAt: now(),
      reason: 'Cashout parcial conferido',
    });
    expect(await service.workspace()).toMatchObject({ bankroll: '985.00', exposure: '60.00' });
    await command({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'cashout',
      closedPrincipal: '60.00',
      returnAmount: '80.00',
      settledAt: now(),
      reason: 'Cashout final conferido',
    });
    expect((await service.bet(bet.id)).bet.profit).toBe('5.00');
    await command({
      type: 'settlement.reverse',
      id: partial.id,
      effectiveAt: now(),
      reason: 'Correção do primeiro cashout',
    });
    const detail = await service.bet(bet.id);
    expect(detail.bet).toMatchObject({ state: 'open', remaining: '40.00', profit: '20.00' });
    expect(detail.settlements).toHaveLength(2);
    expect(detail.settlements.find((row) => row.id === partial.id)?.reversed).toBe(true);
    expect(await service.workspace()).toMatchObject({ bankroll: '1020.00', exposure: '40.00' });
  });
  it('keeps freebet principal out of the bank and credits only real payout', async () => {
    const { bookmakerId } = await initialized();
    const credit = await command({
      type: 'freebet.create',
      bookmakerId,
      amount: '20.00',
      expiresOn: '2099-12-31',
      stakeReturned: false,
      note: 'Crédito fictício',
    });
    const bet = await createBet(bookmakerId, {
      stake: '20.00',
      odds: '3.00',
      freebetId: credit.id,
    });
    expect(await service.workspace()).toMatchObject({
      bankroll: '1000.00',
      exposure: '0.00',
      available: '1000.00',
    });
    await command({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'win',
      closedPrincipal: '20.00',
      returnAmount: '40.00',
      settledAt: now(),
      reason: 'Freebet ganha conferida',
    });
    expect((await service.workspace()).bankroll).toBe('1040.00');
    expect((await service.bet(bet.id)).bet.profit).toBe('40.00');
    expect((await service.bet(bet.id)).bet.freebetStakeReturned).toBe(false);
    await expect(createBet(bookmakerId, { stake: '20.00', freebetId: credit.id })).rejects.toThrow(
      'INVALID_FINANCIAL_OPERATION',
    );
  });
  it('refuses expired promotional credits and conflicting re-use after a void', async () => {
    const { bookmakerId } = await initialized();
    const expired = await command({
      type: 'freebet.create',
      bookmakerId,
      amount: '20.00',
      expiresOn: '2000-01-01',
      stakeReturned: false,
      note: '',
    });
    await expect(createBet(bookmakerId, { stake: '20.00', freebetId: expired.id })).rejects.toThrow(
      'INVALID_FINANCIAL_OPERATION',
    );
    const credit = await command({
      type: 'freebet.create',
      bookmakerId,
      amount: '20.00',
      expiresOn: '2099-12-31',
      stakeReturned: false,
      note: '',
    });
    const bet = await createBet(bookmakerId, { stake: '20.00', freebetId: credit.id });
    const settlement = await command({
      type: 'bet.settle',
      id: bet.id,
      outcome: 'void',
      closedPrincipal: '20.00',
      returnAmount: '0.00',
      settledAt: now(),
      reason: 'Anulação promocional',
    });
    await createBet(bookmakerId, { stake: '20.00', freebetId: credit.id });
    await expect(
      command({
        type: 'settlement.reverse',
        id: settlement.id,
        effectiveAt: now(),
        reason: 'Tentativa após reutilização',
      }),
    ).rejects.toThrow('STATE_CONFLICT');
  });
  it('flags insufficient cash without inventing a deposit', async () => {
    const { bookmakerId } = await initialized();
    await createBet(bookmakerId, { stake: '700.00' });
    expect(await service.workspace()).toMatchObject({
      bankroll: '1000.00',
      available: '300.00',
      exposure: '700.00',
      warnings: ['NEGATIVE_BALANCE'],
    });
    expect(
      (await service.journal({ page: 1, pageSize: 20 })).items.map((row) => row.kind),
    ).not.toContain('deposit');
  });
  it('freezes the current unit and requires review for absent historical units', async () => {
    const { bookmakerId, reserve } = await initialized();
    const month = saoPauloDate(new Date()).slice(0, 7);
    await command({
      type: 'money.move',
      kind: 'deposit',
      accountId: reserve,
      targetAccountId: null,
      amount: '1000.00',
      effectiveAt: now(),
      reason: 'Aporte no meio do mês',
    });
    await command({ type: 'settings.update', unitPercent: '2.00' });
    expect((await service.workspace()).units.find((unit) => unit.month === month)?.amount).toBe(
      '10.00',
    );
    await expect(createBet(bookmakerId, { placedAt: '2020-01-15T12:00:00-03:00' })).rejects.toThrow(
      'UNIT_REQUIRED',
    );
    const pending = await createBet(bookmakerId, {
      placedAt: '2020-01-15T12:00:00-03:00',
      allowMissingUnit: true,
    });
    expect((await service.bet(pending.id)).bet.unitAmount).toBeNull();
    await command({
      type: 'unit.set',
      month: '2020-01',
      amount: '5.00',
      reason: 'Unidade histórica conferida',
    });
    const historic = await createBet(bookmakerId, { placedAt: '2020-01-16T12:00:00-03:00' });
    expect((await service.bet(historic.id)).bet.unitAmount).toBe('5.00');
    expect((await service.bet(pending.id)).bet.unitAmount).toBeNull();
  });
  it('rolls back invalid event dates and preserves partial dates without invented times', async () => {
    const { bookmakerId } = await initialized();
    await expect(
      createBet(bookmakerId, {
        selections: [
          {
            ...selection,
            eventDate: '2026-09-01',
            eventAt: '2026-09-02T15:00:00-03:00',
            dateStatus: 'confirmed',
          },
        ],
      }),
    ).rejects.toThrow('INVALID_FINANCIAL_OPERATION');
    expect((await service.workspace()).exposure).toBe('0.00');
    const bet = await createBet(bookmakerId, {
      selections: [{ ...selection, eventDate: '2026-09-01', dateStatus: 'confirmed' }],
    });
    expect((await service.bet(bet.id)).bet.selections[0]).toMatchObject({
      eventDate: '2026-09-01',
      eventAt: null,
    });
  });
  it('enforces immutable balanced journals at the database boundary', async () => {
    const { reserve } = await initialized();
    const journal = (await service.journal({ page: 1, pageSize: 10 })).items[0]!;
    await expect(
      database.pool.query('update finance.journal set reason=$2 where id=$1', [
        journal.id,
        'Apagar trilha',
      ]),
    ).rejects.toThrow('FINANCIAL_HISTORY_IMMUTABLE');
    await expect(
      database.pool.query(
        'insert into finance.posting(journal_id,account_id,amount) values($1,$2,1)',
        [journal.id, reserve],
      ),
    ).rejects.toThrow('JOURNAL_ALREADY_CLOSED');
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      const id = randomUUID();
      await client.query(
        "insert into finance.journal(id,kind,effective_at,actor,reason) values($1,'test',now(),'fixture','unbalanced')",
        [id],
      );
      await client.query(
        'insert into finance.posting(journal_id,account_id,amount) values($1,$2,1)',
        [id, reserve],
      );
      await expect(client.query('commit')).rejects.toThrow('JOURNAL_NOT_BALANCED');
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
  it('blocks anonymous and cross-origin financial writes before invoking business commands', async () => {
    const getOwner = vi.fn().mockResolvedValue(null);
    const ownerAuth = { origin: 'http://127.0.0.1:8088', getOwner } as unknown as OwnerAuth;
    const app = createApp({ checkDatabase: database.check, ownerAuth, finance: service });
    try {
      expect((await app.inject('/api/v1/workspace')).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/commands',
            headers: { origin: 'https://untrusted.example' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      getOwner.mockResolvedValue({
        user: { id: 'fixture-owner', name: 'Fixture Owner' },
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });
      expect((await app.inject('/api/v1/workspace')).statusCode).toBe(200);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/commands',
        headers: { origin: ownerAuth.origin, 'idempotency-key': randomUUID() },
        payload: {
          type: 'catalog.create',
          expectedVersion: 1,
          kind: 'tipster',
          name: 'Teste',
          aliases: [],
        },
      });
      expect(response.statusCode).toBe(200);
      expect((await service.workspace()).catalog.some((item) => item.name === 'Teste')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
