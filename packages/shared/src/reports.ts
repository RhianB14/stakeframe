import { z } from 'zod';
import { pageQuerySchema } from './finance.js';

// Aggregates can exceed a single permitted money movement. Keep their exact
// decimal representation instead of imposing the transaction amount ceiling.
export const reportMoneySchema = z.string().regex(/^-?(0|[1-9]\d{0,29})\.\d{2}$/);
export const reportUnitsSchema = z.string().regex(/^-?(0|[1-9]\d{0,29})\.\d{6}$/);
const count = z.number().int().nonnegative();
const percent = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,29})\.\d{2}$/)
  .nullable();
export const reportQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  bookmakerId: z.uuid().optional(),
  tipsterId: z.union([z.uuid(), z.literal('none')]).optional(),
  sport: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['all', 'real', 'freebet']).default('all'),
  state: z.enum(['open', 'settled']).optional(),
  includeEstimated: z.enum(['true', 'false']).default('false'),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export const reportDetailQuerySchema = reportQuerySchema.extend(pageQuerySchema.shape);
export type ReportDetailQuery = z.infer<typeof reportDetailQuerySchema>;
export const reportMetricsSchema = z.object({
  bets: count,
  settledBets: count,
  openBets: count,
  realStake: reportMoneySchema,
  freebetStake: reportMoneySchema,
  realPrincipalClosed: reportMoneySchema,
  realReturns: reportMoneySchema,
  freebetReturns: reportMoneySchema,
  realProfit: reportMoneySchema,
  freebetProfit: reportMoneySchema,
  profit: reportMoneySchema,
  profitUnits: reportUnitsSchema.nullable(),
  knownProfitUnits: reportUnitsSchema,
  missingUnitBets: count,
  exposure: reportMoneySchema,
  roiReal: percent,
  hitRateReal: percent,
  hitWinsReal: count,
  hitEligibleReal: count,
});
export type ReportMetrics = z.infer<typeof reportMetricsSchema>;
export const reportBucketSchema = z.object({ date: z.iso.date(), metrics: reportMetricsSchema });
export const reportBreakdownSchema = z.object({
  key: z.string(),
  label: z.string(),
  metrics: reportMetricsSchema,
});
export type ReportBreakdown = z.infer<typeof reportBreakdownSchema>;
export const reportSchema = z
  .object({
    generatedAt: z.iso.datetime({ offset: true }),
    version: z.number().int().positive(),
    filters: reportQuerySchema,
    dateBasis: z.literal('last_event_sao_paulo'),
    granularity: z.enum(['day', 'month']),
    metrics: reportMetricsSchema,
    previous: z.object({ from: z.iso.date(), to: z.iso.date(), metrics: reportMetricsSchema }),
    exclusions: z.object({ unknownDateBets: count, estimatedDateBets: count }),
    timeline: z.array(reportBucketSchema),
    byBookmaker: z.array(reportBreakdownSchema),
    byTipster: z.array(reportBreakdownSchema),
    bySport: z.array(reportBreakdownSchema),
  })
  .meta({ id: 'PerformanceReport' });
export type PerformanceReport = z.infer<typeof reportSchema>;
export const reportBetSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  eventSummary: z.string(),
  eventDate: z.iso.date(),
  dateStatus: z.enum(['confirmed', 'estimated']),
  bookmakerId: z.uuid(),
  bookmaker: z.string(),
  tipsterId: z.uuid().nullable(),
  tipster: z.string(),
  sportKey: z.string(),
  sport: z.string(),
  state: z.enum(['open', 'settled']),
  freebet: z.boolean(),
  stake: reportMoneySchema,
  remaining: reportMoneySchema,
  returns: reportMoneySchema,
  profit: reportMoneySchema,
  profitUnits: reportUnitsSchema.nullable(),
  placedAt: z.iso.datetime({ offset: true }),
});
export const reportBetPageSchema = z
  .object({
    items: z.array(reportBetSchema),
    total: count,
    page: count,
    pageSize: count,
  })
  .meta({ id: 'PerformanceBetPage' });
export const reportOptionsSchema = z
  .object({
    sports: z.array(z.object({ key: z.string(), label: z.string() })),
  })
  .meta({ id: 'ReportOptions' });
export function formatReportBRL(value: string) {
  reportMoneySchema.parse(value);
  const [whole = '0', fraction = '00'] = value.replace(/^-/, '').split('.');
  return `${value.startsWith('-') ? '−' : ''}R$ ${BigInt(whole).toLocaleString('pt-BR')},${fraction}`;
}
