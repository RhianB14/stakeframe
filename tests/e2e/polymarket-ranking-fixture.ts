import {
  polymarketRankingSchema,
  rankingAggregatePolicy,
  rankingCompleteness,
  rankingSample,
} from '../../packages/shared/src/index.js';
import type { Page } from '@playwright/test';

const traders = [
  {
    proxyWallet: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
    userName: '@alpha_odds',
    pnl: '48210.123456789012345678',
    vol: '312000.000000000000000001',
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

type RankingFixtureOptions = {
  available?: boolean;
  status?: 'complete' | 'truncated' | 'partial' | 'unknown';
  empty?: boolean;
  minSample?: number;
};

function decimalInteger(value: string) {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const scaled = BigInt(`${whole}${fraction.padEnd(18, '0')}`);
  return negative ? -scaled : scaled;
}

function rankingResponse(category: string, orderBy: string, options: RankingFixtureOptions = {}) {
  const available = options.available ?? true;
  const status = options.status ?? (available ? 'truncated' : 'unknown');
  const matching =
    !available || options.empty
      ? []
      : category === 'SPORTS' || category === 'ESPORTS'
        ? traders.filter((trader) => trader.categories.some((item) => item === category))
        : traders;
  const rows = [...matching]
    .sort((left, right) => {
      const leftValue = decimalInteger(orderBy === 'VOL' ? left.vol : left.pnl);
      const rightValue = decimalInteger(orderBy === 'VOL' ? right.vol : right.pnl);
      return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
    })
    .map((trader, index) => ({
      rank: String(index + 1),
      proxyWallet: trader.proxyWallet,
      userName: trader.userName,
      pnl: trader.pnl,
      vol: trader.vol,
    }));
  const series = {
    status,
    available,
    ingested: !available ? 0 : status === 'complete' ? rows.length : 1000,
    backfillFrom: '2026-04-13',
    pages: !available ? 0 : status === 'complete' ? 1 : 20,
    failedPages: status === 'partial' ? 1 : 0,
  };
  const aggregatePolicy = rankingAggregatePolicy({ status, available });

  return polymarketRankingSchema.parse({
    window: {
      category: category === 'SPORTS' || category === 'ESPORTS' ? category : 'OVERALL',
      timePeriod: 'MONTH',
      orderBy: orderBy === 'VOL' ? 'VOL' : 'PNL',
    },
    series,
    completeness: rankingCompleteness({ series }),
    sample: rankingSample({ n: rows.length, minSample: options.minSample ?? 30 }),
    aggregate: aggregatePolicy.allowed
      ? { blocked: false, reason: null }
      : { blocked: true, reason: aggregatePolicy.reason },
    requested: 100,
    returned: rows.length,
    rows,
  });
}

export async function mockPolymarketRanking(page: Page, options: RankingFixtureOptions = {}) {
  await page.route('**/api/v1/polymarket/ranking?*', (route) => {
    const requestUrl = new URL(route.request().url());
    return route.fulfill({
      json: rankingResponse(
        requestUrl.searchParams.get('category') ?? 'OVERALL',
        requestUrl.searchParams.get('orderBy') ?? 'PNL',
        options,
      ),
    });
  });
}
