import { z } from 'zod';
import { pageQuerySchema, selectionInputSchema } from './finance.js';

export const eventProviderSchema = z.enum(['thesportsdb', 'tavily']);
export type EventProvider = z.infer<typeof eventProviderSchema>;
export const eventCandidateSchema = z.object({
  id: z.uuid(),
  provider: eventProviderSchema,
  title: z.string().max(300),
  url: z.url({ protocol: /^https$/ }).max(2000),
  excerpt: z.string().max(3000),
  rawDate: z.string().max(100).nullable(),
  rawTime: z.string().max(100).nullable(),
  suggestedAt: z.iso.datetime({ offset: true }).nullable(),
  postponed: z.boolean(),
});
export type EventCandidate = z.infer<typeof eventCandidateSchema>;
export const calendarQuerySchema = pageQuerySchema.extend({
  from: z.iso.date(),
  to: z.iso.date(),
  view: z.enum(['scheduled', 'pending']).default('scheduled'),
  betState: z.enum(['open', 'settled', 'cancelled']).optional(),
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
export const calendarItemSchema = z.object({
  selection: selectionInputSchema.extend({ id: z.uuid() }),
  betId: z.uuid(),
  betReference: z.string(),
  bookmaker: z.string(),
  betState: z.enum(['open', 'settled', 'cancelled']),
  dateSource: z.enum(['manual', 'thesportsdb', 'tavily']),
  dateEvidence: eventCandidateSchema.nullable(),
  scheduleStatus: z.enum(['scheduled', 'postponed', 'cancelled']),
});
export type CalendarItem = z.infer<typeof calendarItemSchema>;
export const calendarPageSchema = z
  .object({
    items: z.array(calendarItemSchema),
    total: z.number().int().nonnegative(),
    distinctBets: z.number().int().nonnegative(),
    pendingSelections: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'CalendarPage' });
export const eventSearchInputSchema = z.strictObject({
  selectionId: z.uuid(),
  provider: eventProviderSchema,
  dateHint: z.iso.date().nullable(),
  refresh: z.boolean().optional(),
});
export type EventSearchInput = z.infer<typeof eventSearchInputSchema>;
export const eventSearchSchema = z
  .object({
    id: z.uuid(),
    selectionId: z.uuid(),
    provider: eventProviderSchema,
    query: z.string(),
    dateHint: z.iso.date().nullable(),
    state: z.enum(['pending', 'processing', 'complete', 'failed']),
    candidates: z.array(eventCandidateSchema).max(5),
    errorCode: z.string().nullable(),
    cached: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'EventSearch' });
export type EventSearch = z.infer<typeof eventSearchSchema>;
export const eventSearchStatusSchema = z
  .object({
    providers: z.array(
      z.object({
        provider: eventProviderSchema,
        enabled: z.boolean(),
        dailyUsed: z.number().int().nonnegative(),
        dailyLimit: z.number().int().positive(),
        monthlyUsed: z.number().int().nonnegative(),
        monthlyLimit: z.number().int().positive(),
      }),
    ),
  })
  .meta({ id: 'EventSearchStatus' });
