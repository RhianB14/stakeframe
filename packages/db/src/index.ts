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
  type BetaInvitationStatus,
  type MembershipRole,
  type LegalDocumentType,
  type LegalDocumentStatus,
} from './core-schema.js';
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
export {
  createOnboardingService,
  OnboardingError,
  type OnboardingService,
  type OnboardingStatus,
  type OnboardingProfileUpdate,
  type OnboardingErrorCode,
  type FirstBetResolution,
} from './onboarding.js';
export { createReportService, type ReportService } from './reports.js';
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
