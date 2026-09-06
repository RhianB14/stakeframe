import { z } from 'zod';

export const systemStatusSchema = z.object({
  name: z.literal('Stakeframe'),
  stage: z.literal('local-setup'),
  database: z.enum(['available', 'unavailable']),
  authentication: z.literal('not-configured'),
  productEnabled: z.literal(false),
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().uuid() }),
});

export const probeSchema = z.object({ nonce: z.string().uuid() }).strict();
export const PROBE_QUEUE = 'system-probe';
