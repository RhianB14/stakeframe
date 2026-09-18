import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createTelegramCallbackHandler } from '../../apps/worker/src/telegram-callbacks.js';
import { createTelegramClient, type TelegramConfig } from '../../apps/worker/src/telegram.js';

// STK-G0-19-R6 — callbacks dos botões: resolvidos pelo vínculo canônico
// (chat + id da mensagem), com confirmação explícita na exclusão e idempotência.
// O Bot API é MOÇADO; zero operação real.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const config: TelegramConfig = {
  token: '123456:TEST-TOKEN',
  userId: '999',
  chatId: '42',
  miniAppUrl: 'https://app.stakeframe.test',
};
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
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let tenantContext: OrganizationContext;
let name: string;
let calls: Array<{ method: string; body: Record<string, unknown> }>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

const handler = () =>
  createTelegramCallbackHandler(database, createTelegramClient(config, fetchImpl), config);
const callback = (action: string, messageId: number) =>
  ({
    updateId: 90,
    callbackId: `cb-${action}`,
    action,
    messageId,
  }) as never;

async function boundInbox(resultMessageId = 7777): Promise<string> {
  const { id } = await imports.upload(tenantContext, randomUUID(), {
    image: image.toString('base64'),
    caption: 'Fixture\nBet365',
  });
  await database.pool.query(
    "update integration.inbox set extraction=$2::jsonb,state='review',telegram_chat_id=42,telegram_source_message_id=900,telegram_result_message_id=$3 where id=$1",
    [id, JSON.stringify({ extraction }), resultMessageId],
  );
  return id;
}
const inboxState = async (id: string) =>
  (
    await database.pool.query<{ state: string; version: number }>(
      'select state,version from integration.inbox where id=$1',
      [id],
    )
  ).rows[0]!;
const editRows = async (id: string) =>
  (
    await database.pool.query<{ count: string }>(
      "select count(*) from integration.telegram_outbox where inbox_id=$1 and operation='edit_result_message'",
      [id],
    )
  ).rows[0]!.count;

beforeEach(async () => {
  name = `stk_telegram_cb_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_telegram_cb_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
  await finance.command(tenantContext, randomUUID(), {
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
    expectedVersion: (await finance.workspace(tenantContext)).version,
  });
  calls = [];
  fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const method = String(input).split('/').pop() ?? '';
    const body =
      init && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ method, body });
    return Response.json({ ok: true, result: true });
  });
});
afterEach(async () => {
  await database?.close();
  if (/^stk_telegram_cb_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('telegram result buttons callbacks', () => {
  // R7: os fluxos de status e casa NÃO são mais callbacks de texto — viraram
  // botões web_app com seções reais do Mini App (o parser os recusa; os testes
  // de rota com initData real cobrem a gravação efetiva).

  it('requires an explicit confirmation before discarding and allows cancelling', async () => {
    const id = await boundInbox();
    await handler()(callback('delete', 7777));
    const confirmEdit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const keyboard = confirmEdit.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    expect(keyboard.inline_keyboard[0]![0]!.callback_data).toBe('sf:v1:delete:confirm');
    expect((await inboxState(id)).state).toBe('review');

    calls.length = 0;
    await handler()(callback('delete_cancel', 7777));
    const cancelEdit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const restored = cancelEdit.body.reply_markup as {
      inline_keyboard: Array<Array<{ web_app?: { url?: string } }>>;
    };
    expect(restored.inline_keyboard[0]![0]!.web_app?.url).toContain(`#miniapp?import=${id}`);
    expect((await inboxState(id)).state).toBe('review');
  });

  it('discards on confirmation and stays idempotent for repeated events', async () => {
    const id = await boundInbox();
    await handler()(callback('delete_confirm', 7777));
    const afterFirst = await inboxState(id);
    expect(afterFirst.state).toBe('discarded');
    expect(String(calls[0]!.body.text)).toBe('Importação descartada.');
    // O descarte reflete no Telegram como edição canônica da resposta final.
    expect(Number(await editRows(id))).toBe(1);
    await handler()(callback('delete_confirm', 7777));
    expect(String(calls[1]!.body.text)).toBe('Importação descartada.');
    const afterReplay = await inboxState(id);
    expect(afterReplay.state).toBe('discarded');
    expect(afterReplay.version).toBe(afterFirst.version);
  });

  it('refuses callbacks for unknown messages without touching any record', async () => {
    const id = await boundInbox(8888);
    await handler()(callback('delete', 9999));
    expect(String(calls[0]!.body.text)).toContain('não encontrada');
    expect((await inboxState(id)).state).toBe('review');
    expect(await editRows(id)).toBe('0');
  });

  it('keeps organization isolation: a foreign organization message is not found or changed', async () => {
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const otherContext = await createFinanceService(database).ensureContext('fixture-other');
    const { id: foreignId } = await imports.upload(otherContext, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    });
    await database.pool.query(
      "update integration.inbox set state='review',telegram_chat_id=42,telegram_result_message_id=6666 where id=$1",
      [foreignId],
    );
    await handler()(callback('delete_confirm', 6666));
    expect(String(calls[0]!.body.text)).toContain('não encontrada');
    const foreign = (
      await database.pool.query<{ state: string }>(
        'select state from integration.inbox where id=$1',
        [foreignId],
      )
    ).rows[0]!;
    expect(foreign.state).toBe('review');
  });
});
