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
 * Bookmaker slugs a policy can name. The active organization catalog still
 * owns bookmaker identity at runtime; these slugs only declare which houses
 * carry homologated evidence (approved) and which are explicitly held back
 * (pending) from automatic import.
 */
export const automaticBookmakerSchema = z.enum(['bet365', 'superbet', 'novibet']);
export type AutomaticBookmaker = z.infer<typeof automaticBookmakerSchema>;

/**
 * Legacy global approval (schemaVersion 2). It deliberately contains no
 * bookmaker allow-list: it approved every active house at once. It is kept
 * only so the loader and the checker can refuse it explicitly — an approval
 * that cannot represent a pending house must never authorize automation.
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

/**
 * Explicit-bookmaker approval (schemaVersion 3). The owner approves named
 * houses backed by homologated corpus evidence; every other house — including
 * the ones listed as pending with a reason — stays fail-closed in manual
 * review. Evidence fields aggregate only the approved houses' corpora; a
 * pending house never contributes to the approved totals.
 */
export const automaticPolicyV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    requiresUserBookmaker: z.literal(true),
    aiBookmakerClassification: z.literal('disabled'),
    bookmakerScope: z.literal('explicit'),
    bookmakers: z.strictObject({
      approved: z.array(automaticBookmakerSchema).min(1).max(3),
      pending: z
        .array(
          z.strictObject({
            bookmaker: automaticBookmakerSchema,
            reason: z.string().trim().min(1).max(240),
          }),
        )
        .max(3),
    }),
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
  })
  .superRefine((policy, ctx) => {
    const approved = policy.bookmakers.approved;
    if (new Set(approved).size !== approved.length)
      ctx.addIssue({
        code: 'custom',
        message: 'POLICY_APPROVED_DUPLICATE',
        path: ['bookmakers', 'approved'],
      });
    const pending = policy.bookmakers.pending.map((entry) => entry.bookmaker);
    if (new Set(pending).size !== pending.length)
      ctx.addIssue({
        code: 'custom',
        message: 'POLICY_PENDING_DUPLICATE',
        path: ['bookmakers', 'pending'],
      });
    if (approved.some((bookmaker) => pending.includes(bookmaker)))
      ctx.addIssue({
        code: 'custom',
        message: 'POLICY_BOOKMAKER_STATUS_CONFLICT',
        path: ['bookmakers'],
      });
  });

export type AutomaticPolicyV3 = z.infer<typeof automaticPolicyV3Schema>;

export function automaticPolicyIsCurrent(
  policy: { approvedAt: string; expiresAt: string },
  now = Date.now(),
) {
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
