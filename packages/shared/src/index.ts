import { z } from 'zod';
import { releaseInfoSchema } from './release.js';
export * from './imports.js';
export * from './telegram.js';
export * from './decimal.js';
export * from './finance.js';
export * from './release.js';

export const systemStatusSchema = z
  .object({
    name: z.literal('Stakeframe'),
    stage: z.enum(['local-setup', 'production-setup']),
    database: z.enum(['available', 'unavailable']),
    authentication: z.enum(['not-configured', 'google']),
    productEnabled: z.boolean(),
    release: releaseInfoSchema,
  })
  .meta({ id: 'SystemStatus' });

export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const apiErrorCodeSchema = z.enum([
  'NOT_FOUND',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'AUTH_NOT_CONFIGURED',
  'UNAUTHENTICATED',
  'ORIGIN_NOT_ALLOWED',
  'AUTH_REQUEST_FAILED',
  'RATE_LIMITED',
  'AUTH_UNAVAILABLE',
  'INVITE_REJECTED',
  'RESET_REJECTED',
  'EMAIL_NOT_VERIFIED',
  'CONSENT_REQUIRED',
  'CONSENT_INVALID',
  'ONBOARDING_PREREQUISITE',
  'STATE_CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_FINANCIAL_OPERATION',
  'UNIT_REQUIRED',
  'NOT_INITIALIZED',
  'ALIAS_CONFLICT',
  'ORIGIN_REQUIRED',
  'FREEBET_UNRESOLVED',
  'DUPLICATE_REVIEW_REQUIRED',
  'INVALID_INBOX_IMAGE',
  'INBOX_BUSY',
  'INBOX_CAPACITY_REACHED',
  'ATTACHMENT_UNAVAILABLE',
  'EVENT_PROVIDER_DISABLED',
  'EVENT_QUEUE_FULL',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const apiErrorSchema = z
  .object({
    error: z.object({ code: apiErrorCodeSchema, message: z.string(), requestId: z.uuid() }),
  })
  .meta({ id: 'ApiError' });

export const livenessSchema = z.object({ status: z.literal('alive') }).meta({ id: 'Liveness' });
export const readinessSchema = z.object({ status: z.literal('ready') }).meta({ id: 'Readiness' });
export const unavailabilitySchema = z
  .object({ status: z.literal('unavailable') })
  .meta({ id: 'Unavailability' });
export const googleSignInSchema = z
  .object({ url: z.url(), redirect: z.literal(false) })
  .meta({ id: 'GoogleSignIn' });
export const signOutSchema = z.object({ success: z.literal(true) }).meta({ id: 'SignOut' });

export const betaInviteOpenSchema = z
  .object({ token: z.string().min(1).max(512) })
  .meta({ id: 'BetaInviteOpen' });
export const betaInviteOpenedSchema = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'BetaInviteOpened' });

export const emailSignUpSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email(),
    password: z.string().min(8).max(128),
  })
  .meta({ id: 'EmailSignUp' });
export const emailSignInSchema = z
  .object({ email: z.email(), password: z.string().min(8).max(128) })
  .meta({ id: 'EmailSignIn' });

/** Sanitized session summary; never carries tokens, e-mail, cookies or provider data. */
export const authUserSummarySchema = z
  .object({ user: z.object({ id: z.string().min(1), name: z.string() }) })
  .meta({ id: 'AuthUserSummary' });
export const emailVerificationResultSchema = z
  .object({ status: z.literal(true) })
  .meta({ id: 'EmailVerificationResult' });
export const authStatusSchema = z.object({ status: z.literal(true) }).meta({ id: 'AuthStatus' });

export const passwordResetRequestSchema = z
  .object({ email: z.email().max(320) })
  .meta({ id: 'PasswordResetRequest' });
export const passwordResetSubmitSchema = z
  .object({ token: z.string().min(1).max(512), newPassword: z.string().min(8).max(128) })
  .meta({ id: 'PasswordResetSubmit' });
export const resendVerificationSchema = z
  .object({ email: z.email().max(320) })
  .meta({ id: 'ResendVerification' });

/** Stable legal-document types; never derived from display text. */
export const legalDocumentTypeSchema = z
  .enum(['terms_of_use', 'privacy_policy', 'minimum_age'])
  .meta({ id: 'LegalDocumentType' });
export type LegalDocumentTypeName = z.infer<typeof legalDocumentTypeSchema>;

export const consentDocumentStatusSchema = z
  .object({
    type: legalDocumentTypeSchema,
    version: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(600),
    textUrl: z.string().min(1).max(300),
    effectiveAt: z.iso.datetime(),
    accepted: z.boolean(),
    stale: z.boolean(),
    integrity: z.enum(['ok', 'changed']),
    acceptedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ConsentDocumentStatus' });

export const consentStatusSchema = z
  .object({
    status: z.enum(['accepted', 'pending']),
    documents: z.array(consentDocumentStatusSchema).min(1),
    pendingTypes: z.array(legalDocumentTypeSchema),
  })
  .meta({ id: 'ConsentStatus' });

export const consentAcceptSchema = z
  .object({
    documents: z
      .array(
        z.object({
          type: legalDocumentTypeSchema,
          /** Optional echo of the version the client displayed; must match the effective one. */
          version: z.string().min(1).max(64).optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .meta({ id: 'ConsentAccept' });

export const consentAcceptedSchema = z
  .object({
    accepted: z.array(
      z.object({
        type: legalDocumentTypeSchema,
        version: z.string().min(1).max(64),
        acceptedAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'ConsentAccepted' });

export const consentHistorySchema = z
  .object({
    history: z.array(
      z.object({
        type: legalDocumentTypeSchema,
        version: z.string().min(1).max(64),
        acceptedAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'ConsentHistory' });

export const probeSchema = z.object({ nonce: z.string().uuid() }).strict();
export const PROBE_QUEUE = 'system-probe';

export const organizationRoleSchema = z.enum(['owner', 'superadmin']);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const ownerSessionSchema = z
  .object({
    user: z.object({ id: z.string(), name: z.string() }),
    organization: z.object({ id: z.uuid(), role: organizationRoleSchema }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'OwnerSession' });
export type OwnerSession = z.infer<typeof ownerSessionSchema>;
export * from './events.js';
export * from './reports.js';
export * from './automatic.js';
export * from './operations.js';
export * from './onboarding.js';
