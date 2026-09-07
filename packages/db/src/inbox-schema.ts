import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const integrationNamespace = pgSchema('integration');
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
export const inbox = integrationNamespace.table(
  'inbox',
  {
    id: uuid('id').primaryKey(),
    sourceKey: text('source_key').notNull().unique(),
    image: bytea('image').notNull(),
    sha256: text('sha256').notNull(),
    caption: text('caption').notNull(),
    metadata: jsonb('metadata').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    version: integer('version').notNull().default(1),
    extraction: jsonb('extraction'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'inbox_state_check',
      sql`${table.state} in ('pending', 'processing', 'review', 'failed', 'discarded', 'imported')`,
    ),
    check('inbox_image_size_check', sql`octet_length(${table.image}) between 1 and 8388608`),
    check('inbox_attempts_check', sql`${table.attempts} >= 0 and ${table.version} > 0`),
    index('inbox_state_created_idx').on(table.state, table.createdAt),
    index('inbox_image_hash_idx').on(table.sha256),
  ],
);
export const integrationCursor = integrationNamespace.table('cursor', {
  name: text('name').primaryKey(),
  nextOffset: bigint('next_offset', { mode: 'number' }).notNull().default(0),
});
export const aiUsageDay = integrationNamespace.table(
  'ai_usage_day',
  {
    day: text('day').primaryKey(),
    requests: integer('requests').notNull().default(0),
  },
  (table) => [check('ai_usage_nonnegative', sql`${table.requests} >= 0`)],
);
