import { z } from 'zod';
import { formatReportBRL, type ReportMetrics } from './reports.js';
import { reportPeriodSchema } from './report-snapshots.js';

// STK-F2-08 — o CONTRATO do que a página HTML privada renderiza.
//
// O snapshot já é a versão congelada e auditável; o contrato abaixo é apenas a
// FORMA como ela chega ao navegador. Ele é deliberadamente magro: um relatório
// é uma PÁGINA, não um app, e tudo o que ela precisa mostrar está aqui.
//
// Três decisões que aparecem no contrato e valem por si:
//
//  - `narrative` separa `fact` de `heuristic`. O usuário consegue distinguir o
//    número que a frase afirma da leitura que o produto faz sobre ele, e a
//    página mostra a origem de cada linha. Narrativa gerada por modelo
//    entraria aqui indistinta — e o card exclui isso.
//  - `immutable` e `contentSha256` viajam no payload. A página diz que o
//    documento é congelado e mostra o hash, para que a auditoria não dependa
//    de alguém acreditar no texto.
//  - NÃO existe `html`, `url`, `token` nem `fileUrl` no contrato. O snapshot
//    é DADO, não endereço: a página é a rota autenticada do produto, e nenhum
//    campo aqui pode virar um link que funcione fora dela (sem URL pública
//    temporária, §4.3).

export const reportSnapshotRefSchema = z
  .strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    period: reportPeriodSchema,
    from: z.iso.date(),
    to: z.iso.date(),
    financialVersion: z.number().int().positive(),
    title: z.string().min(1).max(120),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** `true` quando existe versão posterior: a exibida é a última do período. */
    latest: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    requestedBy: z.string().nullable(),
    revisionReason: z.string().nullable(),
  })
  .meta({ id: 'ReportSnapshotRef' });
export type ReportSnapshotRef = z.infer<typeof reportSnapshotRefSchema>;

/** Métricas do snapshot, no mesmo contrato de sempre (nunca float). */
export const reportSnapshotMetricsSchema = z
  .strictObject({
    bets: z.number().int().nonnegative(),
    settledBets: z.number().int().nonnegative(),
    openBets: z.number().int().nonnegative(),
    realStake: z.string(),
    freebetStake: z.string(),
    realPrincipalClosed: z.string(),
    realReturns: z.string(),
    freebetReturns: z.string(),
    realProfit: z.string(),
    freebetProfit: z.string(),
    profit: z.string(),
    profitUnits: z.string().nullable(),
    knownProfitUnits: z.string(),
    missingUnitBets: z.number().int().nonnegative(),
    exposure: z.string(),
    roiReal: z.string().nullable(),
    yieldReal: z.string().nullable(),
    hitRateReal: z.string().nullable(),
    hitWinsReal: z.number().int().nonnegative(),
    hitEligibleReal: z.number().int().nonnegative(),
  })
  .meta({ id: 'ReportSnapshotMetrics' });

export const reportSnapshotLineSchema = z
  .strictObject({
    kind: z.enum(['fact', 'heuristic']),
    text: z.string().min(1).max(300),
    fact: z.string().max(120).nullable(),
  })
  .meta({ id: 'ReportSnapshotLine' });

export const reportSnapshotSchema = z
  .object({
    snapshot: reportSnapshotRefSchema,
    metrics: reportSnapshotMetricsSchema,
    narrative: z.object({
      lines: z.array(reportSnapshotLineSchema).max(24),
      lowSample: z.boolean(),
      minSample: z.number().int().nonnegative(),
    }),
    /** Uma dimensão de comparação (casa, esporte, tipster) com P&L e N. */
    breakdown: z
      .array(
        z.strictObject({
          id: z.string().max(40),
          label: z.string().max(120),
          labelKey: z.string().max(120),
          bets: z.number().int().nonnegative(),
          profit: z.string(),
          lowSample: z.boolean(),
        }),
      )
      .max(120),
    /** Versões do mesmo período, mais recente primeiro. */
    revisions: z.array(reportSnapshotRefSchema).max(20),
    /** `true` quando a janela não tinha apostas e nada foi publicado. */
    empty: z.boolean(),
  })
  .meta({ id: 'ReportSnapshot' });
export type ReportSnapshotPayload = z.infer<typeof reportSnapshotSchema>;

/** Lista de relatórios do tenant (a aba "histórico" da página). */
export const reportSnapshotListSchema = z
  .object({
    items: z.array(reportSnapshotRefSchema).max(100),
  })
  .meta({ id: 'ReportSnapshotList' });

/** Resposta da revisão sob demanda. */
export const reportRevisionInputSchema = z
  .strictObject({
    reason: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'ReportRevisionRequest' });
export type ReportRevisionInput = z.infer<typeof reportRevisionInputSchema>;

/**
 * Os QUATRO blocos de número que a página mostra, na ordem em que o usuário
 * precisa deles. Cada um é derivado das métricas do snapshot — nenhuma consulta,
 * nenhum número inventado. É o mesmo conjunto que o `/hoje` da F2-07 diz no
 * chat, o que evita a divergência "no Telegram diz X, na página diz Y".
 */
export function reportHeadline(metrics: ReportMetrics): {
  label: string;
  value: string;
  detail: string;
  tone: 'positive' | 'negative' | 'neutral';
}[] {
  const percent = (value: string | null) =>
    value === null ? 'Sem base' : `${value.replace('.', ',')}%`;
  const profit = BigInt(metrics.profit.replace('.', ''));
  return [
    {
      label: 'Resultado',
      value: formatReportBRL(metrics.profit),
      detail: `${metrics.settledBets} liquidadas · ${metrics.openBets} abertas`,
      tone: profit > 0n ? 'positive' : profit < 0n ? 'negative' : 'neutral',
    },
    {
      label: 'ROI real',
      value: percent(metrics.roiReal),
      detail: `principal real ${formatReportBRL(metrics.realPrincipalClosed)}`,
      tone: 'neutral',
    },
    {
      label: 'Yield real',
      value: percent(metrics.yieldReal),
      detail: `retornos ${formatReportBRL(metrics.realReturns)}`,
      tone: 'neutral',
    },
    {
      label: 'Exposição aberta',
      value: formatReportBRL(metrics.exposure),
      detail: `${metrics.bets} ${metrics.bets === 1 ? 'aposta' : 'apostas'} no período`,
      tone: 'neutral',
    },
  ];
}
