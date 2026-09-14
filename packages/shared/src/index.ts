import { z } from 'zod';
export * from './imports.js';
export * from './decimal.js';
export * from './finance.js';

export const systemStatusSchema = z
  .object({
    name: z.literal('Stakeframe'),
    stage: z.enum(['local-setup', 'production-setup']),
    database: z.enum(['available', 'unavailable']),
    authentication: z.enum(['not-configured', 'google']),
    productEnabled: z.boolean(),
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
  'STATE_CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_FINANCIAL_OPERATION',
  'UNIT_REQUIRED',
  'NOT_INITIALIZED',
  'ALIAS_CONFLICT',
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
