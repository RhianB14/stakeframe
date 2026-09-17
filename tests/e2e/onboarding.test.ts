import { expect, test, type Page } from '@playwright/test';
import type {
  Workspace,
  ReportMetrics,
  PerformanceReport,
} from '../../packages/shared/src/index.js';

const house = '10000000-0000-4000-8000-000000000001';
const reserve = '10000000-0000-4000-8000-000000000002';
const release = {
  version: '0.1.0-beta.1',
  commit: 'a'.repeat(40),
  builtAt: '2026-09-14T12:00:00Z',
  environment: 'production',
};
const statusBody = {
  name: 'Stakeframe',
  stage: 'local-setup',
  database: 'available',
  authentication: 'google',
  productEnabled: true,
  release,
};
const emptyMetrics: ReportMetrics = {
  bets: 0,
  settledBets: 0,
  openBets: 0,
  realStake: '0.00',
  freebetStake: '0.00',
  realPrincipalClosed: '0.00',
  realReturns: '0.00',
  freebetReturns: '0.00',
  realProfit: '0.00',
  freebetProfit: '0.00',
  profit: '0.00',
  profitUnits: '0.000000',
  knownProfitUnits: '0.000000',
  missingUnitBets: 0,
  exposure: '0.00',
  roiReal: null,
  hitRateReal: null,
  hitWinsReal: 0,
  hitEligibleReal: 0,
};
function reportFixture(): PerformanceReport {
  return {
    generatedAt: '2026-09-07T00:00:00Z',
    version: 1,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    dateBasis: 'last_event_sao_paulo',
    granularity: 'day',
    metrics: { ...emptyMetrics },
    previous: { from: '2026-08-02', to: '2026-08-31', metrics: { ...emptyMetrics } },
    exclusions: { unknownDateBets: 0, estimatedDateBets: 0 },
    timeline: [],
    byBookmaker: [],
    byTipster: [],
    bySport: [],
  };
}
type OnboardingState = {
  displayName: string;
  timezone: string | null;
  steps: {
    profile: { completed: boolean; completedAt: string | null };
    bankroll: { completed: boolean };
    firstBet: { completed: boolean; resolution: 'registered' | 'deferred' | null };
  };
  completedAt: string | null;
};
function pendingOnboarding(): OnboardingState {
  return {
    displayName: 'Fixture Owner',
    timezone: null,
    steps: {
      profile: { completed: false, completedAt: null },
      bankroll: { completed: false },
      firstBet: { completed: false, resolution: null },
    },
    completedAt: null,
  };
}
function finishedOnboarding(): OnboardingState {
  const state = pendingOnboarding();
  state.timezone = 'America/Sao_Paulo';
  state.steps.profile = { completed: true, completedAt: '2026-09-16T12:00:00.000Z' };
  state.steps.bankroll = { completed: true };
  state.steps.firstBet = { completed: true, resolution: 'registered' };
  state.completedAt = '2026-09-16T12:30:00.000Z';
  return state;
}
function emptyWorkspace(): Workspace {
  return {
    version: 1,
    initialized: false,
    unitPercent: '1.00',
    bankroll: '0.00',
    available: '0.00',
    exposure: '0.00',
    accounts: [
      { id: reserve, kind: 'reserve', name: 'Reserva', bookmakerId: null, balance: '0.00' },
    ],
    catalog: [],
    units: [],
    freebets: [],
    warnings: [],
  };
}
type Harness = {
  workspace: Workspace;
  onboarding: OnboardingState;
  commands: unknown[];
  profilePosts: number[];
  finishPosts: number[];
  finishChoices: ('registered' | 'deferred' | null)[];
};
async function enableOnboarding(
  page: Page,
  options: {
    workspace?: Workspace;
    onboarding?: OnboardingState;
    signedIn?: boolean;
    consentRequired?: boolean;
  } = {},
): Promise<Harness> {
  const workspace = options.workspace ?? emptyWorkspace();
  const onboarding = options.onboarding ?? pendingOnboarding();
  const harness: Harness = {
    workspace,
    onboarding,
    commands: [],
    profilePosts: [],
    finishPosts: [],
    finishChoices: [],
  };
  await page.route('**/api/v1/system/status', (route) => route.fulfill({ json: statusBody }));
  await page.route('**/api/v1/me', (route) => {
    if (options.consentRequired)
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: 'CONSENT_REQUIRED',
            message: 'É necessário aceitar os documentos legais vigentes para continuar.',
            requestId: '00000000-0000-4000-8000-000000000000',
          },
        },
      });
    if (options.signedIn === false)
      return route.fulfill({
        status: 401,
        json: {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Entre com a conta autorizada para continuar.',
            requestId: '00000000-0000-4000-8000-000000000000',
          },
        },
      });
    return route.fulfill({
      json: {
        user: { id: 'fixture-owner', name: onboarding.displayName },
        organization: { id: '00000000-0000-4000-8000-000000000001', role: 'owner' },
        expiresAt: '2099-09-01T00:00:00Z',
      },
    });
  });
  await page.route('**/api/v1/onboarding', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        step?: string;
        displayName?: string;
        timezone?: string;
        firstBet?: 'registered' | 'deferred';
      };
      if (body.step === 'profile') {
        harness.profilePosts.push(1);
        onboarding.displayName = body.displayName ?? onboarding.displayName;
        onboarding.timezone = body.timezone ?? onboarding.timezone;
        onboarding.steps.profile = { completed: true, completedAt: new Date().toISOString() };
      }
      if (body.step === 'finish') {
        harness.finishPosts.push(1);
        harness.finishChoices.push(body.firstBet ?? null);
        if (!onboarding.steps.firstBet.completed && body.firstBet)
          onboarding.steps.firstBet = { completed: true, resolution: body.firstBet };
        onboarding.completedAt = new Date().toISOString();
      }
    }
    return route.fulfill({ json: onboarding });
  });
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/v1/commands', (route) => {
    const body = route.request().postDataJSON() as { type?: string; name?: string };
    harness.commands.push(body);
    if (body.type === 'catalog.create') {
      workspace.catalog.push({
        id: house,
        kind: 'bookmaker',
        name: String(body.name),
        aliases: [],
        active: true,
      });
    }
    if (body.type === 'bankroll.initialize') {
      workspace.initialized = true;
      onboarding.steps.bankroll.completed = true;
      workspace.version++;
    }
    if (body.type === 'bet.create')
      onboarding.steps.firstBet = { completed: true, resolution: 'registered' };
    workspace.version++;
    return route.fulfill({ json: { id: crypto.randomUUID(), version: workspace.version } });
  });
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: reportFixture() }));
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  return harness;
}
async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= (visualViewport?.width ?? innerWidth),
    ),
  ).toBe(true);
}

test('first steps: profile, first bankroll (new house) and first manual bet survive reloads', async ({
  page,
}, info) => {
  const harness = await enableOnboarding(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Primeiros passos', level: 2 })).toBeVisible();
  await noHorizontalOverflow(page);

  // Step 1 — profile, time zone and preferences.
  await page.getByLabel('Nome exibido').fill('Rhian Beta');
  await page.getByLabel('Fuso horário').fill('America/Sao_Paulo');
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('onboarding-step2.png'), fullPage: true });

  // Reload in the middle of the flow: the server state resumes the correct step.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adicionar casa' })).toBeVisible();

  // Step 2 — first house, then the explicit balance confirmation (reuses the existing flows).
  await page.getByRole('button', { name: 'Adicionar casa' }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Bet365');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByLabel('Bet365 (R$)', { exact: true })).toBeVisible();
  await page.getByLabel('Reserva (R$)', { exact: true }).fill('500,00');
  await page.getByLabel('Bet365 (R$)', { exact: true }).fill('250,00');
  await page.getByRole('button', { name: 'Confirmar saldos iniciais' }).click();
  expect(
    harness.commands.filter((item) => (item as { type?: string }).type === 'bankroll.initialize'),
  ).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirmar saldos iniciais' }).click();
  const initialized = harness.commands.find(
    (item) => (item as { type?: string }).type === 'bankroll.initialize',
  );
  expect(initialized).toMatchObject({
    reserve: '500.00',
    unitPercent: '1.00',
    balances: [{ bookmakerId: house, amount: '250.00' }],
  });

  // Reload again: the bankroll step is derived from the financial core.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sua primeira aposta' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('onboarding-step3.png'), fullPage: true });

  // Step 3 — first manual bet through the existing form.
  await page.getByRole('button', { name: 'Registrar aposta manual' }).click();
  await expect(page.getByRole('dialog')).toContainText('Nova aposta');
  await page.getByLabel('Casa de aposta').selectOption({ label: 'Bet365' });
  await page.getByLabel('Valor apostado (R$)').fill('100,00');
  await page.getByLabel('Odd total').fill('1,85');
  await page.getByLabel('Evento 1', { exact: true }).fill('Time A × Time B');
  await page.getByLabel('Mercado 1', { exact: true }).fill('Gols');
  await page.getByLabel('Palpite 1', { exact: true }).fill('Mais de 2,5');
  await page.getByRole('button', { name: 'Registrar aposta' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Primeira aposta registrada')).toBeVisible();

  // Finish explicitly and land on the regular overview.
  await page.getByRole('button', { name: 'Concluir primeiros passos' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  expect(harness.finishChoices).toEqual(['registered']);
});

test('concluding without a bet requires the explicit deferral choice', async ({ page }) => {
  const onboarding = pendingOnboarding();
  onboarding.timezone = 'America/Sao_Paulo';
  onboarding.steps.profile = { completed: true, completedAt: '2026-09-16T12:00:00.000Z' };
  onboarding.steps.bankroll = { completed: true };
  const workspace = emptyWorkspace();
  workspace.initialized = true;
  const harness = await enableOnboarding(page, { onboarding, workspace });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua primeira aposta' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar sem registrar aposta' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  expect(harness.finishChoices).toEqual(['deferred']);
  expect(harness.onboarding.steps.firstBet).toEqual({
    completed: true,
    resolution: 'deferred',
  });
});

test('an onboarding lookup failure surfaces an error state with retry, never the overview', async ({
  page,
}) => {
  let failing = true;
  const harness = await enableOnboarding(page);
  // Last match wins: while `failing`, every lookup answers a sanitized server error.
  await page.route('**/api/v1/onboarding', (route) =>
    failing
      ? route.fulfill({
          status: 500,
          json: {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Não foi possível concluir a solicitação.',
              requestId: '00000000-0000-4000-8000-000000000000',
            },
          },
        })
      : route.fulfill({ json: harness.onboarding }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Não foi possível carregar seu progresso');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('heading', { name: 'Primeiros passos', level: 2 })).toBeVisible();
});

test('an invalid time zone keeps the user on the profile step with a clear error', async ({
  page,
}) => {
  const harness = await enableOnboarding(page);
  await page.goto('/');
  await page.getByLabel('Fuso horário').fill('Invalid/Zone');
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
  await expect(page.getByText(/fuso horário IANA válido/)).toBeVisible();
  expect(harness.profilePosts).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'Seu perfil' })).toBeVisible();
});

test('a pending consent shows the consent screen instead of the onboarding', async ({ page }) => {
  await enableOnboarding(page, { consentRequired: true });
  await page.route('**/api/v1/consents/status', (route) =>
    route.fulfill({
      json: {
        status: 'pending',
        documents: [
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
        ],
        pendingTypes: ['terms_of_use'],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByText('Antes de continuar.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Primeiros passos' })).toHaveCount(0);
});

test('an unauthenticated visitor never sees the onboarding', async ({ page }) => {
  await enableOnboarding(page, { signedIn: false });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Entrar com Google/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Primeiros passos' })).toHaveCount(0);
});

test('a finished onboarding opens the regular overview without the first-steps flow', async ({
  page,
}) => {
  const workspace = emptyWorkspace();
  workspace.initialized = true;
  await enableOnboarding(page, { onboarding: finishedOnboarding(), workspace });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Primeiros passos' })).toHaveCount(0);
});

test('the Telegram route only explains the upcoming connector and writes nothing', async ({
  page,
}) => {
  const onboarding = pendingOnboarding();
  onboarding.timezone = 'America/Sao_Paulo';
  onboarding.steps.profile = { completed: true, completedAt: '2026-09-16T12:00:00.000Z' };
  onboarding.steps.bankroll = { completed: true };
  const workspace = emptyWorkspace();
  workspace.initialized = true;
  const harness = await enableOnboarding(page, { onboarding, workspace });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua primeira aposta' })).toBeVisible();
  await page.getByRole('button', { name: 'Conectar Telegram' }).click();
  await expect(page.getByText(/STK-F2-04/)).toBeVisible();
  expect(harness.finishPosts).toHaveLength(0);
  expect(harness.finishChoices).toHaveLength(0);
  expect(harness.commands).toHaveLength(0);
});

test('the stepper resumes on the first incomplete step with accessible progress', async ({
  page,
}) => {
  const onboarding = pendingOnboarding();
  onboarding.timezone = 'America/Sao_Paulo';
  onboarding.steps.profile = { completed: true, completedAt: '2026-09-16T12:00:00.000Z' };
  const harness = await enableOnboarding(page, { onboarding });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Etapas dos primeiros passos' });
  await expect(steps.getByRole('listitem').first()).toContainText('(concluída)');
  await expect(steps.locator('[aria-current="step"]')).toContainText('Primeira banca');
  await expect(page.locator('.onboarding-progress')).toContainText('Passo 2 de 3');
  expect(harness.profilePosts).toHaveLength(0);
});

test('the onboarding is fully operable by keyboard with visible focus', async ({ page }) => {
  const harness = await enableOnboarding(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Seu perfil' })).toBeVisible();
  await page.getByLabel('Nome exibido').focus();
  await page.keyboard.type('Rhian Teclado');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Fuso horário')).toBeFocused();
  await page.keyboard.type('America/Sao_Paulo');
  await page.keyboard.press('Tab');
  const save = page.getByRole('button', { name: 'Salvar e continuar' });
  await expect(save).toBeFocused();
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).not.toBeNull();
  expect(outline && outline.style === 'solid' && outline.width !== '0px').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  const add = page.getByRole('button', { name: 'Adicionar casa' });
  await add.focus();
  await add.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Nome', { exact: true }).fill('Bet365');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByLabel('Bet365 (R$)', { exact: true })).toBeVisible();
  await page.getByLabel('Reserva (R$)', { exact: true }).fill('400,00');
  await page.getByLabel('Bet365 (R$)', { exact: true }).fill('200,00');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirmar saldos iniciais' }).click();
  await expect(page.getByRole('heading', { name: 'Sua primeira aposta' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Escolha da primeira aposta' })).toBeVisible();
  const defer = page.getByRole('button', { name: 'Continuar sem registrar aposta' });
  await defer.focus();
  await defer.press('Enter');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  expect(harness.finishChoices).toEqual(['deferred']);
});

test('double submits of the profile step are prevented while the save is in flight', async ({
  page,
}) => {
  const harness = await enableOnboarding(page);
  await page.route('**/api/v1/onboarding', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = req.postDataJSON() as { step?: string; displayName?: string; timezone?: string };
    if (body.step !== 'profile') return route.fallback();
    harness.profilePosts.push(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    harness.onboarding.steps.profile = { completed: true, completedAt: new Date().toISOString() };
    harness.onboarding.displayName = body.displayName ?? harness.onboarding.displayName;
    harness.onboarding.timezone = body.timezone ?? harness.onboarding.timezone;
    return route.fulfill({ json: harness.onboarding });
  });
  await page.goto('/');
  await page.getByLabel('Nome exibido').fill('Rhian Duplo');
  await page.getByLabel('Fuso horário').fill('America/Sao_Paulo');
  const save = page.getByRole('button', { name: /Salvar|Salvando/ });
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  expect(harness.profilePosts).toHaveLength(1);
});

test('a finish failure keeps the step open, is announced and offers an explicit retry', async ({
  page,
}) => {
  let failing = true;
  const onboarding = pendingOnboarding();
  onboarding.timezone = 'America/Sao_Paulo';
  onboarding.steps.profile = { completed: true, completedAt: '2026-09-16T12:00:00.000Z' };
  onboarding.steps.bankroll = { completed: true };
  const workspace = emptyWorkspace();
  workspace.initialized = true;
  const harness = await enableOnboarding(page, { onboarding, workspace });
  await page.route('**/api/v1/onboarding', async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { step?: string } | null;
    if (req.method() === 'POST' && body?.step === 'finish' && failing) {
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Não foi possível concluir a solicitação.',
            requestId: '00000000-0000-4000-8000-000000000000',
          },
        },
      });
    }
    return route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sua primeira aposta' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar sem registrar aposta' }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível concluir a solicitação.');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  expect(harness.finishChoices).toEqual(['deferred']);
});

test('the onboarding adapts to a mobile viewport without horizontal overflow', async ({
  page,
}, info) => {
  await enableOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Primeiros passos', level: 2 })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByLabel('Nome exibido').fill('Rhian Mobile');
  await page.getByLabel('Fuso horário').fill('America/Sao_Paulo');
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Sua primeira banca' })).toBeVisible();
  const add = page.getByRole('button', { name: 'Adicionar casa' });
  await expect(add).toBeVisible();
  const box = await add.boundingBox();
  expect(box && box.height >= 40).toBe(true);
  await page.screenshot({ path: info.outputPath('onboarding-mobile.png'), fullPage: true });
  await noHorizontalOverflow(page);
});
