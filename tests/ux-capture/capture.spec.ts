// Capturas desktop e móveis para a auditoria visual STK-UX-01/02.
// Roda APENAS com o config próprio (tests/ux-capture/playwright.ux.config.ts);
// o playwright.config.ts da CI aponta para ./tests/e2e e não inclui esta pasta.
// Todos os dados exibidos são sintéticos (fixtures.ts); nada de bilhetes reais.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ImportDetail } from '../../packages/shared/src/index.js';
import {
  betId,
  house,
  house2,
  house3,
  importId,
  miniAppImport,
  richBets,
  richReport,
  richWorkspace,
} from './fixtures.js';

const imageFile = fileURLToPath(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));

// Rotas base: sistema ligado, workspace já inicializado, sessão válida.
async function boot(page: Page, bets = richBets()) {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'available',
        authentication: 'google',
        productEnabled: true,
        release: {
          version: '0.1.0-beta.7',
          commit: 'b'.repeat(40),
          builtAt: '2026-09-23T12:00:00Z',
          environment: 'production',
        },
      },
    }),
  );
  await page.route('**/api/v1/onboarding', (route) =>
    route.fulfill({
      json: {
        displayName: 'Usuário Sintético',
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
        user: { id: 'fixture-owner', name: 'Usuário Sintético' },
        organization: { id: '00000000-0000-4000-8000-000000000001', role: 'owner' },
        expiresAt: '2099-09-01T00:00:00Z',
      },
    }),
  );
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: richWorkspace() }));
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: richReport() }));
  await page.route('**/api/v1/reports/options', (route) =>
    route.fulfill({
      json: { sports: ['Futebol', 'Basquete', 'Tênis'], bookmakers: [house, house2, house3] },
    }),
  );
  await page.route('**/api/v1/reports/bets?*', (route) =>
    route.fulfill({ json: { items: bets, total: bets.length, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({ json: { items: bets, total: bets.length, page: 1, pageSize: 25 } }),
  );
  await page.route(`**/api/v1/bets/${betId}`, (route) =>
    route.fulfill({ json: { bet: richBets()[0], settlements: [] } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/calendar?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
}

async function importRoutes(page: Page, detail: ImportDetail = miniAppImport()) {
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [detail.item], total: 1, page: 1, pageSize: 25 } }),
  );
  await page.route(`**/api/v1/imports/${importId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/imports/${importId}/image`, (route) =>
    route.fulfill({ contentType: 'image/png', body: readFileSync(imageFile) }),
  );
}

async function telegram(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        initData: 'stub-initdata',
        close: () => undefined,
        HapticFeedback: { notificationOccurred: () => undefined },
      },
    };
  });
}

test('STK-UX-01 visao geral', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  await expect(page.getByText('R$ 2.480,00', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('01-overview.png'), fullPage: true });
});

test('STK-UX-01 apostas lista', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#bets');
  await expect(page.getByRole('heading', { name: 'Apostas', exact: true })).toBeVisible();
  await expect(page.getByLabel('Situação')).toBeVisible();
  await page.screenshot({ path: info.outputPath('02-bets-list.png'), fullPage: true });
});

test('STK-UX-01 apostas detalhe', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#bets');
  await page.getByRole('button', { name: /Ver aposta Aurora × Central/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: info.outputPath('03-bet-detail.png'), fullPage: true });
});

test('STK-UX-01 calendario', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#calendar');
  await expect(page.getByRole('heading', { name: 'Calendário', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('04-calendar.png'), fullPage: true });
});

test('STK-UX-01 analises', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#analytics');
  await expect(page.getByRole('heading', { name: 'Análises', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('05-analytics.png'), fullPage: true });
});

test('STK-UX-01 financeiro', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#finance');
  await expect(page.getByRole('heading', { name: 'Financeiro', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('06-finance.png'), fullPage: true });
});

test('STK-UX-01 configuracoes', async ({ page }, info) => {
  await boot(page);
  await page.goto('/#settings');
  await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('07-settings.png'), fullPage: true });
});

test('STK-UX-02 miniapp edicao', async ({ page }, info) => {
  await boot(page);
  await importRoutes(page);
  await telegram(page);
  await page.goto(`/miniapp#miniapp?import=${importId}`);
  await expect(page.getByRole('heading', { name: 'Editar aposta' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('08-miniapp-editor.png'), fullPage: true });
});

test('STK-UX-02 miniapp salvando', async ({ page }, info) => {
  await boot(page);
  const detail = miniAppImport();
  detail.item.state = 'imported';
  await importRoutes(page, detail);
  await telegram(page);
  await page.route(`**/api/v1/imports/${importId}**`, (route) => {
    // Só escrita: o GET precisa cair no handler de leitura de importRoutes.
    if (route.request().method() === 'GET') return route.fallback();
    return route.fulfill({
      json: { version: 3, freebetCleared: false, automaticPolicy: 'disabled' },
    });
  });
  await page.route(`**/api/v1/imports/${importId}/status`, (route) =>
    route.fulfill({ json: { version: 4, betState: 'open' } }),
  );
  await page.route('**/api/v1/commands', (route) =>
    route.fulfill({ json: { id: betId, version: 5 } }),
  );
  await page.goto(`/miniapp#miniapp?import=${importId}`);
  await expect(page.getByRole('heading', { name: 'Editar aposta' })).toBeVisible();
  // O alertdialog de status é o único gatilho de confirmação (statusChanged).
  await page.getByLabel('Status', { exact: true }).selectOption('win');
  await page.getByRole('button', { name: 'Salvar e confirmar aposta' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Confirmar status' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('09-miniapp-saving.png'), fullPage: true });
});

test('STK-UX-02 miniapp conflito de versao', async ({ page }, info) => {
  await boot(page);
  await importRoutes(page);
  await telegram(page);
  await page.route(`**/api/v1/imports/${importId}**`, (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Os dados foram alterados em outra operação.',
            requestId: '00000000-0000-4000-8000-000000000042',
          },
        },
      });
    }
    return route.fulfill({ json: miniAppImport() });
  });
  await page.goto(`/miniapp#miniapp?import=${importId}`);
  await expect(page.getByRole('heading', { name: 'Editar aposta' })).toBeVisible();
  await page.getByLabel('Casa de aposta', { exact: true }).selectOption(house2);
  await page.getByLabel('Status', { exact: true }).selectOption('win');
  await page.getByRole('button', { name: 'Salvar e confirmar aposta' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Confirmar status' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar e salvar' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('10-miniapp-conflict.png'), fullPage: true });
});

test('STK-UX-01 estado de erro na visao geral', async ({ page }, info) => {
  await boot(page);
  await page.route('**/api/v1/reports?*', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Não foi possível carregar o relatório.',
          requestId: '00000000-0000-4000-8000-000000000043',
        },
      },
    }),
  );
  await page.goto('/#overview');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('11-overview-error.png'), fullPage: true });
});
