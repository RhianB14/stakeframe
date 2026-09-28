import {
  formatReportBRL,
  type AnalyticsSplitDimension,
  type AnalyticsSplitRow,
} from '@stakeframe/shared';
import { percent, sampleLabel } from './dashboard-metrics.js';

/**
 * STK-F2-03 — apresentação de um split: ROI, P&L, yield e `N` juntos em cada
 * linha, na mesma regra do dashboard (Plano §8.5, teste §15):
 * - `N` aparece sempre, ao lado das métricas derivadas;
 * - base nula fica `Sem base`, nunca zero (unknown preservado);
 * - com `lowSample` a linha só carrega números crus e a marca de aviso.
 */
export type SplitRowView = {
  key: string;
  label: string;
  profit: string;
  roi: string;
  yieldReal: string;
  n: string;
  negative: boolean;
  lowSample: boolean;
};

export function splitRowView(row: AnalyticsSplitRow): SplitRowView {
  return {
    key: row.key,
    label: row.label,
    profit: formatReportBRL(row.metrics.profit),
    roi: percent(row.metrics.roiReal),
    yieldReal: percent(row.metrics.yieldReal),
    n: sampleLabel(row.metrics.bets),
    negative: row.metrics.profit.startsWith('-'),
    lowSample: row.lowSample,
  };
}

export const splitRowViews = (dimension: AnalyticsSplitDimension) =>
  dimension.rows.map(splitRowView);

/** Aviso de baixa amostra por split: `null` quando toda linha está no limiar. */
export function splitNotice(input: { dimension: AnalyticsSplitDimension; minSample: number }) {
  const low = input.dimension.rows.filter((row) => row.lowSample).length;
  if (low === 0) return null;
  const lines = input.dimension.rows.length;
  return {
    title: 'Baixa amostra',
    body:
      `${low} de ${lines} ${lines === 1 ? 'linha' : 'linhas'} com N abaixo de ` +
      `${input.minSample} ${input.minSample === 1 ? 'aposta' : 'apostas'} nesta dimensão: ` +
      'apenas números crus, sem interpretação, comparação ou conselho.',
  };
}
