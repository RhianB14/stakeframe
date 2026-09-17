import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createTenantContext,
  enqueueOutbox,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createTelegramOutboxService } from '../../apps/worker/src/telegram-outbox.js';
import type { TelegramConfig } from '../../apps/worker/src/telegram.js';
import type { FinanceCommand } from '../../packages/shared/src/index.js';

// STK-G0-19-R5 — executor da outbox com o Bot API MOÇADO (zero operação real).

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const config: TelegramConfig = { token: '123456:TEST-TOKEN', userId: '999', chatId: '42' };
const json = (body: unknown, status = 200) => Response.json(body, { status });
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
let responses: (Response | Error)[];
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
const run = async (input: CommandInput) =>
  finance.command(tenantContext, randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace(tenantContext)).version,
  } as FinanceCommand);
const extraction = {
  bookmaker: 'Bet365',
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
async function boundInbox(): Promise<string> {
  const { id } = await imports.upload(tenantContext, randomUUID(), {
    image: image.toString('base64'),
    caption: 'Tipster\nBet365',
  });
  await database.pool.query(
    "update integration.inbox set extraction=$2::jsonb,state='review' where id=$1",
    [id, JSON.stringify({ extraction })],
  );
  await imports.attachTelegram(tenantContext, id, {
    chatId: 42,
    sourceMessageId: 900,
    receivedAt: new Date('2026-09-17T13:00:00Z'),
  });
  return id;
}
const service = () => createTelegramOutboxService(database, config, fetchImpl);

beforeEach(async () => {
  name = `stk_telegram_outbox_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_telegram_outbox_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
    balances: [
      {
        bookmakerId: (await finance.workspace(tenantContext)).catalog.find(
          (c) => c.name === 'Bet365',
        )!.id,
        amount: '500.00',
      },
    ],
    unitPercent: '1.00',
  });
  responses = [];
  fetchImpl = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('UNEXPECTED_TELEGRAM_CALL');
    if (next instanceof Error) throw next;
    return next;
  });
});
afterEach(async () => {
  await database?.close();
  if (/^stk_telegram_outbox_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('telegram outbox executor', () => {
  it('sends the processing message once, storing its id and the source binding', async () => {
    const id = await boundInbox();
    responses.push(json({ ok: true, result: { message_id: 111 } }));
    await service().processOnce();
    const row = (
      await database.pool.query<{ telegram_processing_message_id: string }>(
        'select telegram_processing_message_id from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(Number(row.telegram_processing_message_id)).toBe(111);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ chat_id: 42, reply_to_message_id: 900 });
    // Idempotente: uma segunda passada não reenvia.
    expect(await service().processOnce()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('delivers the result before deleting the temporary message, never duplicating', async () => {
    const id = await boundInbox();
    responses.push(
      json({ ok: true, result: { message_id: 111 } }),
      json({ ok: true, result: { message_id: 222 } }),
      json({ ok: true, result: true }),
    );
    await imports.queueResultMessage(tenantContext, id);
    let progressed = true;
    while (progressed) progressed = await service().processOnce();
    const row = (
      await database.pool.query<{
        telegram_processing_message_id: string | null;
        telegram_result_message_id: string;
        telegram_sync_state: string;
      }>(
        'select telegram_processing_message_id,telegram_result_message_id,telegram_sync_state from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(Number(row.telegram_result_message_id)).toBe(222);
    expect(row.telegram_processing_message_id).toBeNull();
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.at(-1)).toContain('/deleteMessage');
    const deleteBody = JSON.parse(
      String((fetchImpl.mock.calls.at(-1)![1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(deleteBody).toMatchObject({ chat_id: 42, message_id: 111 });
    expect(row.telegram_sync_state).toBe('synced');
    expect(urls.filter((url) => url.endsWith('/sendMessage'))).toHaveLength(2);
  });

  it('respects retry_after on 429 and does not duplicate the message on retry', async () => {
    const id = await boundInbox();
    responses.push(json({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429));
    await service().processOnce();
    const row = (
      await database.pool.query<{ state: string; attempts: number; next_attempt_at: Date }>(
        'select state,attempts,next_attempt_at from integration.telegram_outbox where inbox_id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 5_000);
    await database.pool.query(
      "update integration.telegram_outbox set next_attempt_at=now() - interval '1 second'",
    );
    responses.push(json({ ok: true, result: { message_id: 333 } }));
    await service().processOnce();
    const after = (
      await database.pool.query<{ telegram_processing_message_id: string }>(
        'select telegram_processing_message_id from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(Number(after.telegram_processing_message_id)).toBe(333);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('marks permanent failures for reconciliation without touching canonical data', async () => {
    const id = await boundInbox();
    responses.push(json({ ok: true, result: { message_id: 111 } }));
    await service().processOnce();
    await database.pool.query(
      'update integration.inbox set telegram_result_message_id=222 where id=$1',
      [id],
    );
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 2, eventAt: '2026-09-20T21:30:00.000Z' },
      'web',
    );
    responses.push(json({ ok: false, error_code: 403, description: 'Forbidden' }, 403));
    await service().processOnce();
    const row = (
      await database.pool.query<{
        telegram_sync_state: string;
        telegram_result_message_id: string;
        event_at: Date;
        event_date_status: string;
      }>(
        'select telegram_sync_state,telegram_result_message_id,event_at,event_date_status from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.telegram_sync_state).toBe('failed');
    // A edição canônica permanece intacta; nada foi desfeito.
    expect(Number(row.telegram_result_message_id)).toBe(222);
    expect(row.event_date_status).toBe('confirmed');
  });

  it('never lets a stale edit overwrite a newer canonical version', async () => {
    const id = await boundInbox();
    await database.pool.query(
      'update integration.inbox set telegram_result_message_id=222 where id=$1',
      [id],
    );
    await imports.updateDraft(tenantContext, id, { version: 2, betOrigin: 'real' }, 'web');
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 3, eventAt: '2026-09-20T21:30:00.000Z' },
      'web',
    );
    // Drena a mensagem temporária pendente antes de observar as edições.
    responses.push(json({ ok: true, result: { message_id: 111 } }));
    await service().processOnce();
    responses.push(json({ ok: true, result: true }));
    let progressed = true;
    let calls = 0;
    while (progressed) {
      progressed = await service().processOnce();
      calls += 1;
      if (calls > 10) break;
    }
    const edits = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/editMessageText'));
    expect(edits).toHaveLength(1);
    const body = JSON.parse(String((edits[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(String(body.text)).toContain('confirmado');
  });

  it('treats a missing message as an idempotent success during cleanup', async () => {
    const id = await boundInbox();
    responses.push(json({ ok: true, result: { message_id: 111 } }));
    await service().processOnce();
    await database.pool.query(
      'update integration.inbox set telegram_result_message_id=222 where id=$1',
      [id],
    );
    const tenant = createTenantContext(database);
    await tenant.withOrganizationTransaction(tenantContext, (client) =>
      enqueueOutbox(client, id, 'delete_result_message', 3),
    );
    responses.push(
      json(
        { ok: false, error_code: 400, description: 'Bad Request: message to delete not found' },
        400,
      ),
    );
    await service().processOnce();
    const row = (
      await database.pool.query<{
        state: string;
        telegram_deleted_at: Date;
        telegram_sync_state: string;
      }>(
        'select o.state,i.telegram_deleted_at,i.telegram_sync_state from integration.telegram_outbox o join integration.inbox i on i.id=o.inbox_id where o.operation=$1 and o.inbox_id=$2',
        ['delete_result_message', id],
      )
    ).rows[0]!;
    expect(row.state).toBe('done');
    expect(row.telegram_deleted_at).not.toBeNull();
    expect(row.telegram_sync_state).toBe('deleted');
  });

  it('keeps the settled status when a cleanup deletion fails permanently', async () => {
    const id = await boundInbox();
    responses.push(json({ ok: true, result: { message_id: 333 } }));
    await service().processOnce();
    await database.pool.query(
      'update integration.inbox set telegram_result_message_id=222 where id=$1',
      [id],
    );
    const betInput = {
      bookmakerId: (await finance.workspace(tenantContext)).catalog.find(
        (c) => c.name === 'Bet365',
      )!.id,
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
          dateStatus: 'pending' as const,
        },
      ],
    };
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: { kind: 'create', bet: betInput, duplicateReason: '', betOrigin: 'real' },
    });
    await run({
      type: 'bet.settle',
      id: created.id,
      outcome: 'loss',
      closedPrincipal: '100.00',
      returnAmount: '0.00',
      settledAt: new Date().toISOString(),
      reason: 'Liquidação conferida',
    });
    // Falhas permanentes em todas as exclusões.
    for (let index = 0; index < 3; index += 1)
      responses.push(json({ ok: false, error_code: 403, description: 'Forbidden' }, 403));
    let progressed = true;
    while (progressed) progressed = await service().processOnce();
    const bet = (await finance.bet(tenantContext, created.id)).bet;
    expect(bet.state).toBe('settled');
    const row = (
      await database.pool.query<{ telegram_sync_state: string }>(
        'select telegram_sync_state from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.telegram_sync_state).toBe('failed');
    const failed = (
      await database.pool.query<{ count: string }>(
        "select count(*) from integration.telegram_outbox where state='failed'",
      )
    ).rows[0]!;
    expect(Number(failed.count)).toBe(3);
  });
});
