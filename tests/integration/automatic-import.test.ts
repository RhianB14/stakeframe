import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createInboxStore,
  createAutomaticImportService,
  layoutDigest,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  OPENROUTER_MODEL,
  type FinanceCommand,
  type TicketExtraction,
  type ValidatedLayout,
} from '../../packages/shared/src/index.js';
import { startWorker } from '../../apps/worker/src/worker.js';
import { startIntegrations } from '../../apps/worker/src/integrations.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
let database: Database;
let finance: FinanceService;
let tenantContext: OrganizationContext;
let name: string;
let layout: ValidatedLayout;
type CommandInput = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: CommandInput) =>
  finance.command(tenantContext, randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace(tenantContext)).version,
  } as FinanceCommand);
beforeEach(async () => {
  name = `stk_auto_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_auto_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
  const bookmakerId = (await finance.workspace(tenantContext)).catalog.find(
    (row) => row.name === 'Bet365',
  )!.id;
  await run({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId, amount: '500.00' }],
    unitPercent: '1.00',
  });
  await run({
    type: 'catalog.create',
    kind: 'tipster',
    name: 'Tipster fictício',
    aliases: ['Fixture'],
  });
  layout = {
    id: 'synthetic-layout',
    bookmaker: 'bet365',
    bookmakerId,
    model: OPENROUTER_MODEL,
    description: 'Fictional layout used exclusively for deterministic integration tests.',
    placedAtFormat: 'iso-offset',
    allowFreebet: true,
    potentialReturnLabels: ['Retorno Total'],
    layoutSha256: '2'.repeat(64),
    coverage: {
      positive: 20,
      negative: 5,
      multiples: 3,
      missingFields: 3,
      promotional: 3,
      uniqueImages: 25,
    },
    corpusSha256: '0'.repeat(64),
    evaluationSha256: '1'.repeat(64),
    sampleCount: 20,
    essentialFieldErrors: 0,
    approvedBy: 'owner',
    approvedAt: '2020-01-01T00:00:00Z',
    expiresAt: '2999-01-01T00:00:00Z',
  };
});
afterEach(async () => {
  await database?.close();
  if (/^stk_auto_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());
async function input(changes: Partial<TicketExtraction> = {}, caption = 'Fixture\nBet365\nreal') {
  const imports = createImportService(database);
  const { id } = await imports.upload(tenantContext, randomUUID(), {
    image: image.toString('base64'),
    caption,
  });
  const claim = await createInboxStore(database).claim(tenantContext, id);
  expect(claim).not.toBeNull();
  const extraction: TicketExtraction = {
    bookmaker: 'Bet365',
    reference: `fixture-${randomUUID()}`,
    placedAtText: new Date(Date.now() - 1000).toISOString(),
    currency: 'BRL',
    stake: '100.00',
    odds: '2.00',
    potentialReturn: '200.00',
    freebet: false,
    selections: [
      {
        event: 'Aurora × Central',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Aurora',
        odds: null,
        eventDateText: '07/09/2026',
      },
    ],
    warnings: [],
    ...changes,
  };
  return {
    id,
    attempt: claim!.attempt,
    result: {
      extraction,
      model: OPENROUTER_MODEL,
      layoutId: layout.id,
      policyDigest: layoutDigest(layout),
    },
  };
}
async function complete(value: Awaited<ReturnType<typeof input>>, layouts = [layout]) {
  return createAutomaticImportService(database, layouts).complete(
    tenantContext,
    value.id,
    value.attempt,
    value.result,
  );
}
describe('automatic import financial boundary', () => {
  it('consumes the persistent queue and records one automatic bet through the worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stk-auto-worker-test-'));
    const file = join(directory, 'policies.json');
    writeFileSync(file, JSON.stringify([layout]));
    const url = new URL(source);
    url.pathname = `/${name}`;
    let boss: Awaited<ReturnType<typeof startWorker>> | undefined;
    let integrations: Awaited<ReturnType<typeof startIntegrations>> | undefined;
    try {
      const imports = createImportService(database);
      const { id } = await imports.upload(tenantContext, randomUUID(), {
        image: image.toString('base64'),
        caption: 'Fixture\nBet365\nreal',
      });
      const extraction = {
        bookmaker: 'Bet365',
        reference: 'worker-fixture',
        placedAtText: new Date(Date.now() - 1000).toISOString(),
        currency: 'BRL',
        stake: '100.00',
        odds: '2.00',
        potentialReturn: '200.00',
        freebet: false,
        selections: [
          {
            event: 'Fictional A × B',
            sport: null,
            market: 'Result',
            selection: 'A',
            odds: null,
            eventDateText: null,
          },
        ],
        warnings: [],
      };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 'fixture-completion',
          model: OPENROUTER_MODEL,
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ layoutId: layout.id, extraction }) },
            },
          ],
        }),
      );
      boss = await startWorker(url.toString(), 'automatic_queue');
      integrations = await startIntegrations(
        database,
        boss,
        {
          AI_ENABLED: 'true',
          AI_PROVIDER: 'openrouter',
          OPENROUTER_MODEL,
          OPENROUTER_ALLOW_FALLBACKS: 'true',
          OPENROUTER_API_KEY: `sk-or-v1-${'0'.repeat(64)}`,
          AUTOMATIC_IMPORT_ENABLED: 'true',
          AUTOMATIC_IMPORT_POLICIES_FILE: file,
        },
        fetchImpl,
      );
      await expect
        .poll(async () => (await imports.detail(tenantContext, id)).item.state, { timeout: 10000 })
        .toBe('imported');
      expect((await imports.detail(tenantContext, id)).automatic).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((await finance.workspace(tenantContext)).exposure).toBe('100.00');
    } finally {
      await integrations?.stop();
      await boss?.stop({ graceful: true, timeout: 5000 });
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('is disabled without validated policy and binds model, layout and policy digest', async () => {
    const cases = [
      { layouts: [] as ValidatedLayout[] },
      { result: { layoutId: 'unknown-layout' } },
      { result: { model: 'different-model' } },
      { result: { policyDigest: 'f'.repeat(64) } },
    ];
    for (const change of cases) {
      const value = await input();
      Object.assign(value.result, change.result);
      expect(await complete(value, change.layouts ?? [layout])).toMatchObject({
        state: 'review',
        reason: 'LAYOUT_NOT_VALIDATED',
      });
    }
    expect((await finance.workspace(tenantContext)).exposure).toBe('0.00');
  });
  it('commits evidence, bet, unit, ledger and audit once across repeated completions', async () => {
    const value = await input();
    const outcomes = await Promise.all([complete(value), complete(value)]);
    expect(outcomes.map((outcome) => outcome.state).sort()).toEqual(['imported', 'unchanged']);
    expect(await complete(value)).toEqual({ state: 'unchanged' });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    expect(detail).toMatchObject({
      automatic: true,
      automaticReason: 'IMPORTED',
      item: { state: 'imported' },
    });
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet).toMatchObject({ stake: '100.00', unitAmount: '10.00', state: 'open' });
    // Data/hora do evento saiu da importação automática (R3): a seleção nasce
    // pendente de enriquecimento, mesmo com eventDateText presente na extração.
    expect(bet.selections[0]).toMatchObject({
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending',
    });
    expect(await finance.workspace(tenantContext)).toMatchObject({
      bankroll: '1000.00',
      available: '900.00',
      exposure: '100.00',
    });
    expect(
      (
        await database.pool.query(
          "select count(*)::int n from finance.audit where type='import.automatic'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query(
          "select count(*)::int n from finance.command_receipt where actor='system:automatic-import'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('serializes competing duplicate images and keeps the second for review', async () => {
    const first = await input();
    const second = await input();
    const outcomes = await Promise.all([complete(first), complete(second)]);
    expect(outcomes.map((outcome) => outcome.state).sort()).toEqual(['imported', 'review']);
    expect(outcomes.find((outcome) => outcome.state === 'review')).toMatchObject({
      reason: 'DUPLICATE_REVIEW_REQUIRED',
    });
    expect((await finance.workspace(tenantContext)).exposure).toBe('100.00');
  });
  it.each([
    [{ warnings: ['Unreadable'] }, 'EXTRACTION_UNCERTAIN'],
    [{ currency: null }, 'EXTRACTION_UNCERTAIN'],
    [{ stake: '10.123' }, 'EXTRACTION_UNCERTAIN'],
    [{ potentialReturn: '199.99' }, 'RETURN_MISMATCH'],
    [{ odds: null }, 'EXTRACTION_UNCERTAIN'],
    [{ placedAtText: '07/09 10:30' }, 'PLACED_AT_UNCERTAIN'],
    [{ placedAtText: '9999-01-01T00:00:00Z' }, 'PLACED_AT_UNCERTAIN'],
    [{ placedAtText: '2001-01-01T00:00:00Z' }, 'UNIT_REQUIRED'],
    [{ bookmaker: 'Superbet' }, 'BOOKMAKER_CONFLICT'],
    [{ freebet: true }, 'FREEBET_CONFLICT'],
  ] as const)('retains evidence with reason %s / %s', async (changes, reason) => {
    const value = await input(changes as Partial<TicketExtraction>);
    expect(await complete(value)).toMatchObject({ state: 'review', reason });
    expect(
      (await createImportService(database).detail(tenantContext, value.id)).extraction,
    ).toEqual(value.result.extraction);
    expect((await finance.workspace(tenantContext)).exposure).toBe('0.00');
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      0,
    );
  });
  it('requires both caption aliases and leaves unknown event dates pending', async () => {
    const invalid = await input({}, 'Unknown tipster\nBet365\nreal');
    expect(await complete(invalid)).toMatchObject({ reason: 'CAPTION_UNRESOLVED' });
    const valid = await input({
      selections: [
        {
          event: 'A × B',
          sport: null,
          market: 'Resultado',
          selection: 'A',
          odds: null,
          eventDateText: 'amanhã',
        },
      ],
    });
    expect(await complete(valid)).toMatchObject({ state: 'imported' });
    const detail = await createImportService(database).detail(tenantContext, valid.id);
    expect((await finance.bet(tenantContext, detail.item.betId!)).bet.selections[0]).toMatchObject({
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending',
    });
  });
  it('uses only a unique matching freebet and does not debit cash', async () => {
    await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const value = await input(
      { freebet: true, potentialReturn: '100.00' },
      'Fixture\nBet365\nfreebet',
    );
    expect(await complete(value)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    expect(await finance.workspace(tenantContext)).toMatchObject({
      bankroll: '1000.00',
      exposure: '0.00',
      available: '1000.00',
    });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    expect((await finance.workspace(tenantContext)).freebets[0]?.usedBy).toBe(detail.item.betId);
  });
  it('treats an AI null as compatible with the explicit freebet context', async () => {
    await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const nullable = await input(
      { freebet: null, potentialReturn: '100.00' },
      'Fixture\nBet365\nfreebet',
    );
    expect(await complete(nullable)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, nullable.id);
    expect((await finance.workspace(tenantContext)).freebets[0]?.usedBy).toBe(detail.item.betId);
  });
  it('accepts an AI null with the explicit real context', async () => {
    const realNull = await input({ freebet: null, potentialReturn: '200.00' });
    expect(await complete(realNull)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    expect((await finance.workspace(tenantContext)).exposure).toBe('100.00');
  });
  it('accepts a consistent visual read as cash and blocks type contradictions', async () => {
    const realFalse = await input({
      freebet: false,
      placedAtText: new Date(Date.now() - 2 * 86400000).toISOString(),
    });
    expect(await complete(realFalse)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const realTrue = await input({ freebet: true });
    expect(await complete(realTrue)).toMatchObject({
      state: 'review',
      reason: 'FREEBET_CONFLICT',
    });
    const freebetFalse = await input({ freebet: false }, 'Fixture\nBet365\nfreebet');
    expect(await complete(freebetFalse)).toMatchObject({
      state: 'review',
      reason: 'FREEBET_CONFLICT',
    });
    expect((await finance.workspace(tenantContext)).exposure).toBe('100.00');
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      1,
    );
  });
  it('never auto-imports legacy two-line captions or ambiguous types', async () => {
    const legacy = await input({}, 'Fixture\nBet365');
    expect(await complete(legacy)).toMatchObject({
      state: 'review',
      reason: 'CAPTION_UNRESOLVED',
    });
    const unknown = await input({}, 'Fixture\nBet365\nbonus');
    expect(await complete(unknown)).toMatchObject({ reason: 'CAPTION_UNRESOLVED' });
    const empty = await input({}, 'Fixture\nBet365\n');
    expect(await complete(empty)).toMatchObject({ reason: 'CAPTION_UNRESOLVED' });
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      0,
    );
  });
  it('accepts a missing visual mark and never copies the informed house into the extraction', async () => {
    const hidden = await input({ bookmaker: null });
    expect(await complete(hidden)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, hidden.id);
    expect(detail.extraction?.bookmaker).toBeNull();
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.bookmakerId).toBe(layout.bookmakerId);
  });
  it('blocks another known house and keeps unresolved visual text in review', async () => {
    const matching = await input({ bookmaker: 'Bet365' });
    expect(await complete(matching)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const other = await input({
      bookmaker: 'Superbet',
      placedAtText: new Date(Date.now() - 5 * 86400000).toISOString(),
    });
    expect(await complete(other)).toMatchObject({ state: 'review', reason: 'BOOKMAKER_CONFLICT' });
    const unknown = await input({
      bookmaker: 'Casa Fantasma',
      placedAtText: new Date(Date.now() - 6 * 86400000).toISOString(),
    });
    expect(await complete(unknown)).toMatchObject({
      state: 'review',
      reason: 'BOOKMAKER_CONFLICT',
    });
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      1,
    );
  });
  it('rejects ambiguity between two eligible promotional credits', async () => {
    for (let i = 0; i < 2; i++)
      await run({
        type: 'freebet.create',
        bookmakerId: layout.bookmakerId,
        amount: '100.00',
        expiresOn: '9999-01-01',
        stakeReturned: false,
        note: 'Fictional credit',
      });
    expect(
      await complete(
        await input({ freebet: null, potentialReturn: '100.00' }, 'Fixture\nBet365\nfreebet'),
      ),
    ).toMatchObject({ reason: 'FREEBET_UNRESOLVED' });
  });
  it('imports without a reference and never writes a synthetic one', async () => {
    const value = await input({ reference: null });
    expect(await complete(value)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.reference).toBe('');
  });
  it('uses the caption date when the image has none and blocks divergent instants', async () => {
    const divergent = await input(
      { placedAtText: '2026-09-08T10:30:00-03:00' },
      'Fixture\nBet365\nreal\n07/09/2026 10:30',
    );
    expect(await complete(divergent)).toMatchObject({
      state: 'review',
      reason: 'PLACED_AT_UNCERTAIN',
    });
    const equal = await input(
      { placedAtText: '2026-09-07T10:30:00-03:00' },
      'Fixture\nBet365\nreal\n07/09/2026 10:30',
    );
    expect(await complete(equal)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, equal.id);
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.placedAt).toBe('2026-09-07T13:30:00.000Z');
  });
  it('imports from the caption date alone when the image carries no date', async () => {
    const value = await input({ placedAtText: null }, 'Fixture\nBet365\nreal\n07/09/2026 10:30');
    expect(await complete(value)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.placedAt).toBe('2026-09-07T13:30:00.000Z');
  });
  it('rolls back all financial effects if recording the decision fails and allows one safe retry', async () => {
    const value = await input();
    await database.pool
      .query(`create function finance.fail_automatic_audit() returns trigger language plpgsql as $$ begin if NEW.type='import.automatic' then raise exception 'SYNTHETIC_FAILURE'; end if; return NEW; end $$;
      create trigger fail_automatic_audit before insert on finance.audit for each row execute function finance.fail_automatic_audit()`);
    await expect(complete(value)).rejects.toThrow('SYNTHETIC_FAILURE');
    expect((await finance.workspace(tenantContext)).exposure).toBe('0.00');
    expect((await createImportService(database).detail(tenantContext, value.id)).item.state).toBe(
      'processing',
    );
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      0,
    );
    await database.pool.query('drop trigger fail_automatic_audit on finance.audit');
    expect(await complete(value)).toMatchObject({ state: 'imported' });
  });
  it('ignores a stale attempt without overwriting its successor', async () => {
    const value = await input();
    await database.pool.query('update integration.inbox set attempts=attempts+1 where id=$1', [
      value.id,
    ]);
    expect(await complete(value)).toEqual({ state: 'unchanged' });
    expect((await createImportService(database).detail(tenantContext, value.id)).item.state).toBe(
      'processing',
    );
  });
});
