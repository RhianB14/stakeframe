import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { authSchema } from './auth-schema.js';
export { authSchema } from './auth-schema.js';
export { createInboxStore, type EnqueueExtraction, type InboxInput } from './inbox.js';
export { createImportService, type ImportService } from './import-review.js';
export {
  createEventService,
  readEventSearchConfig,
  EVENT_LIMITS,
  type EventService,
  type EventSearchConfig,
} from './events.js';
export {
  createAttachmentStore,
  createR2Storage,
  validateImage,
  type ObjectStorage,
} from './attachments.js';
export type { PoolClient } from 'pg';
export { createFinanceService, FinanceError, type FinanceService } from './finance-service.js';
export { createReportService, type ReportService } from './reports.js';
export { layoutDigest } from './automatic-policy.js';
export { createAutomaticImportService } from './automatic-import.js';
export { readRuntime, readSecret, readDatabaseConfig } from './runtime-config.js';

export function createDatabase(
  connectionString: string,
  options: { statementTimeoutMs?: number } = {},
) {
  const statementTimeoutMs = options.statementTimeoutMs ?? 3_000;
  if (
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > 30_000
  )
    throw new Error('INVALID_DATABASE_TIMEOUT');
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3_000,
    // Cancel work on PostgreSQL before the client gives up waiting for its result.
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 2_000,
  });
  // A disconnected idle client is replaced by the pool; do not leak URLs/errors to logs.
  pool.on('error', () => undefined);
  const orm = drizzle(pool, { schema: authSchema });
  return {
    pool,
    orm,
    createMigrationClient() {
      return new pg.Client({
        connectionString,
        connectionTimeoutMillis: 3_000,
        statement_timeout: 30_000,
        query_timeout: 35_000,
        lock_timeout: 10_000,
      });
    },
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
