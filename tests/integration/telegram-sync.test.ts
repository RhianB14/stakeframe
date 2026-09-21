import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { OPENROUTER_MODEL } from '../../packages/shared/src/index.js';
import type { BetInput, FinanceCommand } from '../../packages/shared/src/index.js';

// STK-G0-19-R5 — fonte canônica única: origem declarada, datas separadas e
// limpeza do Telegram enfileirada na outbox idempotente. Nenhuma operação real
// do Telegram acontece aqui.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let tenantContext: OrganizationContext;
let name: string;
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
const upload = async (caption = 'Tipster\nBet365') =>
  (await imports.upload(tenantContext, randomUUID(), { image: image.toString('base64'), caption }))
    .id;
const houseId = async () =>
  (await finance.workspace(tenantContext)).catalog.find((c) => c.name === 'Bet365')!.id;
async function betInput(over: Partial<BetInput> = {}): Promise<BetInput> {
  return {
    bookmakerId: await houseId(),
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: null,
    reference: 'fixture-ticket',
    allowMissingUnit: false,
    selections: [
      {
        event: 'A x B',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'A',
        odds: null,
        eventDate: null,
        eventAt: null,
        dateStatus: 'pending',
      },
    ],
    ...over,
  };
}
const draftExtraction = {
  reference: 'FICTICIO',
  placedAtText: '17/09/2026 10:00',
  currency: 'BRL',
  stake: '100.00',
  odds: '2.00',
  potentialReturn: null,
  freebet: null,
  selections: [
    {
      event: 'A x B',
      sport: 'Futebol',
      market: 'Resultado',
      selection: 'A',
      odds: null,
      eventDateText: null,
    },
  ],
  warnings: [],
};
const seedExtraction = (id: string, over: Record<string, unknown> = {}) =>
  database.pool.query('update integration.inbox set extraction=$2::jsonb where id=$1', [
    id,
    JSON.stringify({ extraction: { ...draftExtraction, ...over } }),
  ]);
const outbox = async () =>
  (
    await database.pool.query<{ operation: string; state: string; version: number }>(
      'select operation,state,version from integration.telegram_outbox order by created_at,id',
    )
  ).rows;

beforeEach(async () => {
  name = `stk_telegram_sync_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_telegram_sync_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  finance = createFinanceService(database);
  await migrateLocalDatabase(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Fixture Owner','fixture-owner@stk.test') on conflict (id) do nothing",
  );
  tenantContext = await finance.ensureContext('fixture-owner');
  imports = createImportService(database);
  await run({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId: await houseId(), amount: '500.00' }],
    unitPercent: '1.00',
  });
});
afterEach(async () => {
  await database?.close();
  if (/^stk_telegram_sync_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('telegram sync canonical draft', () => {
  it('binds the private identifiers idempotently and queues the processing message once', async () => {
    const id = await upload();
    const meta = { chatId: 42, sourceMessageId: 900, receivedAt: new Date('2026-09-17T13:00:00Z') };
    await imports.attachTelegram(tenantContext, id, meta);
    await imports.attachTelegram(tenantContext, id, meta);
    const row = (
      await database.pool.query<{
        telegram_chat_id: string;
        telegram_source_message_id: string;
        telegram_received_at: Date;
        telegram_sync_state: string;
        version: number;
      }>(
        'select telegram_chat_id,telegram_source_message_id,telegram_received_at,telegram_sync_state,version from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(Number(row.telegram_chat_id)).toBe(42);
    expect(Number(row.telegram_source_message_id)).toBe(900);
    expect(row.telegram_sync_state).toBe('pending');
    const ops = await outbox();
    expect(ops.filter((op) => op.operation === 'send_processing_message')).toHaveLength(1);
  });

  it('stores the declared origin, confirms the event date and preserves the received instant', async () => {
    const id = await upload();
    const received = new Date('2026-09-17T13:00:00Z');
    await imports.attachTelegram(tenantContext, id, {
      chatId: 42,
      sourceMessageId: 901,
      receivedAt: received,
    });
    await database.pool.query(
      'update integration.inbox set telegram_result_message_id=902 where id=$1',
      [id],
    );
    const first = await imports.updateDraft(
      tenantContext,
      id,
      { version: 2, betOrigin: 'real' },
      'web',
    );
    const second = await imports.updateDraft(
      tenantContext,
      id,
      { version: first.version, eventAt: '2026-09-20T21:30:00.000Z' },
      'web',
    );
    const row = (
      await database.pool.query<{
        bet_origin: string;
        event_at: Date;
        event_date_status: string;
        telegram_received_at: Date;
        telegram_sync_state: string;
      }>(
        'select bet_origin,event_at,event_date_status,telegram_received_at,telegram_sync_state from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.bet_origin).toBe('real');
    expect(row.event_date_status).toBe('confirmed');
    expect(row.event_at.toISOString()).toBe('2026-09-20T21:30:00.000Z');
    // Nunca sobrescrever telegramReceivedAt com a data do evento.
    expect(row.telegram_received_at.toISOString()).toBe(received.toISOString());
    const edits = (await outbox()).filter((op) => op.operation === 'edit_result_message');
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.at(-1)!.version).toBe(second.version);
    const audit = (
      await database.pool.query<{ after: Record<string, unknown> }>(
        "select after from finance.audit where type='import.draft_update' order by created_at",
      )
    ).rows;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('902');
  });

  it('persists the editable ticket shape without changing the OCR evidence', async () => {
    const id = await upload();
    const before = (
      await database.pool.query<{ extraction: unknown }>(
        'select extraction from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!.extraction;
    const saved = await imports.updateDraft(
      tenantContext,
      id,
      {
        version: 1,
        ticketKind: 'betbuild',
        stake: '25.00',
        odds: '14.70',
        sport: 'Tênis',
        tournament: 'Copa Davis',
        country: 'Mundo',
        selections: [
          {
            event: 'Jiri Lehecka x Ben Shelton',
            market: 'Resultado Final',
            selection: 'Jiri Lehecka',
          },
          {
            event: 'Jiri Lehecka x Ben Shelton',
            market: 'Game 7 - Vencedor',
            selection: 'Jiri Lehecka',
          },
        ],
      },
      'web',
    );
    const row = (
      await database.pool.query<{
        metadata: { userOverrides?: Record<string, unknown> };
        extraction: unknown;
      }>('select metadata,extraction from integration.inbox where id=$1', [id])
    ).rows[0]!;
    expect(row.metadata.userOverrides).toMatchObject({
      ticketKind: 'betbuild',
      stake: '25.00',
      odds: '14.70',
      sport: 'Tênis',
      tournament: 'Copa Davis',
      country: 'Mundo',
    });
    expect(row.metadata.userOverrides?.selections).toHaveLength(2);
    expect(row.extraction).toEqual(before);
    expect(saved.version).toBe(2);
  });

  it('clears the event date back to pending and rejects stale versions', async () => {
    const id = await upload();
    const first = await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, eventAt: new Date().toISOString() },
      'web',
    );
    expect(
      (
        await database.pool.query<{ event_date_status: string }>(
          'select event_date_status from integration.inbox where id=$1',
          [id],
        )
      ).rows[0]!.event_date_status,
    ).toBe('confirmed');
    await expect(
      imports.updateDraft(tenantContext, id, { version: 1, eventAt: null }, 'web'),
    ).rejects.toThrow('VERSION_CONFLICT');
    await imports.updateDraft(tenantContext, id, { version: first.version, eventAt: null }, 'web');
    expect(
      (
        await database.pool.query<{ event_date_status: string }>(
          'select event_date_status from integration.inbox where id=$1',
          [id],
        )
      ).rows[0]!.event_date_status,
    ).toBe('pending');
  });

  it('requires the explicit credit for a freebet origin and rejects mismatches', async () => {
    const id = await upload();
    await seedExtraction(id);
    await expect(
      imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'freebet' }, 'web'),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const saved = await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    const row = (
      await database.pool.query<{ bet_origin: string; freebet_id: string }>(
        'select bet_origin,freebet_id from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.bet_origin).toBe('freebet');
    expect(row.freebet_id).toBe(credit.id);
    // Trocar para dinheiro real limpa o crédito — nunca escolha implícita.
    await imports.updateDraft(
      tenantContext,
      id,
      { version: saved.version, betOrigin: 'real' },
      'web',
    );
    expect(
      (
        await database.pool.query<{ freebet_id: string | null }>(
          'select freebet_id from integration.inbox where id=$1',
          [id],
        )
      ).rows[0]!.freebet_id,
    ).toBeNull();
  });

  it('keeps records private across organizations', async () => {
    const id = await upload();
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const other = await createFinanceService(database).ensureContext('fixture-other');
    await expect(
      imports.updateDraft(other, id, { version: 1, betOrigin: 'real' }, 'web'),
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('import confirmation under the R5 contract', () => {
  it('assumes real money when no promotional origin was declared', async () => {
    const id = await upload();
    const bet = await betInput();
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: '' },
    });
    expect(created.id).toEqual(expect.any(String));
    expect((await database.pool.query('select count(*) from finance.bet')).rows[0]!.count).toBe(
      '1',
    );
  });

  it('records the origin declared in the confirm command as canonical draft state', async () => {
    const id = await upload();
    const bet = await betInput();
    await database.pool.query(
      'update integration.inbox set telegram_chat_id=42,telegram_result_message_id=950 where id=$1',
      [id],
    );
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: '', betOrigin: 'real' },
    });
    const row = (
      await database.pool.query<{
        bet_origin: string;
        state: string;
        imported_bet_id: string;
        version: number;
      }>('select bet_origin,state,imported_bet_id,version from integration.inbox where id=$1', [id])
    ).rows[0]!;
    expect(row.bet_origin).toBe('real');
    expect(row.state).toBe('imported');
    expect(row.imported_bet_id).toBe(created.id);
    const edits = (await outbox()).filter(
      (op) => op.operation === 'edit_result_message' && op.version === row.version,
    );
    expect(edits).toHaveLength(1);
  });

  it('rejects contradictions between the command and the canonical draft', async () => {
    const id = await upload();
    await imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'real' }, 'web');
    const bet = await betInput();
    await expect(
      run({
        type: 'import.confirm',
        importId: id,
        expectedInboxVersion: 2,
        decision: { kind: 'create', bet, duplicateReason: '', betOrigin: 'freebet' },
      }),
    ).rejects.toThrow('STATE_CONFLICT');
  });

  it('gives a freebet import the exact credit chosen by the user', async () => {
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const id = await upload();
    await seedExtraction(id);
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: await betInput({ freebetId: credit.id }),
        duplicateReason: '',
      },
    });
    const bet = (await finance.bet(tenantContext, created.id)).bet;
    expect(bet.freebetId).toBe(credit.id);
  });
});

describe('automatic telegram cleanup after leaving pending', () => {
  const settle = (id: string, outcome: 'win' | 'loss' | 'cashout') =>
    run({
      type: 'bet.settle',
      id,
      outcome,
      closedPrincipal: '100.00',
      returnAmount: outcome === 'win' ? '200.00' : outcome === 'cashout' ? '150.00' : '0.00',
      settledAt: new Date().toISOString(),
      reason: 'Liquidação conferida',
    });
  async function importedWithTelegram(): Promise<{ importId: string; betId: string }> {
    const id = await upload();
    await imports.attachTelegram(tenantContext, id, {
      chatId: 42,
      sourceMessageId: 960,
      receivedAt: new Date('2026-09-17T13:00:00Z'),
    });
    await database.pool.query(
      'update integration.inbox set telegram_processing_message_id=961, telegram_result_message_id=962 where id=$1',
      [id],
    );
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: await betInput(),
        duplicateReason: 'Bilhetes distintos do cenário de limpeza',
        betOrigin: 'real',
      },
    });
    return { importId: id, betId: created.id };
  }
  it('queues photo, result and processing deletions when a bet is won, lost or cashed out', async () => {
    for (const outcome of ['win', 'loss', 'cashout'] as const) {
      const { importId, betId } = await importedWithTelegram();
      await settle(betId, outcome);
      const deletes = (await outbox()).filter((op) => op.operation.startsWith('delete_'));
      for (const operation of [
        'delete_source_message',
        'delete_result_message',
        'delete_processing_message',
      ])
        expect(deletes.some((op) => op.operation === operation)).toBe(true);
      const row = (
        await database.pool.query<{ telegram_sync_state: string }>(
          'select telegram_sync_state from integration.inbox where id=$1',
          [importId],
        )
      ).rows[0]!;
      expect(row.telegram_sync_state).toBe('pending');
    }
  });

  it('queues the same cleanup on cancellation', async () => {
    const { betId } = await importedWithTelegram();
    await run({
      type: 'bet.cancel',
      id: betId,
      effectiveAt: new Date().toISOString(),
      reason: 'Aposta anulada',
    });
    const deletes = (await outbox()).filter((op) => op.operation.startsWith('delete_'));
    expect(deletes.map((op) => op.operation)).toContain('delete_source_message');
    expect(deletes.map((op) => op.operation)).toContain('delete_result_message');
  });

  it('never re-creates messages when a bet returns to open', async () => {
    const { importId, betId } = await importedWithTelegram();
    const settled = await settle(betId, 'loss');
    const deletesBefore = (await outbox()).filter((op) =>
      op.operation.startsWith('delete_'),
    ).length;
    await run({
      type: 'settlement.reverse',
      id: settled.id,
      effectiveAt: new Date().toISOString(),
      reason: 'Correção do resultado',
    });
    const after = await outbox();
    expect(after.filter((op) => op.operation.startsWith('send_')).length).toBe(1); // só a processamento (da attach)
    expect(after.filter((op) => op.operation.startsWith('delete_')).length).toBe(deletesBefore);
    expect(after.filter((op) => op.operation === 'send_result_message').length).toBe(0);
    void importId;
  });
});

describe('freebet compatibility on the canonical draft (R6)', () => {
  it('refuses credits from another house, expired, or already used', async () => {
    const id = await upload();
    await seedExtraction(id);
    const superbet = (await finance.workspace(tenantContext)).catalog.find(
      (c) => c.name === 'Superbet',
    )!;
    const foreignHouse = await run({
      type: 'freebet.create',
      bookmakerId: superbet.id,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    await expect(
      imports.updateDraft(
        tenantContext,
        id,
        { version: 1, betOrigin: 'freebet', freebetId: foreignHouse.id },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
    const expired = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    await database.pool.query(
      "update finance.freebet set expires_on = (now() at time zone 'America/Sao_Paulo')::date - 1 where id=$1",
      [expired.id],
    );
    await expect(
      imports.updateDraft(
        tenantContext,
        id,
        { version: 1, betOrigin: 'freebet', freebetId: expired.id },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
    const used = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const consumed = await run({ type: 'bet.create', ...(await betInput({ freebetId: used.id })) });
    await database.pool.query('update finance.freebet set used_by=$2 where id=$1', [
      used.id,
      consumed.id,
    ]);
    await expect(
      imports.updateDraft(
        tenantContext,
        id,
        { version: 1, betOrigin: 'freebet', freebetId: used.id },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
  });

  it('refuses a credit from another organization without leaking details', async () => {
    const id = await upload();
    await seedExtraction(id);
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const financeOther = createFinanceService(database);
    const otherContext = await financeOther.ensureContext('fixture-other');
    const otherHouse = (await financeOther.workspace(otherContext)).catalog.find(
      (c) => c.name === 'Bet365',
    )!;
    await financeOther.command(otherContext, randomUUID(), {
      type: 'bankroll.initialize',
      reserve: '500.00',
      balances: [{ bookmakerId: otherHouse.id, amount: '500.00' }],
      unitPercent: '1.00',
      expectedVersion: (await financeOther.workspace(otherContext)).version,
    });
    const otherCredit = await financeOther.command(otherContext, randomUUID(), {
      type: 'freebet.create',
      bookmakerId: otherHouse.id,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
      expectedVersion: (await financeOther.workspace(otherContext)).version,
    });
    await expect(
      imports.updateDraft(
        tenantContext,
        id,
        { version: 1, betOrigin: 'freebet', freebetId: otherCredit.id },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
  });

  it('declares freebet regardless of the automatic policy (R7) — saved and flagged, never blocked', async () => {
    const id = await upload();
    await seedExtraction(id);
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const directory = mkdtempSync(join(tmpdir(), 'stk-policy-'));
    const file = join(directory, 'policies.json');
    const house = await houseId();
    const layout = (allowFreebet: boolean) => ({
      id: 'synthetic-layout',
      bookmaker: 'bet365',
      bookmakerId: house,
      model: OPENROUTER_MODEL,
      description: 'Fictional layout used exclusively for deterministic integration tests.',
      placedAtFormat: 'iso-offset',
      allowFreebet,
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
    });
    // R7: a declaração do usuário nunca é bloqueada pela política automática —
    // nem com layout allowFreebet=false. O que muda é só o aviso sanitizado.
    writeFileSync(file, JSON.stringify([layout(false)]));
    process.env.AUTOMATIC_IMPORT_POLICIES_FILE = file;
    try {
      const saved = await imports.updateDraft(
        tenantContext,
        id,
        { version: 1, betOrigin: 'freebet', freebetId: credit.id },
        'web',
      );
      expect(saved.version).toBeGreaterThan(1);
      // AUTOMATIC_IMPORT_ENABLED não está ligado no ambiente de teste: o
      // aviso é 'disabled' (a automação não roda, o bilhete segue em revisão).
      expect(saved.automaticPolicy).toBe('disabled');
      expect(saved.freebetCleared).toBe(false);
    } finally {
      delete process.env.AUTOMATIC_IMPORT_POLICIES_FILE;
      rmSync(directory, { recursive: true, force: true });
    }
    // Sem arquivo de política algum a declaração TAMBÉM é salva (novo rascunho).
    const other = await upload();
    await seedExtraction(other);
    const second = await imports.updateDraft(
      tenantContext,
      other,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    expect(second.version).toBeGreaterThan(1);
  });

  it('keeps exactly one import when two drafts compete for the same credit', async () => {
    const first = await upload();
    const second = await upload();
    await seedExtraction(first);
    await seedExtraction(second);
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    await imports.updateDraft(
      tenantContext,
      first,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    await imports.updateDraft(
      tenantContext,
      second,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    await run({
      type: 'import.confirm',
      importId: first,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: await betInput({ freebetId: credit.id }),
        duplicateReason: '',
        betOrigin: 'freebet',
      },
    });
    await expect(
      run({
        type: 'import.confirm',
        importId: second,
        expectedInboxVersion: 2,
        decision: {
          kind: 'create',
          bet: await betInput({ freebetId: credit.id }),
          duplicateReason: 'Segundo bilhete concorrente pelo mesmo crédito',
          betOrigin: 'freebet',
        },
      }),
    ).rejects.toThrow('INVALID_FINANCIAL_OPERATION');
    expect((await database.pool.query('select count(*)::int n from finance.bet')).rows[0]!.n).toBe(
      1,
    );
  });

  it('refuses freebet when the draft house or stake cannot be resolved', async () => {
    const unknownHouse = await upload('Fixture\nCasa Desconhecida');
    await seedExtraction(unknownHouse, { bookmaker: null });
    await expect(
      imports.updateDraft(
        tenantContext,
        unknownHouse,
        { version: 1, betOrigin: 'freebet', freebetId: randomUUID() },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
    const noExtraction = await upload();
    await expect(
      imports.updateDraft(
        tenantContext,
        noExtraction,
        { version: 1, betOrigin: 'freebet', freebetId: randomUUID() },
        'web',
      ),
    ).rejects.toThrow('FREEBET_UNRESOLVED');
  });
});
