import { sql } from 'drizzle-orm';
import { check, index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { integrationNamespace } from './inbox-schema.js';

export const eventSearchRequest = integrationNamespace.table(
  'event_search',
  {
    id: uuid('id').primaryKey(),
    actor: text('actor').notNull(),
    hash: text('hash').notNull(),
    selectionId: uuid('selection_id').notNull(),
    provider: text('provider').notNull(),
    query: text('query').notNull(),
    eventFingerprint: text('event_fingerprint').notNull(),
    dateHint: text('date_hint'),
    state: text('state').notNull().default('pending'),
    candidates: jsonb('candidates').notNull().default([]),
    errorCode: text('error_code'),
    cachedFrom: uuid('cached_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('event_search_state', sql`${t.state} in ('pending','processing','complete','failed')`),
    check('event_search_provider', sql`${t.provider} in ('thesportsdb','tavily')`),
    index('event_search_selection_idx').on(t.selectionId, t.createdAt),
    index('event_search_cache_idx').on(t.provider, t.eventFingerprint, t.dateHint, t.completedAt),
    index('event_search_queue_idx')
      .on(t.createdAt)
      .where(sql`${t.state}='pending'`),
    index('event_search_usage_idx')
      .on(t.provider, t.startedAt)
      .where(sql`${t.startedAt} is not null`),
  ],
);
