import { polymarketRankingSchema } from '../../packages/shared/src/index.js';
import type { Page } from '@playwright/test';

const traders = [
  {
    proxyWallet: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    userName: '@alpha_odds',
    pnl: '48210',
    vol: '312000',
    categories: ['SPORTS'] as const,
  },
  {
    proxyWallet: '0x2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e',
    userName: '@beta_market',
    pnl: '31000',
    vol: '160000',
    categories: ['SPORTS'] as const,
  },
  {
    proxyWallet: '0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f',
    userName: '@csgo_arb',
    pnl: '12000',
    vol: '198000',
    categories: ['SPORTS', 'ESPORTS'] as const,
  },
  {
    proxyWallet: '0x4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
    userName: '@gamma_lines',
    pnl: '7000',
    vol: '90000',
    categories: ['SPORTS'] as const,
  },
  {
    proxyWallet: '0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081',
    userName: '@edge_detector',
    pnl: '-12400',
    vol: '220000',
    categories: ['SPORTS'] as const,
  },
  {
    proxyWallet: '0x6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192',
    userName: '@pro_polymarket',
    pnl: '-2000',
    vol: '80000',
    categories: ['ESPORTS'] as const,
  },
];

function rankingResponse(category: string, orderBy: string) {
  const matching =
    category === 'SPORTS' || category === 'ESPORTS'
      ? traders.filter((trader) => trader.categories.some((item) => item === category))
      : traders;
  const rows = [...matching]
    .sort((left, right) => {
      const leftValue = BigInt(orderBy === 'VOL' ? left.vol : left.pnl);
      const rightValue = BigInt(orderBy === 'VOL' ? right.vol : right.pnl);
      return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
    })
    .map((trader, index) => ({
      rank: String(index + 1),
      proxyWallet: trader.proxyWallet,
      userName: trader.userName,
      pnl: trader.pnl,
      vol: trader.vol,
    }));

  return polymarketRankingSchema.parse({
    window: {
      category: category === 'SPORTS' || category === 'ESPORTS' ? category : 'OVERALL',
      timePeriod: 'MONTH',
      orderBy: orderBy === 'VOL' ? 'VOL' : 'PNL',
    },
    series: {
      status: 'truncated',
      available: true,
      ingested: 1000,
      backfillFrom: '2026-04-13',
      pages: 20,
      failedPages: 0,
    },
    completeness: {
      truncated: true,
      label: 'Cobertura truncada',
      detail: '210 de 1.000 eventos ingeridos nesta janela.',
    },
    sample: { n: rows.length, minSample: 30, lowSample: rows.length < 30 },
    aggregate: {
      blocked: true,
      reason: 'A série está truncada; o agregado não pode ser afirmado.',
    },
    requested: 100,
    returned: rows.length,
    rows,
  });
}

export async function mockPolymarketRanking(page: Page) {
  await page.route('**/api/v1/polymarket/ranking?*', (route) => {
    const requestUrl = new URL(route.request().url());
    return route.fulfill({
      json: rankingResponse(
        requestUrl.searchParams.get('category') ?? 'OVERALL',
        requestUrl.searchParams.get('orderBy') ?? 'PNL',
      ),
    });
  });
}
