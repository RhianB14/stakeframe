import { describe, expect, it } from 'vitest';
import {
  analyticsDashboardSchema,
  reportMetricsSchema,
  type ReportMetrics,
} from '../../packages/shared/src/index.js';
import { dashboardCards, lowSampleNotice } from '../../apps/web/src/product/dashboard-metrics.js';

const metrics = (over: Partial<ReportMetrics> = {}): ReportMetrics =>
  reportMetricsSchema.parse({
    bets: 8,
    settledBets: 6,
    openBets: 2,
    realStake: '800.00',
    freebetStake: '100.00',
    realPrincipalClosed: '700.00',
    realReturns: '900.00',
    freebetReturns: '100.00',
    realProfit: '100.00',
    freebetProfit: '0.00',
    profit: '100.00',
    profitUnits: '10.000000',
    knownProfitUnits: '10.000000',
    missingUnitBets: 0,
    exposure: '100.00',
    roiReal: '14.29',
    yieldReal: '12.50',
    hitRateReal: '83.33',
    hitWinsReal: 5,
    hitEligibleReal: 6,
    ...over,
  });

// §15 — "Nenhuma recomendação enganosa em baixa amostra": nenhuma palavra de
// recomendação, leitura de desempenho ou conselho pode chegar à interface.
const ADVISORY = [
  /recomend/i,
  /considere/i,
  /sugest/i,
  /sugira/i,
  /tendência/i,
  /desempenho/i,
  /melhor/i,
  /pior/i,
  /excelente/i,
  /acima da média/i,
  /abaixo da média/i,
  /aposte mais/i,
  /pare de/i,
];
// Em baixa amostra só números crus, o estado `unknown` e o próprio aviso.
const RAW_LINE = /^(?:Unidades a conferir|N = \d+ aposta?s?|\d+(?:\.\d{3})*(?:,\d+)? u)$/;

describe('dashboard cards (STK-F2-02)', () => {
  it('exibe ROI, P&L, yield e N juntos, com N ao lado de cada métrica', () => {
    const cards = dashboardCards({ metrics: metrics({ bets: 42 }), lowSample: false });
    expect(cards.map((card) => card.key)).toEqual([
      'profit',
      'roi',
      'yield',
      'bets',
      'stake',
      'exposure',
    ]);
    expect(cards.find((card) => card.key === 'profit')?.value).toBe('R$ 100,00');
    expect(cards.find((card) => card.key === 'roi')?.value).toBe('14,29%');
    expect(cards.find((card) => card.key === 'yield')?.value).toBe('12,50%');
    expect(cards.find((card) => card.key === 'bets')?.value).toBe('42');
    for (const card of cards) expect(card.details).toContain('N = 42 apostas');
    const singular = dashboardCards({ metrics: metrics({ bets: 1 }), lowSample: true });
    for (const card of singular) expect(card.details).toContain('N = 1 aposta');
  });

  it('preserva unknown: base nula vira "Sem base" e nunca zero', () => {
    const cards = dashboardCards({
      metrics: metrics({ roiReal: null, yieldReal: null, profitUnits: null }),
      lowSample: false,
    });
    expect(cards.find((card) => card.key === 'roi')?.value).toBe('Sem base');
    expect(cards.find((card) => card.key === 'yield')?.value).toBe('Sem base');
    expect(cards.map((card) => card.value).join(' ')).not.toContain('0,00%');
    expect(cards.find((card) => card.key === 'profit')?.details).toContain('Unidades a conferir');
  });

  it('com N abaixo do limiar mostra apenas números crus ao lado do aviso', () => {
    const low = dashboardCards({ metrics: metrics({ bets: 8 }), lowSample: true });
    for (const card of low) for (const line of card.details) expect(line).toMatch(RAW_LINE);
    const notice = lowSampleNotice({ n: 8, minSample: 30 });
    expect(notice.title).toBe('Baixa amostra');
    expect(notice.body).toContain('N = 8 apostas');
    expect(notice.body).toContain('mínimo configurado de 30');
  });

  it('§15 — nenhuma recomendação enganosa em baixa amostra', () => {
    const cards = dashboardCards({
      metrics: metrics({ bets: 3, roiReal: null, yieldReal: null, profitUnits: null }),
      lowSample: true,
    });
    const notice = lowSampleNotice({ n: 3, minSample: 30 });
    const surface = [
      notice.title,
      notice.body,
      ...cards.flatMap((card) => [card.label, card.value, ...card.details]),
    ].join(' \n ');
    for (const pattern of ADVISORY) expect(surface).not.toMatch(pattern);
    // Amostra pequena: nenhuma linha de detalhe interpretativa — só N e números.
    for (const card of cards) for (const line of card.details) expect(line).toMatch(RAW_LINE);
    // O aviso é obrigatório e informativo, nunca um conselho de ação.
    expect(notice.body).toMatch(/^N = \d+ apostas?, abaixo do mínimo configurado de \d+\./);
  });

  it('com N >= limiar o painel volta a contextualizar sem virar recomendação', () => {
    const cards = dashboardCards({ metrics: metrics({ bets: 30 }), lowSample: false });
    const surface = cards.flatMap((card) => [card.label, card.value, ...card.details]).join(' \n ');
    for (const pattern of ADVISORY) expect(surface).not.toMatch(pattern);
    for (const card of cards) expect(card.details).toContain('N = 30 apostas');
    expect(cards.find((card) => card.key === 'roi')?.details.join(' ')).toContain(
      'principal real liquidado',
    );
  });
});

describe('dashboard payload (STK-F2-02)', () => {
  it('só expõe números, filtros e flags — sem campo narrativo', () => {
    const payload = analyticsDashboardSchema.parse({
      generatedAt: '2026-09-07T00:00:00.000Z',
      version: 4,
      filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
      minSample: 30,
      lowSample: true,
      metrics: metrics({ bets: 2 }),
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['filters', 'generatedAt', 'lowSample', 'metrics', 'minSample', 'version'].sort(),
    );
    expect(payload.lowSample).toBe(true);
    expect(payload.minSample).toBe(30);
    expect(payload.metrics).toMatchObject({ bets: 2, roiReal: '14.29', yieldReal: '12.50' });
    expect(payload.metrics.bets).toBeLessThan(payload.minSample);
    // unknown não é normalizado para zero pelo cliente nem pelo schema.
    const unknown = analyticsDashboardSchema.parse({
      ...payload,
      metrics: metrics({ roiReal: null }),
    });
    expect(unknown.metrics.roiReal).toBeNull();
  });
});
