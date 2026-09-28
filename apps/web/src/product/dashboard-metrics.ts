import { formatReportBRL, type ReportMetrics } from '@stakeframe/shared';

/**
 * STK-F2-02 — apresentação do dashboard analítico (ROI, P&L, yield e N juntos).
 *
 * Regras derivadas do Plano §8.5 e do teste §15:
 * - `N` fica visível ao lado de CADA métrica derivada, sempre;
 * - com `lowSample` (N < limiar configurado) só saem números crus e o aviso:
 *   nenhum texto de leitura, comparação ou recomendação;
 * - estado `unknown` nunca vira zero: base nula rende `Sem base`.
 */
export type DashboardCard = {
  key: 'profit' | 'roi' | 'yield' | 'bets' | 'stake' | 'exposure';
  label: string;
  value: string;
  /** Cada linha é renderizada como um elemento próprio (N sempre é uma delas). */
  details: string[];
};

export const percent = (value: string | null) =>
  value === null ? 'Sem base' : value.replace('.', ',') + '%';

export const units = (value: string | null) =>
  value === null
    ? 'Unidades a conferir'
    : `${value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} u`;

export const sampleLabel = (n: number) => `N = ${n} ${n === 1 ? 'aposta' : 'apostas'}`;

export function dashboardCards(input: {
  metrics: ReportMetrics;
  lowSample: boolean;
}): DashboardCard[] {
  const { metrics, lowSample } = input;
  const n = sampleLabel(metrics.bets);
  // Em baixa amostra só números: sem denominadores, definições ou leitura.
  const context = (lines: string[]) => (lowSample ? [] : lines);
  return [
    {
      key: 'profit',
      label: 'P&L realizado',
      value: formatReportBRL(metrics.profit),
      details: [
        ...context([
          `Real ${formatReportBRL(metrics.realProfit)} · Freebets ${formatReportBRL(metrics.freebetProfit)}`,
        ]),
        units(metrics.profitUnits),
        n,
      ],
    },
    {
      key: 'roi',
      label: 'ROI real',
      value: percent(metrics.roiReal),
      details: [
        ...context([
          `Sobre ${formatReportBRL(metrics.realPrincipalClosed)} de principal real liquidado`,
        ]),
        n,
      ],
    },
    {
      key: 'yield',
      label: 'Yield real',
      value: percent(metrics.yieldReal),
      details: [
        ...context([`Sobre ${formatReportBRL(metrics.realStake)} apostados em dinheiro real`]),
        n,
      ],
    },
    {
      key: 'bets',
      label: 'Apostas no período',
      value: String(metrics.bets),
      details: [
        ...context([`${metrics.settledBets} liquidadas · ${metrics.openBets} em aberto`]),
        n,
      ],
    },
    {
      key: 'stake',
      label: 'Valor apostado real',
      value: formatReportBRL(metrics.realStake),
      details: [...context(['Dinheiro real no período']), n],
    },
    {
      key: 'exposure',
      label: 'Exposição atual do período',
      value: formatReportBRL(metrics.exposure),
      details: [...context(['Principal real ainda aberto nas apostas deste filtro']), n],
    },
  ];
}

export function lowSampleNotice(input: { n: number; minSample: number }) {
  const bets = input.n === 1 ? 'aposta' : 'apostas';
  return {
    title: 'Baixa amostra',
    body:
      `N = ${input.n} ${bets}, abaixo do mínimo configurado de ${input.minSample}. ` +
      'Com amostra pequena o painel mostra apenas os números crus do período: ' +
      'sem interpretação, comparação ou conselho.',
  };
}
