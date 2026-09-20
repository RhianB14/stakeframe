import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createInboxStore,
  createAutomaticImportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  OPENROUTER_MODEL,
  type AutomaticPolicyV2,
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
let globalPolicy: AutomaticPolicyV2;
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
  globalPolicy = {
    schemaVersion: 2,
    requiresUserBookmaker: true,
    aiBookmakerClassification: 'disabled',
    bookmakerScope: 'all-active',
    model: OPENROUTER_MODEL,
    placedAtFormats: ['iso-offset'],
    allowFreebet: true,
    potentialReturnLabels: ['Retorno Total'],
    corpusSha256: layout.corpusSha256,
    evaluationSha256: layout.evaluationSha256,
    coverage: layout.coverage,
    sampleCount: layout.sampleCount,
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
async function input(
  changes: Partial<TicketExtraction> = {},
  caption = 'Fixture\nBet365',
  origin: { kind: 'real' | 'freebet' | null; freebetId?: string | null } = { kind: 'real' },
  bookmakerOverrideId?: string | null,
) {
  const imports = createImportService(database);
  const { id } = await imports.upload(tenantContext, randomUUID(), {
    image: image.toString('base64'),
    caption,
  });
  // STK-G0-19-R5: a origem é declarada pelo usuário no rascunho canônico.
  if (origin.kind !== null)
    await database.pool.query(
      'update integration.inbox set bet_origin=$2,freebet_id=$3 where id=$1',
      [id, origin.kind, origin.freebetId ?? null],
    );
  if (bookmakerOverrideId !== undefined)
    await database.pool.query('update integration.inbox set bookmaker_override_id=$2 where id=$1', [
      id,
      bookmakerOverrideId,
    ]);
  const claim = await createInboxStore(database).claim(tenantContext, id);
  expect(claim).not.toBeNull();
  const extraction: TicketExtraction = {
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
  it('consumes the persistent queue and resolves the house from the user caption (STK-G0-22-F2)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stk-auto-worker-test-'));
    const file = join(directory, 'policies.json');
    writeFileSync(file, JSON.stringify(globalPolicy));
    chmodSync(file, 0o600);
    const url = new URL(source);
    url.pathname = `/${name}`;
    let boss: Awaited<ReturnType<typeof startWorker>> | undefined;
    let integrations: Awaited<ReturnType<typeof startIntegrations>> | undefined;
    try {
      const imports = createImportService(database);
      const { id } = await imports.upload(tenantContext, randomUUID(), {
        image: image.toString('base64'),
        caption: 'Fixture\nBet365',
      });
      await database.pool.query("update integration.inbox set bet_origin='real' where id=$1", [id]);
      const extraction = {
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
              message: { content: JSON.stringify(extraction) },
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
      // STK-G0-22-F2: a resposta neutra não carrega layout; o servidor resolve
      // a casa pela legenda e escolhe a política correspondente.
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
  it('fails closed without a validated house policy or when the model tries to select one', async () => {
    const withoutPolicy = await input();
    expect(await complete(withoutPolicy, [])).toMatchObject({
      state: 'review',
      reason: 'LAYOUT_NOT_VALIDATED',
    });
    const modelSelected = await input();
    Object.assign(modelSelected.result, {
      layoutId: 'model-selected-layout',
      policyDigest: 'f'.repeat(64),
    });
    expect(await complete(modelSelected)).toMatchObject({
      state: 'review',
      reason: 'EXTRACTION_UNCERTAIN',
    });
    const wrongModel = await input();
    Object.assign(wrongModel.result, { model: 'different-model' });
    expect(await complete(wrongModel)).toMatchObject({
      state: 'review',
      reason: 'LAYOUT_NOT_VALIDATED',
    });
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
    [{ odds: null }, 'EXTRACTION_UNCERTAIN'],
    [{ placedAtText: '07/09 10:30' }, 'PLACED_AT_UNCERTAIN'],
    [{ placedAtText: '9999-01-01T00:00:00Z' }, 'PLACED_AT_UNCERTAIN'],
    [{ placedAtText: '2001-01-01T00:00:00Z' }, 'UNIT_REQUIRED'],
    // STK-G0-22: resposta com campo de casa é recusada pelo contrato neutro.
    [{ bookmaker: 'Superbet' }, 'EXTRACTION_UNCERTAIN'],
    [{ freebet: true }, 'FREEBET_CONFLICT'],
  ] as const)('retains evidence with reason %s / %s', async (changes, reason) => {
    const value = await input(changes as Partial<TicketExtraction>);
    expect(await complete(value)).toMatchObject({ state: 'review', reason });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    if ('bookmaker' in (changes as object)) {
      // STK-G0-22: resposta com campo de casa é inválida (contrato neutro) —
      // nenhuma extração é retida.
      expect(detail.extraction).toBeNull();
    } else {
      expect(detail.extraction).toEqual(value.result.extraction);
    }
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
  it('uses the explicitly selected freebet credit and does not debit cash', async () => {
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const value = await input({ freebet: true, potentialReturn: '100.00' }, 'Fixture\nBet365', {
      kind: 'freebet',
      freebetId: credit.id,
    });
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
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const nullable = await input({ freebet: null, potentialReturn: '100.00' }, 'Fixture\nBet365', {
      kind: 'freebet',
      freebetId: credit.id,
    });
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
    const freebetFalse = await input({ freebet: false }, 'Fixture\nBet365', { kind: 'freebet' });
    expect(await complete(freebetFalse)).toMatchObject({
      state: 'review',
      reason: 'FREEBET_CONFLICT',
    });
    expect((await finance.workspace(tenantContext)).exposure).toBe('100.00');
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      1,
    );
  });
  it('keeps imports without a declared origin in review and distinguishes unresolved houses', async () => {
    const undeclared = await input({}, 'Fixture\nBet365', { kind: null });
    expect(await complete(undeclared)).toMatchObject({
      state: 'review',
      reason: 'ORIGIN_UNRESOLVED',
    });
    const missingHouse = await input({}, 'Fixture\n');
    expect(await complete(missingHouse)).toMatchObject({ reason: 'BOOKMAKER_UNRESOLVED' });
    const singleLine = await input({}, 'Fixture');
    expect(await complete(singleLine)).toMatchObject({ reason: 'BOOKMAKER_UNRESOLVED' });
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      0,
    );
  });
  it('keeps the extraction neutral — no house field — and imports from the user caption (STK-G0-22)', async () => {
    const item = await input();
    expect(await complete(item)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, item.id);
    expect(detail.extraction).not.toBeNull();
    expect(detail.extraction).not.toHaveProperty('bookmaker');
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.bookmakerId).toBe(layout.bookmakerId);
  });
  it('resolves the caption house only from the active organization catalog', async () => {
    const matching = await input({}, 'Fixture\nBet365');
    expect(await complete(matching)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const superbet = (await finance.workspace(tenantContext)).catalog.find(
      (item) => item.name === 'Superbet',
    )!;
    const superbetLayout = {
      ...layout,
      id: 'synthetic-superbet',
      bookmaker: 'superbet',
      bookmakerId: superbet.id,
    };
    const other = await input({}, 'Fixture\nSuperbet', { kind: null });
    expect(await complete(other, [layout, superbetLayout])).toMatchObject({
      state: 'review',
      reason: 'ORIGIN_UNRESOLVED',
    });
    expect(
      (
        await database.pool.query<{ automatic: { policyId: string } }>(
          "select extraction->'automatic' as automatic from integration.inbox where id=$1",
          [other.id],
        )
      ).rows[0]?.automatic.policyId,
    ).toBe(superbetLayout.id);
    const unknown = await input({}, 'Fixture\nCasa Fantasma');
    expect(await complete(unknown)).toMatchObject({
      state: 'review',
      reason: 'BOOKMAKER_REFUSED',
    });
    await database.pool.query('update finance.catalog set active=false where id=$1', [superbet.id]);
    const inactive = await input({}, 'Fixture\nSuperbet');
    expect(await complete(inactive, [layout, superbetLayout])).toMatchObject({
      state: 'review',
      reason: 'BOOKMAKER_REFUSED',
    });
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      1,
    );
  });
  it('uses an explicit MiniApp/Web/Telegram house selection over the caption', async () => {
    const superbet = (await finance.workspace(tenantContext)).catalog.find(
      (item) => item.name === 'Superbet',
    )!;
    const superbetLayout = {
      ...layout,
      id: 'synthetic-superbet',
      bookmaker: 'superbet',
      bookmakerId: superbet.id,
    };
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: superbet.id,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Explicit bookmaker context fixture',
    });
    const selected = await input(
      { freebet: null, potentialReturn: '100.00' },
      'Fixture\nCasa Fantasma',
      { kind: 'freebet', freebetId: credit.id },
      superbet.id,
    );
    expect(await complete(selected, [layout, superbetLayout])).toMatchObject({
      state: 'imported',
      reason: 'IMPORTED',
    });
    const detail = await createImportService(database).detail(tenantContext, selected.id);
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.bookmakerId).toBe(superbet.id);
    expect(detail.matches.captionBookmakerId).toBeNull();
    expect(detail.bookmakerOverrideId).toBe(superbet.id);
  });
  it('requires the explicit credit for a freebet origin and refuses incompatible credits', async () => {
    // Sem crédito escolhido: fail-closed (a IA não escolhe por ninguém).
    expect(
      await complete(
        await input({ freebet: null, potentialReturn: '100.00' }, 'Fixture\nBet365', {
          kind: 'freebet',
        }),
      ),
    ).toMatchObject({ reason: 'FREEBET_UNRESOLVED' });
    // Crédito de valor incompatível com a stake também é recusado.
    const small = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '50.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional small credit',
    });
    expect(
      await complete(
        await input({ freebet: null, potentialReturn: '100.00' }, 'Fixture\nBet365', {
          kind: 'freebet',
          freebetId: small.id,
        }),
      ),
    ).toMatchObject({ reason: 'FREEBET_UNRESOLVED' });
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0].n).toBe(
      0,
    );
  });
  it('imports without a reference and never writes a synthetic one', async () => {
    const value = await input({ reference: null });
    expect(await complete(value)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, value.id);
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.reference).toBe('');
  });
  it('never blocks on a divergent visual return and keeps the computed value as the source', async () => {
    // R6: o valor visual é diagnóstico; a base financeira é stake × odd.
    const divergent = await input({ potentialReturn: '199.99' });
    expect(await complete(divergent)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, divergent.id);
    // O valor visual permanece na evidência apenas como diagnóstico de fidelidade…
    expect(detail.extraction?.potentialReturn).toBe('199.99');
    // …e o registro financeiro usa somente stake e odd validados.
    const { bet } = await finance.bet(tenantContext, detail.item.betId!);
    expect(bet.stake).toBe('100.00');
    expect(bet.odds).toBe('2.0000');
  });
  it('imports with an absent visual return', async () => {
    const missing = await input({ potentialReturn: null });
    expect(await complete(missing)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
  });
  it('keeps the freebet gross calculation without changing credit accounting', async () => {
    const freebetCredit = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const freebetValue = await input({ freebet: null, potentialReturn: null }, 'Fixture\nBet365', {
      kind: 'freebet',
      freebetId: freebetCredit.id,
    });
    expect(await complete(freebetValue)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    expect((await finance.workspace(tenantContext)).bankroll).toBe('1000.00');
  });
  it('never autoimports without an approved policy and explains it with a sanitized reason (R7)', async () => {
    const withoutPolicy = await input();
    expect(await complete(withoutPolicy, [])).toMatchObject({ state: 'review' });
    const fromStore = (
      await database.pool.query<{ automatic_reason: string }>(
        "select extraction->'automatic'->>'reason' as automatic_reason from integration.inbox where id=$1",
        [withoutPolicy.id],
      )
    ).rows[0];
    expect(fromStore?.automatic_reason).toBe('LAYOUT_NOT_VALIDATED');
  });
  it('blocks freebet on a layout without allowFreebet and proceeds with a valid credit when allowed (R7)', async () => {
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    const deniedLayout = { ...layout, allowFreebet: false };
    const deniedInput = await input({ freebet: null }, 'Fixture\nBet365', {
      kind: 'freebet',
      freebetId: credit.id,
    });
    // O digest cobre o layout inteiro: o caminho realmente percorrido é o de
    // um layout APROVADO que não permite freebet.
    const disallowed = await complete(deniedInput, [deniedLayout]);
    expect(disallowed).toMatchObject({ state: 'review', reason: 'FREEBET_UNRESOLVED' });
    // allowFreebet: true + crédito válido: prossegue, mas os DEMAIS gates
    // continuam valendo (a stake veio válida; a odd também).
    const allowed = await complete(
      await input({ freebet: null }, 'Fixture\nBet365', { kind: 'freebet', freebetId: credit.id }),
      [{ ...layout, allowFreebet: true }],
    );
    expect(allowed).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
  });
  it('refuses a credit from another house or an expired credit even with an approved layout (R7)', async () => {
    const superbet = (await finance.workspace(tenantContext)).catalog.find(
      (item) => item.name === 'Superbet',
    )!.id;
    const foreignCredit = await run({
      type: 'freebet.create',
      bookmakerId: superbet,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    expect(
      await complete(
        await input({ freebet: null }, 'Fixture\nBet365', {
          kind: 'freebet',
          freebetId: foreignCredit.id,
        }),
      ),
    ).toMatchObject({ state: 'review', reason: 'FREEBET_UNRESOLVED' });
    const expired = await run({
      type: 'freebet.create',
      bookmakerId: layout.bookmakerId,
      amount: '100.00',
      expiresOn: '9999-01-01',
      stakeReturned: false,
      note: 'Fictional credit',
    });
    // Fuso: expirar no relógio de São Paulo (current_date é UTC no servidor).
    await database.pool.query(
      "update finance.freebet set expires_on=(now() at time zone 'America/Sao_Paulo')::date - 1 where id=$1",
      [expired.id],
    );
    expect(
      await complete(
        await input({ freebet: null }, 'Fixture\nBet365', {
          kind: 'freebet',
          freebetId: expired.id,
        }),
      ),
    ).toMatchObject({ state: 'review', reason: 'FREEBET_UNRESOLVED' });
  });
  it('keeps a case without a readable placedAt in review and never invents an instant', async () => {
    // R5: a legenda não carrega mais data; placedAt vem apenas do texto visual.
    const noDate = await input({ placedAtText: null });
    expect(await complete(noDate)).toMatchObject({
      state: 'review',
      reason: 'PLACED_AT_UNCERTAIN',
    });
    const migrated = await input(
      { placedAtText: '2026-09-07T10:30:00-03:00' },
      'Fixture\nBet365\nreal\n07/09/2026 10:30',
    );
    expect(await complete(migrated)).toMatchObject({ state: 'imported', reason: 'IMPORTED' });
    const detail = await createImportService(database).detail(tenantContext, migrated.id);
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
