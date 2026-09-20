import { z } from 'zod';
import { OPENROUTER_MODELS } from './imports.js';

export const automaticPlacedAtFormatSchema = z.enum([
  'iso-offset',
  'br-sao-paulo',
  'br-textual-sao-paulo',
]);

const policyCoverageSchema = z.strictObject({
  positive: z.number().int().min(20).max(100_000),
  negative: z.number().int().min(5).max(100_000),
  multiples: z.number().int().min(3).max(100_000),
  missingFields: z.number().int().min(3).max(100_000),
  promotional: z.number().int().min(0).max(100_000),
  uniqueImages: z.number().int().min(20).max(100_000),
});

/**
 * Global automatic-import approval. It deliberately contains no bookmaker
 * allow-list: the active organization catalog is the runtime source of
 * bookmaker identity, while this document approves the neutral extraction
 * contract and its evidence for every active house.
 */
export const automaticPolicyV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  requiresUserBookmaker: z.literal(true),
  aiBookmakerClassification: z.literal('disabled'),
  bookmakerScope: z.literal('all-active'),
  model: z.enum(OPENROUTER_MODELS),
  placedAtFormats: z
    .array(automaticPlacedAtFormatSchema)
    .min(1)
    .max(3)
    .refine((formats) => new Set(formats).size === formats.length),
  allowFreebet: z.boolean(),
  potentialReturnLabels: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: policyCoverageSchema,
  sampleCount: z.number().int().min(20).max(100_000),
  essentialFieldErrors: z.literal(0),
  approvedBy: z.literal('owner'),
  approvedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

export type AutomaticPolicyV2 = z.infer<typeof automaticPolicyV2Schema>;

export function automaticPolicyIsCurrent(policy: AutomaticPolicyV2, now = Date.now()) {
  const approvedAt = Date.parse(policy.approvedAt);
  const expiresAt = Date.parse(policy.expiresAt);
  return (
    Number.isFinite(approvedAt) &&
    Number.isFinite(expiresAt) &&
    approvedAt <= now &&
    expiresAt > now &&
    expiresAt > approvedAt
  );
}
