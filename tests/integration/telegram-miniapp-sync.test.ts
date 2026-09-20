import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTANTE: as rotas resolvem '@stakeframe/db' pelo exports do pacote (dist).
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
import { createTelegramOutboxService } from '../../apps/worker/src/telegram-outbox.js';
import { type TelegramConfig } from '../../apps/worker/src/telegram.js';

// STK-G0-19-R8 — fonte canônica pós-importação e sincronização REAL
// Telegram ↔ web: troca de casa como comando financeiro transacional (journal
// de reclassificação), troca de origem com journals compensatórios, data por
// seleção via comando de evento, e a outbox EXECUTADA com cliente mockado —
// conferindo o corpo de editMessageText (valores novos presentes, antigos
// ausentes, versão antiga não sobrescrevendo).

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const token = ['123456', 'TEST-TOKEN-TEST-TOKEN-TEST-TOKEN12'].join(':');
const ownerTelegramId = '424242';
const config: TelegramConfig = {
  token: '123456:TEST-TOKEN',
  userId: '999',
  chatId: '42',
  miniAppUrl: 'https://app.stakeframe.test',
};
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
const houseId = async (house = 'Bet365') =>
  (await finance.workspace(tenantContext)).catalog.find((c) => c.name === house)!.id;
const upload = async () =>
  (
    await imports.upload(tenantContext, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Tipster\nBet365',
    })
  ).id;
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
async function betInput(
  over: Partial<BetInput> = {},
  selections?: BetInput['selections'],
): Promise<BetInput> {
  return {
    bookmakerId: await houseId(),
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: new Date(Date.now() - 60_000).toISOString(),
    freebetId: null,
    reference: 'fixture-ticket',
    allowMissingUnit: false,
    selections: selections ?? [
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
    ...over,
  };
}
async function bindTelegram(id: string) {
  await database.pool.query(
    'update integration.inbox set telegram_chat_id=42,telegram_source_message_id=901,telegram_processing_message_id=900,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
    [id, 'pending'],
  );
}
// Importação registrada (aposta pendente) vinculada ao Telegram, com a fila
// inicial já processada — os asserts enxergam somente operações novas.
async function imported(over: Partial<BetInput> = {}, selections?: BetInput['selections']) {
  const id = await upload();
  await seedExtraction(id);
  await imports.updateDraft(tenantContext, id, { version: 1, betOrigin: 'real' }, 'web');
  const applied = await run({
    type: 'import.confirm',
    importId: id,
    expectedInboxVersion: 2,
    decision: { kind: 'create', bet: await betInput(over, selections), duplicateReason: '' },
  } as CommandInput);
  await bindTelegram(id);
  await drain();
  calls.length = 0;
  const version = (
    await database.pool.query<{ version: number }>(
      'select version from integration.inbox where id=$1',
      [id],
    )
  ).rows[0]!.version;
  return { importId: id, betId: applied.id, version };
}
async function importedFreebet() {
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
  await bindTelegram(id);
  await drain();
  calls.length = 0;
  const version = (
    await database.pool.query<{ version: number }>(
      'select version from integration.inbox where id=$1',
      [id],
    )
  ).rows[0]!.version;
  return { importId: id, betId: applied.id, version, oldCredit: credit.id };
}
const calls: { method: string; body: Record<string, unknown> }[] = [];
const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = url.split('/').pop() ?? '';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ method, body });
  if (method === 'editMessageText' || method === 'sendMessage')
    return Response.json({ ok: true, result: { message_id: 902 } });
  return Response.json({ ok: true, result: true });
});
const outbox = () => createTelegramOutboxService(database, config, fetchImpl);
async function drain() {
  let progressed = true;
  let guard = 0;
  while (progressed && guard < 200) {
    progressed = await outbox().processOnce();
    guard += 1;
  }
}
const journalCount = async (kind: string) =>
  Number(
    (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from finance.journal where kind=$1',
        [kind],
      )
    ).rows[0]!.n,
  );
const settlementCount = async (betId: string) =>
  Number(
    (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from finance.settlement where bet_id=$1',
        [betId],
      )
    ).rows[0]!.n,
  );
const outboxCount = async () =>
  Number(
    (
      await database.pool.query<{ n: string }>(
        'select count(*)::text as n from integration.telegram_outbox',
      )
    ).rows[0]!.n,
  );
const creditUsedBy = async (id: string) =>
  (
    await database.pool.query<{ used_by: string | null }>(
      'select used_by from finance.freebet where id=$1',
      [id],
    )
  ).rows[0]!.used_by;
const betRow = async (betId: string) =>
  (
    await database.pool.query<{
      bookmaker_id: string;
      state: string;
      freebet_id: string | null;
      remaining: string;
    }>('select bookmaker_id,state,freebet_id,remaining from finance.bet where id=$1', [betId])
  ).rows[0]!;
async function balanceSnapshot() {
  const byHouse = (
    await database.pool.query<{ house: string | null; amount: string }>(
      "select coalesce(c.name,'(conta)') as house,coalesce(sum(p.amount),0)::text as amount from finance.account a left join finance.posting p on p.account_id=a.id left join finance.catalog c on c.id=a.bookmaker_id where a.kind='bookmaker' group by c.name order by c.name",
    )
  ).rows;
  const byKind = (
    await database.pool.query<{ kind: string; amount: string }>(
      'select kind,coalesce(sum(p.amount),0)::text as amount from finance.account a left join finance.posting p on p.account_id=a.id group by kind order by kind',
    )
  ).rows;
  return { byHouse, byKind };
}
const journals = async (kind: string) =>
  (
    await database.pool.query<{ house: string | null; amount: string }>(
      'select c.name as house,p.amount from finance.journal j join finance.posting p on p.journal_id=j.id join finance.account a on a.id=p.account_id left join finance.catalog c on c.id=a.bookmaker_id where j.kind=$1 order by p.amount desc',
      [kind],
    )
  ).rows;
// R9 — toda ação exige idempotency-key; por padrão cada chamada usa uma chave
// nova (confirmação intencional); replays explícitos passam a MESMA chave.
const post = (
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  key: string = randomUUID(),
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/imports/${path}`,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
    payload,
  });

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
  name = `stk_miniapp_sync_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_miniapp_sync_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
  const bet365 = await houseId('Bet365');
  const superbet = await houseId('Superbet');
  await run({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [
      { bookmakerId: bet365, amount: '500.00' },
      { bookmakerId: superbet, amount: '500.00' },
    ],
    unitPercent: '1.00',
  });
  const getOwner = vi.fn(async (headers: Headers) =>
    headers.get('cookie')?.includes('session=fake')
      ? { user: { id: 'fixture-owner' }, status: 'active' }
      : null,
  );
  calls.length = 0;
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
  if (/^stk_miniapp_sync_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => {
  await admin.close();
});

describe('troca de casa pós-importação (R8)', () => {
  it('altera finance.bet.bookmaker_id, reflete na web e reclassifica a exposição sem mudar a banca (1–3)', async () => {
    const { importId, betId, version } = await imported();
    const before = await balanceSnapshot();
    const superbet = await houseId('Superbet');
    const response = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ betState: 'open', bookmakerName: 'Superbet' });
    // (1) A fonte financeira mudou de verdade.
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    // (2) A leitura web devolve a nova casa.
    const viaWeb = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}`,
      headers: session,
    });
    expect(
      (viaWeb.json() as { bet: { bookmakerId: string; bookmakerName: string } | null }).bet,
    ).toMatchObject({ bookmakerId: superbet, bookmakerName: 'Superbet' });
    // (3) Exposição total e banca total preservadas; o valor migrou de casa.
    const after = await balanceSnapshot();
    expect(after.byKind).toEqual(before.byKind);
    const house = (snapshot: typeof before, target: string) =>
      snapshot.byHouse.find((row) => row.house === target)?.amount;
    expect(house(before, 'Bet365')).toBe('400.00');
    expect(house(after, 'Bet365')).toBe('500.00');
    expect(house(before, 'Superbet')).toBe('500.00');
    expect(house(after, 'Superbet')).toBe('400.00');
  });

  it('o journal compensatório registra as contas antiga e nova corretamente (4)', async () => {
    const { betId, importId, version } = await imported();
    await post(`${importId}/bookmaker`, { version, bookmakerId: await houseId('Superbet') }, tg);
    const rows = await journals('bet_bookmaker_change');
    expect(rows).toEqual([
      { house: 'Bet365', amount: '100.00' },
      { house: 'Superbet', amount: '-100.00' },
    ]);
    // Nunca um UPDATE silencioso: o bet referencia o journal? (rastreabilidade
    // via kind/efetivo) — o journal existe e as contas batem.
    expect((await betRow(betId)).bookmaker_id).toBe(await houseId('Superbet'));
  });

  it('a mensagem EXECUTADA pela outbox contém a nova casa e não a antiga (5–7, §7)', async () => {
    const { importId, version } = await imported();
    await post(`${importId}/bookmaker`, { version, bookmakerId: await houseId('Superbet') }, tg);
    await drain();
    const edits = calls.filter((call) => call.method === 'editMessageText');
    expect(edits.length).toBeGreaterThan(0);
    const text = String(edits[edits.length - 1]!.body.text);
    expect(text).toContain('Superbet');
    expect(text).not.toContain('Bet365');
  });

  it('repetição/versão desatualizada não duplica journal nem altera nada (8–9)', async () => {
    const { importId, betId, version } = await imported();
    const superbet = await houseId('Superbet');
    expect(
      (await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg)).statusCode,
    ).toBe(200);
    // A versão da inbox avançou (carimbo do sync): repetir o MESMO pedido com
    // a versão antiga conflita sem efeito — nenhum journal adicional.
    const replay = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect((await journals('bet_bookmaker_change')).length).toBe(2);
    // Ação DIFERENTE com versão velha: também conflita, nada muda.
    const stale = await post(
      `${importId}/bookmaker`,
      { version: version - 1, bookmakerId: await houseId() },
      tg,
    );
    expect(stale.statusCode).toBe(409);
    // O estado final permanece o da primeira operação.
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
  });

  it('organização B não altera nem observa a aposta da organização A (10)', async () => {
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
    const foreign = await post(
      `${foreignId}/bookmaker`,
      { version: 1, bookmakerId: await houseId('Superbet') },
      tg,
    );
    expect(foreign.statusCode).toBe(404);
    expect((await betRow((await imported()).betId)).bookmaker_id).toBe(await houseId());
  });

  it('aposta liquidada recusa a troca de casa (11)', async () => {
    const { importId, betId, version } = await imported();
    await run({
      type: 'bet.settle',
      id: betId,
      outcome: 'win',
      closedPrincipal: '100.00',
      returnAmount: '200.00',
      settledAt: new Date().toISOString(),
      reason: 'Fixture settlement',
    } as CommandInput);
    const response = await post(
      `${importId}/bookmaker`,
      { version, bookmakerId: await houseId('Superbet') },
      tg,
    );
    expect(response.statusCode).toBe(409);
    expect((await betRow(betId)).bookmaker_id).toBe(await houseId());
  });

  it('crédito incompatível nunca permanece vinculado à casa nova (12)', async () => {
    const { importId, betId, version, oldCredit } = await importedFreebet();
    const superbet = await houseId('Superbet');
    const bet365 = await houseId();
    // Sem crédito novo: recusa sanitizada e NADA muda.
    const refused = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'FREEBET_UNRESOLVED' } });
    expect(await betRow(betId)).toMatchObject({
      bookmaker_id: bet365,
      freebet_id: expect.any(String),
    });
    // Com o crédito ANTIGO (ainda vinculado ao bet): recusa.
    const withOld = await post(
      `${importId}/bookmaker`,
      { version, bookmakerId: superbet, freebetId: oldCredit },
      tg,
    );
    expect(withOld.statusCode).toBe(409);
    // Com um crédito NOVO e válido, porém da casa ANTIGA: recusa — o crédito
    // tem de pertencer à casa de destino (nunca semântica cruzada).
    const wrongHouse = await run({
      type: 'freebet.create',
      bookmakerId: bet365,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const withWrongHouse = await post(
      `${importId}/bookmaker`,
      { version, bookmakerId: superbet, freebetId: wrongHouse.id },
      tg,
    );
    expect(withWrongHouse.statusCode).toBe(409);
    expect(withWrongHouse.json()).toMatchObject({ error: { code: 'FREEBET_UNRESOLVED' } });
    expect((await betRow(betId)).bookmaker_id).toBe(bet365);
    expect(
      (
        await database.pool.query<{ used_by: string | null }>(
          'select used_by from finance.freebet where id=$1',
          [wrongHouse.id],
        )
      ).rows[0]!.used_by,
    ).toBeNull();
    // Com crédito compatível da casa nova: troca atômica de crédito + casa.
    const newCredit = await run({
      type: 'freebet.create',
      bookmakerId: superbet,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const ok = await post(
      `${importId}/bookmaker`,
      { version, bookmakerId: superbet, freebetId: newCredit.id },
      tg,
    );
    expect(ok.statusCode).toBe(200);
    const row = await betRow(betId);
    expect(row.bookmaker_id).toBe(superbet);
    expect(row.freebet_id).toBe(newCredit.id);
    // O crédito da casa antiga foi liberado na mesma operação.
    const oldRow = (
      await database.pool.query<{ used_by: string | null }>(
        'select used_by from finance.freebet where id=$1',
        [oldCredit],
      )
    ).rows[0]!;
    expect(oldRow.used_by).toBeNull();
  });

  it('troca real → freebet gera ajuste financeiro correto e consome o crédito (13)', async () => {
    const { importId, betId, version } = await imported();
    const before = await balanceSnapshot();
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const response = await post(
      `${importId}/origin`,
      { version, kind: 'freebet', freebetId: credit.id },
      tg,
    );
    expect(response.statusCode).toBe(200);
    const row = await betRow(betId);
    expect(row.freebet_id).toBe(credit.id);
    // Exposição de dinheiro real retirada; banca total inalterada.
    const after = await balanceSnapshot();
    const exposure = (snapshot: typeof before) =>
      Number(snapshot.byKind.find((item) => item.kind === 'exposure')?.amount ?? '0');
    expect(exposure(before)).toBe(100);
    expect(exposure(after)).toBe(0);
    const creditRow = (
      await database.pool.query<{ used_by: string | null }>(
        'select used_by from finance.freebet where id=$1',
        [credit.id],
      )
    ).rows[0]!;
    expect(creditRow.used_by).toBe(betId);
    // Journal compensatório tracejável (exposição retirada; contraparte na casa).
    const entries = await journals('bet_origin_change');
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it('troca freebet → real libera o crédito e cria exposição real (14)', async () => {
    const { importId, betId, version, oldCredit } = await importedFreebet();
    const before = await balanceSnapshot();
    const response = await post(`${importId}/origin`, { version, kind: 'real' }, tg);
    expect(response.statusCode).toBe(200);
    expect((await betRow(betId)).freebet_id).toBeNull();
    const creditRow = (
      await database.pool.query<{ used_by: string | null }>(
        'select used_by from finance.freebet where id=$1',
        [oldCredit],
      )
    ).rows[0]!;
    expect(creditRow.used_by).toBeNull();
    const afterSnapshot = await balanceSnapshot();
    const exposure = (snapshot: typeof before) =>
      Number(snapshot.byKind.find((item) => item.kind === 'exposure')?.amount ?? '0');
    expect(exposure(before)).toBe(0);
    expect(exposure(afterSnapshot)).toBe(100);
  });
});

describe('data canônica e renderização (R8)', () => {
  it('edição web aparece no texto executado no Telegram (15–17)', async () => {
    const { importId, version } = await imported();
    // Edição pela SESSÃO web (mesma rota canônica).
    const webEdit = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/bookmaker`,
      headers: {
        ...session,
        'content-type': 'application/json',
        origin: 'https://stakeframe.test',
        // R9 — confirmação intencional carrega a própria chave.
        'idempotency-key': randomUUID(),
      },
      payload: { version, bookmakerId: await houseId('Superbet') },
    });
    expect(webEdit.statusCode).toBe(200);
    const freshVersion = (webEdit.json() as { version: number }).version;
    await drain();
    const edit = calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit.body.text)).toContain('Superbet');
    // (17) Data da simples via comando de evento + mensagem com a data nova.
    const detail = (
      await database.pool.query<{ id: string }>(
        'select id from finance.selection where bet_id=(select imported_bet_id from integration.inbox where id=$1) order by position',
        [importId],
      )
    ).rows[0]!;
    const dateResponse = await post(
      `${importId}/event`,
      { version: freshVersion, selectionId: detail.id, eventAt: '2026-10-05T18:30:00-03:00' },
      tg,
    );
    expect(dateResponse.statusCode).toBe(200);
    const selection = (
      await database.pool.query<{ date_status: string; event_at: Date | null; event_date: string }>(
        'select date_status,event_at,event_date::text as event_date from finance.selection where id=$1',
        [detail.id],
      )
    ).rows[0]!;
    expect(selection.date_status).toBe('confirmed');
    expect(selection.event_date).toBe('2026-10-05');
    await drain();
    const edit2 = calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit2.body.text)).toContain('05/10/2026');
  });

  it('múltipla não recebe data global silenciosamente (18)', async () => {
    const selections = [
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
      {
        event: 'C x D',
        sport: 'Futebol',
        market: 'Gols',
        selection: 'Mais de 2',
        odds: null,
        eventDate: null,
        eventAt: null,
        dateStatus: 'pending' as const,
      },
    ];
    const { importId, version } = await imported({}, selections);
    const rows = (
      await database.pool.query<{ id: string; position: number; date_status: string }>(
        'select id,position,date_status from finance.selection where bet_id=(select imported_bet_id from integration.inbox where id=$1) order by position',
        [importId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    const response = await post(
      `${importId}/event`,
      { version, selectionId: rows[0]!.id, eventAt: '2026-10-05T18:30:00-03:00' },
      tg,
    );
    expect(response.statusCode).toBe(200);
    const freshVersion = (response.json() as { version: number }).version;
    const after = (
      await database.pool.query<{ id: string; date_status: string; event_at: Date | null }>(
        'select id,date_status,event_at from finance.selection where id=any($1::uuid[])',
        [[rows[0]!.id, rows[1]!.id]],
      )
    ).rows;
    const first = after.find((item) => item.id === rows[0]!.id)!;
    const second = after.find((item) => item.id === rows[1]!.id)!;
    expect(first.date_status).toBe('confirmed');
    expect(second.date_status).toBe('pending');
    expect(second.event_at).toBeNull();
    // Seleção de outro bet: 404 sanitizado.
    const foreign = await post(
      `${importId}/event`,
      { version: freshVersion, selectionId: '00000000-0000-4000-8000-00000000dead', eventAt: null },
      tg,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('rascunho continua editável sem efeitos financeiros (19) e nada grava só na inbox com aposta (20)', async () => {
    // (19) Rascunho (sem aposta): as rotas canônicas delegam ao updateDraft e
    // nenhum efeito financeiro é criado.
    const draftId = await upload();
    await seedExtraction(draftId);
    const superbet = await houseId('Superbet');
    const draftSave = await post(`${draftId}/bookmaker`, { version: 1, bookmakerId: superbet }, tg);
    expect(draftSave.statusCode).toBe(200);
    expect(draftSave.json()).toMatchObject({ betState: null, bookmakerId: superbet });
    const overrideRow = (
      await database.pool.query<{ bookmaker_override_id: string }>(
        'select bookmaker_override_id from integration.inbox where id=$1',
        [draftId],
      )
    ).rows[0]!;
    expect(overrideRow.bookmaker_override_id).toBe(superbet);
    expect(
      Number(
        (await database.pool.query<{ count: string }>('select count(*) from finance.bet')).rows[0]!
          .count,
      ),
    ).toBe(0);
    // (20) Com aposta registrada, a rota NÃO grava só na inbox: a casa da
    // aposta muda e a inbox continua intacta (fonte única é o financeiro).
    const { importId, betId, version } = await imported();
    const beforeOverride = (
      await database.pool.query<{ bookmaker_override_id: string | null }>(
        'select bookmaker_override_id from integration.inbox where id=$1',
        [importId],
      )
    ).rows[0]!;
    const moved = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(moved.statusCode).toBe(200);
    const afterOverride = (
      await database.pool.query<{ bookmaker_override_id: string | null }>(
        'select bookmaker_override_id from integration.inbox where id=$1',
        [importId],
      )
    ).rows[0]!;
    expect(afterOverride).toEqual(beforeOverride);
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    // PATCH de rascunho para importada segue conflitando (nada de dois donos).
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${importId}`,
      headers: { ...tg, 'content-type': 'application/json' },
      payload: { version, bookmakerId: await houseId() },
    });
    expect(patch.statusCode).toBe(409);
  });
});

describe('R9 — idempotência por operação, créditos por destino e bloqueio pós-liquidação', () => {
  it('casa A→B→A→B aplica todas; replay exato devolve o mesmo resultado; conflito de corpo (R9.1)', async () => {
    const { importId, betId, version } = await imported();
    const bet365 = await houseId();
    const superbet = await houseId('Superbet');
    const k1 = randomUUID();
    const k2 = randomUUID();
    const k3 = randomUUID();
    const r1 = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg, k1);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(
      `${importId}/bookmaker`,
      { version: (r1.json() as { version: number }).version, bookmakerId: bet365 },
      tg,
      k2,
    );
    expect(r2.statusCode).toBe(200);
    const v2 = (r2.json() as { version: number }).version;
    const r3 = await post(`${importId}/bookmaker`, { version: v2, bookmakerId: superbet }, tg, k3);
    expect(r3.statusCode).toBe(200);
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    expect(await journalCount('bet_bookmaker_change')).toBe(3);
    // Replay da terceira: mesma chave e mesmo corpo, versão já avançada.
    const replay = await post(
      `${importId}/bookmaker`,
      { version: v2, bookmakerId: superbet },
      tg,
      k3,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(r3.json());
    expect(await journalCount('bet_bookmaker_change')).toBe(3);
    // Mesma chave com casa diferente.
    const conflict = await post(
      `${importId}/bookmaker`,
      { version: (r3.json() as { version: number }).version, bookmakerId: bet365 },
      tg,
      k3,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
  });

  it('origem real→X→real→X por chaves novas; replay sem duplo consumo (R9.2)', async () => {
    const { importId, betId, version } = await imported();
    const x = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const k1 = randomUUID();
    const k2 = randomUUID();
    const k3 = randomUUID();
    const o1 = await post(
      `${importId}/origin`,
      { version, kind: 'freebet', freebetId: x.id },
      tg,
      k1,
    );
    expect(o1.statusCode).toBe(200);
    expect((await betRow(betId)).freebet_id).toBe(x.id);
    expect(await creditUsedBy(x.id)).toBe(betId);
    const o2 = await post(
      `${importId}/origin`,
      { version: (o1.json() as { version: number }).version, kind: 'real' },
      tg,
      k2,
    );
    expect(o2.statusCode).toBe(200);
    expect((await betRow(betId)).freebet_id).toBeNull();
    expect(await creditUsedBy(x.id)).toBeNull();
    const v3 = (o2.json() as { version: number }).version;
    const o3 = await post(
      `${importId}/origin`,
      { version: v3, kind: 'freebet', freebetId: x.id },
      tg,
      k3,
    );
    expect(o3.statusCode).toBe(200);
    expect((await betRow(betId)).freebet_id).toBe(x.id);
    expect(await creditUsedBy(x.id)).toBe(betId);
    const journals = await journalCount('bet_origin_change');
    const replay = await post(
      `${importId}/origin`,
      { version: v3, kind: 'freebet', freebetId: x.id },
      tg,
      k3,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(o3.json());
    expect(await journalCount('bet_origin_change')).toBe(journals);
    expect(await creditUsedBy(x.id)).toBe(betId);
    const conflict = await post(
      `${importId}/origin`,
      { version: (o3.json() as { version: number }).version, kind: 'real' },
      tg,
      k3,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('data D1→D2→D1 em três chaves; replay exato; conflito de corpo (R9.3)', async () => {
    const { importId, betId, version } = await imported();
    const selectionId = (
      await database.pool.query<{ id: string }>(
        'select id from finance.selection where bet_id=$1 order by position',
        [betId],
      )
    ).rows[0]!.id;
    const d1 = '2026-10-05T18:30:00-03:00';
    const d2 = '2026-10-06T20:00:00-03:00';
    const k1 = randomUUID();
    const k2 = randomUUID();
    const k3 = randomUUID();
    const e1 = await post(`${importId}/event`, { version, selectionId, eventAt: d1 }, tg, k1);
    expect(e1.statusCode).toBe(200);
    const e2 = await post(
      `${importId}/event`,
      { version: (e1.json() as { version: number }).version, selectionId, eventAt: d2 },
      tg,
      k2,
    );
    expect(e2.statusCode).toBe(200);
    const v3 = (e2.json() as { version: number }).version;
    const e3 = await post(`${importId}/event`, { version: v3, selectionId, eventAt: d1 }, tg, k3);
    expect(e3.statusCode).toBe(200);
    const row = async () =>
      (
        await database.pool.query<{ event_at: Date; date_status: string }>(
          'select event_at,date_status from finance.selection where id=$1',
          [selectionId],
        )
      ).rows[0]!;
    expect((await row()).event_at.toISOString()).toBe(new Date(d1).toISOString());
    expect((await row()).date_status).toBe('confirmed');
    const replay = await post(
      `${importId}/event`,
      { version: v3, selectionId, eventAt: d1 },
      tg,
      k3,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(e3.json());
    const conflict = await post(
      `${importId}/event`,
      { version: (e3.json() as { version: number }).version, selectionId, eventAt: d2 },
      tg,
      k3,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await row()).event_at.toISOString()).toBe(new Date(d1).toISOString());
  });

  it('créditos por casa de destino; o consumido nunca aparece (R9.4)', async () => {
    const { importId, oldCredit } = await importedFreebet();
    const superbet = await houseId('Superbet');
    const creditSB = await run({
      type: 'freebet.create',
      bookmakerId: superbet,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const superList = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}/credits?bookmakerId=${superbet}`,
      headers: tg,
    });
    expect(superList.statusCode).toBe(200);
    const idsSuper = (superList.json() as { credits: { id: string }[] }).credits.map((c) => c.id);
    expect(idsSuper).toEqual([creditSB.id]);
    const bet365 = await houseId();
    const fresh365 = await run({
      type: 'freebet.create',
      bookmakerId: bet365,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const list365 = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${importId}/credits?bookmakerId=${bet365}`,
      headers: tg,
    });
    expect(list365.statusCode).toBe(200);
    const ids365 = (list365.json() as { credits: { id: string }[] }).credits.map((c) => c.id);
    expect(ids365).toContain(fresh365.id);
    expect(ids365).not.toContain(oldCredit);
    // Nenhuma lista vaza crédito de OUTRA casa de destino.
    expect(ids365).not.toContain(creditSB.id);
    expect(idsSuper).not.toContain(fresh365.id);
  });

  it('troca de casa de freebet não cria journal vazio e recusa sem crédito novo (R9.5)', async () => {
    const { importId, betId, version } = await importedFreebet();
    const superbet = await houseId('Superbet');
    const before = await journalCount('bet_bookmaker_change');
    const refused = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(refused.statusCode).toBe(409);
    const creditSB = await run({
      type: 'freebet.create',
      bookmakerId: superbet,
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const ok = await post(
      `${importId}/bookmaker`,
      { version, bookmakerId: superbet, freebetId: creditSB.id },
      tg,
    );
    expect(ok.statusCode).toBe(200);
    expect((await betRow(betId)).bookmaker_id).toBe(superbet);
    expect(await journalCount('bet_bookmaker_change')).toBe(before);
  });

  it('partial cashout bloqueia troca de casa e origem sem efeito parcial (R9.6)', async () => {
    const { importId, betId, version } = await imported();
    const partial = await run({
      type: 'bet.settle',
      id: betId,
      outcome: 'partial_cashout',
      closedPrincipal: '40.00',
      returnAmount: '25.00',
      settledAt: new Date().toISOString(),
      reason: 'Liquidação parcial fictícia',
    });
    expect(await settlementCount(betId)).toBe(1);
    expect((await betRow(betId)).state).toBe('open');
    const journalsHouse = await journalCount('bet_bookmaker_change');
    const journalsOrigin = await journalCount('bet_origin_change');
    const outboxBefore = await outboxCount();
    const superbet = await houseId('Superbet');
    const houseTry = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(houseTry.statusCode).toBe(409);
    expect(houseTry.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    const credit = await run({
      type: 'freebet.create',
      bookmakerId: await houseId(),
      amount: '100.00',
      expiresOn: '2026-12-31',
      stakeReturned: false,
      note: '',
    });
    const originTry = await post(
      `${importId}/origin`,
      { version, kind: 'freebet', freebetId: credit.id },
      tg,
    );
    expect(originTry.statusCode).toBe(409);
    expect(originTry.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    // Liquidado e REVERTIDO: o fato histórico permanece — mesma recusa mesmo
    // com o valor de volta ao principal (remaining === stake).
    await run({
      type: 'settlement.reverse',
      id: partial.id,
      effectiveAt: new Date().toISOString(),
      reason: 'Reversão fictícia para prova de congelamento',
    });
    const reverted = await betRow(betId);
    expect(reverted.state).toBe('open');
    const revertedTry = await post(`${importId}/bookmaker`, { version, bookmakerId: superbet }, tg);
    expect(revertedTry.statusCode).toBe(409);
    expect(revertedTry.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    expect((await betRow(betId)).bookmaker_id).toBe(await houseId());
    expect((await betRow(betId)).freebet_id).toBeNull();
    expect(await journalCount('bet_bookmaker_change')).toBe(journalsHouse);
    expect(await journalCount('bet_origin_change')).toBe(journalsOrigin);
    expect(await outboxCount()).toBe(outboxBefore);
    expect(await creditUsedBy(credit.id)).toBeNull();
  });

  it('etapas A→B→A→B renderizam a casa vigente; replay não gera nova edição (R9.7)', async () => {
    const { importId, version } = await imported();
    const bet365 = await houseId();
    const superbet = await houseId('Superbet');
    const steps: { id: string; name: string; other: string }[] = [
      { id: String(superbet), name: 'Superbet', other: 'Bet365' },
      { id: String(bet365), name: 'Bet365', other: 'Superbet' },
      { id: String(superbet), name: 'Superbet', other: 'Bet365' },
    ];
    let v = version;
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const inputVersions: number[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      calls.length = 0;
      inputVersions.push(v);
      const response = await post(
        `${importId}/bookmaker`,
        { version: v, bookmakerId: steps[i]!.id },
        tg,
        keys[i]!,
      );
      expect(response.statusCode).toBe(200);
      v = (response.json() as { version: number }).version;
      await drain();
      const edits = calls
        .filter((c) => c.method === 'editMessageText')
        .map((c) => String(c.body.text ?? ''));
      const last = edits.at(-1) ?? '';
      expect(last).toContain(steps[i]!.name);
      expect(last).not.toContain(steps[i]!.other);
    }
    // Replay da última etapa: MESMA chave e corpo EXATO (versão de entrada) —
    // o recibo devolve o resultado mesmo com a versão já avançada.
    calls.length = 0;
    const replay = await post(
      `${importId}/bookmaker`,
      { version: inputVersions[2]!, bookmakerId: superbet },
      tg,
      keys[2]!,
    );
    expect(replay.statusCode).toBe(200);
    await drain();
    expect(calls.filter((c) => c.method === 'editMessageText').length).toBe(0);
  });
});
