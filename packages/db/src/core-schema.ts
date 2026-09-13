import { sql } from 'drizzle-orm';
import {
  check,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

export const coreNamespace = pgSchema('core');

const core = coreNamespace;
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const membershipRole = core.enum('membership_role', ['owner', 'superadmin']);
export type MembershipRole = (typeof membershipRole.enumValues)[number];

export const betaInvitationStatus = core.enum('beta_invitation_status', [
  'pending',
  'accepted',
  'revoked',
]);
export type BetaInvitationStatus = (typeof betaInvitationStatus.enumValues)[number];

export const organization = core.table(
  'organization',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check('organization_name_not_empty', sql`btrim(${table.name}) <> ''`)],
);

export const membership = core.table(
  'membership',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    uniqueIndex('membership_user_id_unique').on(table.userId),
  ],
);

export const betaInvitation = core.table(
  'beta_invitation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    status: betaInvitationStatus('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedUserId: text('accepted_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('beta_invitation_token_hash_key').on(table.tokenHash),
    uniqueIndex('beta_invitation_pending_email_key')
      .on(table.email)
      .where(sql`${table.status} = 'pending'`),
    check('beta_invitation_email_not_empty', sql`btrim(${table.email}) <> ''`),
  ],
);

export const coreSchema = { organization, membership, betaInvitation };
