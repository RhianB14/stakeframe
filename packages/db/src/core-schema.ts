import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
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

/** Stable document types; the frontend never decides meaning from display text. */
export const legalDocumentType = core.enum('legal_document_type', [
  'terms_of_use',
  'privacy_policy',
  'minimum_age',
]);
export type LegalDocumentType = (typeof legalDocumentType.enumValues)[number];

/**
 * `current` = the version users must accept right now; `superseded` = kept only for the
 * audit trail. Superseding never rewrites history: acceptance rows keep their own copy of
 * the version and content hash they were recorded against.
 */
export const legalDocumentStatus = core.enum('legal_document_status', ['current', 'superseded']);
export type LegalDocumentStatus = (typeof legalDocumentStatus.enumValues)[number];

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

/**
 * Versioned legal-document catalog. Lives in `core` (shared reference data, not private
 * to an organization). Content stays in the row so the exact accepted text can be
 * verified by hash; `content_hash` is the SHA-256 of `content_md`.
 */
export const legalDocument = core.table(
  'legal_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docType: legalDocumentType('doc_type').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    contentMd: text('content_md').notNull(),
    contentHash: text('content_hash').notNull(),
    textUrl: text('text_url').notNull(),
    required: boolean('required').default(true).notNull(),
    status: legalDocumentStatus('status').default('current').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('legal_document_type_version_key').on(table.docType, table.version),
    index('legal_document_type_status_idx').on(table.docType, table.status),
    check('legal_document_version_not_empty', sql`btrim(${table.version}) <> ''`),
    check('legal_document_hash_format', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Append-only acceptance history. One row per user + document; the server records the
 * version and hash observed at acceptance time, so publishing a new version (or changing
 * the content of the same version) never rewrites past evidence.
 */
export const consentRecord = core.table(
  'consent_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => legalDocument.id, { onDelete: 'restrict' }),
    docType: legalDocumentType('doc_type').notNull(),
    documentVersion: text('document_version').notNull(),
    documentHash: text('document_hash').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('consent_record_user_document_key').on(table.userId, table.documentId),
    index('consent_record_user_accepted_idx').on(table.userId, table.acceptedAt),
  ],
);

export const coreSchema = { organization, membership, betaInvitation, legalDocument, consentRecord };