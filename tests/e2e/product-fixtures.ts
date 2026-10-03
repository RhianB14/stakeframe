/* O caminho é RELATIVO e não o alias `@stakeframe/shared`: os testes do E2E
   são transformados pelo Playwright sem o `tsconfig` do workspace, e o alias
   resolveria para o pacote ainda não compilado. */
import {
  saoPauloDate,
  type Workspace,
  type Bet,
  type ReportMetrics,
  type PerformanceReport,
} from '../../packages/shared/src/index.js';
import type { Page } from '@playwright/test';

/**
 * STK-F3-03 — a casca de produto pronta, extraída de `product.test.ts`.
 *
 * Era função privada daquele arquivo. O STK-F3-03 precisa da MESMA casca
 * (status, `/me`, onboarding, workspace) para chegar ao painel do mês, e a
 * alternativa — copiar as 10 rotas para `chart-overview.test.ts` — já falhou
 * uma vez: sem o status e o `/me`, o teste rodava verde sem ver o painel.
 *
 * Por que um módulo e não só `export` em `product.test.ts`: importar de um
 * arquivo que declara `test()` faz o Playwright EXECUTAR os testes dele de
 * novo. Com o import direto, `npx playwright test chart-overview.test.ts`
 * rodava os 86 testes de `product.test.ts` junto (96 num comando que deveria
 * rodar 10). Aqui não há `test()`, e o custo desaparece.
 *
 * `product.test.ts` importa daqui — uma fonte só, para os dois arquivos não
 * divergirem no primeiro fixture editado.
 */

export const house = '10000000-0000-4000-8000-000000000001';
export const reserve = '10000000-0000-4000-8000-000000000002';
export const houseAccount = '10000000-0000-4000-8000-000000000003';
export const betId = '10000000-0000-4000-8000-000000000004';

export const emptyMetrics: ReportMetrics = {
  bets: 0,
  settledBets: 0,
  openBets: 0,
  realStake: '0.00',
  freebetStake: '0.00',
  realPrincipalClosed: '0.00',
  realReturns: '0.00',
  freebetReturns: '0.00',
  realProfit: '0.00',
  freebetProfit: '0.00',
  profit: '0.00',
  profitUnits: '0.000000',
  knownProfitUnits: '0.000000',
  missingUnitBets: 0,
  exposure: '0.00',
  roiReal: null,
  yieldReal: null,
  hitRateReal: null,
  hitWinsReal: 0,
  hitEligibleReal: 0,
};

export function reportFixture(): PerformanceReport {
  return {
    generatedAt: '2026-09-07T00:00:00Z',
    version: 1,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    dateBasis: 'last_event_sao_paulo',
    granularity: 'day',
    metrics: { ...emptyMetrics },
    previous: { from: '2026-08-02', to: '2026-08-31', metrics: { ...emptyMetrics } },
    exclusions: { unknownDateBets: 0, estimatedDateBets: 0 },
    timeline: [],
    byBookmaker: [],
    byTipster: [],
    bySport: [],
  };
}

export function splitsFixture() {
  const metrics: ReportMetrics = {
    ...emptyMetrics,
    bets: 8,
    settledBets: 8,
    realStake: '800.00',
    realPrincipalClosed: '800.00',
    realProfit: '100.00',
    profit: '100.00',
    profitUnits: '10.000000',
    knownProfitUnits: '10.000000',
    roiReal: '12.50',
    yieldReal: '12.50',
    hitRateReal: '50.00',
    hitWinsReal: 4,
    hitEligibleReal: 8,
  };
  const row = (key: string, label: string, bets: number, over: Partial<ReportMetrics> = {}) => ({
    key,
    label,
    lowSample: bets < 30,
    metrics: { ...metrics, bets, ...over },
  });
  const dim = (
    id: string,
    label: string,
    source: string,
    available: boolean,
    note: string | null,
    rows: unknown[],
  ) => ({ id, label, source, available, note, rows });
  return {
    generatedAt: '2026-09-07T00:00:00.000Z',
    version: 1,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    minSample: 30,
    lowSample: true,
    metrics,
    dimensions: [
      dim('sport', 'Esporte', 'finance.selection.sport', true, null, [
        row('sport:futebol', 'Futebol', 6),
        row('unknown', 'Esporte a conferir', 2),
      ]),
      dim(
        'tournament',
        'Liga/torneio',
        'integration.inbox.metadata.userOverrides.tournament',
        true,
        'Somente o torneio informado manualmente na importação.',
        [row('unknown', 'Torneio a conferir', 7), row('copa do brasil', 'Copa do Brasil', 1)],
      ),
      dim('team', 'Time', 'unavailable', false, 'O modelo atual não guarda time.', [
        row('unknown', 'Sem base', 8),
      ]),
      dim('player', 'Jogador', 'unavailable', false, 'O modelo atual não guarda jogador.', [
        row('unknown', 'Sem base', 8),
      ]),
      dim('ticketKind', 'Tipo de aposta', 'derived:finance.selection', true, null, [
        row('simple', 'Simples', 5),
        row('multiple', 'Múltipla', 2),
        row('betbuild', 'BetBuild', 1),
      ]),
      dim('market', 'Mercado', 'finance.selection.market', true, null, [
        row('market:resultado', 'Resultado', 8),
      ]),
      dim('bookmaker', 'Casa', 'finance.bet.bookmaker_id', true, null, [row(house, 'Bet365', 8)]),
      dim('oddsBand', 'Faixa de odd', 'derived:finance.bet.odds', true, null, [
        row('1.50-1.99', '1,50 a 1,99', 8),
      ]),
      dim('weekday', 'Dia da semana', 'derived:finance.bet.placed_at', true, null, [
        row('seg', 'Segunda-feira', 8),
      ]),
      dim('hour', 'Hora', 'derived:finance.bet.placed_at', true, null, [
        row('10', '10:00–10:59', 8),
      ]),
      dim(
        'live',
        'Live/pré-jogo',
        'unavailable',
        false,
        'O modelo atual não guarda se a aposta foi ao vivo.',
        [row('unknown', 'Sem base', 8)],
      ),
      dim('tipster', 'Tipster', 'finance.bet.tipster_id', true, null, [
        row('none', 'Sem tipster', 8),
      ]),
    ],
  };
}

export function fixture(): Workspace {
  return {
    version: 1,
    initialized: true,
    unitPercent: '1.00',
    bankroll: '1000.00',
    available: '900.00',
    exposure: '100.00',
    accounts: [
      { id: reserve, kind: 'reserve', name: 'Reserva', bookmakerId: null, balance: '500.00' },
      {
        id: houseAccount,
        kind: 'bookmaker',
        name: 'Bet365',
        bookmakerId: house,
        balance: '400.00',
      },
    ],
    catalog: [{ id: house, kind: 'bookmaker', name: 'Bet365', aliases: ['bet 365'], active: true }],
    units: [
      {
        month: saoPauloDate(new Date()).slice(0, 7),
        amount: '10.00',
        base: '1000.00',
        percent: '1.00',
        source: 'initial',
      },
    ],
    freebets: [],
    warnings: [],
  };
}

export const bet: Bet = {
  id: betId,
  ticketNumber: 1,
  bookmakerId: house,
  tipsterId: null,
  stake: '100.00',
  odds: '2.00',
  placedAt: '2026-09-01T18:00:00Z',
  createdAt: '2026-09-01T18:00:00Z',
  freebetId: null,
  freebetStakeReturned: null,
  reference: '',
  completionState: 'complete',
  state: 'open',
  ticketKind: 'simple',
  latestOutcome: null,
  remaining: '100.00',
  unitMonth: '2026-09',
  unitAmount: '10.00',
  stakeUnits: '10.000000',
  returnAmount: '0.00',
  profit: '0.00',
  selections: [
    {
      event: 'Aurora × Central',
      sport: 'Futebol',
      market: 'Gols',
      selection: 'Mais de 2,5',
      odds: null,
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending',
    },
  ],
};

export async function enabledProduct(
  page: Page,
  workspace = fixture(),
  bets: Bet[] = [],
  detailBet: Bet = bet,
) {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'available',
        authentication: 'google',
        productEnabled: true,
        release: {
          version: '0.1.0-beta.1',
          commit: 'a'.repeat(40),
          builtAt: '2026-09-14T12:00:00Z',
          environment: 'production',
        },
      },
    }),
  );
  // Already-onboarded fixture: the first-steps flow is not shown and the overview stays regular.
  await page.route('**/api/v1/onboarding', (route) =>
    route.fulfill({
      json: {
        displayName: 'Fixture Owner',
        timezone: 'America/Sao_Paulo',
        steps: {
          profile: { completed: true, completedAt: '2026-09-14T12:00:00.000Z' },
          bankroll: { completed: true },
          firstBet: { completed: true, resolution: 'registered' },
        },
        completedAt: '2026-09-14T12:30:00.000Z',
      },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'fixture-owner', name: 'Fixture Owner' },
        organization: { id: '00000000-0000-4000-8000-000000000001', role: 'owner' },
        expiresAt: '2099-09-01T00:00:00Z',
      },
    }),
  );
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: reportFixture() }));
  // STK-F2-03: os 12 splits no painel de análises (mesmos filtros do relatório).
  await page.route('**/api/v1/analytics/splits?*', (route) =>
    route.fulfill({ json: splitsFixture() }),
  );
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({ json: { items: bets, total: bets.length, page: 1, pageSize: 25 } }),
  );
  await page.route(`**/api/v1/bets/${betId}`, (route) =>
    route.fulfill({ json: { bet: detailBet, settlements: [] } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
}
