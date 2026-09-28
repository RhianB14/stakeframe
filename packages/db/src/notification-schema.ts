import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { membership } from './core-schema.js';

export const notification = pgSchema('notification');

/**
 * STK-F2-10 — preferências de notificação por usuário e fila de alertas.
 *
 * `notification_preference` é por USUÁRIO (§8.7: quiet hours, timezone e
 * preferências ficam por usuário), não por organização: a organização continua
 * sendo o isolador de dados, e o usuário autenticado é o dono da preferência.
 * A coluna `organization_id` faz parte da chave e do predicado de todo acesso,
 * então a preferência de um usuário de outra organização nunca é lida.
 */
const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .default(sql`current_setting('app.organization_id', true)::uuid`);

export const notificationPreference = notification.table(
  'preference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    userId: text('user_id').notNull(),
    /** Fuso IANA do usuário; quiet hours são avaliados NESTE fuso. */
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    /** Minutos desde a meia-noite local (0–1439); a janela pode cruzar a meia-noite. */
    quietHoursStart: integer('quiet_hours_start').notNull().default(1320),
    quietHoursEnd: integer('quiet_hours_end').notNull().default(360),
    /** Preferência por tópico: resultado, revisão pendente e expiração de freebet. */
    topics: jsonb('topics').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_preference_user_idx').on(table.organizationId, table.userId),
    check(
      'notification_preference_quiet_hours_check',
      sql`${table.quietHoursStart} between 0 and 1439 and ${table.quietHoursEnd} between 0 and 1439`,
    ),
    check(
      'notification_preference_timezone_check',
      sql`char_length(${table.timezone}) between 1 and 64`,
    ),
    foreignKey({
      name: 'notification_preference_membership_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [membership.organizationId, membership.userId],
    }),
  ],
);

/**
 * Fila durável de notificações. A chave de deduplicação
 * (organization, topic, subject, window) garante UM alerta por freebet e por
 * janela — repetir o job nunca duplica a notificação. `state` distingue a
 * entrega de um silêncio por quiet hours: um alerta adiado por quiet hours
 * continua `pending` com nova hora, jamais `delivered`.
 */
export const notificationOutbox = notification.table(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    userId: text('user_id').notNull(),
    topic: text('topic').notNull(),
    /** Entidade que originou a notificação (freebet, aposta, importação). */
    subjectId: uuid('subject_id'),
    /** Janela do alerta (`24h`, `4h`, `1d`): parte da chave de deduplicação. */
    window: text('window').notNull().default('default'),
    /** Chave de deduplicação determinística. */
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Instante de entrega já convertido ao fuso do usuário. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('notification_outbox_dedupe_idx').on(table.organizationId, table.dedupeKey),
    unique('notification_outbox_organization_id_id_idx').on(table.organizationId, table.id),
    check(
      'notification_outbox_topic_check',
      sql`${table.topic} in ('bet_settled','review_pending','freebet_expiring')`,
    ),
    check(
      'notification_outbox_state_check',
      sql`${table.state} in ('pending','delivered','skipped_quiet_hours','failed','cancelled')`,
    ),
    check(
      'notification_outbox_attempts_check',
      sql`${table.attempts} >= 0 and char_length(${table.window}) between 1 and 16`,
    ),
    index('notification_outbox_due_idx').on(table.state, table.scheduledFor),
    index('notification_outbox_subject_idx').on(table.organizationId, table.subjectId),
    index('notification_outbox_user_idx').on(table.organizationId, table.userId, table.createdAt),
    foreignKey({
      name: 'notification_outbox_preference_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [notificationPreference.organizationId, notificationPreference.userId],
    }),
  ],
);
