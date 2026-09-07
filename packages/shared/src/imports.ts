import { z } from 'zod';
import { pageQuerySchema } from './finance.js';

export const importStateSchema = z.enum([
  'pending',
  'processing',
  'review',
  'failed',
  'discarded',
  'imported',
]);
export const importItemSchema = z.object({
  id: z.uuid(),
  source: z.enum(['web', 'telegram']),
  caption: z.string(),
  state: importStateSchema,
  version: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  errorCode: z.string().nullable(),
  betId: z.uuid().nullable(),
  imageAvailable: z.boolean(),
});
export const importQuerySchema = pageQuerySchema.extend({
  state: importStateSchema.optional(),
  betId: z.uuid().optional(),
});
export const importPageSchema = z
  .object({
    items: z.array(importItemSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'ImportPage' });
export const uploadSchema = z.strictObject({
  image: z
    .string()
    .min(4)
    .max(11_184_812)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  caption: z.string().max(1024),
});
export const uploadResultSchema = z.object({ id: z.uuid() }).meta({ id: 'UploadResult' });

export const OPENROUTER_MODEL = 'google/gemini-3.8-flash' as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const text = z.string().min(1).max(500);
const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/);

// Extraction is evidence for review, never authority to create a financial entry.
export const ticketExtractionSchema = z.strictObject({
  bookmaker: text.nullable(),
  reference: text.nullable(),
  placedAtText: text.nullable(),
  currency: z.enum(['BRL']).nullable(),
  stake: decimal.nullable(),
  odds: decimal.nullable(),
  potentialReturn: decimal.nullable(),
  freebet: z.boolean().nullable(),
  selections: z
    .array(
      z.strictObject({
        event: text.nullable(),
        sport: text.nullable(),
        market: text.nullable(),
        selection: text.nullable(),
        odds: decimal.nullable(),
        eventDateText: text.nullable(),
      }),
    )
    .min(1)
    .max(40),
  warnings: z.array(text).max(20),
});
export type TicketExtraction = z.infer<typeof ticketExtractionSchema>;
export const automaticReasonSchema = z.enum([
  'IMPORTED',
  'LAYOUT_NOT_VALIDATED',
  'EXTRACTION_UNCERTAIN',
  'CAPTION_UNRESOLVED',
  'BOOKMAKER_CONFLICT',
  'PLACED_AT_UNCERTAIN',
  'FREEBET_UNRESOLVED',
  'RETURN_MISMATCH',
  'UNIT_REQUIRED',
  'DUPLICATE_REVIEW_REQUIRED',
  'FINANCIAL_REVIEW_REQUIRED',
]);
export type AutomaticReason = z.infer<typeof automaticReasonSchema>;
export const automaticDecisionSchema = z.strictObject({
  reason: automaticReasonSchema,
  policyId: z.string().nullable(),
  policyDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export const validatedLayoutSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  bookmakerId: z.uuid(),
  model: z.literal(OPENROUTER_MODEL),
  description: z.string().trim().min(20).max(1000),
  placedAtFormat: z.enum(['iso-offset', 'br-sao-paulo']),
  allowFreebet: z.boolean(),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleCount: z.number().int().min(20).max(10000),
  essentialFieldErrors: z.literal(0),
  approvedBy: z.literal('owner'),
  approvedAt: z.iso.datetime({ offset: true }),
});
export const validatedLayoutsSchema = z
  .array(validatedLayoutSchema)
  .max(5)
  .refine((layouts) => new Set(layouts.map((layout) => layout.id)).size === layouts.length);
export type ValidatedLayout = z.infer<typeof validatedLayoutSchema>;
export const layoutExtractionSchema = z.strictObject({
  layoutId: z.string().nullable(),
  extraction: ticketExtractionSchema,
});
export const layoutExtractionJsonSchema = z.toJSONSchema(layoutExtractionSchema);
export const duplicateSchema = z.object({
  betId: z.uuid(),
  reference: z.string(),
  bookmakerId: z.uuid(),
  stake: z.string(),
  placedAt: z.iso.datetime({ offset: true }),
  reasons: z.array(z.enum(['image', 'reference', 'similar'])),
});
export const importDetailSchema = z
  .object({
    item: importItemSchema,
    extraction: ticketExtractionSchema.nullable(),
    labels: z.object({
      tipster: z.string().nullable(),
      bookmaker: z.string().nullable(),
      requiresReview: z.boolean(),
    }),
    matches: z.object({
      tipsterId: z.uuid().nullable(),
      captionBookmakerId: z.uuid().nullable(),
      extractedBookmakerId: z.uuid().nullable(),
      conflict: z.boolean(),
    }),
    duplicates: z.array(duplicateSchema),
    duplicateCount: z.number().int().nonnegative(),
    automatic: z.boolean(),
    automaticReason: automaticReasonSchema,
  })
  .meta({ id: 'ImportDetail' });
export type ImportDetail = z.infer<typeof importDetailSchema>;
export const ticketExtractionJsonSchema = z.toJSONSchema(ticketExtractionSchema);

export const completionSchema = z.object({
  id: z.string().min(1).max(200),
  model: z.literal(OPENROUTER_MODEL),
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({ content: z.string().min(1).max(65_536), refusal: z.null().optional() }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});

const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const telegramFileSchema = z.object({
  file_id: z.string().min(1).max(512),
  file_unique_id: z.string().min(1).max(512),
  file_size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const telegramUpdateIdSchema = z.object({
  update_id: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
export const telegramMessageSchema = telegramUpdateIdSchema.extend({
  message: z.object({
    message_id: telegramId,
    date: telegramId,
    from: z.object({ id: telegramId, is_bot: z.literal(false) }),
    chat: z.object({ id: telegramId, type: z.literal('private') }),
    sender_chat: z.never().optional(),
    business_connection_id: z.never().optional(),
    via_bot: z.never().optional(),
    forward_origin: z.never().optional(),
    caption: z.string().max(1024).optional(),
    photo: z.array(telegramFileSchema).min(1).max(20).optional(),
    document: z
      .object({
        file_id: z.string().min(1).max(512),
        file_unique_id: z.string().min(1).max(512),
        file_size: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
        mime_type: z.enum(['image/png', 'image/jpeg']),
      })
      .optional(),
  }),
});

export function parseCaption(caption: string) {
  const lines = caption
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());
  return {
    tipster: lines[0] || null,
    bookmaker: lines[1] || null,
    requiresReview: lines.length !== 2 || lines.some((line) => !line || line.length > 100),
  };
}
