import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  it('refuses to create a financial bet without a declared origin (fail-closed)', async () => {
    const id = await upload();
    const bet = await betInput();
    await expect(
      run({
        type: 'import.confirm',
        importId: id,
        expectedInboxVersion: 1,
        decision: { kind: 'create', bet, duplicateReason: '' },
      }),
    ).rejects.toThrow('ORIGIN_REQUIRED');
    expect((await database.pool.query('select count(*) from finance.bet')).rows[0]!.count).toBe(
      '0',
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
