import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { authSchema } from './auth-schema.js';
import { coreSchema } from './core-schema.js';
export { authSchema } from './auth-schema.js';
export {
  coreSchema,
  membershipRole,
  betaInvitation,
  betaInvitationStatus,
  legalDocument,
  legalDocumentType,
  legalDocumentStatus,
  consentRecord,
  adminPanelAccess,
  type BetaInvitationStatus,
  type MembershipRole,
  type LegalDocumentType,
  type LegalDocumentStatus,
  telegramLink,
  telegramLinkRequest,
  telegramLinkRequestState,
  telegramLinkState,
  type TelegramLinkRequestState,
  type TelegramLinkState,
} from './core-schema.js';
export {
  createAdminPanelService,
  AdminPanelError,
  type AdminPanelService,
  type AdminPanelServiceOptions,
  type AdminPanelErrorCode,
  type TelemetryState,
} from './admin-panel.js';
export {
  createConsentsService,
  hashDocumentContent,
  documentContentIsIntact,
  ConsentError,
  LEGAL_DOCUMENT_TYPES,
  REQUIRED_LEGAL_DOCUMENT_TYPES,
  type ConsentErrorCode,
  type ConsentStatus,
  type ConsentDocumentStatus,
  type ConsentsService,
  type CurrentDocument,
} from './consents.js';
export {
  createBetaInvitation,
  normalizeInvitationEmail,
  hashInvitationToken,
  BetaInvitationError,
  type BetaInvitationErrorCode,
  type BetaInvitationService,
  type CreatedBetaInvitation,
  type RedeemedBetaInvitation,
} from './beta-invitation.js';
export {
  captureTransactions,
  currentTransaction,
  type TransactionExecutor,
} from './transaction-scope.js';
export {
  createTenantContext,
  systemOrganizationContext,
  ORGANIZATION_CONTEXT_SETTING,
  TenantContextError,
  type OrganizationContext,
  type TenantContextErrorCode,
  type WithOrganizationTransactionOptions,
} from './tenant-context.js';
export { createInboxStore, type EnqueueExtraction, type InboxInput } from './inbox.js';
export { createImportService, type ImportService } from './import-review.js';
export {
  createImportDraftService,
  enqueueOutbox,
  enqueueBetSync,
  enqueueCleanupForBet,
  enqueueSyncForSelection,
  claimOutboxItem,
  finishOutboxItem,
} from './telegram-sync.js';
export {
  createEventService,
  readEventSearchConfig,
  EVENT_LIMITS,
  type EventService,
  type EventSearchConfig,
} from './events.js';
export {
  createFreebetService,
  FreebetError,
  expiresAtFor,
  statusOf,
  DEFAULT_TIMEZONE,
  DEFAULT_TOPIC_FLAGS,
  FREEBET_EXPIRY_WINDOWS,
  type FreebetErrorCode,
  type FreebetService,
} from './freebets.js';
export {
  createNotificationService,
  outsideQuietHours,
  type NotificationService,
} from './notifications.js';
export { notification, notificationPreference, notificationOutbox } from './notification-schema.js';
export {
  createAttachmentStore,
  createR2Storage,
  validateImage,
  type ObjectStorage,
} from './attachments.js';
export type { PoolClient } from 'pg';
export { createFinanceService, FinanceError, type FinanceService } from './finance-service.js';
export {
  createOnboardingService,
  OnboardingError,
  type OnboardingService,
  type OnboardingStatus,
  type OnboardingProfileUpdate,
  type OnboardingErrorCode,
  type FirstBetResolution,
} from './onboarding.js';
export { createReportService, type ReportService, type ReportServiceOptions } from './reports.js';
export {
  reportPopulation,
  reportMetricsSql,
  reportValues,
  splitDimensions,
  splitDimensionSql,
  splitPopulation,
  type SplitDimensionDefinition,
} from './report-query.js';
export { createTtlCache, type TtlCache } from './ttl-cache.js';
export { createAccountExportService, type AccountExportService } from './account-export.js';
export {
  createAccountDeletionService,
  AccountDeletionError,
  ACCOUNT_DELETION_GRACE_MS,
  ATTACHMENT_RETENTION_AFTER_PURGE_DAYS,
  type AccountDeletionErrorCode,
  type AccountDeletionService,
  type AccountDeletionStatus,
  type DuePurge,
} from './account-deletion.js';
export {
  createTelegramLinkService,
  hashTelegramLinkToken,
  TelegramLinkError,
  TelegramSessionError,
  TELEGRAM_LINK_TTL_MS,
  type TelegramLinkErrorCode,
  type TelegramSessionErrorCode,
  type TelegramLinkService,
} from './telegram-link.js';
export {
  createTelegramTicketService,
  telegramTicketContext,
  telegramTicketIdentity,
  TelegramTicketError,
  TELEGRAM_ARCHIVE_RECOVERY_DAYS,
  type TelegramTicketErrorCode,
  type TelegramTicketService,
} from './telegram-ticket.js';
export {
  createExtractionPolicyService,
  categoryForErrorCode,
  secondaryAllowedAfter,
  sha256Hex,
  AI_CIRCUIT_FAILURE_THRESHOLD,
  AI_CIRCUIT_RECOVERY_MS,
  type ExtractionPolicyService,
} from './extraction-policy.js';

export { layoutDigest } from './automatic-policy.js';
export { attachmentExpiredSql, claimExpiredAttachmentsForBackup } from './attachment-policy.js';
export { assertRecoveryReviewed } from './recovery-guard.js';
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
  const orm = drizzle(pool, { schema: { ...authSchema, ...coreSchema } });
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
