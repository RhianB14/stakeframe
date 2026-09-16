import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createEventService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type EventService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  type FinanceCommand,
  type BetInput,
  type EventCandidate,
} from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let tenantContext: OrganizationContext;
let events: EventService;
let name: string;
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
  eventDate: null,
  eventAt: null,
  dateStatus: 'pending' as const,
};
const candidate = (): EventCandidate => ({
  id: randomUUID(),
  provider: 'thesportsdb',
  title: 'Aurora vs Central',
  url: 'https://www.thesportsdb.com/event/123',
  excerpt: 'Liga fictícia',
  rawDate: '2026-09-01',
  rawTime: '00:30:00',
  suggestedAt: '2026-09-01T00:30:00Z',
  postponed: false,
});
async function makeBet(selections: BetInput['selections'] = [selection]) {
  const bookmakerId = (await finance.workspace(tenantContext)).catalog.find((row) => row.name === 'Bet365')!.id;
  return run({
    type: 'bet.create',
    bookmakerId,
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: null,
    reference: 'fixture-ticket',
    allowMissingUnit: false,
    selections,
  });
}
beforeEach(async () => {
  name = `stk_event_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_event_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  tenantContext = await finance.ensureContext('fixture-owner');
  events = createEventService(database, { thesportsdb: true, tavily: true });
  const bookmakerId = (await finance.workspace(tenantContext)).catalog.find((row) => row.name === 'Bet365')!.id;
  await run({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId, amount: '500.00' }],
    unitPercent: '1.00',
  });
});
afterEach(async () => {
  await database?.close();
  if (/^stk_event_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('calendar and event search persistence', () => {
  it('counts a multiple once, preserves partial dates and uses São Paulo dates across UTC midnight', async () => {
    const bet = await makeBet([
      { ...selection, eventAt: '2026-09-01T00:30:00Z', dateStatus: 'confirmed' },
      { ...selection, event: 'Aurora × Norte', eventDate: '2026-09-02', dateStatus: 'estimated' },
      { ...selection, event: 'Aurora × Sul' },
    ]);
    const august = await events.calendar(tenantContext, {
      from: '2026-08-01',
      to: '2026-08-31',
      view: 'scheduled',
      page: 1,
      pageSize: 25,
    });
    expect(august).toMatchObject({ total: 1, distinctBets: 1, pendingSelections: 1 });
    expect(august.items[0]?.selection).toMatchObject({
      eventDate: '2026-08-31',
      eventAt: '2026-09-01T00:30:00.000Z',
    });
    const all = await events.calendar(tenantContext, {
      from: '2026-08-01',
      to: '2026-09-30',
      view: 'scheduled',
      page: 1,
      pageSize: 25,
    });
    expect(all).toMatchObject({ total: 2, distinctBets: 1 });
    expect(all.items[1]?.selection).toMatchObject({
      eventAt: null,
      eventDate: '2026-09-02',
      dateStatus: 'estimated',
    });
    const pending = await events.calendar(tenantContext, {
      from: '2030-01-01',
      to: '2030-01-31',
      view: 'pending',
      page: 1,
      pageSize: 25,
    });
    expect(pending).toMatchObject({ total: 1, distinctBets: 1 });
    expect(pending.items[0]?.betId).toBe(bet.id);
    expect(all.items[0]).not.toHaveProperty('stake');
    expect(() =>
      events.calendar(tenantContext, {
        from: '2026-09-30',
        to: '2026-09-01',
        view: 'scheduled',
        page: 1,
        pageSize: 25,
      }),
    ).toThrow();
  });
  it('keeps selection IDs and source evidence through reorder/market correction, rejecting foreign IDs atomically', async () => {
    const bet = await makeBet([selection, { ...selection, event: 'Aurora × Norte' }]);
    const original = (await finance.bet(tenantContext, bet.id)).bet;
    const id = original.selections[0]!.id!;
    const found = candidate();
    const request = await events.request(tenantContext, randomUUID(), {
      selectionId: id,
      provider: 'thesportsdb',
      dateHint: null,
    });
    expect((await events.claim(tenantContext))?.id).toBe(request.id);
    await events.complete(tenantContext, request.id, [found]);
    const before = await finance.workspace(tenantContext);
    await run({
      type: 'event.update',
      selectionId: id,
      eventDate: '2026-08-31',
      eventAt: found.suggestedAt,
      dateStatus: 'confirmed',
      scheduleStatus: 'scheduled',
      candidateId: found.id,
      reason: 'Conferência da fonte e do fuso',
    });
    expect(await finance.workspace(tenantContext)).toMatchObject({
      bankroll: before.bankroll,
      exposure: before.exposure,
      available: before.available,
      units: before.units,
    });
    const updated = (await finance.bet(tenantContext, bet.id)).bet;
    await run({
      type: 'bet.update',
      id: bet.id,
      tipsterId: null,
      reference: 'corrigida',
      reason: 'Corrigir ordem e mercado',
      selections: [updated.selections[1]!, { ...updated.selections[0]!, market: 'Vencedor' }],
    });
    expect((await finance.bet(tenantContext, bet.id)).bet.selections.map((s) => s.id)).toEqual([
      original.selections[1]!.id,
      id,
    ]);
    expect(await events.selection(tenantContext, id)).toMatchObject({
      dateSource: 'thesportsdb',
      dateEvidence: { id: found.id },
    });
    const current = (await finance.bet(tenantContext, bet.id)).bet;
    await expect(
      run({
        type: 'bet.update',
        id: bet.id,
        tipsterId: null,
        reference: 'errada',
        reason: 'ID inválido',
        selections: [{ ...current.selections[0]!, id: randomUUID() }],
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect((await finance.bet(tenantContext, bet.id)).bet.reference).toBe('corrigida');
    const audit = await database.pool.query(
      "select * from finance.audit where type='event.update' and entity_id=$1",
      [bet.id],
    );
    expect(audit.rowCount).toBe(1);
  });
  it('deduplicates concurrent request keys, shares cache without spending a quota, and never changes confirmed manual dates', async () => {
    const bet = await makeBet([{ ...selection, eventDate: '2026-09-05', dateStatus: 'confirmed' }]);
    const id = (await finance.bet(tenantContext, bet.id)).bet.selections[0]!.id!;
    const input = { selectionId: id, provider: 'thesportsdb' as const, dateHint: null };
    const key = randomUUID();
    const responses = await Promise.all([
      events.request(tenantContext, key, input),
      events.request(tenantContext, key, input),
    ]);
    expect(responses[0]).toEqual(responses[1]);
    await expect(
      events.request(tenantContext, key, { ...input, dateHint: '2026-09-01' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const claims = await Promise.all([events.claim(tenantContext), events.claim(tenantContext)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await events.complete(tenantContext, key, [candidate()]);
    const cached = await events.request(tenantContext, randomUUID(), input);
    expect(cached).toMatchObject({ state: 'complete', cached: true });
    expect((await events.status(tenantContext)).providers[0]?.dailyUsed).toBe(1);
    expect(await events.selection(tenantContext, id)).toMatchObject({
      selection: { eventDate: '2026-09-05', eventAt: null, dateStatus: 'confirmed' },
      dateSource: 'manual',
    });
    const refresh = await events.request(tenantContext, randomUUID(), {
      ...input,
      refresh: true,
    });
    expect(refresh).toMatchObject({ state: 'pending', cached: false });
    const disabled = createEventService(database);
    await expect(disabled.request(tenantContext, randomUUID(), input)).rejects.toThrow(
      'EVENT_PROVIDER_DISABLED',
    );
  });
  it('audits postponement and manual rescheduling, rejects stale versions and impossible date combinations', async () => {
    const bet = await makeBet([{ ...selection, eventDate: '2026-09-05', dateStatus: 'confirmed' }]);
    const id = (await finance.bet(tenantContext, bet.id)).bet.selections[0]!.id!;
    const version = (await finance.workspace(tenantContext)).version;
    const update: FinanceCommand = {
      type: 'event.update',
      expectedVersion: version,
      selectionId: id,
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending',
      scheduleStatus: 'postponed',
      candidateId: null,
      reason: 'Adiamento informado pela organização',
    };
    const key = randomUUID();
    const first = await finance.command(tenantContext, key, update);
    expect(await finance.command(tenantContext, key, update)).toEqual(first);
    await expect(finance.command(tenantContext, randomUUID(), update)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(await events.selection(tenantContext, id)).toMatchObject({
      scheduleStatus: 'postponed',
      selection: { eventDate: null, eventAt: null, dateStatus: 'pending' },
    });
    await expect(
      run({ ...update, type: 'event.update', eventDate: '2026-09-09', dateStatus: 'confirmed' }),
    ).rejects.toThrow();
    await run({
      type: 'event.update',
      selectionId: id,
      eventDate: '2026-09-09',
      eventAt: null,
      dateStatus: 'confirmed',
      scheduleStatus: 'scheduled',
      candidateId: null,
      reason: 'Nova data confirmada sem horário',
    });
    expect(await events.selection(tenantContext, id)).toMatchObject({
      selection: { eventDate: '2026-09-09', eventAt: null },
      scheduleStatus: 'scheduled',
    });
    await expect(
      run({
        type: 'event.update',
        selectionId: id,
        eventDate: '2026-09-01',
        eventAt: '2026-09-01T00:30:00Z',
        dateStatus: 'confirmed',
        scheduleStatus: 'scheduled',
        candidateId: null,
        reason: 'Fuso incorreto',
      }),
    ).rejects.toThrow();
  });
  it('enforces persistent quota and fences interrupted calls instead of retrying or accepting late results', async () => {
    const bet = await makeBet();
    const id = (await finance.bet(tenantContext, bet.id)).bet.selections[0]!.id!;
    await database.pool.query(
      `insert into integration.event_search(id,actor,hash,selection_id,provider,query,event_fingerprint,state,started_at)
      select gen_random_uuid(),'fixture-owner','quota',$1,'tavily','fixture','fixture','failed',now()-interval '2 minutes' from generate_series(1,20)`,
      [id],
    );
    const blocked = await events.request(tenantContext, randomUUID(), {
      selectionId: id,
      provider: 'tavily',
      dateHint: null,
    });
    expect(await events.claim(tenantContext)).toBeNull();
    expect(await events.search(tenantContext, blocked.id)).toMatchObject({
      state: 'failed',
      errorCode: 'EVENT_QUOTA_REACHED',
    });
    const interrupted = await events.request(tenantContext, randomUUID(), {
      selectionId: id,
      provider: 'thesportsdb',
      dateHint: null,
    });
    expect((await events.claim(tenantContext))?.id).toBe(interrupted.id);
    await database.pool.query(
      "update integration.event_search set started_at=now()-interval '6 minutes' where id=$1",
      [interrupted.id],
    );
    expect(await events.claim(tenantContext)).toBeNull();
    await events.complete(tenantContext, interrupted.id, [candidate()]);
    expect(await events.search(tenantContext, interrupted.id)).toMatchObject({
      state: 'failed',
      errorCode: 'EVENT_OUTCOME_UNCERTAIN',
      candidates: [],
    });
    expect((await events.status(tenantContext)).providers[0]?.dailyUsed).toBe(1);
  });
  it('refuses evidence belonging to another or renamed event', async () => {
    const bet = await makeBet();
    const id = (await finance.bet(tenantContext, bet.id)).bet.selections[0]!.id!;
    const search = await events.request(tenantContext, randomUUID(), {
      selectionId: id,
      provider: 'thesportsdb',
      dateHint: null,
    });
    await events.claim(tenantContext);
    const found = candidate();
    await events.complete(tenantContext, search.id, [found]);
    const current = (await finance.bet(tenantContext, bet.id)).bet;
    await run({
      type: 'bet.update',
      id: bet.id,
      tipsterId: null,
      reference: '',
      reason: 'Evento diferente',
      selections: [{ ...current.selections[0]!, event: 'Outro time × Central' }],
    });
    await expect(
      run({
        type: 'event.update',
        selectionId: id,
        eventDate: '2026-09-05',
        eventAt: null,
        dateStatus: 'estimated',
        scheduleStatus: 'scheduled',
        candidateId: found.id,
        reason: 'Fonte anterior',
      }),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });
  it('protects all calendar/search routes before parsing bodies or disclosing external configuration', async () => {
    const getOwner = vi.fn().mockResolvedValue(null);
    const auth = { origin: 'https://stakeframe.test', getOwner } as unknown as OwnerAuth;
    const app = createApp({ checkDatabase: database.check, ownerAuth: auth, finance, events });
    try {
      for (const url of [
        '/api/v1/calendar',
        `/api/v1/events/${randomUUID()}`,
        '/api/v1/event-search/status',
        `/api/v1/event-search/${randomUUID()}`,
        `/api/v1/event-search?selectionId=${randomUUID()}`,
      ]) {
        expect((await app.inject(url)).statusCode).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/event-search',
            headers: { origin: auth.origin, 'content-type': 'application/json' },
            payload: '{bad',
          })
        ).statusCode,
      ).toBe(401);
      getOwner.mockResolvedValue({ user: { id: 'fixture-owner' } });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/event-search',
            headers: { origin: 'https://attacker.test' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const page = await app.inject('/api/v1/calendar?from=2026-09-01&to=2026-09-30');
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
