import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTANTE: a rota resolve '@stakeframe/db' pelo exports do pacote (dist).
// O harness importa o MESMO arquivo dist para que `instanceof FinanceError`
// se comporte como em produção (src × dist são classes diferentes).
import {
  createDatabase,
  createFinanceService,
  createImportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportService,
  type OrganizationContext,
} from '../../packages/db/dist/index.js';
import type { BetInput, FinanceCommand } from '../../packages/shared/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

// STK-G0-19-R7 — AÇÕES REAIS pelo Mini App autenticado por importação:
// "Alterar Status" liquida a aposta pendente (vitória/derrota) pelo comando
// financeiro canônico com versão otimista + idempotência; "Alterar Casa"
// declara a casa do rascunho e revalida o crédito freebet. Tudo atravessa o
// app completo (Fastify + banco descartável) com initData assinado de teste.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const token = '123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN12';
const ownerTelegramId = '424242';
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let tenantContext: OrganizationContext;
let app: ReturnType<typeof createApp>;
let name: string;
const previousEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  owner: process.env.TELEGRAM_OWNER_USER_ID,
};

function sign(over: { user?: string; authDate?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    auth_date: String(over.authDate ?? now),
    query_id: 'AAF',
    user: over.user ?? JSON.stringify({ id: Number(ownerTelegramId), first_name: 'Fixture' }),
  });
  const pairs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
  return params.toString();
}
const tg = { 'x-telegram-init-data': sign() };
const session = { cookie: 'session=fake' };

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
const houseId = async (house = 'Bet365') =>
  (await finance.workspace(tenantContext)).catalog.find((c) => c.name === house)!.id;
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
const seedExtraction = (id: string) =>
  database.pool.query('update integration.inbox set extraction=$2::jsonb where id=$1', [
    id,
    JSON.stringify({ extraction: draftExtraction }),
  ]);
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
// Importação registrada (aposta pendente) já vinculada ao Telegram, como se a
// resposta final da mensagem existisse (chat 42, resultado 902).
async function importedWithTelegram() {
  const id = await upload();
  await seedExtraction(id);
  await imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'real' }, 'web');
  const applied = await run({
    type: 'import.confirm',
    importId: id,
    expectedInboxVersion: 2,
    decision: { kind: 'create', bet: await betInput(), duplicateReason: '' },
  } as CommandInput);
  await database.pool.query(
    'update integration.inbox set telegram_chat_id=42,telegram_source_message_id=901,telegram_processing_message_id=900,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
    [id, 'pending'],
  );
  const version = (
    await database.pool.query<{ version: number }>(
      'select version from integration.inbox where id=$1',
      [id],
    )
  ).rows[0]!.version;
  return { importId: id, betId: applied.id, version };
}
const outbox = async (importId: string) =>
  (
    await database.pool.query<{ operation: string; state: string }>(
      'select operation,state from integration.telegram_outbox where inbox_id=$1 order by created_at,id',
      [importId],
    )
  ).rows;

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_OWNER_USER_ID = ownerTelegramId;
});
afterAll(() => {
  if (previousEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousEnv.token;
  if (previousEnv.owner === undefined) delete process.env.TELEGRAM_OWNER_USER_ID;
  else process.env.TELEGRAM_OWNER_USER_ID = previousEnv.owner;
});
beforeEach(async () => {
  name = `stk_miniapp_actions_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_miniapp_actions_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
  const getOwner = vi.fn(async (headers: Headers) =>
    headers.get('cookie')?.includes('session=fake')
      ? { user: { id: 'fixture-owner' }, status: 'active' }
      : null,
  );
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: { origin: 'https://stakeframe.test', getOwner } as unknown as OwnerAuth,
    finance,
    imports,
  });
});
afterEach(async () => {
  await app?.close();
  await database?.close();
  if (/^stk_miniapp_actions_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => {
  await admin.close();
});

describe('Mini App status section (R7)', () => {
  it('loads the canonical bet and the active houses with a valid signed initData', async () => {
    const { importId } = await importedWithTelegram();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: tg,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      bet: { state: string; stake: string; odds: string } | null;
      bookmakers: { id: string; name: string }[];
      automaticPolicy: string;
    };
    expect(body.bet).toMatchObject({ state: 'open', stake: '100.00', odds: '2.0000' });
    expect(body.bookmakers.some((house) => house.name === 'Bet365')).toBe(true);
    expect(body.automaticPolicy).toBe('disabled');
  });

  it('settles a pending bet for real, persists it, syncs Telegram and queues the cleanup', async () => {
    const { importId, version } = await importedWithTelegram();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action: 'win' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'settled' });
    // Persistência financeira: liquidação com retorno bruto calculado no servidor.
    const settlement = (
      await database.pool.query<{ outcome: string; return_amount: string }>(
        'select outcome,return_amount from finance.settlement order by settled_at desc limit 1',
      )
    ).rows[0]!;
    expect(settlement.outcome).toBe('win');
    // 100,00 de principal × odd 2,00 = 200,00 (derivado no servidor).
    expect(settlement.return_amount).toBe('200.00');
    // Reflete na web (leituras canônicas do proprietário).
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect((viaWeb.json() as { bet: { state: string } | null }).bet?.state).toBe('settled');
    // Saiu de pendente → limpeza idempotente na outbox (foto, temporária, resultado).
    const ops = (await outbox(importId)).map((item) => item.operation);
    for (const operation of [
      'delete_source_message',
      'delete_result_message',
      'delete_processing_message',
    ])
      expect(ops).toContain(operation);
  });

  it('replays the same liquidation idempotently and conflicts on a different outcome', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    const send = (action: 'win' | 'loss', withVersion = version) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/imports/${importId}/status`,
        headers: { ...tg, 'content-type': 'application/json' },
        payload: { version: withVersion, action },
      });
    expect((await send('win')).statusCode).toBe(200);
    const cleanupAfterFirst = (await outbox(importId)).length;
    // Repetição (mesmo pedido, versão antiga): mesmo resultado, zero efeito novo.
    const replay = await send('win');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ betState: 'settled' });
    expect((await outbox(importId)).length).toBe(cleanupAfterFirst);
    const settlements = (
      await database.pool.query<{ count: string }>(
        'select count(*) from finance.settlement where bet_id=$1',
        [betId],
      )
    ).rows[0]!.count;
    expect(Number(settlements)).toBe(1);
    // Outcome diferente após liquidação: conflito sanitizado, nada muda.
    expect((await send('loss')).statusCode).toBe(409);
  });
});

describe('Mini App bookmaker section (R7)', () => {
  it('declares the house on the draft and persists it for the web view', async () => {
    const id = await upload();
    await seedExtraction(id);
    const superbet = await houseId('Superbet');
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, bookmakerId: superbet },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freebetCleared: false });
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${id}`,
      headers: session,
    });
    expect((viaWeb.json() as { bookmakerOverrideId: string }).bookmakerOverrideId).toBe(superbet);
  });

  it('never keeps an incompatible freebet credit silently when the house changes', async () => {
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
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 2, bookmakerId: await houseId('Superbet') },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ freebetCleared: true });
    const row = (
      await database.pool.query<{
        bet_origin: string | null;
        freebet_id: string | null;
        bookmaker_override_id: string;
      }>('select bet_origin,freebet_id,bookmaker_override_id from integration.inbox where id=$1', [
        id,
      ])
    ).rows[0]!;
    expect(row.freebet_id).toBeNull();
    expect(row.bet_origin).toBeNull();
    // O crédito em si permanece intacto (nada foi consumido ou apagado).
    const creditRow = (
      await database.pool.query<{ used_by: string | null }>(
        'select used_by from finance.freebet where id=$1',
        [credit.id],
      )
    ).rows[0]!;
    expect(creditRow.used_by).toBeNull();
  });

  it('refuses foreign houses and foreign records with sanitized errors', async () => {
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Fixture Other','fixture-other@stk.test') on conflict (id) do nothing",
    );
    const otherContext = await finance.ensureContext('fixture-other');
    const foreignId = (
      await imports.upload(otherContext, randomUUID(), {
        image: image.toString('base64'),
        caption: 'Tipster\nBet365',
      })
    ).id;
    const id = await upload();
    await seedExtraction(id);
    // UUID de registro de OUTRA organização: 404 sanitizado (nunca 403 vazando).
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${foreignId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, action: 'win' },
    });
    expect(foreign.statusCode).toBe(404);
    const foreignPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${foreignId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, bookmakerId: await houseId() },
    });
    expect(foreignPatch.statusCode).toBe(404);
    // Casa de outra organização (mesmo UUID não existe no catálogo do dono).
    const otherHouse = (await finance.workspace(otherContext)).catalog.find(
      (c) => c.name === 'Bet365',
    )!.id;
    const invalidHouse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, bookmakerId: otherHouse },
    });
    expect(invalidHouse.statusCode).toBe(404);
  });

  it('web edits still sync the canonical telegram message (17) and Mini App edits appear on the web (18)', async () => {
    // (17) Rascunho em revisão vinculado ao Telegram: a edição pela SESSÃO web
    // entra na outbox como sincronização da mensagem específica.
    const id = await upload();
    await seedExtraction(id);
    await database.pool.query(
      'update integration.inbox set telegram_chat_id=42,telegram_source_message_id=901,telegram_processing_message_id=900,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
      [id, 'pending'],
    );
    const webEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: {
        ...session,
        'content-type': 'application/json',
        origin: 'https://stakeframe.test',
      },
      payload: { version: 1, bookmakerId: await houseId('Superbet') },
    });
    expect(webEdit.statusCode).toBe(200);
    const ops = (await outbox(id)).map((item) => item.operation);
    expect(ops).toContain('edit_result_message');
    // (18) A alteração salva pelo Mini App aparece para a leitura web — coberto
    // no teste de liquidação acima (GET com sessão reflete o estado novo).
  });
});

describe('Mini App status transitions by financial modality (G0-20)', () => {
  async function importedFreebet() {
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
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, betOrigin: 'freebet', freebetId: credit.id },
      'web',
    );
    const applied = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: await betInput({ freebetId: credit.id }),
        duplicateReason: '',
      },
    } as CommandInput);
    const version = (
      await database.pool.query<{ version: number }>(
        'select version from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!.version;
    return { importId: id, betId: applied.id, version };
  }
  const settle = (importId: string, version: number, action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action },
    });
  const lastSettlement = async (betId: string) =>
    (
      await database.pool.query<{ outcome: string; return_amount: string }>(
        'select outcome,return_amount from finance.settlement where bet_id=$1 order by settled_at desc, id desc limit 1',
        [betId],
      )
    ).rows[0]!;

  it('freebet win returns the freebet multiplied by (odd - 1), never the stake back', async () => {
    const { importId, betId, version } = await importedFreebet();
    const response = await settle(importId, version, 'win');
    expect(response.statusCode).toBe(200);
    // 100,00 de freebet x (2,00 - 1) = 100,00 — o valor da freebet nao retorna.
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'win',
      return_amount: '100.00',
    });
  });
  it('half win returns half of (P x O + P) for real', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    expect((await settle(importId, version, 'half_win')).statusCode).toBe(200);
    // (100 x 2 + 100) / 2 = 150,00 (metade ganha + metade anulada).
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'half_win',
      return_amount: '150.00',
    });
  });
  it('half loss returns P/2 for real', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    expect((await settle(importId, version, 'half_loss')).statusCode).toBe(200);
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'half_loss',
      return_amount: '50.00',
    });
  });
  it('void returns the real principal', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    expect((await settle(importId, version, 'void')).statusCode).toBe(200);
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'void',
      return_amount: '100.00',
    });
  });
  it('void returns zero for a freebet', async () => {
    const { importId, betId, version } = await importedFreebet();
    expect((await settle(importId, version, 'void')).statusCode).toBe(200);
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'void',
      return_amount: '0.00',
    });
  });
  it('keeps "Pendente" as an informative no-op without any settlement', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    const response = await settle(importId, version, 'pending');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'open' });
    const count = (
      await database.pool.query<{ count: string }>(
        'select count(*) from finance.settlement where bet_id=$1',
        [betId],
      )
    ).rows[0]!.count;
    expect(Number(count)).toBe(0);
  });
});

// STK-G0-20 B2b — aposta HÍBRIDA: valor real + crédito freebet de valor
// DIFERENTE da stake. Retorno = (real x odd) + (freebet x (odd - 1)); o valor
// da freebet nunca retorna; a classificação deriva do par (stake, crédito).
describe('Mini App hybrid modality (G0-20 B2b)', () => {
  async function importedHybrid(over: { credit?: string; stake?: string } = {}) {
    const id = await upload();
    await seedExtraction(id);
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: over.credit ?? '40.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    await imports.updateDraft(
      tenantContext,
      id,
      { version: 1, betOrigin: 'hibrida', freebetId: credit.id },
      'web',
    );
    const applied = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 2,
      decision: {
        kind: 'create',
        bet: await betInput({ freebetId: credit.id, stake: over.stake ?? '60.00' }),
        duplicateReason: '',
      },
    } as CommandInput);
    const version = (
      await database.pool.query<{ version: number }>(
        'select version from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!.version;
    return { importId: id, betId: applied.id, version, creditId: credit.id };
  }
  const settle = (importId: string, version: number, action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action },
    });
  const lastSettlement = async (betId: string) =>
    (
      await database.pool.query<{ outcome: string; return_amount: string }>(
        'select outcome,return_amount from finance.settlement where bet_id=$1 order by settled_at desc, id desc limit 1',
        [betId],
      )
    ).rows[0]!;

  it('creates a hybrid bet with a real stake and a freebet credit of a different value', async () => {
    const { betId, creditId } = await importedHybrid();
    const bet = (
      await database.pool.query<{ stake: string; freebet_id: string | null }>(
        'select stake,freebet_id from finance.bet where id=$1',
        [betId],
      )
    ).rows[0]!;
    expect(bet.stake).toBe('60.00');
    expect(bet.freebet_id).toBe(creditId);
  });

  it('exposes the hybrid origin and credit amount in the Web/Mini App detail', async () => {
    const { importId, creditId } = await importedHybrid();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      betOrigin: 'hibrida',
      bet: { freebetId: creditId, freebetAmount: '40.00' },
    });
  });

  it('settles a hybrid win as real x odd + freebet x (odd - 1)', async () => {
    const { importId, betId, version } = await importedHybrid();
    const response = await settle(importId, version, 'win');
    expect(response.statusCode).toBe(200);
    // 60,00 x 2,00 + 40,00 x (2,00 - 1) = 160,00 — a freebet nao devolve o valor.
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'win',
      return_amount: '160.00',
    });
  });

  it('void returns only the real principal for a hybrid bet', async () => {
    const { importId, betId, version, creditId } = await importedHybrid();
    const response = await settle(importId, version, 'void');
    expect(response.statusCode).toBe(200);
    expect(await lastSettlement(betId)).toMatchObject({
      outcome: 'void',
      return_amount: '60.00',
    });
    const credit = (
      await database.pool.query<{ used_by: string | null }>(
        'select used_by from finance.freebet where id=$1',
        [creditId],
      )
    ).rows[0]!;
    expect(credit.used_by).toBeNull();
  });

  it('refuses a hybrid declaration whose credit equals the stake (freebet is a pure modality)', async () => {
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
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...session, 'content-type': 'application/json' },
      payload: { version: 1, betOrigin: 'hibrida', freebetId: credit.id },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it('keeps organization isolation: foreign credits never resolve and foreign bets stay hidden', async () => {
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const otherFinance = createFinanceService(database);
    const otherContext = await otherFinance.ensureContext('fixture-other');
    await otherFinance.command(otherContext, randomUUID(), {
      type: 'bankroll.initialize',
      reserve: '500.00',
      balances: [
        {
          bookmakerId: (await otherFinance.workspace(otherContext)).catalog.find(
            (c) => c.name === 'Bet365',
          )!.id,
          amount: '500.00',
        },
      ],
      unitPercent: '1.00',
      expectedVersion: (await otherFinance.workspace(otherContext)).version,
    } as FinanceCommand);
    const foreign = await otherFinance.command(otherContext, randomUUID(), {
      type: 'freebet.create',
      bookmakerId: (await otherFinance.workspace(otherContext)).catalog.find(
        (c) => c.name === 'Bet365',
      )!.id,
      amount: '40.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
      expectedVersion: (await otherFinance.workspace(otherContext)).version,
    } as FinanceCommand);
    const id = await upload();
    await seedExtraction(id);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, betOrigin: 'hibrida', freebetId: foreign.id },
    });
    expect(response.statusCode).toBe(409);
    const row = (
      await database.pool.query<{ bet_origin: string | null; freebet_id: string | null }>(
        'select bet_origin,freebet_id from integration.inbox where id=$1',
        [id],
      )
    ).rows[0]!;
    expect(row.bet_origin).toBeNull();
    expect(row.freebet_id).toBeNull();
  });
});

// STK-G0-20 B5 — seção do Tipster: SOMENTE cadastros ATIVOS da organização,
// separados das casas; a seleção grava no registro canônico e sincroniza o
// Telegram pela outbox.
describe('Mini App tipster section (G0-20 B5)', () => {
  const createTipster = async (tipsterName: string, active = true) => {
    const created = await run({
      type: 'catalog.create',
      kind: 'tipster',
      name: tipsterName,
      aliases: [],
    } as CommandInput);
    if (!active)
      await run({
        type: 'catalog.update',
        id: created.id,
        name: tipsterName,
        aliases: [],
        active: false,
      } as CommandInput);
    return created.id;
  };

  it('loads the active tipsters separately from the active houses', async () => {
    const { importId } = await importedWithTelegram();
    const active = await createTipster('TipsterAtivo');
    await createTipster('TipsterInativo', false);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: tg,
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json() as {
      tipsters: { id: string; name: string }[];
      bookmakers: { id: string; name: string }[];
    };
    expect(detail.tipsters.map((item) => item.name)).toContain('TipsterAtivo');
    expect(detail.tipsters.map((item) => item.name)).not.toContain('TipsterInativo');
    // Casas e tipsters nunca se misturam nas duas listas.
    expect(detail.bookmakers.map((item) => item.name)).not.toContain('TipsterAtivo');
    expect(detail.tipsters.map((item) => item.id)).toContain(active);
  });

  it('selects a tipster and syncs the web view and the telegram message', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    const tipster = await createTipster('TipsterAtivo');
    const before = (await outbox(importId)).length;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/tipster`,
      headers: {
        ...tg,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { version, tipsterId: tipster },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tipsterId: tipster, tipsterName: 'TipsterAtivo' });
    const bet = (
      await database.pool.query<{ tipster_id: string | null }>(
        'select tipster_id from finance.bet where id=$1',
        [betId],
      )
    ).rows[0]!;
    expect(bet.tipster_id).toBe(tipster);
    // Web lê o mesmo registro canônico com o nome resolvido.
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(
      (viaWeb.json() as { bet: { tipsterId: string; tipsterName: string } | null }).bet,
    ).toMatchObject({ tipsterId: tipster, tipsterName: 'TipsterAtivo' });
    // Telegram espelhado pela outbox (edição da resposta final).
    const ops = (await outbox(importId)).map((item) => item.operation);
    expect(ops.length).toBeGreaterThan(before);
    expect(ops).toContain('edit_result_message');
  });

  it('refuses inactive or foreign tipsters with sanitized errors', async () => {
    const { importId, version } = await importedWithTelegram();
    const inactive = await createTipster('TipsterInativo', false);
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/tipster`,
      headers: {
        ...tg,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { version, tipsterId: inactive },
    });
    expect(refused.statusCode).toBe(409);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/tipster`,
      headers: {
        ...tg,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { version, tipsterId: '10000000-0000-4000-8000-00000000dead' },
    });
    expect(foreign.statusCode).toBe(409);
  });
});

// STK-G0-20 B4/B5 — cashout: o valor recebido é INFORMADO pelo usuário (nunca
// derivado); o total encerra todo o valor aberto e o parcial, apenas a parte
// declarada — tudo revalidado pelo comando financeiro canônico.
describe('Mini App cashout section (G0-20 B4/B5)', () => {
  const settle = async (importId: string, payload: Record<string, unknown>, version: number) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, ...payload },
    });

  it('registers a total cashout with the informed return and cleans the telegram', async () => {
    const { importId, version } = await importedWithTelegram();
    const response = await settle(importId, { action: 'cashout', returnAmount: '150.00' }, version);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'settled' });
    const settlement = (
      await database.pool.query<{ outcome: string; return_amount: string }>(
        'select outcome,return_amount from finance.settlement order by settled_at desc limit 1',
      )
    ).rows[0]!;
    expect(settlement.outcome).toBe('cashout');
    expect(settlement.return_amount).toBe('150.00');
    const ops = (await outbox(importId)).map((item) => item.operation);
    for (const operation of [
      'delete_source_message',
      'delete_result_message',
      'delete_processing_message',
    ])
      expect(ops).toContain(operation);
  });

  it('registers a partial cashout closing only the informed part', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    const response = await settle(
      importId,
      { action: 'partial_cashout', returnAmount: '80.00', closedPrincipal: '50.00' },
      version,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'open' });
    const bet = (
      await database.pool.query<{ state: string; remaining: string }>(
        'select state,remaining from finance.bet where id=$1',
        [betId],
      )
    ).rows[0]!;
    expect(bet.state).toBe('open');
    expect(bet.remaining).toBe('50.00');
    // Parcial não encerra a aposta: nada de limpeza do chat.
    const ops = (await outbox(importId)).map((item) => item.operation);
    expect(ops).not.toContain('delete_result_message');
    const settlement = (
      await database.pool.query<{ outcome: string; closed_principal: string }>(
        'select outcome,closed_principal from finance.settlement order by settled_at desc limit 1',
      )
    ).rows[0]!;
    expect(settlement.outcome).toBe('partial_cashout');
    expect(settlement.closed_principal).toBe('50.00');
  });

  it('refuses a cashout without the informed values or closing everything', async () => {
    const { importId, version } = await importedWithTelegram();
    // Sem valor informado: o contrato recusa antes de qualquer efeito.
    expect((await settle(importId, { action: 'cashout' }, version)).statusCode).toBe(400);
    expect(
      (await settle(importId, { action: 'partial_cashout', returnAmount: '80.00' }, version))
        .statusCode,
    ).toBe(400);
    // Parcial encerrando o valor aberto inteiro: conflito do comando canônico.
    expect(
      (
        await settle(
          importId,
          { action: 'partial_cashout', returnAmount: '80.00', closedPrincipal: '100.00' },
          version,
        )
      ).statusCode,
    ).toBe(409);
    const settlements = (
      await database.pool.query<{ count: string }>('select count(*) from finance.settlement')
    ).rows[0]!.count;
    expect(Number(settlements)).toBe(0);
  });

  it('replays the same cashout idempotently without duplicating effects', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    expect(
      (await settle(importId, { action: 'cashout', returnAmount: '150.00' }, version)).statusCode,
    ).toBe(200);
    const after = (await outbox(importId)).length;
    const replay = await settle(importId, { action: 'cashout', returnAmount: '150.00' }, version);
    expect(replay.statusCode).toBe(200);
    expect((await outbox(importId)).length).toBe(after);
    const settlements = (
      await database.pool.query<{ count: string }>(
        'select count(*) from finance.settlement where bet_id=$1',
        [betId],
      )
    ).rows[0]!.count;
    expect(Number(settlements)).toBe(1);
  });
});
