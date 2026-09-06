import { expect, test, type Page } from '@playwright/test';

async function enabledAuth(page: Page) {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'available',
        authentication: 'google',
        productEnabled: false,
      },
    }),
  );
}
test('configured login is visible and continues to the Google origin', async ({
  page,
}, testInfo) => {
  await enabledAuth(page);
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/auth/sign-in/google', (route) =>
    route.fulfill({ json: { url: 'https://accounts.google.com/fixture-auth' } }),
  );
  await page.route('https://accounts.google.com/fixture-auth', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Google test boundary</h1>' }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('google-login.png'), fullPage: true });
  await page.getByRole('button', { name: 'Entrar com Google' }).click();
  await expect(page).toHaveURL('https://accounts.google.com/fixture-auth');
});
test('private welcome is removed when logout succeeds', async ({ page }) => {
  await enabledAuth(page);
  let signedIn = true;
  await page.route('**/api/v1/me', (route) =>
    signedIn
      ? route.fulfill({
          json: {
            user: { id: 'fixture-user', name: 'Fixture Owner' },
            expiresAt: '2026-09-07T00:00:00.000Z',
          },
        })
      : route.fulfill({ status: 401, json: {} }),
  );
  await page.route('**/api/auth/sign-out', async (route) => {
    signedIn = false;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto('/');
  await expect(page.getByText('Olá, Fixture Owner.')).toBeVisible();
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
  await expect(page.getByText('Olá, Fixture Owner.')).toHaveCount(0);
});
test('session failure does not display a private welcome and can be retried', async ({ page }) => {
  await enabledAuth(page);
  let failing = true;
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({ status: failing ? 503 : 401, json: {} }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toHaveText('Não foi possível verificar sua sessão.');
  failing = false;
  await page.getByRole('button', { name: 'Verificar acesso novamente' }).click();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
});
test('callback failure shows a generic message and clears provider error details from the URL', async ({
  page,
}) => {
  await enabledAuth(page);
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/?auth=failed&error_description=untrusted-provider-detail');
  await expect(page.getByRole('alert')).toContainText('Use a conta Google autorizada');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('untrusted-provider-detail')).toHaveCount(0);
});
test('unexpected redirect destinations are rejected', async ({ page }) => {
  await enabledAuth(page);
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/auth/sign-in/google', (route) =>
    route.fulfill({ json: { url: 'https://untrusted.example.test' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Entrar com Google' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível entrar.');
  await expect(page).toHaveURL(/127\.0\.0\.1:8088\/$/);
});
