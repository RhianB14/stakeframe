import { expect, test } from '@playwright/test';

test('local setup shows actual readiness without product data or login bypass', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sua banca,em perspectiva.');
  await expect(page.getByRole('status')).toContainText('Conexão estabelecida');
  await expect(page.getByText('Acesso com Google em preparação')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('setup.png'), fullPage: true });
  const protectedRoute = await page.request.get('/api/v1/bets');
  expect(protectedRoute.status()).toBe(404);
});

test('connection failure offers a working retry', async ({ page }) => {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Serviço indisponível');
  await page.unroute('**/api/v1/system/status');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('status')).toContainText('Conexão estabelecida');
});

test('reports database unavailability without stale positive status', async ({ page }) => {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'unavailable',
        authentication: 'not-configured',
        productEnabled: false,
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Banco indisponível');
});
