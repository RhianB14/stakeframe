import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  boolean,
  unique,
} from 'drizzle-orm/pg-core';
import { bet } from './finance-schema.js';

export const integrationNamespace = pgSchema('integration');
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Multi-tenant isolation (STK-F1-13): private import artifacts carry their organization the same
 * way the financial tables do — DEFAULT from the transaction-local setting, fail-closed without
 * context. `cursor` and `ai_usage_day` stay global infrastructure of the workers.
 */
const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .default(sql`current_setting('app.organization_id', true)::uuid`);

export const attachment = integrationNamespace.table(
  'attachment',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    sha256: text('sha256').notNull(),
    image: bytea('image'),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    state: text('state').notNull().default('local'),
    objectKey: text('object_key').notNull().unique(),
    remoteAttempted: boolean('remote_attempted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('attachment_organization_id_id_idx').on(table.organizationId, table.id),
    uniqueIndex('attachment_live_hash_idx')
      .on(table.organizationId, table.sha256)
      .where(sql`${table.state} not in ('deleting','deleted')`),
    check('attachment_state_check', sql`${table.state} in ('local','remote','deleting','deleted')`),
    check('attachment_size_check', sql`${table.size} between 1 and 8388608`),
  ],
);
export const inbox = integrationNamespace.table(
  'inbox',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    sourceKey: text('source_key').notNull().unique(),
    image: bytea('image'),
    attachmentId: uuid('attachment_id'),
    importedBetId: uuid('imported_bet_id'),
    requestHash: text('request_hash'),
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
    unique('inbox_organization_id_id_idx').on(table.organizationId, table.id),
    check(
      'inbox_state_check',
      sql`${table.state} in ('pending', 'processing', 'review', 'failed', 'discarded', 'imported')`,
    ),
    check('inbox_image_size_check', sql`octet_length(${table.image}) between 1 and 8388608`),
    check('inbox_attempts_check', sql`${table.attempts} >= 0 and ${table.version} > 0`),
    index('inbox_state_created_idx').on(table.state, table.createdAt),
    index('inbox_image_hash_idx').on(table.sha256),
    index('inbox_attachment_idx').on(table.attachmentId),
    index('inbox_imported_bet_idx').on(table.importedBetId),
    foreignKey({
      name: 'inbox_attachment_fk',
      columns: [table.organizationId, table.attachmentId],
      foreignColumns: [attachment.organizationId, attachment.id],
    }),
    foreignKey({
      name: 'inbox_imported_bet_fk',
      columns: [table.organizationId, table.importedBetId],
      foreignColumns: [bet.organizationId, bet.id],
    }),
  ],
);
export const extractionRequest = integrationNamespace.table(
  'extraction_request',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    inboxId: uuid('inbox_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'extraction_request_inbox_fk',
      columns: [table.organizationId, table.inboxId],
      foreignColumns: [inbox.organizationId, inbox.id],
    }),
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
