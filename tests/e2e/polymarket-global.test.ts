import { expect, test, type Page } from '@playwright/test';
import { mockPolymarketRanking } from './polymarket-ranking-fixture.js';

async function openGlobal(
  page: Page,
  rankingOptions: Parameters<typeof mockPolymarketRanking>[1] = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem('bettrack.preview.preferences', JSON.stringify({ language: 'pt-BR' }));
  });
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
  await page.route('**/api/v1/workspace', (route) =>
    route.fulfill({
      json: {
        version: 1,
        initialized: true,
        unitPercent: '1.00',
        bankroll: '1000.00',
        available: '900.00',
        exposure: '0.00',
        accounts: [],
        catalog: [],
        units: [],
        freebets: [],
        warnings: [],
      },
    }),
  );
  await mockPolymarketRanking(page, rankingOptions);
  await page.goto('/#pm-global');
  await expect(page.getByRole('heading', { name: 'Ranking global · Polymarket' })).toBeVisible();
}

const cards = (page: Page) => page.getByTestId('global-card');

test('a tela Global renderiza os cards do ranking persistido e suas métricas oficiais', async ({
  page,
}, testInfo) => {
  await openGlobal(page);
  await expect(page.getByTestId('global-grid')).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(6);
  await expect(page.getByTestId('global-count')).toHaveText('6 de 100 traders');

  const first = cards(page).first();
  await expect(first.getByText('@alpha_odds', { exact: true })).toBeVisible();
  await expect(first.locator('.global-card-rank')).toHaveText('#1');
  await expect(first.locator('.global-card-scope')).toHaveText('OVERALL');
  await expect(first.locator('dt')).toHaveText(['P&L · 30D', 'VOLUME · 30D']);
  await expect(first.locator('dd')).toHaveText([
    'US$ 48.210,123456789012345678',
    'US$ 312.000,000000000000000001',
  ]);
  await expect(page.getByTestId('polymarket-ranking-sample')).toHaveText(
    'N = 6 traders · mínimo 30 · Amostra baixa',
  );
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toContainText(
    'série deste ranking está truncada',
  );

  const columns = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="global-grid"]');
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  });
  const width = page.viewportSize()?.width ?? 0;
  if (width >= 1200) expect(columns).toBeGreaterThan(1);
  else expect(columns).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('polymarket-global-cards.png'),
    fullPage: true,
  });
});

test('a cobertura truncada e seu motivo ficam visíveis sem ocultar os dados recebidos', async ({
  page,
}) => {
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);
  const coverage = page.locator('.panel-footnote').filter({ hasText: 'Cobertura truncada' });
  await expect(coverage).toContainText('1000 registros ingeridos em 20 páginas');
  await expect(coverage).toContainText('NÃO representa o ranking inteiro');
  await expect(cards(page).first().getByText('@alpha_odds', { exact: true })).toBeVisible();
  await expect(cards(page).first().locator('dt')).toHaveCount(2);
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toContainText(
    'Métrica bloqueada:',
  );
});

test('a coleta parcial identifica páginas com falha e mantém o agregado bloqueado', async ({
  page,
}) => {
  await openGlobal(page, { status: 'partial' });
  await expect(
    page.locator('.panel-footnote').filter({ hasText: 'Série truncada com falha de coleta' }),
  ).toContainText('1 página falhou na coleta');
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toContainText(
    'série deste ranking está parcial',
  );
  await expect(cards(page)).toHaveCount(6);
});

test('janela não coletada não é apresentada como ranking vazio', async ({ page }) => {
  await openGlobal(page, { available: false });
  await expect(page.getByRole('heading', { name: 'Janela ainda não coletada' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nenhum trader nesta série' })).toHaveCount(0);
  await expect(page.getByText(/Janela ainda não coletada/)).toBeVisible();
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('ranking disponível sem linhas é distinto de uma janela não coletada', async ({ page }) => {
  await openGlobal(page, { empty: true, status: 'complete' });
  await expect(page.getByRole('heading', { name: 'Nenhum trader nesta série' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Janela ainda não coletada' })).toHaveCount(0);
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(0);
});

test('série completa e amostra suficiente não exibem alerta nem bloqueio falsos', async ({
  page,
}) => {
  await openGlobal(page, { status: 'complete', minSample: 6 });
  await expect(
    page.locator('.panel-footnote').filter({ hasText: 'Cobertura completa' }),
  ).toBeVisible();
  await expect(page.getByText('Cobertura truncada', { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('polymarket-ranking-sample')).toHaveText(
    'N = 6 traders · mínimo 6',
  );
  await expect(page.getByTestId('polymarket-aggregate-blocked')).toHaveCount(0);
});

test('a tela renderiza apenas métricas fornecidas pelo contrato do ranking', async ({ page }) => {
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);

  for (const card of await cards(page).all()) {
    await expect(card.locator('dt')).toHaveText(['P&L · 30D', 'VOLUME · 30D']);
    for (const value of await card.locator('dd').allInnerTexts())
      expect(value.trim().length).toBeGreaterThan(0);
  }
  await expect(page.getByText('ROI', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Taxa de acerto', { exact: true })).toHaveCount(0);
});

test('categoria e ordenação consultam respostas distintas do ranking', async ({ page }) => {
  const rankingRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/polymarket/ranking') rankingRequests.push(url);
  });
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);
  const group = page.getByRole('group', { name: 'Filtrar por categoria' });
  await expect(group.getByRole('button')).toHaveCount(3);
  await expect(await group.getByRole('button').allInnerTexts()).toEqual([
    'Todos',
    'Esportes',
    'E-sports',
  ]);

  await group.getByRole('button', { name: 'Esportes' }).click();
  await expect(cards(page)).toHaveCount(5);
  await expect(cards(page).filter({ hasText: '@pro_polymarket' })).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Esportes' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await group.getByRole('button', { name: 'E-sports' }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).filter({ hasText: '@csgo_arb' })).toHaveCount(1);
  await expect(cards(page).filter({ hasText: '@pro_polymarket' })).toHaveCount(1);

  await group.getByRole('button', { name: 'Todos' }).click();
  await expect(cards(page)).toHaveCount(6);
  const order = page.getByRole('group', { name: 'Ordenar por' });
  await expect(order.getByRole('button')).toHaveText(['PnL', 'Volume']);
  const pnlOrder = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-wallet')),
  );
  expect(pnlOrder[0]).toBe('0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d');
  await order.getByRole('button', { name: 'Volume' }).click();
  await expect(cards(page)).toHaveCount(6);
  const volumeOrder = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-wallet')),
  );
  expect(volumeOrder).not.toEqual(pnlOrder);
  expect(volumeOrder[0]).toBe(pnlOrder[0]);
  expect(volumeOrder.indexOf('0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081')).toBeLessThan(
    pnlOrder.indexOf('0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081'),
  );
  await group.getByRole('button', { name: 'Esportes' }).click();
  await expect(cards(page)).toHaveCount(5);
  await expect(group.getByRole('button', { name: 'Esportes' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(rankingRequests.some((url) => url.searchParams.get('category') === 'SPORTS')).toBe(true);
  expect(rankingRequests.some((url) => url.searchParams.get('category') === 'ESPORTS')).toBe(true);
  expect(rankingRequests.some((url) => url.searchParams.get('orderBy') === 'VOL')).toBe(true);
});

test('o card é clicável, focável e anuncia a identidade e as métricas do ranking', async ({
  page,
}) => {
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);
  const first = cards(page).first().locator('.global-card-link');
  await expect(first).toHaveAttribute('href', /#pm-tipster\/0x[0-9a-f]{40}/);
  expect(
    await first.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);

  await page.getByRole('group', { name: 'Ordenar por' }).getByRole('button').last().focus();
  let reachedCard = false;
  for (let step = 0; step < 12 && !reachedCard; step += 1) {
    await page.keyboard.press('Tab');
    reachedCard = await page.evaluate(
      () => document.activeElement?.matches('.global-card-link') === true,
    );
  }
  expect(reachedCard).toBe(true);
  await first.focus();
  const focusStyle = await first.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outline: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusStyle.outline).not.toBe('none');
  expect(Number.parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(2);

  const label = (await first.getAttribute('aria-label')) ?? '';
  expect(label).toContain('@alpha_odds');
  expect(label).toContain('rank 1');
  expect(label).toContain('P and L');
  expect(label).toContain('volume');
  await first.click();
  await expect(page).toHaveURL(/#pm-tipster\/0x/);
});

test('detalhe de tipster não faz requisições externas de posições', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'data-api.polymarket.com')
      externalRequests.push(request.url());
  });
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);
  await cards(page).first().locator('.global-card-link').click();
  await expect(page).toHaveURL(/#pm-tipster\/0x/);
  await expect(page.getByRole('status')).toContainText('depende de autorização específica');
  await page.getByRole('tab', { name: /Apostas fechadas/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('posições fechadas');
  expect(externalRequests).toEqual([]);
});

test('a tela não escreve Composite Score, avaliação nem conselho de aposta', async ({ page }) => {
  await openGlobal(page);
  await expect(cards(page)).toHaveCount(6);
  const rendered = (await page.locator('body').innerText()).toLowerCase();
  for (const forbidden of [
    'composite',
    'score',
    'badge',
    'recomend',
    'selo',
    'rating',
    'melhor trader',
    'melhor tipster',
    'aposte nele',
    'vale a pena',
  ])
    expect(rendered).not.toContain(forbidden);
  expect((await page.locator('.product-sidebar nav').innerText()).toLowerCase()).not.toContain(
    'score',
  );
});
