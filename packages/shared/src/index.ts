import { z } from 'zod';

export const systemStatusSchema = z
  .object({
    name: z.literal('Stakeframe'),
    stage: z.literal('local-setup'),
    database: z.enum(['available', 'unavailable']),
    authentication: z.enum(['not-configured', 'google']),
    productEnabled: z.literal(false),
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

export const probeSchema = z.object({ nonce: z.string().uuid() }).strict();
export const PROBE_QUEUE = 'system-probe';

export const ownerSessionSchema = z
  .object({
    user: z.object({ id: z.string(), name: z.string() }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'OwnerSession' });
export type OwnerSession = z.infer<typeof ownerSessionSchema>;
