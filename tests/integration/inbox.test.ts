import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import {
  createDatabase,
  createInboxStore,
  requireDatabaseUrl,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { startWorker } from '../../apps/worker/src/worker.js';
import {
  integrationStore,
  prepareExtractionQueue,
  startIntegrations,
  EXTRACTION_QUEUE,
} from '../../apps/worker/src/integrations.js';
import { OPENROUTER_MODEL } from '../../packages/shared/src/index.js';
import { IntegrationError } from '../../apps/worker/src/http.js';

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const name = `stk_inbox_test_${randomUUID().replaceAll('-', '')}`;
let database: Database;
let boss: Awaited<ReturnType<typeof startWorker>>;
let created = false;
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const input = () => ({
  sourceKey: `test:${randomUUID()}`,
  caption: 'Tipster\nCasa',
  metadata: { source: 'test' },
});

beforeAll(async () => {
  if (!/^stk_inbox_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  boss = await startWorker(url.toString());
  await prepareExtractionQueue(boss);
});
afterAll(async () => {
  try {
    await boss?.stop({ graceful: true, timeout: 5000 });
    await database?.close();
    if (created && /^stk_inbox_test_[a-f0-9]{32}$/.test(name))
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

describe('durable extraction inbox', () => {
  it('requires recovery review before starting any paid extraction consumer', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await database.pool.query(
      "insert into integration.cursor(name,next_offset) values('recovery-quarantine',1)",
    );
    try {
      await expect(
        startIntegrations(
          database,
          boss,
          {
            AI_ENABLED: 'true',
            AI_PROVIDER: 'openrouter',
            OPENROUTER_MODEL,
            OPENROUTER_ALLOW_FALLBACKS: 'false',
            OPENROUTER_API_KEY: `sk-or-v1-${'a'.repeat(64)}`,
          },
          fetchImpl,
        ),
      ).rejects.toThrow('INTEGRATIONS_RECOVERY_REVIEW_REQUIRED');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await database.pool.query("delete from integration.cursor where name='recovery-quarantine'");
    }
  });
  it('commits image and queue job together; replay does not download again', async () => {
    const store = integrationStore(database, boss);
    const download = vi.fn().mockResolvedValue(image);
    const data = input();
    const id = await store.accept(data, download);
    expect(await store.accept(data, download)).toBe(id);
    expect(download).toHaveBeenCalledTimes(1);
    expect((await boss.getJobById(EXTRACTION_QUEUE, id))?.data).toEqual({ nonce: id });
    const row = await database.pool.query(
      'select a.image,i.state from integration.inbox i join integration.attachment a on a.id=i.attachment_id where i.id=$1',
      [id],
    );
    expect(row.rows[0].image).toEqual(image);
    expect(row.rows[0].state).toBe('pending');
    // Similar or identical images from distinct messages remain distinct candidates for review.
    expect(await store.accept(input(), download)).not.toBe(id);
  });
  it('rolls back the inbox when job insertion fails', async () => {
    const data = input();
    const store = createInboxStore(database, async () => {
      throw new Error('queue unavailable');
    });
    await expect(store.accept(data, async () => image)).rejects.toThrow('queue unavailable');
    expect(
      (
        await database.pool.query('select id from integration.inbox where source_key=$1', [
          data.sourceKey,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('claims once under concurrency and does not release a consumed quota after failure', async () => {
    const store = integrationStore(database, boss);
    const id = await store.accept(input(), async () => image);
    const results = await Promise.all([store.claim(id), store.claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.fail(id, results.find(Boolean)!.attempt, 'AI_CONNECTION_FAILED');
    expect(await store.claim(id)).toBeNull();
    expect(
      (await database.pool.query('select attempts,state from integration.inbox where id=$1', [id]))
        .rows[0],
    ).toEqual({ attempts: 1, state: 'failed' });
  });
  it('keeps the Telegram cursor monotonic', async () => {
    const store = integrationStore(database, boss);
    await store.advance(21);
    await store.advance(10);
    expect(await store.offset()).toBe(21);
  });
  it('ignores late completions from an earlier extraction attempt', async () => {
    const store = integrationStore(database, boss);
    const id = await store.accept(input(), async () => image);
    const first = (await store.claim(id))!;
    await database.pool.query(
      "update integration.inbox set state='pending',version=version+1 where id=$1",
      [id],
    );
    const second = (await store.claim(id))!;
    expect(second.attempt).toBe(first.attempt + 1);
    await store.complete(id, first.attempt, { stale: true });
    await store.fail(id, first.attempt, 'AI_CONNECTION_FAILED');
    expect(
      (
        await database.pool.query('select state,extraction from integration.inbox where id=$1', [
          id,
        ])
      ).rows[0],
    ).toEqual({ state: 'processing', extraction: null });
    await store.complete(id, second.attempt, { current: true });
    expect(
      (await database.pool.query('select extraction from integration.inbox where id=$1', [id]))
        .rows[0].extraction,
    ).toEqual({ current: true });
  });
  it('recovers an interrupted call for explicit review without repeating the paid request', async () => {
    const store = integrationStore(database, boss);
    const id = await store.accept(input(), async () => image);
    await store.claim(id);
    await database.pool.query(
      "update integration.inbox set updated_at=now()-interval '4 minutes' where id=$1",
      [id],
    );
    await store.recoverInterrupted();
    expect(await store.claim(id)).toBeNull();
    expect(
      (
        await database.pool.query('select state,error_code from integration.inbox where id=$1', [
          id,
        ])
      ).rows[0],
    ).toEqual({ state: 'failed', error_code: 'AI_OUTCOME_UNCERTAIN' });
  });
  it('blocks the daily quota before dispatch', async () => {
    const store = integrationStore(database, boss);
    await database.pool.query(
      "insert into integration.ai_usage_day(day,requests) values(to_char(now() at time zone 'UTC','YYYY-MM-DD'),60) on conflict(day) do update set requests=60",
    );
    const id = await store.accept(input(), async () => image);
    expect(await store.claim(id)).toBeNull();
    expect(
      (
        await database.pool.query('select attempts,error_code from integration.inbox where id=$1', [
          id,
        ])
      ).rows[0],
    ).toEqual({ attempts: 0, error_code: 'AI_LOCAL_QUOTA_REACHED' });
    await database.pool.query('update integration.ai_usage_day set requests=0');
  });
  it('consumes a queued extraction through the runtime and stores reviewable output', async () => {
    // Other fixtures are intentionally not processed by this test's consumer.
    await database.pool.query(
      "update integration.inbox set state='discarded' where state='pending'",
    );
    const candidate = {
      bookmaker: null,
      reference: null,
      placedAtText: null,
      currency: null,
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
          eventDateText: null,
        },
      ],
      warnings: ['Conferir casa e mercado'],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'synthetic-completion',
        model: OPENROUTER_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(candidate) } }],
      }),
    );
    const requireBudget = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = await startIntegrations(
      database,
      boss,
      {
        AI_ENABLED: 'true',
        AI_PROVIDER: 'openrouter',
        OPENROUTER_MODEL,
        OPENROUTER_ALLOW_FALLBACKS: 'false',
        OPENROUTER_API_KEY: `sk-or-v1-${'0'.repeat(64)}`,
      },
      fetchImpl,
      requireBudget,
    );
    try {
      const id = await integrationStore(database, boss).accept(input(), async () => image);
      await expect
        .poll(
          async () =>
            (await database.pool.query('select state from integration.inbox where id=$1', [id]))
              .rows[0]?.state,
          { timeout: 15_000 },
        )
        .toBe('review');
      const saved = (
        await database.pool.query('select extraction from integration.inbox where id=$1', [id])
      ).rows[0]?.extraction;
      expect(saved.extraction).toEqual(candidate);
      expect(saved.requiresReview).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      requireBudget.mockRejectedValueOnce(new IntegrationError('AI_BUDGET_UNAVAILABLE'));
      const blocked = await integrationStore(database, boss).accept(input(), async () => image);
      await expect
        .poll(
          async () =>
            (
              await database.pool.query('select error_code from integration.inbox where id=$1', [
                blocked,
              ])
            ).rows[0]?.error_code,
          { timeout: 15_000 },
        )
        .toBe('AI_BUDGET_UNAVAILABLE');
      expect(requireBudget).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });
});
