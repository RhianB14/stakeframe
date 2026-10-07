import { expect, test, type Page } from '@playwright/test';
import type { PerformanceReport, ReportMetrics } from '../../packages/shared/src/index.js';
import { enabledProduct } from './product-fixtures.js';

/**
 * STK-F3-CAPTURAS — as telas da Fase 3 num só lugar, para o dono olhar.
 *
 * Este teste não afirma comportamento novo: os testes que protegem
 * comportamento estão em chart-overview.test.ts, polymarket-global.test.ts e
 * product.test.ts. Aqui o que importa é GRAVAR as telas, nos dois tamanhos,
 * nos estados que precisam ser vistos.
 *
 * Por que `capturas/` e não `test-results/`: o Playwright apaga
 * `test-results/` a cada execução, e uma imagem deixada ali não sobrevive
 * até a revisão. `capturas/` é versionado, e é lá que o orquestrador olha.
 */

const emptyMetrics: ReportMetrics = {
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

/** 30 dias de resultado, alternando lucro e prejuzo: area com sobressalto. */
const TRINCA = ['120.50', '-80.00', '240.00', '-45.30', '95.10', '-150.00', '310.75'];

function reportWith(profits: string[]): PerformanceReport {
  return {
    generatedAt: '2026-09-07T00:00:00Z',
    version: 1,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    dateBasis: 'last_event_sao_paulo',
    granularity: 'day',
    metrics: { ...emptyMetrics, bets: profits.length, settledBets: profits.length },
    previous: { from: '2026-08-02', to: '2026-08-31', metrics: { ...emptyMetrics } },
    exclusions: { unknownDateBets: 0, estimatedDateBets: 0 },
    timeline: profits.map((profit, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, 'd')}`,
      metrics: { ...emptyMetrics, bets: 1, profit },
    })),
    byBookmaker: [],
    byTipster: [],
    bySport: [],
  };
}

async function openOverview(page: Page, report: PerformanceReport): Promise<void> {
  await enabledProduct(page);
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: report }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Resultado acumulado/i })).toBeVisible();
}

const destino = (page: Page, arquivo: string) =>
  test.info().project.name === 'desktop-chromium'
    ? `capturas/stk-f3/${arquivo}`
    : `capturas/stk-f3/${arquivo.replace('.png', '-mobile.png')}`;

test('captura: a Visao geral com a area de resultado realizado', async ({ page }) => {
  await openOverview(page, reportWith(TRINCA));
  await page.screenshot({ path: destino(page, 'visao-geral.png') });
});

test('captura: a tabela de apostas com status, badge e acoes', async ({ page }) => {
  await enabledProduct(page);
  await page.goto('/#bets');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: destino(page, 'apostas.png') });
});

test('captura: a tabela com o painel de colunas aberto', async ({ page }) => {
  await enabledProduct(page);
  await page.goto('/#bets');
  await page.waitForTimeout(1200);
  const painel = page.getByRole('button', { name: /colunas/i }).first();
  if (await painel.isVisible().catch(() => false)) {
    await painel.click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: destino(page, 'apostas-colunas.png') });
});
