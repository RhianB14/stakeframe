import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase, requireDatabaseUrl, type Database } from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

/**
 * STK-F2-13 — a 0025 é REPLAY-SAFE de verdade, provada por execução.
 *
 * O teste aplica a migração DUAS vezes no mesmo banco, na mesma transação
 * lógica do runner, e compara o estado resultante com o de uma aplicação
 * única. Um `IF NOT EXISTS` que esquece uma tabela, ou um seed sem
 * `ON CONFLICT`, aparece aqui como diferença de contagem — não em produção.
 */
const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const SQL = readFileSync(
  new URL('../../packages/db/migrations/0025_entitlements_breakers.sql', import.meta.url),
  'utf8',
);

/** O runner do drizzle separa por `--> statement-breakpoint`. */
const statements = (): string[] =>
  SQL.split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

async function snapshot(database: Database) {
  const counts = await database.pool.query<{ label: string; n: string }>(
    `select 'plan' as label, count(*)::text as n from core.plan
     union all select 'plan_entitlement', count(*)::text from core.plan_entitlement
     union all select 'organization_entitlement', count(*)::text from core.organization_entitlement
     union all select 'breaker_policy', count(*)::text from integration.breaker_policy
     union all select 'ai_model_price', count(*)::text from integration.ai_model_price
     union all select 'ai_cost_model', count(*)::text from integration.ai_cost_model`,
  );
  return Object.fromEntries(counts.rows.map((row) => [row.label, Number(row.n)]));
}

describe('STK-F2-13 — replay da 0025', () => {
  it('aplicar duas vezes deixa o estado idêntico ao de uma aplicação', async () => {
    const name = `stk_f213_replay_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f213_replay_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    const database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    try {
      await migrateLocalDatabase(database);
      const first = await snapshot(database);

      // Replay: a migração inteira, de novo, statement por statement. Se
      // qualquer objeto usasse `CREATE TABLE` sem IF NOT EXISTS, um seed sem
      // ON CONFLICT, ou uma coluna sem IF NOT EXISTS, esta passagem quebraria.
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
      // E o teto de R$200 continua gravado uma única vez.
      const cap = (
        await database.pool.query<{ n: string }>(
          "select count(*)::text as n from integration.breaker_policy where scope='global' and spend_cap_micros=200000000",
        )
      ).rows[0]!;
      expect(Number(cap.n)).toBe(1);
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.close();
    }
  });
});
