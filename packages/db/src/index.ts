import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { authSchema } from './auth-schema.js';
export { authSchema } from './auth-schema.js';
export { createInboxStore, type EnqueueExtraction, type InboxInput } from './inbox.js';
export { createImportService, type ImportService } from './import-review.js';
export {
  createAttachmentStore,
  createR2Storage,
  validateImage,
  type ObjectStorage,
} from './attachments.js';
export type { PoolClient } from 'pg';
export { createFinanceService, FinanceError, type FinanceService } from './finance-service.js';
export { readRuntime, readSecret, readDatabaseConfig } from './runtime-config.js';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });
  // A disconnected idle client is replaced by the pool; do not leak URLs/errors to logs.
  pool.on('error', () => undefined);
  const orm = drizzle(pool, { schema: authSchema });
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

export type Database = ReturnType<typeof createDatabase>;

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
