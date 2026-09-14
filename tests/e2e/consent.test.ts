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

const consentDocuments = [
  {
    type: 'terms_of_use',
    version: '1.0.0-draft',
    title: 'Termos de Uso (provisório)',
    summary: 'Rascunho técnico dos Termos de Uso do Stakeframe.',
    textUrl: '/api/v1/legal/documents/terms_of_use/1.0.0-draft',
    effectiveAt: '2026-09-14T03:00:00.000Z',
    accepted: false,
    stale: false,
    integrity: 'ok',
    acceptedAt: null,
  },
  {
    type: 'privacy_policy',
    version: '1.0.0-draft',
    title: 'Política de Privacidade (provisório)',
    summary: 'Rascunho técnico da Política de Privacidade (LGPD).',
    textUrl: '/api/v1/legal/documents/privacy_policy/1.0.0-draft',
    effectiveAt: '2026-09-14T03:00:00.000Z',
    accepted: false,
    stale: false,
    integrity: 'ok',
    acceptedAt: null,
  },
  {
    type: 'minimum_age',
    version: '1.0.0-draft',
    title: 'Declaração de Idade Mínima (provisório)',
    summary: 'Declaração de idade mínima (18+).',
    textUrl: '/api/v1/legal/documents/minimum_age/1.0.0-draft',
    effectiveAt: '2026-09-14T03:00:00.000Z',
    accepted: false,
    stale: false,
    integrity: 'ok',
    acceptedAt: null,
  },
];

test('consent screen: no pre-checked boxes, explicit acceptance unlocks the app', async ({
  page,
}) => {
  await page.route('**/api/v1/system/status', (route) => route.fulfill({ json: statusBody }));
  let accepted = false;
  await page.route('**/api/v1/me', async (route) => {
    if (!accepted)
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: 'CONSENT_REQUIRED',
            message:
              'É necessário aceitar os documentos legais vigentes (Termos de Uso, Política de Privacidade e declaração de idade mínima) para continuar.',
            requestId: '00000000-0000-4000-8000-000000000000',
          },
        },
      });
    else
      await route.fulfill({
        json: {
          user: { id: 'fixture-user', name: 'Fixture Owner' },
          organization: { id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      });
  });
  await page.route('**/api/v1/consents/status', (route) =>
    route.fulfill({
      json: {
        status: 'pending',
        documents: consentDocuments,
        pendingTypes: consentDocuments.map((d) => d.type),
      },
    }),
  );
  let acceptBody: unknown = null;
  await page.route('**/api/v1/consents/accept', async (route) => {
    acceptBody = route.request().postDataJSON();
    accepted = true;
    await route.fulfill({
      json: {
        accepted: consentDocuments.map((document) => ({
          type: document.type,
          version: document.version,
          acceptedAt: new Date().toISOString(),
        })),
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Antes de continuar.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Documentos obrigatórios' })).toBeVisible();
  const boxes = page.getByRole('checkbox');
  await expect(boxes).toHaveCount(3);
  for (let index = 0; index < 3; index++) await expect(boxes.nth(index)).not.toBeChecked();
  const submit = page.getByRole('button', { name: 'Aceitar e continuar' });
  await expect(submit).toBeDisabled();
  // Version and validity are visible, with a full-text link per document.
  await expect(page.getByText(/Versão 1\.0\.0-draft/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ler na íntegra' })).toHaveCount(3);
  // Keyboard-accessible checkboxes: focus and toggle the first one.
  await boxes.nth(0).focus();
  await page.keyboard.press('Space');
  await expect(boxes.nth(0)).toBeChecked();
  await expect(submit).toBeDisabled();
  await boxes.nth(1).check();
  await boxes.nth(2).check();
  await expect(submit).toBeEnabled();
  await submit.click();
  // Acceptance unlocks the private flow: the session view replaces the consent screen.
  await expect(page.getByText('Olá, Fixture Owner.')).toBeVisible();
  const submitted = acceptBody as { documents: { type: string }[] };
  expect(submitted.documents.map((document) => document.type).sort()).toEqual([
    'minimum_age',
    'privacy_policy',
    'terms_of_use',
  ]);
});

test('consent screen: stale version is called out and refusal signs out', async ({ page }) => {
  await page.route('**/api/v1/system/status', (route) => route.fulfill({ json: statusBody }));
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'É necessário aceitar os documentos legais vigentes para continuar.',
          requestId: '00000000-0000-4000-8000-000000000000',
        },
      },
    }),
  );
  await page.route('**/api/v1/consents/status', (route) =>
    route.fulfill({
      json: {
        status: 'pending',
        documents: consentDocuments.map((document, index) =>
          index === 0
            ? { ...document, version: '2.0.0', stale: true }
            : { ...document, accepted: true, acceptedAt: '2026-09-14T05:00:00.000Z' },
        ),
        pendingTypes: ['terms_of_use'],
      },
    }),
  );
  let signedOut = false;
  await page.route('**/api/auth/sign-out', async (route) => {
    signedOut = true;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto('/');
  await expect(page.getByText('Antes de continuar.')).toBeVisible();
  await expect(page.getByText(/aceitou uma versão anterior/)).toBeVisible();
  // Already-accepted documents still start unchecked: acceptance is always explicit.
  const boxes = page.getByRole('checkbox');
  for (let index = 0; index < 3; index++) await expect(boxes.nth(index)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Aceitar e continuar' })).toBeDisabled();
  await page.getByRole('button', { name: 'Recusar e sair' }).click();
  await expect.poll(() => signedOut).toBe(true);
});
