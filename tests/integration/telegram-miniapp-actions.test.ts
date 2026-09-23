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
const seedExtraction = (id: string, patch: { warnings?: string[] } = {}) =>
  database.pool.query('update integration.inbox set extraction=$2::jsonb where id=$1', [
    id,
    JSON.stringify({ extraction: { ...draftExtraction, ...patch } }),
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
    // O bilhete mantém a resposta final como reentrada do Mini App; foto e
    // temporária são removidas e a mensagem final recebe o novo status.
    const ops = (await outbox(importId)).map((item) => item.operation);
    for (const operation of [
      'delete_source_message',
      'delete_processing_message',
      'edit_result_message',
    ])
      expect(ops).toContain(operation);
    expect(ops).not.toContain('delete_result_message');
  });

  it('replays the same liquidation idempotently and corrects a settled outcome with audited reversals', async () => {
    const { importId, betId, version } = await importedWithTelegram();
    const balanceBefore = await finance.workspace(tenantContext);
    const send = (action: 'win' | 'loss' | 'pending', withVersion = version) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/imports/${importId}/status`,
        headers: { ...tg, 'content-type': 'application/json' },
        payload: { version: withVersion, action },
      });
    const won = await send('win');
    expect(won.statusCode).toBe(200);
    const readOutcome = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/${importId}`,
        headers: session,
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { bet: { activeOutcome: string | null } }).bet.activeOutcome;
    };
    expect(await readOutcome()).toBe('win');
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
    // Corrige resultado pela mesma operação pública: o primeiro lançamento é
    // estornado no ledger e o novo resultado é lançado na mesma transação.
    const corrected = await send('loss', (won.json() as { version: number }).version);
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({ betState: 'settled' });
    expect(await readOutcome()).toBe('loss');
    await expect(
      database.pool.query(
        'select outcome from finance.settlement where bet_id=$1 order by settled_at desc, id desc limit 1',
        [betId],
      ),
    ).resolves.toMatchObject({ rows: [{ outcome: 'loss' }] });
    const pending = await send('pending', (corrected.json() as { version: number }).version);
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ betState: 'open' });
    expect(await readOutcome()).toBeNull();
    const balanceAfter = await finance.workspace(tenantContext);
    const financialSnapshot = (value: typeof balanceBefore) => ({
      bankroll: value.bankroll,
      available: value.available,
      exposure: value.exposure,
      accounts: value.accounts
        .map(({ id, balance }) => ({ id, balance }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(financialSnapshot(balanceAfter)).toEqual(financialSnapshot(balanceBefore));
    const activeSettlements = (
      await database.pool.query<{ count: string }>(
        'select count(*) from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.bet_id=$1 and r.settlement_id is null',
        [betId],
      )
    ).rows[0]!.count;
    expect(Number(activeSettlements)).toBe(0);
    const reversals = (
      await database.pool.query<{ count: string }>(
        'select count(*) from finance.settlement_reversal r join finance.settlement s on s.id=r.settlement_id where s.bet_id=$1',
        [betId],
      )
    ).rows[0]!.count;
    expect(Number(reversals)).toBe(2);
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

describe('Mini App draft confirmation (G0-22)', () => {
  it('saves the canonical draft, confirms one bet, and replays idempotently', async () => {
    const id = await upload();
    await seedExtraction(id);
    const key = randomUUID();
    const bookmakerId = await houseId();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: {
        version: 1,
        betOrigin: 'real',
        bookmakerId,
        tipsterId: null,
        sport: 'Futebol',
        tournament: 'Fixture',
        country: 'Brasil',
        ticketKind: 'simple',
        stake: '100.00',
        odds: '2.00',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
      },
    });
    expect(patch.statusCode).toBe(200);
    const version = (patch.json() as { version: number }).version;
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/confirm`,
      headers: { ...tg, 'content-type': 'application/json', 'idempotency-key': key },
      payload: { version },
    });
    expect(confirmed.statusCode).toBe(200);
    const result = confirmed.json() as { version: number; betId: string; betState: string };
    expect(result.betState).toBe('open');

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/confirm`,
      headers: { ...tg, 'content-type': 'application/json', 'idempotency-key': key },
      payload: { version },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { betId: string }).betId).toBe(result.betId);
    const count = (
      await database.pool.query<{ count: string }>('select count(*) from finance.bet where id=$1', [
        result.betId,
      ])
    ).rows[0]!.count;
    expect(Number(count)).toBe(1);
  });

  it('assumes real money when the origin is not selected', async () => {
    const id = await upload();
    await seedExtraction(id);
    const bookmakerId = await houseId();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: 1, bookmakerId, stake: '100.00', odds: '2.00' },
    });
    expect(patch.statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/confirm`,
      headers: { ...tg, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: { version: (patch.json() as { version: number }).version },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'open' });
  });

  it('confirms from the Mini App after the owner fixes extraction warnings', async () => {
    const id = await upload();
    await seedExtraction(id, {
      warnings: [
        'Rótulos de stake e retorno potencial não identificados na imagem.',
        'Odds individuais de cada seleção não são exibidas no criador de aposta.',
      ],
    });
    const bookmakerId = await houseId();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: {
        version: 1,
        betOrigin: 'real',
        bookmakerId,
        sport: 'Futebol',
        tournament: 'Fixture',
        country: 'Brasil',
        ticketKind: 'simple',
        stake: '100.00',
        odds: '2.00',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
      },
    });
    expect(patch.statusCode).toBe(200);

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/confirm`,
      headers: { ...tg, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: { version: (patch.json() as { version: number }).version },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ betState: 'open' });
    expect((await imports.detail(tenantContext, id)).item.state).toBe('imported');
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

  it('selects a tipster on a draft and keeps the choice in the shared detail', async () => {
    const importId = await upload('');
    await seedExtraction(importId);
    const tipster = await createTipster('TipsterDoRascunho');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/tipster`,
      headers: {
        ...tg,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { version: 1, tipsterId: tipster },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      betState: null,
      tipsterId: tipster,
      tipsterName: 'TipsterDoRascunho',
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ tipsterOverrideId: tipster });
    const manual = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: {
        version: 2,
        sport: 'Futebol',
        tournament: 'Copa do Brasil',
        country: 'Brasil',
      },
    });
    expect(manual.statusCode).toBe(200);
    const afterManual = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(afterManual.json()).toMatchObject({
      sportOverride: 'Futebol',
      tournamentOverride: 'Copa do Brasil',
      countryOverride: 'Brasil',
    });
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
    for (const operation of ['delete_source_message', 'delete_processing_message'])
      expect(ops).toContain(operation);
    expect(ops).toContain('edit_result_message');
    expect(ops).not.toContain('delete_result_message');
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

describe('STK-G0-23 confiabilidade do salvamento no Mini App', () => {
  // Caminho real do Mini App: upload -> extracao -> PATCH do rascunho -> confirm.
  // Assim a fixture nasce como o fluxo a produz, e nao por escrita direta.
  async function registeredComplete() {
    const id = await upload();
    await seedExtraction(id);
    const bookmakerId = await houseId();
    const draft = await imports.updateDraft(
      tenantContext,
      id,
      {
        version: 1,
        betOrigin: 'real',
        bookmakerId,
        tipsterId: null,
        sport: 'Futebol',
        tournament: 'Fixture',
        country: 'Brasil',
        ticketKind: 'simple',
        stake: '100.00',
        odds: '2.00',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
      },
      'web',
    );
    const confirmed = await imports.confirmDraft(
      tenantContext,
      id,
      { version: draft.version },
      'web',
      randomUUID(),
    );
    return { importId: id, betId: confirmed.betId, version: confirmed.version, bookmakerId };
  }
  const betRow = async (betId: string) => {
    const row = (
      await database.pool.query<{
        stake: string;
        odds: string;
        bookmaker_id: string;
        state: string;
        completion_state: string;
      }>('select stake,odds,bookmaker_id,state,completion_state from finance.bet where id=$1', [
        betId,
      ])
    ).rows[0];
    if (!row) throw new Error('BET_NOT_FOUND');
    return row;
  };
  const inboxVersion = async (importId: string) =>
    (
      await database.pool.query<{ version: number }>(
        'select version from integration.inbox where id=$1',
        [importId],
      )
    ).rows[0]!.version;

  it('recusa no servidor uma edicao que nao pode ser persistida no registro canonico', async () => {
    const { importId, betId, version } = await registeredComplete();
    const before = await betRow(betId);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: {
        version,
        betOrigin: 'real',
        stake: '250.00',
        odds: '3.50',
        selections: [{ event: 'C x D', market: 'Total', selection: 'C' }],
      },
    });
    // Nunca 200: o servidor nao pode anunciar "salvo" algo que nao gravou.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    // O registro financeiro permanece intacto (fonte da Web e da mensagem).
    expect(await betRow(betId)).toEqual(before);
    expect(before).toMatchObject({ stake: '100.00', odds: '2.0000', completion_state: 'complete' });
    // Nada foi gravado no rascunho: a versao nem avancou.
    expect(await inboxVersion(importId)).toBe(version);
    const detail = await imports.detail(tenantContext, importId);
    // O override do rascunho pode existir, mas nunca com o valor recusado.
    expect(detail.stakeOverride).not.toBe('250.00');
    expect(detail.bet).toMatchObject({ stake: '100.00' });
  });

  it('aceita o PATCH quando nao ha divergencia com o registro canonico', async () => {
    const { importId, version } = await registeredComplete();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      // Mesmo conteudo vigente: nao ha nada a persistir, logo nao ha mentira.
      payload: {
        version,
        betOrigin: 'real',
        stake: '100.00',
        odds: '2.00',
        sport: 'Futebol',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await inboxVersion(importId)).toBeGreaterThan(version);
  });

  it('reflete a troca de casa feita pelo comando canonico no registro financeiro', async () => {
    const { importId, betId, version } = await registeredComplete();
    const houses = (await finance.workspace(tenantContext)).catalog;
    const target = houses.find((entry) => entry.name === 'Superbet');
    expect(target).toBeDefined();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/bookmaker`,
      headers: {
        ...tg,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { version, bookmakerId: target!.id },
    });
    expect(response.statusCode).toBe(200);
    const bet = await betRow(betId);
    expect(bet.bookmaker_id).toBe(target!.id);
    // A mensagem do Telegram le o canonico, portanto ja ve a casa nova.
    const detail = await imports.detail(tenantContext, importId);
    expect(detail.bet?.bookmakerId).toBe(target!.id);
    // O que prevalece na tela e na mensagem e o canonico (o editor foi
    // corrigido para dar precedencia a ele sobre o override do rascunho).
    expect(detail.bet?.bookmakerId ?? detail.bookmakerOverrideId).toBe(target!.id);
  });

  it('nao deixa uma versao stale sobrescrever a mudanca mais recente', async () => {
    const { importId, betId, version } = await registeredComplete();
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: version - 1, tournament: 'Torneio antigo' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    // A mudanca nova continua valendo.
    expect(await inboxVersion(importId)).toBe(version);
    expect((await betRow(betId)).stake).toBe('100.00');
    const fresh = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, tournament: 'Torneio novo' },
    });
    expect(fresh.statusCode).toBe(200);
    const detail = await imports.detail(tenantContext, importId);
    expect(detail.tournamentOverride).toBe('Torneio novo');
  });

  it('liquidada -> outro resultado -> Pendente preserva a trilha contabil', async () => {
    const { importId, version } = await registeredComplete();
    const won = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action: 'win' },
    });
    expect(won.statusCode).toBe(200);
    const settledVersion = (won.json() as { version: number }).version;
    const first = (
      await database.pool.query<{ id: string; outcome: string; return_amount: string }>(
        'select id,outcome,return_amount from finance.settlement',
      )
    ).rows;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ outcome: 'win', return_amount: '200.00' });
    // Correcao para outro resultado liquida a MESMA aposta sem duplicar.
    const loss = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: settledVersion, action: 'loss' },
    });
    expect(loss.statusCode).toBe(200);
    // Correcao gera estorno da liquidacao anterior + nova: duas linhas no
    // historico, mas UMA unica liquidacao ativa (a vigente).
    expect(
      (
        await database.pool.query(
          'select s.id from finance.settlement s left join finance.settlement_reversal r on r.organization_id=s.organization_id and r.settlement_id=s.id where r.settlement_id is null',
        )
      ).rowCount,
    ).toBe(1);
    const reopenVersion = (loss.json() as { version: number }).version;
    const pending = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version: reopenVersion, action: 'pending' },
    });
    expect(pending.statusCode).toBe(200);
    expect((pending.json() as { betState: string }).betState).toBe('open');
    const reversals = (
      await database.pool.query<{ settlement_id: string }>(
        'select settlement_id from finance.settlement_reversal',
      )
    ).rows;
    // O estorno fica auditavel: a liquidacao vigente foi revertida.
    expect(reversals.length).toBeGreaterThanOrEqual(1);
    expect(reversals.map((row) => row.settlement_id)).toContain(first[0]!.id);
  });

  it('reabre mostrando o resultado vigente', async () => {
    const { importId, version } = await registeredComplete();
    const settled = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action: 'half_win' },
    });
    expect(settled.statusCode).toBe(200);
    const reopened = await imports.detail(tenantContext, importId);
    expect(reopened.bet).toMatchObject({ state: 'settled', activeOutcome: 'half_win' });
    // O menu suspenso da tela Editar aposta reabre no resultado vigente.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: tg,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ bet: { state: 'settled', activeOutcome: 'half_win' } });
  });

  it('repeticao da liquidacao nao duplica efeito financeiro', async () => {
    const { importId, version } = await registeredComplete();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action: 'win' },
    });
    expect(first.statusCode).toBe(200);
    const settlements = async () =>
      (await database.pool.query('select id from finance.settlement')).rowCount;
    expect(await settlements()).toBe(1);
    // Rede incerta / retry com a MESMA versao e a MESMA acao: o servidor
    // reconhece a liquidacao ativa como sucesso idempotente — mas nao cria
    // outro journal nem altera o resultado de novo.
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/status`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, action: 'win' },
    });
    expect(retry.statusCode).toBe(200);
    expect(await settlements()).toBe(1);
    // O registro continua integro e a aposta segue liquida UMA vez.
    const detail = await imports.detail(tenantContext, importId);
    expect(detail.bet).toMatchObject({ state: 'settled', activeOutcome: 'win' });
  });

  it('distingue persistencia concluida de entrega Telegram pendente', async () => {
    const { importId, version } = await registeredComplete();
    await database.pool.query(
      'update integration.inbox set telegram_chat_id=42,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
      [importId, 'synced'],
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, tournament: 'Copa do Brasil' },
    });
    expect(response.statusCode).toBe(200);
    const persisted = await imports.detail(tenantContext, importId);
    expect(persisted.tournamentOverride).toBe('Copa do Brasil');
    // Persistencia concluida ANTES do envio: a fila fica pendente a parte.
    const state = (
      await database.pool.query<{ telegram_sync_state: string }>(
        'select telegram_sync_state from integration.inbox where id=$1',
        [importId],
      )
    ).rows[0]!;
    expect(state.telegram_sync_state).toBe('pending');
    expect(await outbox(importId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'pending' })]),
    );
  });
});

// STK-G0-23-R1 — a revisão do Codex mostrou que o formulário completo do Mini
// App mandava TUDO pelo PATCH do rascunho, de modo que campos que JÁ têm
// comando canônico (casa, tipster, origem/crédito e data) acabavam recusados
// pelo fail-closed. Estes casos exercitam o caminho HTTP real que o editor
// passou a usar e leem o resultado depois de cada chamada.
describe('STK-G0-23-R1 encaminhamento canonico no Mini App', () => {
  const createTipster = async (tipsterName: string) =>
    (
      await run({
        type: 'catalog.create',
        kind: 'tipster',
        name: tipsterName,
        aliases: [],
      } as CommandInput)
    ).id;
  const createCredit = async (bookmakerId: string) =>
    (
      await run({
        type: 'freebet.create',
        bookmakerId,
        amount: '100.00',
        expiresOn: '2026-12-31',
        stakeReturned: false,
        note: '',
      } as CommandInput)
    ).id;
  const inboxRow = async (importId: string) =>
    (
      await database.pool.query<{
        version: number;
        tournament: unknown;
        stake_override: unknown;
        telegram_sync_state: string;
      }>('select version,metadata,telegram_sync_state from integration.inbox where id=$1', [
        importId,
      ])
    ).rows[0]!;
  const betRow = async (betId: string) =>
    (
      await database.pool.query<{
        bookmaker_id: string;
        tipster_id: string | null;
        freebet_id: string | null;
        stake: string;
        odds: string;
      }>('select bookmaker_id,tipster_id,freebet_id,stake,odds from finance.bet where id=$1', [
        betId,
      ])
    ).rows[0]!;
  const settingsVersion = async () =>
    (await database.pool.query<{ version: number }>('select version from finance.settings'))
      .rows[0]!.version;

  // Aposta CONFIRMADA e vinculada ao Telegram — mesmo caminho do Mini App.
  async function confirmedWithTelegram() {
    const id = await upload();
    await seedExtraction(id);
    const bookmakerId = await houseId();
    const draft = await imports.updateDraft(
      tenantContext,
      id,
      {
        version: 1,
        betOrigin: 'real',
        bookmakerId,
        tipsterId: null,
        sport: 'Futebol',
        tournament: 'Fixture',
        country: 'Brasil',
        ticketKind: 'simple',
        stake: '100.00',
        odds: '2.00',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
      },
      'web',
    );
    const confirmed = await imports.confirmDraft(
      tenantContext,
      id,
      { version: draft.version },
      'web',
      randomUUID(),
    );
    // Baseline: mensagem já sincronizada, para medir a re-sincronização.
    await database.pool.query(
      'update integration.inbox set telegram_chat_id=42,telegram_source_message_id=901,telegram_processing_message_id=900,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
      [id, 'synced'],
    );
    const version = (await inboxRow(id)).version;
    const selections = (
      await database.pool.query<{ id: string }>(
        'select id from finance.selection where bet_id=$1 order by position',
        [confirmed.betId],
      )
    ).rows;
    return {
      importId: id,
      betId: confirmed.betId,
      version,
      bookmakerId,
      selectionId: selections[0]!.id,
    };
  }
  const post = (importId: string, route: string, payload: unknown, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/${route}`,
      headers: { ...tg, 'content-type': 'application/json', 'idempotency-key': key },
      payload: payload as Record<string, unknown>,
    });

  it('encaminha casa e tipster pelos comandos canonicos: registro, web e mensagem do Telegram', async () => {
    const { importId, betId, version } = await confirmedWithTelegram();
    const superbet = await houseId('Superbet');
    const tipster = await createTipster('R1Tipster');
    const before = (await outbox(importId)).length;

    const house = await post(importId, 'bookmaker', { version, bookmakerId: superbet });
    expect(house.statusCode).toBe(200);
    const houseVersion = (house.json() as { version: number }).version;
    // A versão devolvida é a que a próxima chamada DEVE usar.
    expect(houseVersion).toBeGreaterThanOrEqual(version);

    const tipsterRes = await post(importId, 'tipster', {
      version: houseVersion,
      tipsterId: tipster,
    });
    expect(tipsterRes.statusCode).toBe(200);
    const tipsterVersion = (tipsterRes.json() as { version: number }).version;

    // Registro canônico alterado.
    expect(await betRow(betId)).toMatchObject({
      bookmaker_id: superbet,
      tipster_id: tipster,
    });
    // A Web lê o MESMO registro, com nomes resolvidos.
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(viaWeb.json().bet).toMatchObject({
      bookmakerId: superbet,
      bookmakerName: 'Superbet',
      tipsterId: tipster,
      tipsterName: 'R1Tipster',
    });
    // A mensagem do Telegram foi re-enfileirada (não depende do PATCH).
    const ops = (await outbox(importId)).map((item) => item.operation);
    expect(ops.length).toBeGreaterThan(before);
    expect(ops).toContain('edit_result_message');
    expect((await inboxRow(importId)).telegram_sync_state).toBe('pending');
    // Reabertura: o detalhe devolve a versão nova, que é a que o editor usa.
    const reopened = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: tg,
    });
    expect((reopened.json() as { item: { version: number } }).item.version).toBe(tipsterVersion);
  });

  it('usa o comando de origem/crédito proprio e o replay nao duplica efeito', async () => {
    const { importId, betId, version, bookmakerId } = await confirmedWithTelegram();
    const credit = await createCredit(bookmakerId);
    const key = randomUUID();
    const before = await settingsVersion();

    const applied = await post(
      importId,
      'origin',
      { version, kind: 'freebet', freebetId: credit },
      key,
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ kind: 'freebet' });
    expect(await betRow(betId)).toMatchObject({ freebet_id: credit });
    const afterApply = await settingsVersion();
    expect(afterApply).toBeGreaterThan(before);

    // Retry incerto: mesma chave devolve o MESMO resultado e não executa de novo.
    const replay = await post(
      importId,
      'origin',
      { version, kind: 'freebet', freebetId: credit },
      key,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(applied.json());
    expect(await settingsVersion()).toBe(afterApply);
    expect(await betRow(betId)).toMatchObject({ freebet_id: credit });
  });

  it('usa o comando de data proprio e atualiza a selecao sem duplicar', async () => {
    const { importId, betId, version, selectionId } = await confirmedWithTelegram();
    const key = randomUUID();
    const before = await settingsVersion();
    const eventAt = '2026-09-30T15:00:00.000Z';

    const applied = await post(importId, 'event', { version, selectionId, eventAt }, key);
    expect(applied.statusCode).toBe(200);
    const selection = (
      await database.pool.query<{ event_at: Date | null }>(
        'select event_at from finance.selection where id=$1',
        [selectionId],
      )
    ).rows[0]!;
    expect(selection.event_at?.toISOString()).toBe(eventAt);
    expect(await settingsVersion()).toBeGreaterThan(before);

    const replay = await post(importId, 'event', { version, selectionId, eventAt }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(applied.json());
    expect(await settingsVersion()).toBe(before + 1);
    // O PATCH do rascunho continua sendo quem guarda torneio/país.
    expect(betId).toBeTruthy();
  });

  it('recusa valor e odd ANTES de gravar o rascunho, mesmo com metadados no mesmo payload', async () => {
    const { importId, version } = await confirmedWithTelegram();
    const before = await inboxRow(importId);

    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, stake: '250.00', odds: '3.50', tournament: 'Torneio Novo' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });

    // Nada foi escrito — nem o campo bloqueado nem o metadado que vinha junto.
    const after = await inboxRow(importId);
    expect(after.version).toBe(before.version);
    expect(after.telegram_sync_state).toBe(before.telegram_sync_state);
    const metadata = after.tournament as { tournamentOverride?: string | null } | null;
    expect(metadata?.tournamentOverride ?? 'Fixture').not.toBe('Torneio Novo');
  });

  it('mantem editavel a aposta confirmada quando nada financeiro muda', async () => {
    const { importId, version } = await confirmedWithTelegram();

    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, tournament: 'Copa do Brasil', country: 'Brasil', ticketKind: 'simple' },
    });
    expect(saved.statusCode).toBe(200);
    const newVersion = (saved.json() as { version: number }).version;
    expect(newVersion).toBeGreaterThan(version);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(detail.json().tournamentOverride).toBe('Copa do Brasil');
  });

  it('versao stale nao sobrescreve e a falha parcial preserva o que ja foi aplicado', async () => {
    const { importId, betId, version } = await confirmedWithTelegram();
    const superbet = await houseId('Superbet');

    const house = await post(importId, 'bookmaker', { version, bookmakerId: superbet });
    expect(house.statusCode).toBe(200);
    const fresh = (house.json() as { version: number }).version;

    // Versão obsoleta: repete o valor ANTIGO — não pode sobrescrever nada.
    const stale = await post(importId, 'bookmaker', { version, bookmakerId: await houseId() });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);

    // Falha parcial REAL: a casa ficou aplicada e o tipster falhou por versão
    // velha. O estado parcial existe e é exatamente o que a interface precisa
    // nomear (coberto em tests/unit/miniapp-confirmed-save.test.ts).
    const staleTipster = await post(importId, 'tipster', {
      version,
      tipsterId: await createTipster('R1TipsterStale'),
    });
    expect(staleTipster.statusCode).toBe(409);
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    expect((await betRow(betId)).tipster_id).toBeNull();

    // Recuperação segura: usar a versão devolvida completa a sequência sem
    // repetir a troca de casa.
    const settingsBefore = await settingsVersion();
    const tipster = await createTipster('R1TipsterFinal');
    const recovered = await post(importId, 'tipster', { version: fresh, tipsterId: tipster });
    expect(recovered.statusCode).toBe(200);
    expect(await betRow(betId)).toMatchObject({ bookmaker_id: superbet, tipster_id: tipster });
    expect(await settingsVersion()).toBeGreaterThan(settingsBefore);
  });

  // STK-G0-23-R2 — a revisão do Codex mostrou que `save()` mandava o PATCH com a
  // versão capturada quando o PLANO foi montado, ignorando a versão devolvida
  // pelo último comando canônico. Como cada comando avança a inbox, o PATCH
  // chegava obsoleto e o servidor recusava por VERSION_CONFLICT — o botão
  // "Salvar e confirmar aposta" deixava o salvamento parcial. Estes testes rodam
  // a SEQUÊNCIA REAL do cliente (comandos + PATCH) contra o servidor.
  const patch = (importId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload,
    });

  it('a sequencia do botao salvar conclui com a versao devolvida pelo comando canonico', async () => {
    const { importId, betId, version } = await confirmedWithTelegram();
    const superbet = await houseId('Superbet');
    const before = (await outbox(importId)).length;
    // O plano é montado ANTES de qualquer escrita: os campos não alterados e os
    // metadados do rascunho, com a versão capturada na abertura.
    const planned = {
      tournament: 'Copa do Brasil',
      country: 'Brasil',
      ticketKind: 'simple',
      stake: '100.00',
      odds: '2.00',
    };

    // O comando canônico avança a inbox...
    const house = await post(importId, 'bookmaker', { version, bookmakerId: superbet });
    expect(house.statusCode).toBe(200);
    const fresh = (house.json() as { version: number }).version;
    expect(fresh).toBeGreaterThan(version);

    // ...então a versão do PLANO está obsoleta: é o defeito apontado.
    const stale = await patch(importId, { ...planned, version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect((await inboxRow(importId)).version).toBe(fresh);

    // Com a versão DEVOLVIDA pelo comando, a sequência conclui.
    const saved = await patch(importId, { ...planned, version: fresh });
    expect(saved.statusCode).toBe(200);
    const savedVersion = (saved.json() as { version: number }).version;
    expect(savedVersion).toBeGreaterThan(fresh);

    // Registro canônico, Web e mensagem do Telegram — os dois caminhos da edição.
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(viaWeb.json().bet).toMatchObject({ bookmakerId: superbet, bookmakerName: 'Superbet' });
    expect(viaWeb.json().tournamentOverride).toBe('Copa do Brasil');
    const ops = (await outbox(importId)).map((item) => item.operation);
    expect(ops.length).toBeGreaterThan(before);
    expect(ops).toContain('edit_result_message');
    expect((await inboxRow(importId)).telegram_sync_state).toBe('pending');
  });

  it('duas alteracoes canonicas no mesmo salvamento encadeiam a versao ate o PATCH', async () => {
    const { importId, betId, version, selectionId } = await confirmedWithTelegram();
    const superbet = await houseId('Superbet');
    const eventAt = '2026-10-02T18:00:00.000Z';
    const planned = {
      tournament: 'Copa do Brasil',
      country: 'Brasil',
      ticketKind: 'simple',
      stake: '100.00',
      odds: '2.00',
    };

    const house = await post(importId, 'bookmaker', { version, bookmakerId: superbet });
    expect(house.statusCode).toBe(200);
    const afterHouse = (house.json() as { version: number }).version;

    // O segundo comando usa a versão que o PRIMEIRO devolveu.
    const date = await post(importId, 'event', { version: afterHouse, selectionId, eventAt });
    expect(date.statusCode).toBe(200);
    const afterDate = (date.json() as { version: number }).version;
    expect(afterDate).toBeGreaterThan(afterHouse);

    // A versão do plano (a da abertura) já está obsoleta nos dois saltos.
    const stale = await patch(importId, { ...planned, version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });

    const saved = await patch(importId, { ...planned, version: afterDate });
    expect(saved.statusCode).toBe(200);

    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    const selection = (
      await database.pool.query<{ event_at: Date | null }>(
        'select event_at from finance.selection where id=$1',
        [selectionId],
      )
    ).rows[0]!;
    expect(selection.event_at?.toISOString()).toBe(eventAt);
  });

  it('o PATCH fecha a sequencia com a versao alcancada apos uma falha parcial', async () => {
    const { importId, betId, version } = await confirmedWithTelegram();
    const superbet = await houseId('Superbet');
    const planned = {
      tournament: 'Copa do Brasil',
      country: 'Brasil',
      ticketKind: 'simple',
      stake: '100.00',
      odds: '2.00',
    };

    const house = await post(importId, 'bookmaker', { version, bookmakerId: superbet });
    expect(house.statusCode).toBe(200);
    const reached = (house.json() as { version: number }).version;
    const settingsAfterHouse = await settingsVersion();

    // Falha parcial: o PATCH da PRIMEIRA tentativa sai com a versão do plano.
    const failed = await patch(importId, { ...planned, version });
    expect(failed.statusCode).toBe(409);
    // A troca de casa continua aplicada — é exatamente o "parcial" que a
    // interface precisa nomear, e não pode ser re-aplicada no retry.
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);

    // Retry do cliente: mesma versão alcançada, sem repetir o comando canônico.
    const saved = await patch(importId, { ...planned, version: reached });
    expect(saved.statusCode).toBe(200);
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    expect(await settingsVersion()).toBe(settingsAfterHouse);
  });
});
