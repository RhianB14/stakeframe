import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import {
  createDatabase,
  createFinanceService,
  createReportService,
  createTenantContext,
  reportMetricsSql,
  reportPopulation,
  reportValues,
  splitDimensions,
  splitDimensionSql,
} from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/dist/migrate.js';
import { reportQuerySchema } from '../../packages/shared/dist/index.js';

/**
 * STK-F2-03 — EXPLAIN (ANALYZE, BUFFERS) dos 12 splits em banco local
 * descartável: mesmo fixture de volume do `validation:performance`, medição
 * ANTES e — quando a migração é informada — DEPOIS dos índices compostos.
 * Só cria e derruba um banco próprio: nunca toca no banco local compartilhado
 * nem em produção.
 *
 *   node scripts/validation/splits-explain.mjs [caminho/da/0019_*.sql]
 */
const password = process.env.LOCAL_DB_PASSWORD;
const port = process.env.LOCAL_DB_PORT ?? '55432';
if (!/^[a-f0-9]{48}$/.test(password ?? '') || !/^\d+$/.test(port) || +port < 1 || +port > 65535)
  throw new Error('INVALID_LOCAL_PERFORMANCE_CONFIGURATION');
const source = new URL(
  `postgresql://stakeframe_local:${password}@127.0.0.1:${port}/stakeframe_local`,
);
const name = `stk_splits_explain_${randomUUID().replaceAll('-', '')}`;
assert.match(name, /^stk_splits_explain_[a-f0-9]{32}$/);
const admin = createDatabase(source.toString(), { statementTimeoutMs: 30_000 });
let database;
let created = false;

const NODE_PATTERN =
  /^(Seq Scan|Parallel Seq Scan|Index Only Scan|Index Scan|Bitmap Index Scan|Bitmap Heap Scan|CTE Scan|Foreign Scan|Subquery Scan|Function Scan|Materialize|Memoize|Incremental Sort|Sort|Append|WindowAgg|GroupAggregate|HashAggregate|Aggregate|Hash|Nested Loop|Merge Join|Hash Join|Gather Merge|Gather)\b(?: on ([^\s(]+))?/;

/** Linhas úteis do plano: nós executados, varreduras sequenciais e tempos. */
function summarizePlan(lines) {
  const nodes = [];
  for (const raw of lines) {
    const line = raw.replace(/^[\s->]*/, '').trim();
    const match = line.match(NODE_PATTERN);
    if (match) nodes.push(match[2] ? `${match[1]} on ${match[2]}` : match[1]);
  }
  const executionLine = lines.find((line) => line.startsWith('Execution Time'));
  return {
    executionMs: executionLine ? Number.parseFloat(executionLine.split(':')[1]) : null,
    nodes,
    seqScans: nodes.filter((node) => node.startsWith('Seq Scan')),
    indexOnlyScans: nodes.filter((node) => node.startsWith('Index Only Scan')),
    buffers: lines.find((line) => line.includes('Buffers: shared'))?.trim() ?? null,
  };
}

async function explain(client, label, sql, values) {
  const result = await client.query(`explain (analyze, buffers) ${sql}`, values);
  const lines = result.rows.map((row) => row['QUERY PLAN']);
  // O plano completo vai para a evidência (gitignored) — é o que se cita nos docs.
  return { label, ...summarizePlan(lines), plan: lines };
}

const totalMs = (rows) =>
  Math.round(rows.reduce((sum, row) => sum + (row.executionMs ?? 0), 0) * 10) / 10;

/** Índices existentes das tabelas usadas pelos splits (evidência da migração). */
async function indexList(client) {
  const rows = await client.query(
    `select tablename, indexname from pg_indexes
     where schemaname in ('finance', 'integration')
       and tablename in ('selection', 'settlement', 'bet', 'inbox')
     order by tablename, indexname`,
  );
  return rows.rows.map((row) => `${row.tablename}.${row.indexname}`);
}

/** Relatório (base de comparação) + os 12 splits, com e sem filtro de casa. */
async function measurePhase(client, query, bookmakerId) {
  const rows = [];
  for (const [suffix, values] of [
    ['', reportValues(query)],
    [' + filtro casa', reportValues({ ...query, bookmakerId })],
  ]) {
    rows.push(
      await explain(
        client,
        `relatório${suffix}`,
        `${reportPopulation} select ${reportMetricsSql} from eligible`,
        values,
      ),
    );
    for (const dimension of splitDimensions)
      rows.push(
        await explain(client, `${dimension.id}${suffix}`, splitDimensionSql(dimension), values),
      );
  }
  return rows;
}

try {
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  created = true;
  source.pathname = `/${name}`;
  database = createDatabase(source.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  const finance = createFinanceService(database);
  const tenant = createTenantContext(database);
  await database.pool.query(
    `insert into auth."user"(id,name,email) values('synthetic-explain','Synthetic Explain','explain@stk.test') on conflict (id) do nothing`,
  );
  const context = await tenant.ensureOrganizationMembership('synthetic-explain');
  const workspace = await finance.workspace(context);
  const bookmakerId = workspace.catalog.find((row) => row.name === 'Bet365').id;
  await finance.command(context, randomUUID(), {
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
    await seed.query("select set_config('app.organization_id', $1, true)", [
      context.organizationId,
    ]);
    await seed.query(await readFile(new URL('./seed-performance.sql', import.meta.url), 'utf8'));
    await seed.query('commit');
    // Visibility map dos inserts recentes: sem ela o planner nem considera
    // index-only scan, então a comparação antes/depois seria enviesada.
    await seed.query('vacuum analyze');
  } finally {
    await seed.end();
  }

  const reports = createReportService(database);
  const query = reportQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });
  // Fixture carregado: 9.000 apostas no período (mesmo do validation:performance).
  const sanity = await reports.report(context, query);
  assert.equal(sanity.metrics.bets, 9000);

  const migration = process.argv[2];
  const client = await database.pool.connect();
  let before;
  let after = null;
  let indexEvidence = null;
  try {
    await client.query("select set_config('app.organization_id', $1, false)", [
      context.organizationId,
    ]);
    // A 0019 já roda dentro de migrateLocalDatabase; a fase "antes" mede o banco
    // SEM o índice novo (removido aqui) para comparar de forma limpa.
    await client.query('drop index if exists finance.selection_organization_bet_rollup_idx');
    await client.query('vacuum analyze');
    // Fase morna: a primeira passada aquece os buffers (a criação do índice
    // derruba o cache), então a medição registrada é sempre a segunda.
    await measurePhase(client, query, bookmakerId);
    before = await measurePhase(client, query, bookmakerId);
    const indexesBefore = await indexList(client);
    if (migration) {
      await client.query(await readFile(migration, 'utf8'));
      await client.query('vacuum analyze');
      await measurePhase(client, query, bookmakerId);
      after = await measurePhase(client, query, bookmakerId);
    }
    const indexesAfter = await indexList(client);
    indexEvidence = { before: indexesBefore, after: indexesAfter };
  } finally {
    client.release(true);
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    fixture: 'fictional-10000-v1',
    node: process.version,
    platform: platform(),
    betsInPeriod: sanity.metrics.bets,
    migration: migration ?? null,
    indexes: indexEvidence,
    before: { totalMs: totalMs(before), rows: before },
    ...(after ? { after: { totalMs: totalMs(after), rows: after } } : {}),
  };
  await mkdir('.cache/validation', { recursive: true });
  await writeFile(
    '.cache/validation/splits-explain.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  for (const [phase, rows] of [['ANTES', before], ...(after ? [['DEPOIS', after]] : [])]) {
    console.log(
      `\n=== ${phase}${after ? ' DA MIGRAÇÃO' : ''} — relatório + 12 splits (sem e com filtro de casa) ===`,
    );
    console.log(`total ${totalMs(rows)} ms`);
    for (const row of rows)
      console.log(
        `${row.label.padEnd(34)} ${String(row.executionMs).padStart(8)} ms  seq=[${row.seqScans.join('; ')}]  indexOnly=[${row.indexOnlyScans.join('; ')}]`,
      );
  }
  console.log('\nevidência gravada em .cache/validation/splits-explain.json');
  if (indexEvidence) {
    const created = indexEvidence.after.filter((name) => !indexEvidence.before.includes(name));
    console.log(`índices criados pela migração: ${created.join(', ') || 'nenhum'}`);
  }
} catch (error) {
  console.error(
    `SPLITS_EXPLAIN_FAILED: ${error instanceof assert.AssertionError ? error.message : String(error?.stack ?? error?.message ?? error)}`,
  );
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } finally {
    try {
      if (created) await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  }
}
