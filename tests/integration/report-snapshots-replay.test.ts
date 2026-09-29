import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase, requireDatabaseUrl, type Database } from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

/**
 * STK-F2-08 — a 0027 é REPLAY-SAFE de verdade, provada por execução.
 *
 * O teste aplica a migração DUAS vezes no mesmo banco, na mesma lógica do
 * runner, e compara o estado resultante com o de uma aplicação única. Um
 * `CREATE TABLE` sem `IF NOT EXISTS`, um seed sem `ON CONFLICT` ou um trigger
 * criado sem `DROP TRIGGER IF EXISTS` aparece aqui como erro ou como diferença
 * de contagem — não em produção.
 */
const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const SQL = readFileSync(
  new URL('../../packages/db/migrations/0027_report_snapshots.sql', import.meta.url),
  'utf8',
);

/** O runner do drizzle separa por `--> statement-breakpoint`. */
const statements = (): string[] =>
  SQL.split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

async function snapshot(database: Database) {
  const counts = await database.pool.query<{ label: string; n: string }>(
    `select 'snapshot' as label, count(*)::text as n from integration.report_snapshot
     union all select 'delivery', count(*)::text from integration.report_delivery
     union all select 'triggers', count(*)::text from pg_trigger t
       join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
      where not t.tgisinternal and ns.nspname='integration' and c.relname='report_snapshot'
     union all select 'functions', count(*)::text from pg_proc p
       join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='integration' and p.proname='immutable_report_snapshot'`,
  );
  return Object.fromEntries(counts.rows.map((row) => [row.label, Number(row.n)]));
}

describe('STK-F2-08 — replay da 0027', () => {
  it('a migração está no journal como a última entrada, com o número reservado', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1]!;
    // A 0027 foi RESERVADA para este card: a 0026 pertence à F2-09 (branch
    // paralela) e ainda não existe no journal da main. O arquivo se chama
    // 0027 e ocupa o último `idx` mesmo sem a 0026, e é isso que o teste
    // fixa — se alguém renomear, a colisão com a F2-09 volta.
    expect(last.tag).toBe('0027_report_snapshots');
    expect(last.idx).toBe(journal.entries.length - 1);
    expect(journal.entries.some((entry) => entry.tag.startsWith('0026_'))).toBe(false);
  });

  it('aplicar duas vezes deixa o estado idêntico ao de uma aplicação', async () => {
    const name = `stk_f208_replay_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f208_replay_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    const database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    try {
      await migrateLocalDatabase(database);
      const first = await snapshot(database);
      // O que a migração cria existe exatamente uma vez depois de uma
      // aplicação: duas tabelas, um trigger e uma função.
      expect(first).toEqual({ snapshot: 0, delivery: 0, triggers: 1, functions: 1 });

      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements()) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const second = await snapshot(database);
      expect(second).toEqual(first);
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
    }
  });
});

describe('STK-F2-08 — o canal de envio é Telegram e nada mais', () => {
  it('o banco recusa e-mail, PDF, PNG e webhook como canal', async () => {
    const name = `stk_f208_channel_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f208_channel_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    const database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    try {
      await migrateLocalDatabase(database);
      await database.pool.query(
        "insert into auth.\"user\"(id,name,email) values('u','U','u@stk.test') on conflict (id) do nothing",
      );
      const { createFinanceService } = await import('../../packages/db/src/index.js');
      const context = await createFinanceService(database).ensureContext('u');
      await database.pool.query(
        `insert into integration.report_snapshot
           (organization_id,version,period,"from","to",financial_version,metrics,payload,content_sha256)
         values($1,1,'monthly',date '2026-09-01',date '2026-09-30',1,'{}'::jsonb,'{}'::jsonb,$2)`,
        [context.organizationId, 'a'.repeat(64)],
      );
      const snapshotId = (
        await database.pool.query<{ id: string }>(
          'select id from integration.report_snapshot limit 1',
        )
      ).rows[0]!.id;
      // E-mail, PDF, PNG e URL compartilhável são ESCOPO EXCLUÍDO (§6.2). A
      // restrição é do banco, não da aplicação: um segundo canal não aparece
      // por conveniência de quem escreve a próxima linha.
      for (const channel of ['email', 'pdf', 'png', 'webhook']) {
        await expect(
          database.pool.query(
            `insert into integration.report_delivery
               (organization_id,snapshot_id,period,"from","to",financial_version,dedupe_key,user_id,channel)
             values($1,$2::uuid,'monthly',date '2026-09-01',date '2026-09-30',1,$3,'u',$4)`,
            [context.organizationId, snapshotId, `k-${channel}`, channel],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.close();
    }
  });
});
