import { expect, test, type Page } from '@playwright/test';

/**
 * STK-F3-04 — as CAPTURAS da tela Global, e o critério delas.
 *
 * Este teste não afirma comportamento de produto: ele grava as imagens que o
 * card pede em `capturas/`, nos DOIS tamanhos de tela, e nos ESTADOS que
 * precisam ser vistos — a grade completa, o card truncado com a métrica
 * bloqueada, e o filtro de e-sports aplicado.
 *
 * Por que as capturas ficam aqui e não no `test-results/`: o Playwright
 * apaga `test-results/` a cada execução, então uma imagem deixada ali não
 * sobrevive para a revisão. `capturas/` é versionado, e é lá que o
 * orquestrador olha.
 *
 * A CAPTURA DE VIEWPORT é a de leitura, e a FULLPAGE é a de inventário. A
 * diferença importa: a sidebar é `position: fixed`, e numa captura de página
 * inteira ela aparece pintada sobre a primeira coluna de cards — é artefato
 * de captura, não defeito de layout. A de viewport é a que mostra o que o
 * usuário vê, e é a que a revisão deve usar para julgar a tela.
 */
async function abrirGlobal(page: Page) {
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
  await page.goto('/#pm-global');
  await expect(page.getByTestId('global-card')).toHaveCount(6);
}

const destino = (page: Page, arquivo: string) =>
  test.info().project.name === 'desktop-chromium'
    ? `capturas/stk-f3-04/${arquivo}`
    : `capturas/stk-f3-04/${arquivo.replace('.png', '-mobile.png')}`;

test('captura: a Global em cards, na tela e inteira', async ({ page }) => {
  await abrirGlobal(page);
  // A de VIEWPORT é a de leitura: é o que o usuário vê sem rolar.
  await page.screenshot({ path: destino(page, 'global-cards-viewport.png') });
  // E a de página inteira é o inventário dos seis cards.
  await page.screenshot({ path: destino(page, 'global-cards-fullpage.png'), fullPage: true });
});

test('captura: o card truncado com a métrica bloqueada, em foco', async ({ page }) => {
  await abrirGlobal(page);
  // O card truncado é trazido para o topo pela rolagem, e não pela
  // ordenação: ele é o TERCEIRO por PnL, e trocar a ordem para fotografá-lo
  // mostraria uma tela que o dono não abriu. A rolagem não mente sobre o
  // estado da lista.
  await page
    .getByTestId('global-card')
    .filter({ hasText: 'Cobertura truncada' })
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: destino(page, 'global-truncado.png') });
});

test('captura: o filtro de e-sports aplicado', async ({ page }) => {
  await abrirGlobal(page);
  await page
    .getByRole('group', { name: 'Filtrar por categoria' })
    .getByRole('button', { name: /E-sports/ })
    .click();
  await expect(page.getByTestId('global-card')).toHaveCount(2);
  await page.screenshot({ path: destino(page, 'global-filtro-esports.png') });
});
