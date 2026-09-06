import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });
  // A disconnected idle client is replaced by the pool; do not leak URLs/errors to logs.
  pool.on('error', () => undefined);
  const orm = drizzle(pool);
  return {
    pool,
    orm,
    async check() {
      await orm.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}

export function requireDatabaseUrl(value: string | undefined): string {
  try {
    const parsed = new URL(value ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  return value as string;
}
