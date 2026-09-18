import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

// STK-G0-19-R10 — ATOMICIDADE das ações de rascunho: efeito (inbox), auditoria,
// outbox e RECIBO na MESMA transação/cliente; concorrência com a mesma chave
// converge; recibo adulterado falha fechado e sanitizado; schema/migração 0013
// alinhados (jsonb, checks, PK, RLS) e upgrade 0012→0013 replay limpo.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let tenantContext: OrganizationContext;
let app: ReturnType<typeof createApp>;
let name: string;
const session = { cookie: 'session=fake', origin: 'https://stakeframe.test' };
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
const seedExtraction = (id: string) =>
  database.pool.query('update integration.inbox set extraction=$2::jsonb where id=$1', [
    id,
    JSON.stringify({ extraction: draftExtraction }),
  ]);
async function bindTelegram(id: string) {
  await database.pool.query(
    'update integration.inbox set telegram_chat_id=42,telegram_source_message_id=901,telegram_processing_message_id=900,telegram_result_message_id=902,telegram_sync_state=$2 where id=$1',
    [id, 'pending'],
  );
}
const inboxRow = async (id: string) =>
  (
    await database.pool.query<{ version: number; book_origin: string | null }>(
      'select version, bet_origin as book_origin from integration.inbox where id=$1',
      [id],
    )
  ).rows[0]!;
const count = async (query: string, params: unknown[]) =>
  Number((await database.pool.query<{ n: string }>(query, params)).rows[0]!.n);
const auditCount = (id: string) =>
  count(
    "select count(*)::text as n from finance.audit where type='import.draft_update' and entity_id=$1",
    [id],
  );
const outboxCount = (id: string) =>
  count('select count(*)::text as n from integration.telegram_outbox where inbox_id=$1', [id]);
const receiptCount = (key: string) =>
  count('select count(*)::text as n from integration.import_action_receipt where key=$1', [key]);

beforeEach(async () => {
  name = `stk_action_atomic_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_action_atomic_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
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
    balances: [{ bookmakerId: await houseId(), amount: '500.00' }],
    unitPercent: '1.00',
    expectedVersion: (await finance.workspace(tenantContext)).version,
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
  if (/^stk_action_atomic_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => {
  await admin.close();
});

describe('atomicidade das ações de rascunho (R10)', () => {
  it('reverts inbox, audit and outbox when the receipt write fails — and a later retry applies', async () => {
    const id = await upload();
    await seedExtraction(id);
    await bindTelegram(id);
    await database.pool.query(
      "create or replace function integration.fixture_fail_receipt() returns trigger language plpgsql as $$ begin if NEW.actor = 'FIXTURE_RECEIPT_FAIL' then raise exception 'TEST_FORCED_RECEIPT_FAILURE'; end if; return NEW; end $$; drop trigger if exists fixture_fail_receipt on integration.import_action_receipt; create trigger fixture_fail_receipt before insert on integration.import_action_receipt for each row execute function integration.fixture_fail_receipt();",
    );
    const key = randomUUID();
    await expect(
      imports.applyBookmaker(
        tenantContext,
        id,
        { version: 1, bookmakerId: await houseId('Superbet') },
        'FIXTURE_RECEIPT_FAIL',
        key,
      ),
    ).rejects.toThrow(/TEST_FORCED_RECEIPT_FAILURE|INVALID/);
    expect((await inboxRow(id)).version).toBe(1);
    expect(await auditCount(id)).toBe(0);
    expect(await outboxCount(id)).toBe(0);
    expect(await receiptCount(key)).toBe(0);
    // Retry legítimo (mesma intenção, falha anterior não deixou resíduo).
    const retried = await imports.applyBookmaker(
      tenantContext,
      id,
      { version: 1, bookmakerId: await houseId('Superbet') },
      'web',
      key,
    );
    expect(retried.version).toBe(2);
    expect((await inboxRow(id)).version).toBe(2);
    expect(await auditCount(id)).toBe(1);
    expect(await outboxCount(id)).toBe(1);
    expect(await receiptCount(key)).toBe(1);
  });

  it('converges two concurrent calls with the same key and body into one effect and the same result', async () => {
    const id = await upload();
    await seedExtraction(id);
    await bindTelegram(id);
    const key = randomUUID();
    const input = { version: 1, bookmakerId: await houseId('Superbet') };
    const [first, second] = await Promise.all([
      imports.applyBookmaker(tenantContext, id, input, 'web', key),
      imports.applyBookmaker(tenantContext, id, input, 'web', key),
    ]);
    expect(first).toEqual(second);
    expect(first.version).toBe(2);
    expect((await inboxRow(id)).version).toBe(2);
    expect(await auditCount(id)).toBe(1);
    expect(await outboxCount(id)).toBe(1);
    expect(await receiptCount(key)).toBe(1);
  });

  it('conflicts on the same key with a different body and still demands the current version for new keys', async () => {
    const id = await upload();
    await seedExtraction(id);
    const key = randomUUID();
    const superbet = await houseId('Superbet');
    const bet365 = await houseId();
    const applied = await imports.applyBookmaker(
      tenantContext,
      id,
      { version: 1, bookmakerId: superbet },
      'web',
      key,
    );
    expect(applied.version).toBe(2);
    await expect(
      imports.applyBookmaker(tenantContext, id, { version: 1, bookmakerId: bet365 }, 'web', key),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    // Chave nova continua exigindo a versão atual.
    await expect(
      imports.applyBookmaker(
        tenantContext,
        id,
        { version: 1, bookmakerId: bet365 },
        'web',
        randomUUID(),
      ),
    ).rejects.toThrow('VERSION_CONFLICT');
    expect((await inboxRow(id)).version).toBe(2);
  });

  it('covers origin and event on the draft path with the same atomic guarantees', async () => {
    // Origin (corpo repetido byte a byte para o replay do mesmo pedido).
    {
      const id = await upload();
      await seedExtraction(id);
      await bindTelegram(id);
      const key = randomUUID();
      const applied = await imports.applyOrigin(
        tenantContext,
        id,
        { version: 1, kind: 'real' },
        'web',
        key,
      );
      expect(applied.version).toBe(2);
      const replay = await imports.applyOrigin(
        tenantContext,
        id,
        { version: 1, kind: 'real' },
        'web',
        key,
      );
      expect(replay).toEqual(applied);
      expect(await receiptCount(key)).toBe(1);
      expect((await inboxRow(id)).version).toBe(2);
      expect(await auditCount(id)).toBe(1);
    }
    // Event (mesma seleção e MESMO instante no pedido e no replay).
    {
      const id = await upload();
      await seedExtraction(id);
      await bindTelegram(id);
      const key = randomUUID();
      const selectionId = randomUUID();
      const eventAt = new Date().toISOString();
      const applied = await imports.applyEvent(
        tenantContext,
        id,
        { version: 1, selectionId, eventAt },
        'web',
        key,
      );
      expect(applied.version).toBe(2);
      const replay = await imports.applyEvent(
        tenantContext,
        id,
        { version: 1, selectionId, eventAt },
        'web',
        key,
      );
      expect(replay).toEqual(applied);
      expect(await receiptCount(key)).toBe(1);
      expect((await inboxRow(id)).version).toBe(2);
      expect(await auditCount(id)).toBe(1);
    }
  });

  it('receives the receipt on a retry after a lost response without duplicating effects (integrated)', async () => {
    const id = await upload();
    await seedExtraction(id);
    await bindTelegram(id);
    const key = randomUUID();
    const payload = { version: 1, bookmakerId: await houseId('Superbet') };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/bookmaker`,
      headers: { ...session, 'content-type': 'application/json', 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(200);
    // A resposta se perdeu: o cliente repete o MESMO pedido (versão já antiga).
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/bookmaker`,
      headers: { ...session, 'content-type': 'application/json', 'idempotency-key': key },
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await inboxRow(id)).version).toBe(2);
    expect(await auditCount(id)).toBe(1);
    expect(await outboxCount(id)).toBe(1);
    expect(await receiptCount(key)).toBe(1);
  });

  it('fails closed and sanitized when the stored receipt is adulterated', async () => {
    const id = await upload();
    await seedExtraction(id);
    const key = randomUUID();
    await imports.applyOrigin(tenantContext, id, { version: 1, kind: 'real' }, 'web', key);
    await database.pool.query(
      'update integration.import_action_receipt set result=\'"garbage"\'::jsonb where key=$1',
      [key],
    );
    await expect(
      imports.applyOrigin(tenantContext, id, { version: 1, kind: 'real' }, 'web', key),
    ).rejects.toThrow('INVALID_FINANCIAL_OPERATION');
    expect((await inboxRow(id)).version).toBe(2);
  });

  it('keeps receipts isolated by organization (RLS)', async () => {
    const id = await upload();
    await seedExtraction(id);
    const key = randomUUID();
    await imports.applyOrigin(tenantContext, id, { version: 1, kind: 'real' }, 'web', key);
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Fixture Other','fixture-other@stk.test') on conflict (id) do nothing",
    );
    const otherContext = await finance.ensureContext('fixture-other');
    const seen = await database.pool.query(
      'select 1 from integration.import_action_receipt where organization_id=$1 and key=$2',
      [otherContext.organizationId, key],
    );
    expect(seen.rowCount).toBe(0);
  });
});

describe('schema, migration e upgrade da 0013 (R10)', () => {
  it('declares the receipt table in the drizzle schema with jsonb result and checks', async () => {
    const { importActionReceipt } = await import('../../packages/db/src/inbox-schema.js');
    const table = importActionReceipt as unknown as Record<symbol, unknown>;
    expect(table[Symbol.for('drizzle:Name')]).toBe('import_action_receipt');
    const columns = table[Symbol.for('drizzle:Columns')] as Record<string, { name: string }>;
    const names = Object.values(columns).map((column) => column.name);
    for (const expected of [
      'organization_id',
      'key',
      'action',
      'actor',
      'hash',
      'result',
      'created_at',
      'updated_at',
    ])
      expect(names).toContain(expected);
  });

  it('matches migration 0013: jsonb result, sha256/actor checks, composite pk and RLS', async () => {
    const column = (
      await database.pool.query<{ data_type: string }>(
        "select data_type from information_schema.columns where table_schema='integration' and table_name='import_action_receipt' and column_name='result'",
      )
    ).rows[0]!;
    expect(column.data_type).toBe('jsonb');
    const checks = (
      await database.pool.query<{ conname: string }>(
        "select conname from pg_constraint where conrelid='integration.import_action_receipt'::regclass and contype='c'",
      )
    ).rows.map((row) => row.conname);
    expect(checks).toContain('import_action_receipt_action_check');
    expect(checks.some((entry) => entry.includes('hash'))).toBe(true);
    expect(checks.some((entry) => entry.includes('actor'))).toBe(true);
    const pk = (
      await database.pool.query<{ conname: string }>(
        "select conname from pg_constraint where conrelid='integration.import_action_receipt'::regclass and contype='p'",
      )
    ).rows[0]!;
    expect(pk.conname).toBe('import_action_receipt_pk');
    const rls = (
      await database.pool.query<{ relrowsecurity: boolean }>(
        "select relrowsecurity from pg_class where oid='integration.import_action_receipt'::regclass",
      )
    ).rows[0]!;
    expect(rls.relrowsecurity).toBe(true);
  });

  it('upgrades a database at 0012 state to 0013 cleanly', async () => {
    await database.pool.query('drop table integration.import_action_receipt');
    await database.pool.query(
      'delete from drizzle.__drizzle_migrations where hash in (select hash from drizzle.__drizzle_migrations order by created_at desc limit 1)',
    );
    await migrateLocalDatabase(database);
    const exists = (
      await database.pool.query<{ n: string }>(
        "select count(*)::text as n from information_schema.tables where table_schema='integration' and table_name='import_action_receipt'",
      )
    ).rows[0]!;
    expect(Number(exists.n)).toBe(1);
  });

  it('refuses a request without the idempotency-key with a stable sanitized 400', async () => {
    const id = await upload();
    await seedExtraction(id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${id}/bookmaker`,
      headers: { ...session, 'content-type': 'application/json' },
      payload: { version: 1, bookmakerId: await houseId() },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  });
});
