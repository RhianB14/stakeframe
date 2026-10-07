import { expect, test, type Page } from '@playwright/test';

/**
 * A tela própria de ranking foi aposentada. A rota legada `#ranking` continua
 * encaminhando para o Ranking global; asserções exclusivas da tela removida
 * (série, amostra, enums e tabela) não têm equivalente neste destino.
 */
async function openLegacyRanking(page: Page) {
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
  await page.goto('/#ranking');
}

test('a rota legada #ranking abre o Ranking global, sem Composite Score', async ({ page }) => {
  await openLegacyRanking(page);

  await expect(page.getByRole('heading', { name: 'Ranking global', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tipsters', level: 2 })).toBeVisible();
  await expect(page.getByTestId('global-grid')).toBeVisible();

  const rendered = (await page.locator('body').innerText()).toLowerCase();
  expect(rendered).not.toContain('composite score');
});
