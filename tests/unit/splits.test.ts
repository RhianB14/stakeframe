import { describe, expect, it } from 'vitest';
import {
  analyticsSplitsSchema,
  reportMetricsSchema,
  type AnalyticsSplitDimension,
  type AnalyticsSplitRow,
  type ReportMetrics,
} from '../../packages/shared/src/index.js';
import {
  splitNotice,
  splitRowView,
  splitRowViews,
} from '../../apps/web/src/product/splits-metrics.js';

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

const row = (over: Partial<AnalyticsSplitRow> = {}): AnalyticsSplitRow => ({
  key: 'sport:futebol',
  label: 'Futebol',
  lowSample: false,
  metrics: metrics(),
  ...over,
});

const dimension = (rows: AnalyticsSplitRow[]): AnalyticsSplitDimension => ({
  id: 'sport',
  label: 'Esporte',
  source: 'finance.selection.sport',
  available: true,
  note: null,
  rows,
});

// §15 — nenhuma palavra de recomendação, leitura de desempenho ou conselho
// pode chegar à interface dos splits.
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
// Em baixa amostra só números crus e o estado `unknown` nas células.
const RAW_CELL = /^(?:Sem base|[−-]?R\$ [\d.]+,\d{2}|[−-]?\d+,\d{2}%|N = \d+ aposta?s?)$/;

describe('splits (STK-F2-03)', () => {
  it('exibe ROI, P&L, yield e N juntos em cada linha', () => {
    const views = splitRowViews(dimension([row()]));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      key: 'sport:futebol',
      label: 'Futebol',
      profit: 'R$ 100,00',
      roi: '14,29%',
      yieldReal: '12,50%',
      n: 'N = 8 apostas',
      negative: false,
    });
    expect(splitRowView(row({ metrics: metrics({ bets: 1 }) })).n).toBe('N = 1 aposta');
    expect(splitRowView(row({ metrics: metrics({ profit: '-25.00' }) })).negative).toBe(true);
  });

  it('preserva unknown: base nula vira "Sem base" e nunca zero', () => {
    const views = splitRowViews(
      dimension([
        row({
          key: 'sport:basquete',
          label: 'Basquete',
          metrics: metrics({ roiReal: null, yieldReal: null }),
        }),
        row({ key: 'unknown', label: 'Sem base' }),
      ]),
    );
    expect(views[0]).toMatchObject({ roi: 'Sem base', yieldReal: 'Sem base' });
    expect(views.map((view) => `${view.roi} ${view.yieldReal}`).join(' ')).not.toContain('0,00%');
  });

  it('marca aviso de baixa amostra por split, linha a linha', () => {
    const low = dimension([
      row({ metrics: metrics({ bets: 2 }), lowSample: true }),
      row({ key: 'unknown', label: 'Sem base', metrics: metrics({ bets: 6 }) }),
    ]);
    const notice = splitNotice({ dimension: low, minSample: 30 });
    expect(notice?.title).toBe('Baixa amostra');
    expect(notice?.body).toContain('1 de 2 linhas');
    expect(notice?.body).toContain('abaixo de 30 apostas');
    expect(splitRowViews(low).map((view) => view.lowSample)).toEqual([true, false]);
    // N igual ao limiar não gera aviso (mesma regra da F2-02).
    expect(splitNotice({ dimension: dimension([row()]), minSample: 8 })).toBeNull();
  });

  it('§15 — nenhuma recomendação enganosa em baixa amostra', () => {
    const rows = [
      row({
        metrics: metrics({ bets: 2, roiReal: null, yieldReal: null, profit: '-25.00' }),
        lowSample: true,
      }),
      row({
        key: 'unknown',
        label: 'Sem base',
        metrics: metrics({ bets: 1, roiReal: null, yieldReal: null }),
        lowSample: true,
      }),
    ];
    const dim = dimension(rows);
    const notice = splitNotice({ dimension: dim, minSample: 30 })!;
    const views = splitRowViews(dim);
    const surface = [
      notice.title,
      notice.body,
      dim.label,
      ...views.flatMap((view) => [view.label, view.profit, view.roi, view.yieldReal, view.n]),
    ].join(' \n ');
    for (const pattern of ADVISORY) expect(surface).not.toMatch(pattern);
    // Em baixa amostra as células são só números, N ou estado `unknown`.
    for (const view of views)
      for (const cell of [view.profit, view.roi, view.yieldReal, view.n])
        expect(cell).toMatch(RAW_CELL);
    expect(notice.body).toMatch(/^2 de 2 linhas com N abaixo de \d+ apostas?/);
  });

  it('payload só expõe números, filtros, origem e flags — sem campo narrativo', () => {
    const payload = analyticsSplitsSchema.parse({
      generatedAt: '2026-09-07T00:00:00.000Z',
      version: 4,
      filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
      minSample: 30,
      lowSample: true,
      metrics: metrics({ bets: 2 }),
      dimensions: [
        {
          id: 'team',
          label: 'Time',
          source: 'unavailable',
          available: false,
          note: 'Coluna inexistente no modelo atual.',
          rows: [row({ key: 'unknown', label: 'Sem base', lowSample: true })],
        },
      ],
    });
    expect(Object.keys(payload).sort()).toEqual(
      [
        'dimensions',
        'filters',
        'generatedAt',
        'lowSample',
        'metrics',
        'minSample',
        'version',
      ].sort(),
    );
    expect(payload.dimensions[0]).toMatchObject({
      id: 'team',
      available: false,
      source: 'unavailable',
    });
    expect(payload.dimensions[0]!.rows[0]).toMatchObject({ key: 'unknown', lowSample: true });
    expect(payload.metrics.bets).toBeLessThan(payload.minSample);
    // unknown não é normalizado para zero pelo cliente nem pelo schema.
    const unknown = analyticsSplitsSchema.parse({
      ...payload,
      metrics: metrics({ roiReal: null }),
    });
    expect(unknown.metrics.roiReal).toBeNull();
    expect(unknown.dimensions[0]!.rows[0]!.metrics.roiReal).toBe('14.29');
  });
});
