import { sql } from 'drizzle-orm';
import {
  bigint,
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

/** STK-F1-08: `pending` blocks access and schedules the purge; `cancelled` restores it. */
export const accountDeletionState = core.enum('account_deletion_state', [
  'pending',
  'cancelled',
  'purged',
]);
export type AccountDeletionState = (typeof accountDeletionState.enumValues)[number];

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

/**
 * Per-user onboarding progress (STK-F1-09). One row per user; `organization_id` keeps every
 * read and write scoped to the tenant that owns the row, and the remaining steps are NOT
 * duplicated here — the bankroll step comes from the financial core (`finance.settings`) and
 * the first-bet step from the registered bets, so there is a single source of truth for each.
 */
export const onboardingState = core.table(
  'onboarding_state',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    timezone: text('timezone'),
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),
    /** The user's explicit choice to conclude without a bet ("connect Telegram later"). */
    firstBetDeferredAt: timestamp('first_bet_deferred_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('onboarding_state_organization_idx').on(table.organizationId),
    check(
      'onboarding_state_timezone_not_empty',
      sql`${table.timezone} is null or btrim(${table.timezone}) <> ''`,
    ),
  ],
);

/**
 * STK-F1-08 account-deletion state machine. One row per user: `pending` blocks every
 * login immediately and schedules the irreversible purge for `expires_at` (requested_at +
 * 30 days); `cancelled` restores normal access inside the grace window; `purged` is the
 * minimal trail that survives the purge itself. `organization_id` is deliberately NOT a
 * foreign key: the purge deletes the organization, and this row must remain as the
 * sanitized evidence that the account was erased (no FK would survive that deletion).
 */
export const accountDeletion = core.table(
  'account_deletion',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    state: accountDeletionState('state').default('pending').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('account_deletion_organization_idx').on(table.organizationId),
    index('account_deletion_due_idx').on(table.state, table.expiresAt),
  ],
);

/**
 * STK-F2-11: append-only audit of every attempt to open the internal superadmin
 * panel — allowed AND denied, so a refused access is evidence too. Deliberately
 * NOT organization-scoped: the panel is the one surface that crosses tenants, and
 * its audit trail must survive (and not depend on) the tenant context. Nothing
 * about the caller beyond the internal user id is stored: no e-mail, no IP, no
 * user-agent, no cookie, no session, no request body and no tenant content.
 */
export const adminPanelAccess = core.table(
  'admin_panel_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Internal user id of the caller (`auth.user.id`), never the e-mail. */
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    view: text('view').notNull(),
    outcome: text('outcome').notNull(),
    /** Server-generated request id; lets an operator correlate with the app log. */
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'admin_panel_access_view_check',
      sql`${table.view} in ('accounts','usage','flags','errors','audit')`,
    ),
    check('admin_panel_access_outcome_check', sql`${table.outcome} in ('allowed','denied')`),
    check('admin_panel_access_actor_not_empty', sql`btrim(${table.actorUserId}) <> ''`),
    index('admin_panel_access_created_idx').on(table.createdAt),
    index('admin_panel_access_actor_idx').on(table.actorUserId, table.createdAt),
  ],
);

/** STK-F2-04: `pending` = deep link vivo; `claimed` = o bot já falou "start"; `consumed` = vínculo confirmado no site; `expired`/`revoked` = terminais. */
export const telegramLinkRequestState = core.enum('telegram_link_request_state', [
  'pending',
  'claimed',
  'consumed',
  'expired',
  'revoked',
]);
export type TelegramLinkRequestState = (typeof telegramLinkRequestState.enumValues)[number];

/** STK-F2-04: `active` = conta Telegram vinculada; `revoked` = desvinculada (a linha fica na trilha). */
export const telegramLinkState = core.enum('telegram_link_state', ['active', 'revoked']);
export type TelegramLinkState = (typeof telegramLinkState.enumValues)[number];

/**
 * STK-F2-04 — deep link de uso único. Artefato GLOBAL e temporário (cinco
 * minutos, Plano §8.2): existe apenas enquanto o link está vivo, é resolvido
 * só pelo SHA-256 do token e nunca carrega nome, e-mail, organização ou conteúdo
 * — o mesmo papel de `core.beta_invitation`. Sem RLS: a resolução por hash é a
 * fronteira (o usuário nunca escolhe a organização aqui).
 */
export const telegramLinkRequest = core.table(
  'telegram_link_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    state: telegramLinkRequestState('state').default('pending').notNull(),
    /** ID numérico do Telegram, preenchido quando o deep link é aberto pelo bot. */
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('telegram_link_request_token_hash_key').on(table.tokenHash),
    index('telegram_link_request_user_state_idx').on(table.userId, table.state, table.expiresAt),
    check('telegram_link_request_ttl_check', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/**
 * STK-F2-04 — vínculo duradouro entre a conta Telegram e o usuário. Privado e
 * escopado pela organização (RLS fail-closed) e removido em cascata quando a
 * organização é apagada. A unicidade GLOBAL da conta Telegram é garantida por
 * índice parcial sobre `state = 'active'`: duas linhas revogadas podem repetir o
 * mesmo id (a trilha), mas nunca dois vínculos ativos.
 */
export const telegramLink = core.table(
  'telegram_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    state: telegramLinkState('state').default('active').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('telegram_link_active_telegram_id_key')
      .on(table.telegramUserId)
      .where(sql`${table.state} = 'active'`),
    uniqueIndex('telegram_link_active_user_id_key')
      .on(table.userId)
      .where(sql`${table.state} = 'active'`),
    index('telegram_link_organization_idx').on(table.organizationId),
    check('telegram_link_telegram_id_check', sql`${table.telegramUserId} > 0`),
    check(
      'telegram_link_revocation_check',
      sql`(${table.state} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
  ],
);

/**
 * STK-F2-04: username público do bot (singleton). Não é segredo — o Telegram
 * publica o username na URL do bot — mas fica no banco, e não no repositório:
 * o valor é resolvido pelo worker a partir de `getMe` e nunca é digitado por
 * ninguém. `null` = deep link indisponível; a API falha fechada.
 */
export const telegramBot = core.table(
  'telegram_bot',
  {
    id: text('id').primaryKey().default('default'),
    username: text('username').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Singleton: a API sempre lê a linha 'default'.
    check('telegram_bot_id_check', sql`${table.id} = 'default'`),
    // Formato do Telegram: letras, dígitos e underscore. Um valor fora disso
    // (URL, arroba, espaço) nunca vira deep link clicável.
    check('telegram_bot_username_format', sql`${table.username} ~ '^[A-Za-z0-9_]{5,32}$'`),
  ],
);

export const coreSchema = {
  organization,
  membership,
  betaInvitation,
  legalDocument,
  consentRecord,
  onboardingState,
  accountDeletion,
  adminPanelAccess,
  telegramLinkRequest,
  telegramLink,
  telegramBot,
};
