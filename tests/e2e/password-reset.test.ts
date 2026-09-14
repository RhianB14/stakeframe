import { expect, test } from '@playwright/test';

const statusBody = {
  name: 'Stakeframe',
  stage: 'local-setup',
  database: 'available',
  authentication: 'google',
  productEnabled: false,
  release: {
    version: '0.1.0-beta.1',
    commit: 'a'.repeat(40),
    builtAt: '2026-09-14T12:00:00Z',
    environment: 'production',
  },
};

test('reset link opens the new-password form and confirms success', async ({ page }) => {
  await page.route('**/api/v1/system/status', (route) => route.fulfill({ json: statusBody }));
  const submitted: string[] = [];
  await page.route('**/api/auth/reset-password', async (route) => {
    const body = route.request().postDataJSON() as { newPassword: string };
    submitted.push(body.newPassword);
    await route.fulfill({ json: { status: true } });
  });
  await page.goto('/?reset=fixture-token');
  await expect(page.getByText('Definir nova senha.')).toBeVisible();
  await page.getByLabel('Nova senha', { exact: true }).fill('fixture-password-9');
  await page.getByLabel('Confirmar nova senha', { exact: true }).fill('fixture-password-8');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('alert')).toContainText('As senhas não conferem');
  await page.getByLabel('Confirmar nova senha', { exact: true }).fill('fixture-password-9');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByText('Senha redefinida.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ir para o login' })).toBeVisible();
  expect(submitted).toEqual(['fixture-password-9']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('expired reset link offers a fresh request without enumeration', async ({ page }) => {
  await page.route('**/api/v1/system/status', (route) => route.fulfill({ json: statusBody }));
  await page.route('**/api/auth/reset-password', (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: {
          code: 'RESET_REJECTED',
          message:
            'Este link de redefinição de senha não é mais válido. Solicite um novo link e tente novamente.',
          requestId: '00000000-0000-4000-8000-000000000000',
        },
      },
    }),
  );
  await page.route('**/api/auth/request-password-reset', (route) =>
    route.fulfill({ json: { status: true } }),
  );
  await page.goto('/?reset=expired-token');
  await page.getByLabel('Nova senha', { exact: true }).fill('fixture-password-9');
  await page.getByLabel('Confirmar nova senha', { exact: true }).fill('fixture-password-9');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('alert')).toContainText('não é mais válido');
  await page.getByRole('button', { name: 'Solicitar novo link' }).click();
  await expect(page.getByText('Recuperar senha.')).toBeVisible();
  await page.getByLabel('E-mail', { exact: true }).fill('fixture@example.test');
  await page.getByRole('button', { name: 'Enviar link de redefinição' }).click();
  await expect(page.getByText('Confira seu e-mail.')).toBeVisible();
  // The public answer never reveals whether the address exists.
  await expect(page.getByText(/Se este endereço tiver uma conta/)).toBeVisible();
});
