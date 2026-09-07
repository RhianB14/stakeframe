import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  createDatabase,
  createFinanceService,
  createReportService,
} from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/dist/migrate.js';
import { reportQuerySchema, cents } from '../../packages/shared/dist/index.js';

// Never accept a production URL. The normal local stack supplies the only target.
const password = process.env.LOCAL_DB_PASSWORD;
const port = process.env.LOCAL_DB_PORT ?? '55432';
if (!/^[a-f0-9]{48}$/.test(password ?? '') || !/^\d+$/.test(port) || +port < 1 || +port > 65535)
  throw new Error('INVALID_LOCAL_PERFORMANCE_CONFIGURATION');
const source = new URL(
  `postgresql://stakeframe_local:${password}@127.0.0.1:${port}/stakeframe_local`,
);
const name = `stk_perf_test_${randomUUID().replaceAll('-', '')}`;
assert.match(name, /^stk_perf_test_[a-f0-9]{32}$/);
const admin = createDatabase(source.toString(), { statementTimeoutMs: 30_000 });
let database;
let created = false;
const timings = [];
async function measure(label, repetitions, budgetMs, action) {
  await action();
  const samples = [];
  for (let i = 0; i < repetitions; i++) {
    const start = performance.now();
    await action();
    samples.push(Math.round((performance.now() - start) * 100) / 100);
  }
  samples.sort((a, b) => a - b);
  const p95Ms = samples[Math.ceil(samples.length * 0.95) - 1];
  const result = {
    label,
    samples: samples.length,
    medianMs:
      Math.round(
        ((samples[Math.floor((samples.length - 1) / 2)] + samples[Math.floor(samples.length / 2)]) /
          2) *
          100,
      ) / 100,
    p95Ms,
    budgetMs,
    passed: p95Ms <= budgetMs,
  };
  timings.push(result);
  console.log(JSON.stringify(result));
}
try {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  source.pathname = `/${name}`;
  database = createDatabase(source.toString());
  await migrateLocalDatabase(database);
  const finance = createFinanceService(database);
  const workspace = await finance.workspace();
  const bookmakerId = workspace.catalog.find((row) => row.name === 'Bet365').id;
  await finance.command('synthetic-performance', randomUUID(), {
    type: 'bankroll.initialize',
    expectedVersion: workspace.version,
    reserve: '100000.00',
    balances: [{ bookmakerId, amount: '100000.00' }],
    unitPercent: '1.00',
  });
  const seed = database.createMigrationClient();
  try {
    await seed.connect();
    await seed.query('begin');
    await seed.query(await readFile(new URL('./seed-performance.sql', import.meta.url), 'utf8'));
    await seed.query('commit');
    await seed.query('analyze');
  } finally {
    await seed.end();
  }
  const reports = createReportService(database);
  const query = reportQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });
  const result = await reports.report(query);
  assert.equal(result.metrics.bets, 9000);
  assert.equal(result.metrics.profit, '22500.00');
  assert.equal(result.metrics.exposure, '45000.00');
  assert.deepEqual(result.exclusions, { unknownDateBets: 500, estimatedDateBets: 500 });
  for (const rows of [result.timeline, result.byBookmaker, result.byTipster, result.bySport]) {
    assert.equal(
      rows.reduce((sum, row) => sum + row.metrics.bets, 0),
      9000,
    );
    assert.equal(
      rows.reduce((sum, row) => sum + cents(row.metrics.profit), 0n),
      2250000n,
    );
  }
  const balance = await finance.workspace();
  assert.equal(balance.bankroll, '225000.00');
  assert.equal(balance.exposure, '50000.00');
  assert.equal(balance.available, '175000.00');
  assert.equal(
    (
      await database.pool.query(
        'select count(*)::int n from (select journal_id from finance.posting group by journal_id having sum(amount)<>0) invalid',
      )
    ).rows[0].n,
    0,
  );
  async function exported(kind) {
    const stream = await reports.export(kind, kind === 'csv' ? query : undefined);
    let text = '';
    for await (const chunk of stream) text += String(chunk);
    if (kind === 'csv') assert.equal(text.split('\r\n').length, 9002);
    else {
      const json = JSON.parse(text);
      assert.equal(json['finance.bet'].length, 10000);
      assert.equal(new Set(json['finance.bet'].map((row) => row.id)).size, 10000);
      assert.equal(json['finance.selection'].length, 16666);
      assert.equal(json['finance.settlement'].length, 5000);
      assert.equal(json['finance.posting'].length, 35003);
    }
  }
  await measure('workspace', 10, 500, () => finance.workspace());
  await measure('report', 10, 2000, () => reports.report(query));
  await measure('detail-first-page', 10, 500, () =>
    reports.bets({ ...query, page: 1, pageSize: 50 }),
  );
  await measure('detail-last-page', 10, 500, () =>
    reports.bets({ ...query, page: 180, pageSize: 50 }),
  );
  await measure('csv-9000', 3, 10000, () => exported('csv'));
  await measure('json-10000', 3, 10000, () => exported('json'));
  const evidence = {
    generatedAt: new Date().toISOString(),
    fixture: 'fictional-10000-v1',
    node: process.version,
    platform: platform(),
    arch: arch(),
    postgres: (await database.pool.query('show server_version')).rows[0].server_version,
    reconciliation: 'passed',
    timings,
  };
  await mkdir('.cache/validation', { recursive: true });
  await writeFile('.cache/validation/performance.json', JSON.stringify(evidence, null, 2) + '\n');
  assert.ok(
    timings.every((row) => row.passed),
    'PERFORMANCE_BUDGET_EXCEEDED',
  );
} catch (error) {
  // Do not print driver errors, connection URLs or parameters in CI logs.
  console.error(
    `PERFORMANCE_VALIDATION_FAILED: ${error instanceof assert.AssertionError ? error.message : 'database or fixture error'}`,
  );
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } finally {
    try {
      if (created) await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
}
