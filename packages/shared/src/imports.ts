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

export const OPENROUTER_MODELS = [
  'google/gemini-3.8-flash',
  'qwen/qwen3-vl-32b-instruct',
  'deepseek/deepseek-v4-flash-vision-exp',
] as const;
export const OPENROUTER_MODEL = OPENROUTER_MODELS[0];
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
  'FREEBET_CONFLICT',
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
  // Rastreio da casa: o bookmaker aplicado vem do contexto informado pelo
  // usuário ('context'); a classificação visual fica registrada à parte como
  // evidência do modelo, nunca como fonte de verdade.
  bookmakerOrigin: z.literal('context').nullable().optional(),
  visualLayoutId: z.string().max(200).nullable().optional(),
});
export const validatedLayoutSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  bookmaker: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  bookmakerId: z.uuid(),
  model: z.enum(OPENROUTER_MODELS),
  description: z.string().trim().min(20).max(1000),
  placedAtFormat: z.enum(['iso-offset', 'br-sao-paulo', 'br-textual-sao-paulo']),
  allowFreebet: z.boolean(),
  // Rótulos autorizados para potentialReturn — parte do digest da política por
  // casa (ex.: Bet365: ["Retorno Total"]; Superbet: ["Prêmio", "Ganho
  // Potencial"]). Opcional para políticas antigas; políticas novas declaram.
  potentialReturnLabels: z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional(),
  layoutSha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.strictObject({
    positive: z.number().int().min(20).max(10000),
    negative: z.number().int().min(5).max(10000),
    multiples: z.number().int().min(3).max(10000),
    missingFields: z.number().int().min(3).max(10000),
    promotional: z.number().int().min(0).max(10000),
    uniqueImages: z.number().int().min(20).max(10000),
  }),
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleCount: z.number().int().min(20).max(10000),
  essentialFieldErrors: z.literal(0),
  approvedBy: z.literal('owner'),
  approvedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
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
      // Tipo da aposta informado na terceira linha da legenda (contexto
      // confiável); null mantém o item em revisão manual.
      kind: z.enum(['real', 'freebet']).nullable(),
      // Quarta linha opcional da legenda (DD/MM/AAAA HH:mm).
      date: z.string().nullable(),
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
  model: z.enum(OPENROUTER_MODELS),
  provider: z.string().min(1).max(200).optional(),
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
  const third = (lines[2] ?? '').toLocaleLowerCase('pt-BR');
  const fourth = lines[3] ?? '';
  const date = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(fourth) ? fourth : null;
  // Contexto explícito e fail-closed: tipster + casa + tipo (real|freebet) e,
  // opcionalmente, a data da aposta em DD/MM/AAAA HH:mm (obrigatória para a
  // automação quando a imagem não traz data parseável). O legado de duas
  // linhas e qualquer valor ausente, desconhecido ou ambíguo ficam em revisão
  // manual e nunca autorizam importação automática.
  return {
    tipster: lines[0] || null,
    bookmaker: lines[1] || null,
    kind: third === 'real' || third === 'freebet' ? (third as 'real' | 'freebet') : null,
    date,
    requiresReview:
      (lines.length !== 3 && lines.length !== 4) ||
      lines.some((line) => !line || line.length > 100) ||
      (third !== 'real' && third !== 'freebet') ||
      (lines.length === 4 && date === null),
  };
}
