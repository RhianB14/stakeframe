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
const callback = (
  action: string,
  messageId: number,
  catalogId: string | null = null,
  statusAction: string | null = null,
) =>
  ({
    updateId: 90,
    callbackId: `cb-${action}${catalogId ? `:${catalogId}` : ''}${statusAction ? `:${statusAction}` : ''}`,
    action,
    catalogId,
    statusAction,
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

const outboxOps = async (id: string) =>
  (
    await database.pool.query<{ operation: string; count: string }>(
      'select operation,count(*)::text as count from integration.telegram_outbox where inbox_id=$1 group by operation order by operation',
      [id],
    )
  ).rows;
const deleteRows = async (id: string) =>
  (
    await database.pool.query<{ count: string }>(
      "select count(*) from integration.telegram_outbox where inbox_id=$1 and operation like 'delete_%'",
      [id],
    )
  ).rows[0]!.count;
const betStateOf = async (id: string) =>
  (
    await database.pool.query<{ state: string }>(
      'select b.state from finance.bet b join integration.inbox i on i.imported_bet_id=b.id where i.id=$1',
      [id],
    )
  ).rows[0]!;

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
    expect(restored.inline_keyboard[0]![0]!.web_app?.url).toContain(
      `/miniapp#miniapp?import=${id}`,
    );
    expect((await inboxState(id)).state).toBe('review');
  });

  it('discards on confirmation, removes the telegram messages and stays idempotent', async () => {
    const id = await boundInbox();
    await handler()(callback('delete_confirm', 7777));
    const afterFirst = await inboxState(id);
    expect(afterFirst.state).toBe('discarded');
    expect(String(calls[0]!.body.text)).toBe('Importação descartada.');
    // G0-20 (B4): a exclusão REMOVE a foto e as mensagens relacionadas do
    // chat (limpeza), nunca deixa mensagens órfãs.
    const ops = (await outboxOps(id)).map((row) => row.operation);
    expect(ops).toContain('delete_source_message');
    expect(ops).toContain('delete_result_message');
    expect(Number(await editRows(id))).toBe(0);
    await handler()(callback('delete_confirm', 7777));
    expect(String(calls[1]!.body.text)).toBe('Importação descartada.');
    const afterReplay = await inboxState(id);
    expect(afterReplay.state).toBe('discarded');
    expect(afterReplay.version).toBe(afterFirst.version);
    expect(Number(await deleteRows(id))).toBe(2);
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

// STK-G0-20 B3 — Casa de aposta e Tipster: botões que abrem SOMENTE o teclado
// inline respectivo com os cadastros ATIVOS da organização; a seleção atualiza
// a aposta (banco), a Web e a mensagem do Telegram (outbox), com idempotência.
describe('Casa de aposta e Tipster (G0-20 B3)', () => {
  const houseOf = async (houseName: string) =>
    (await finance.workspace(tenantContext)).catalog.find((c) => c.name === houseName)!;
  const createCatalog = async (
    kind: 'bookmaker' | 'tipster',
    catalogName: string,
    active = true,
  ) => {
    const created = await finance.command(tenantContext, randomUUID(), {
      type: 'catalog.create',
      kind,
      name: catalogName,
      aliases: [],
      expectedVersion: (await finance.workspace(tenantContext)).version,
    } as never);
    if (!active)
      await finance.command(tenantContext, randomUUID(), {
        type: 'catalog.update',
        id: created.id,
        name: catalogName,
        aliases: [],
        active: false,
        expectedVersion: (await finance.workspace(tenantContext)).version,
      } as never);
    return created.id;
  };
  async function importedInbox(): Promise<string> {
    const id = await boundInbox();
    const house = await houseOf('Bet365');
    // A confirmação é fail-closed sem origem declarada: o rascunho declara
    // dinheiro real antes do import.confirm (mesmo fluxo do Mini App).
    await imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'real' }, 'web');
    await finance.command(tenantContext, randomUUID(), {
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: {
          bookmakerId: house.id,
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
        },
        duplicateReason: '',
      },
      expectedVersion: (await finance.workspace(tenantContext)).version,
    } as never);
    return id;
  }
  const betOf = async (id: string) =>
    (
      await database.pool.query<{ bookmaker_id: string; tipster_id: string | null }>(
        'select b.bookmaker_id,b.tipster_id from finance.bet b join integration.inbox i on i.imported_bet_id=b.id where i.id=$1',
        [id],
      )
    ).rows[0]!;
  const keyboardOf = (call: { body: Record<string, unknown> }) =>
    (
      call.body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
      }
    ).inline_keyboard;

  it('opens only the active houses keyboard', async () => {
    const id = await boundInbox();
    await createCatalog('bookmaker', 'CasaInativa', false);
    calls.length = 0;
    await handler()(callback('bookmaker', 7777));
    const edit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const buttons = keyboardOf(edit).flat();
    const labels = buttons.map((button) => button.text);
    expect(labels).toContain('Bet365');
    expect(labels).not.toContain('CasaInativa');
    expect(buttons.find((button) => button.text === 'Bet365')!.callback_data).toBe(
      `sf:v1:bookmaker:${(await houseOf('Bet365')).id}`,
    );
    expect(keyboardOf(edit).at(-1)![0]!.callback_data).toBe('sf:v1:back');
    expect((await inboxState(id)).state).toBe('review');
  });

  it('opens only the active tipsters keyboard', async () => {
    await boundInbox();
    const active = await createCatalog('tipster', 'TipsterAtivo');
    await createCatalog('tipster', 'TipsterInativo', false);
    calls.length = 0;
    await handler()(callback('tipster', 7777));
    const edit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const buttons = keyboardOf(edit).flat();
    const labels = buttons.map((button) => button.text);
    expect(labels).toContain('TipsterAtivo');
    expect(labels).not.toContain('TipsterInativo');
    expect(buttons.find((button) => button.text === 'TipsterAtivo')!.callback_data).toBe(
      `sf:v1:tipster:${active}`,
    );
  });

  it('never shows houses or tipsters from another organization', async () => {
    await boundInbox();
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const otherFinance = createFinanceService(database);
    const other = await otherFinance.ensureContext('fixture-other');
    await otherFinance.command(other, randomUUID(), {
      type: 'catalog.create',
      kind: 'bookmaker',
      name: 'CasaAlheia',
      aliases: [],
      expectedVersion: (await otherFinance.workspace(other)).version,
    } as never);
    await otherFinance.command(other, randomUUID(), {
      type: 'catalog.create',
      kind: 'tipster',
      name: 'TipsterAlheio',
      aliases: [],
      expectedVersion: (await otherFinance.workspace(other)).version,
    } as never);
    calls.length = 0;
    await handler()(callback('bookmaker', 7777));
    expect(
      keyboardOf(calls.find((call) => call.method === 'editMessageReplyMarkup')!)
        .flat()
        .map((button) => button.text),
    ).not.toContain('CasaAlheia');
    calls.length = 0;
    await handler()(callback('tipster', 7777));
    expect(
      keyboardOf(calls.find((call) => call.method === 'editMessageReplyMarkup')!)
        .flat()
        .map((button) => button.text),
    ).not.toContain('TipsterAlheio');
  });

  it('selects a house and updates the bet, the web and the telegram message', async () => {
    const id = await importedInbox();
    const casaNova = await createCatalog('bookmaker', 'CasaNova');
    const before = Number(await editRows(id));
    calls.length = 0;
    await handler()(callback('bookmaker', 7777, casaNova));
    expect(String(calls[0]!.body.text)).toBe('Casa de aposta atualizada.');
    expect((await betOf(id)).bookmaker_id).toBe(casaNova);
    expect(Number(await editRows(id))).toBe(before + 1);
  });

  it('selects a tipster and updates the canonical bet with telegram sync', async () => {
    const id = await importedInbox();
    const tipster = await createCatalog('tipster', 'TipsterAtivo');
    const before = Number(await editRows(id));
    calls.length = 0;
    await handler()(callback('tipster', 7777, tipster));
    expect(String(calls[0]!.body.text)).toBe('Tipster atualizado.');
    expect((await betOf(id)).tipster_id).toBe(tipster);
    expect(Number(await editRows(id))).toBe(before + 1);
  });

  it('replays the same selection idempotently without duplicating effects', async () => {
    const id = await importedInbox();
    const casaNova = await createCatalog('bookmaker', 'CasaNova');
    await handler()(callback('bookmaker', 7777, casaNova));
    const after = Number(await editRows(id));
    calls.length = 0;
    await handler()(callback('bookmaker', 7777, casaNova));
    expect((await betOf(id)).bookmaker_id).toBe(casaNova);
    expect(Number(await editRows(id))).toBe(after);
  });

  it('restores the main keyboard on back', async () => {
    const id = await boundInbox();
    calls.length = 0;
    await handler()(callback('back', 7777));
    const edit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const first = keyboardOf(edit)[0]![0] as { web_app?: { url?: string } };
    expect(first.web_app?.url).toContain(`/miniapp#miniapp?import=${id}`);
  });
});

// STK-G0-20 B4 — botões e status da mensagem final: `📚 Alterar Status` abre
// SOMENTE o teclado inline (nunca o Mini App); a transição liquida pelo
// comando canônico (versão otimista) e a limpeza do Telegram sai na MESMA
// transação; `🗑️ Excluir` remove a aposta registrada da Web (cancelamento
// canônico) e as mensagens do chat, com confirmação e idempotência.
describe('Status e exclusão da mensagem final (G0-20 B4)', () => {
  const keyboardOf = (call: { body: Record<string, unknown> }) =>
    (
      call.body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
      }
    ).inline_keyboard;
  async function importedInboxB4(): Promise<string> {
    const id = await boundInbox();
    const house = (await finance.workspace(tenantContext)).catalog.find(
      (c) => c.name === 'Bet365',
    )!;
    await imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'real' }, 'web');
    await finance.command(tenantContext, randomUUID(), {
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: {
          bookmakerId: house.id,
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
        },
        duplicateReason: '',
      },
      expectedVersion: (await finance.workspace(tenantContext)).version,
    } as never);
    return id;
  }
  const settlementsOf = async (id: string) =>
    Number(
      (
        await database.pool.query<{ count: string }>(
          'select count(*) from finance.settlement s join integration.inbox i on i.imported_bet_id=s.bet_id where i.id=$1',
          [id],
        )
      ).rows[0]!.count,
    );

  it('opens only the status keyboard without opening the mini app', async () => {
    const id = await boundInbox();
    calls.length = 0;
    await handler()(callback('status', 7777));
    expect(String(calls[0]!.body.text)).toBe('Escolha o novo status.');
    const edit = calls.find((call) => call.method === 'editMessageReplyMarkup')!;
    const buttons = keyboardOf(edit).flat();
    expect(buttons.map((button) => button.text)).toEqual([
      '✅ Ganha',
      '❌ Perdida',
      '⏳ Pendente',
      '🌗 Meio-Ganha',
      '🌗 Meio-Perdida',
      '💱 Reembolsada',
      '◀️ Voltar para o bilhete',
    ]);
    expect(buttons.some((button) => 'web_app' in button)).toBe(false);
    expect((await inboxState(id)).state).toBe('review');
  });

  it('settles a pending bet from the status keyboard and cleans the telegram', async () => {
    const id = await importedInboxB4();
    calls.length = 0;
    await handler()(callback('status', 7777, null, 'win'));
    expect(String(calls[0]!.body.text)).toBe('Liquidação registrada.');
    expect((await betStateOf(id)).state).toBe('settled');
    const ops = (await outboxOps(id)).map((row) => row.operation);
    expect(ops).toContain('delete_source_message');
    expect(ops).toContain('delete_result_message');
    // Repetição do MESMO evento: mesmo resultado, nenhum efeito duplicado.
    calls.length = 0;
    await handler()(callback('status', 7777, null, 'win'));
    expect(String(calls[0]!.body.text)).toBe('Liquidação registrada.');
    expect(await settlementsOf(id)).toBe(1);
  });

  it('keeps pending informative and refuses a conflicting status after settlement', async () => {
    const id = await importedInboxB4();
    calls.length = 0;
    await handler()(callback('status', 7777, null, 'pending'));
    expect(String(calls[0]!.body.text)).toBe('A aposta permanece pendente.');
    expect((await betStateOf(id)).state).toBe('open');
    await handler()(callback('status', 7777, null, 'win'));
    calls.length = 0;
    await handler()(callback('status', 7777, null, 'loss'));
    expect(String(calls[0]!.body.text)).toContain('Não foi possível');
    expect((await betStateOf(id)).state).toBe('settled');
    expect(await settlementsOf(id)).toBe(1);
  });

  it('deletes an imported bet from the web and removes its telegram messages', async () => {
    const id = await importedInboxB4();
    calls.length = 0;
    await handler()(callback('delete_confirm', 7777));
    expect(String(calls[0]!.body.text)).toBe('Aposta excluída.');
    expect((await betStateOf(id)).state).toBe('cancelled');
    const ops = (await outboxOps(id)).map((row) => row.operation);
    expect(ops).toContain('delete_source_message');
    expect(ops).toContain('delete_result_message');
    // Repetição: mesmo resultado, nenhum efeito novo.
    calls.length = 0;
    await handler()(callback('delete_confirm', 7777));
    expect(String(calls[0]!.body.text)).toBe('Aposta excluída.');
    expect((await betStateOf(id)).state).toBe('cancelled');
    expect(Number(await deleteRows(id))).toBe(2);
  });
});
