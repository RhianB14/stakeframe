import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createAttachmentStore,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportService,
  type ObjectStorage,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  type FinanceCommand,
  type BetInput,
  importDetailSchema,
} from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';
import { startWorker } from '../../apps/worker/src/worker.js';
import {
  prepareExtractionQueue,
  drainExtractionRequest,
  EXTRACTION_QUEUE,
} from '../../apps/worker/src/integrations.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let name: string;
type CommandInput = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: CommandInput) =>
  finance.command('fixture-owner', randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace()).version,
  } as FinanceCommand);
const upload = async (key = randomUUID(), caption = 'Tipster\nBet365') =>
  imports.upload('fixture-owner', key, { image: image.toString('base64'), caption });
async function betInput(): Promise<BetInput> {
  const bookmakerId = (await finance.workspace()).catalog.find((c) => c.name === 'Bet365')!.id;
  return {
    bookmakerId,
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
  };
}
async function initialize() {
  const bet = await betInput();
  await run({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId: bet.bookmakerId, amount: '500.00' }],
    unitPercent: '1.00',
  });
  return bet;
}
beforeEach(async (context) => {
  name = `stk_import_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_import_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  if (context.task.name.startsWith('upgrades existing inbox')) {
    for (const file of ['0000_owner_auth', '0001_integration_inbox', '0002_financial_core'])
      await database.pool.query(
        readFileSync(new URL(`../../packages/db/migrations/${file}.sql`, import.meta.url), 'utf8'),
      );
  } else await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  imports = createImportService(database);
});
afterEach(async () => {
  await database?.close();
  if (/^stk_import_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('private import review', () => {
  it('upgrades existing inbox images without losing references or duplicating bytes', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const hash = createHash('sha256').update(image).digest('hex');
    await database.pool.query(
      "insert into integration.inbox(id,source_key,image,sha256,caption,metadata) values($1,'legacy:first',$3,$4,'Primeira legenda','{}'),($2,'legacy:second',$3,$4,'Outra legenda','{}')",
      [first, second, image, hash],
    );
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        readFileSync(
          new URL('../../packages/db/migrations/0003_import_attachments.sql', import.meta.url),
          'utf8',
        ),
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    expect((await imports.image(first)).image).toEqual(image);
    expect((await imports.image(second)).image).toEqual(image);
    expect(
      (await database.pool.query('select count(*)::int as n from integration.attachment')).rows[0]
        .n,
    ).toBe(1);
    expect(
      (
        await database.pool.query(
          'select count(*)::int as n from integration.inbox where image is not null',
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await imports.list({ page: 1, pageSize: 25 })).total).toBe(2);
  });
  it('preserves bytes and remote cleanup intent after an uncertain upload', async () => {
    const objects = new Map<string, Buffer>();
    const storage: ObjectStorage = {
      put: async (key, bytes) => {
        objects.set(key, bytes);
        throw new Error('PUT outcome uncertain');
      },
      get: async (key) => objects.get(key)!,
      delete: async (key) => {
        objects.delete(key);
      },
    };
    const files = createAttachmentStore(database, storage);
    const { id } = await upload();
    await expect(files.uploadOne()).rejects.toThrow('PUT outcome uncertain');
    expect((await imports.image(id)).image).toEqual(image);
    await run({
      type: 'import.discard',
      importId: id,
      expectedInboxVersion: 1,
      reason: 'Descartar comprovante',
    });
    await database.pool.query("update integration.inbox set updated_at=now()-interval '31 days'");
    expect(await createAttachmentStore(database).retainOne()).toBe(false);
    expect(await files.retainOne()).toBe(false);
    await database.pool.query(
      "update integration.attachment set updated_at=now()-interval '3 minutes'",
    );
    expect(await files.retainOne()).toBe(true);
    expect(objects.size).toBe(0);
  });
  it('coordinates financial reopening with deletion and preserves history after expiry', async () => {
    const bet = await initialize();
    const { id } = await upload();
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: '' },
    });
    const settled = await run({
      type: 'bet.settle',
      id: created.id,
      outcome: 'loss',
      closedPrincipal: '100.00',
      returnAmount: '0.00',
      settledAt: new Date().toISOString(),
      reason: 'Liquidação conferida',
    });
    // Simulate an already claimed retention operation, including its uncertain network interval.
    await database.pool.query("update integration.attachment set state='deleting'");
    await expect(
      run({
        type: 'settlement.reverse',
        id: settled.id,
        effectiveAt: new Date().toISOString(),
        reason: 'Correção do resultado',
      }),
    ).rejects.toThrow('STATE_CONFLICT');
    await database.pool.query("update integration.attachment set state='deleted',image=null");
    await run({
      type: 'settlement.reverse',
      id: settled.id,
      effectiveAt: new Date().toISOString(),
      reason: 'Correção do resultado',
    });
    expect((await finance.bet(created.id)).bet.state).toBe('open');
    expect((await imports.detail(id)).item.imageAvailable).toBe(false);
    expect((await imports.list({ page: 1, pageSize: 25, betId: created.id })).items).toHaveLength(
      1,
    );
  });
  it('validates full image decoding, enforces exact upload replay and shares bytes without merging entries', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([upload(key), upload(key)]);
    expect(a).toEqual(b);
    await expect(
      imports.upload('fixture-owner', key, { image: image.toString('base64'), caption: 'changed' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      imports.upload('fixture-owner', randomUUID(), {
        image: image.subarray(0, 64).toString('base64'),
        caption: '',
      }),
    ).rejects.toThrow('INVALID_INBOX_IMAGE');
    const c = await upload();
    expect(c.id).not.toBe(a.id);
    expect(
      (await database.pool.query('select count(*)::int as n from integration.attachment')).rows[0]
        .n,
    ).toBe(1);
    expect(
      (await database.pool.query('select count(*)::int as n from integration.extraction_request'))
        .rows[0].n,
    ).toBe(2);
    expect((await imports.image(a.id)).image).toEqual(image);
  });
  it('commits confirmation and ledger exactly once and rolls back invalid financial input', async () => {
    const bet = await initialize();
    const { id } = await upload();
    const key = randomUUID();
    const command: FinanceCommand = {
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 1,
      expectedVersion: (await finance.workspace()).version,
      decision: { kind: 'create', bet, duplicateReason: '' },
    };
    await expect(
      finance.command('fixture-owner', randomUUID(), {
        ...command,
        decision: {
          kind: 'create',
          bet: { ...bet, placedAt: '2099-01-01T00:00:00Z' },
          duplicateReason: '',
        },
      }),
    ).rejects.toThrow('INVALID_FINANCIAL_OPERATION');
    expect((await imports.detail(id)).item.state).toBe('pending');
    const [a, b] = await Promise.all([
      finance.command('fixture-owner', key, command),
      finance.command('fixture-owner', key, command),
    ]);
    expect(a).toEqual(b);
    expect((await imports.detail(id)).item.betId).toBe(a.id);
    expect((await finance.workspace()).exposure).toBe('100.00');
    await expect(run({ ...command, expectedInboxVersion: 2 })).rejects.toThrow('STATE_CONFLICT');
    expect(
      (await database.pool.query('select count(*)::int as n from finance.bet')).rows[0].n,
    ).toBe(1);
  });
  it('requires duplicate review and links an existing bet without a second stake', async () => {
    const bet = await initialize();
    const first = await upload();
    const created = await run({
      type: 'import.confirm',
      importId: first.id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: '' },
    });
    const second = await upload();
    const detail = importDetailSchema.parse(await imports.detail(second.id));
    expect(detail.duplicates[0]?.betId).toBe(created.id);
    expect(detail.duplicates[0]?.reasons).toContain('image');
    await expect(
      run({
        type: 'import.confirm',
        importId: second.id,
        expectedInboxVersion: 1,
        decision: { kind: 'create', bet, duplicateReason: '' },
      }),
    ).rejects.toThrow('DUPLICATE_REVIEW_REQUIRED');
    await run({
      type: 'import.confirm',
      importId: second.id,
      expectedInboxVersion: 1,
      decision: { kind: 'link', betId: created.id, reason: 'Mesmo bilhete reenviado' },
    });
    expect((await finance.workspace()).exposure).toBe('100.00');
    const third = await upload();
    await run({
      type: 'import.confirm',
      importId: third.id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: 'São dois bilhetes distintos conferidos' },
    });
    expect((await finance.workspace()).exposure).toBe('200.00');
  });
  it('resolves caption aliases and exposes conflicting extraction without guessing dates', async () => {
    const { id } = await upload(randomUUID(), 'Analista\nBet 365');
    await run({ type: 'catalog.create', kind: 'tipster', name: 'Analista', aliases: ['A'] });
    const workspace = await finance.workspace();
    const house = workspace.catalog.find((c) => c.name === 'Bet365')!;
    await run({
      type: 'catalog.update',
      id: house.id,
      name: house.name,
      aliases: ['Bet 365'],
      active: true,
    });
    const candidate = {
      bookmaker: 'Superbet',
      reference: '123',
      placedAtText: 'ontem',
      currency: 'BRL',
      stake: '10.00',
      odds: '2.00',
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: null,
          selection: null,
          odds: null,
          eventDateText: 'amanhã',
        },
      ],
      warnings: ['Data incerta'],
    };
    await database.pool.query(
      "update integration.inbox set state='review',extraction=$2 where id=$1",
      [id, JSON.stringify({ extraction: candidate, requiresReview: true })],
    );
    const result = importDetailSchema.parse(await imports.detail(id));
    expect(result.extraction).toEqual(candidate);
    expect(result.matches.conflict).toBe(true);
    expect(result.matches.captionBookmakerId).toBe(house.id);
    expect(result.matches.tipsterId).not.toBeNull();
    expect(result.automatic).toBe(false);
  });
  it('reprocesses only on explicit command using a fresh durable job and preserves old evidence in audit', async () => {
    const { id } = await upload();
    await database.pool.query(
      "update integration.inbox set state='failed',extraction=$2 where id=$1",
      [id, JSON.stringify({ old: 'evidence' })],
    );
    await run({ type: 'import.retry', importId: id, expectedInboxVersion: 1 });
    expect((await imports.detail(id)).item.state).toBe('pending');
    await expect(
      run({ type: 'import.retry', importId: id, expectedInboxVersion: 2 }),
    ).rejects.toThrow('STATE_CONFLICT');
    expect(
      (await database.pool.query("select before from finance.audit where type='import.retry'"))
        .rows[0].before.extraction,
    ).toEqual({ old: 'evidence' });
    const url = new URL(source);
    url.pathname = `/${name}`;
    const boss = await startWorker(url.toString());
    try {
      await prepareExtractionQueue(boss);
      const pending = (await database.pool.query('select id from integration.extraction_request'))
        .rows;
      expect(pending).toHaveLength(2);
      expect(await drainExtractionRequest(database, boss)).toBe(true);
      expect(await drainExtractionRequest(database, boss)).toBe(true);
      expect(await drainExtractionRequest(database, boss)).toBe(false);
      for (const row of pending)
        expect((await boss.getJobById(EXTRACTION_QUEUE, row.id))?.data).toEqual({ nonce: id });
    } finally {
      await boss.stop({ graceful: true, timeout: 5000 });
    }
  });
  it('keeps shared evidence until all references expire and tolerates uncertain remote deletion', async () => {
    const stored = new Map<string, Buffer>();
    const storage: ObjectStorage = {
      put: vi.fn(async (key, bytes) => {
        stored.set(key, bytes);
      }),
      get: vi.fn(async (key) => stored.get(key)!),
      delete: vi.fn(async (key) => {
        stored.delete(key);
      }),
    };
    const files = createAttachmentStore(database, storage);
    const first = await upload();
    const second = await upload();
    expect(await files.uploadOne()).toBe(true);
    expect((await createImportService(database, storage).image(first.id)).image).toEqual(image);
    expect(
      (await database.pool.query('select image,state from integration.attachment')).rows[0],
    ).toEqual({ image: null, state: 'remote' });
    await database.pool.query(
      "update integration.attachment set updated_at=now()-interval '3 minutes'",
    );
    await run({
      type: 'import.discard',
      importId: first.id,
      expectedInboxVersion: 1,
      reason: 'Descartar teste',
    });
    await database.pool.query(
      "update integration.inbox set updated_at=now()-interval '31 days' where id=$1",
      [first.id],
    );
    expect(await files.retainOne()).toBe(false);
    await run({
      type: 'import.discard',
      importId: second.id,
      expectedInboxVersion: 1,
      reason: 'Descartar teste',
    });
    expect(await files.retainOne()).toBe(false);
    await database.pool.query("update integration.inbox set updated_at=now()-interval '31 days'");
    vi.mocked(storage.delete).mockRejectedValueOnce(new Error('uncertain'));
    await expect(files.retainOne()).rejects.toThrow('uncertain');
    expect(await createAttachmentStore(database).retainOne()).toBe(false);
    expect(await files.retainOne()).toBe(false);
    await database.pool.query(
      "update integration.attachment set updated_at=now()-interval '3 minutes'",
    );
    expect(await files.retainOne()).toBe(true);
    expect(stored.size).toBe(0);
    expect((await imports.detail(first.id)).item.imageAvailable).toBe(false);
    expect((await imports.list({ page: 1, pageSize: 25 })).total).toBe(2);
  });
  it('protects active bets and late settlements from retention', async () => {
    const bet = await initialize();
    const { id } = await upload();
    const created = await run({
      type: 'import.confirm',
      importId: id,
      expectedInboxVersion: 1,
      decision: { kind: 'create', bet, duplicateReason: '' },
    });
    const files = createAttachmentStore(database);
    await database.pool.query("update integration.inbox set updated_at=now()-interval '31 days'");
    expect(await files.retainOne()).toBe(false);
    await run({
      type: 'bet.settle',
      id: created.id,
      outcome: 'loss',
      closedPrincipal: '100.00',
      returnAmount: '0.00',
      settledAt: new Date().toISOString(),
      reason: 'Liquidação de teste',
    });
    expect(await files.retainOne()).toBe(false);
  });
  it('authenticates upload before parsing and serves private image bytes without a public URL', async () => {
    const getOwner = vi.fn().mockResolvedValue(null);
    const auth = { origin: 'http://localhost:8088', getOwner } as unknown as OwnerAuth;
    const app = createApp({ checkDatabase: database.check, ownerAuth: auth, finance, imports });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/imports',
        headers: { origin: auth.origin, 'content-type': 'application/json' },
        payload: 'invalid json',
      });
      expect(denied.statusCode).toBe(401);
      getOwner.mockResolvedValue({ user: { id: 'fixture-owner' } });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/imports',
            headers: { origin: 'http://untrusted.invalid' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const uploaded = await app.inject({
        method: 'POST',
        url: '/api/v1/imports',
        headers: { origin: auth.origin, 'idempotency-key': randomUUID() },
        payload: { image: image.toString('base64'), caption: '' },
      });
      expect(uploaded.statusCode).toBe(200);
      const response = await app.inject(`/api/v1/imports/${uploaded.json().id}/image`);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(image);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toBe('image/png');
      getOwner.mockResolvedValue(null);
      expect((await app.inject(`/api/v1/imports/${uploaded.json().id}/image`)).statusCode).toBe(
        401,
      );
    } finally {
      await app.close();
    }
  });
});
