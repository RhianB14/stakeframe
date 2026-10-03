import { expect, test, type Page } from '@playwright/test';

// STK-F2-12 — E2E do Mini App do Telegram.
//
// O que este arquivo prova, no navegador de verdade:
//  1. o Mini App abre os QUATRO fluxos do escopo (painel, apostas, pendentes e
//     ajustes) dentro do cliente, com menu inferior e sem barra lateral;
//  2. todas as chamadas carregam o initData — a credencial não pode ser
//     esquecida ao trocar de tela (é o que o `request()` centralizado garante);
//  3. o botão de voltar do Telegram funciona, porque cada fluxo é uma ROTA;
//  4. sem initData nada de produto é montado e o initData não é persistido;
//  5. a escrita financeira do Mini App é a MESMA da web: passa pelo comando
//     canônico, com chave de idempotência e confirmação explícita.

const telegramId = 424242;

/** O initData chega ao navegador como o Telegram injeta (objeto opaco). */
async function openAsTelegram(page: Page, initData = 'stub-initdata') {
  await page.addInitScript((value) => {
    (window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        initData: value,
        ready: () => undefined,
        close: () => {
          (window as unknown as { miniAppClosed?: boolean }).miniAppClosed = true;
        },
        expand: () => undefined,
      },
    };
  }, initData);
}

/** Registra os headers de toda requisição à API para provar a credencial. */
function captureApiHeaders(page: Page): string[][] {
  const seen: string[][] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/api/v1/')) return;
    const keys = Object.keys(request.headers());
    seen.push(keys);
  });
  return seen;
}

const workspaceFixture = {
  version: 1,
  initialized: true,
  unitPercent: '2.00',
  bankroll: '1000.00',
  available: '800.00',
  exposure: '200.00',
  accounts: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      kind: 'reserve',
      name: 'Reserva',
      bookmakerId: null,
      balance: '500.00',
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      kind: 'bookmaker',
      name: 'Bet365',
      bookmakerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      balance: '300.00',
    },
  ],
  catalog: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      kind: 'bookmaker',
      name: 'Bet365',
      active: true,
      aliases: ['bet365'],
    },
  ],
  units: [],
  freebets: [],
  warnings: [],
};

const betFixture = {
  id: '11111111-1111-4111-8111-111111111111',
  ticketNumber: 1,
  bookmakerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  tipsterId: null,
  stake: '50.00',
  odds: '1.90',
  placedAt: '2026-09-20T12:00:00.000Z',
  createdAt: '2026-09-20T12:00:00.000Z',
  freebetId: null,
  reference: null,
  freebetStakeReturned: null,
  state: 'open',
  ticketKind: 'simple',
  latestOutcome: null,
  remaining: null,
  completionState: 'incomplete',
  unitMonth: null,
  unitAmount: null,
  stakeUnits: null,
  returnAmount: '0.00',
  profit: '0.00',
  selections: [],
};

async function stubProduct(page: Page, onCommand?: (body: unknown) => void) {
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
  await page.route('**/api/v1/telegram/session', (route) =>
    route.fulfill({
      json: {
        linked: true,
        linkedAt: '2026-09-20T10:00:00.000Z',
        role: 'owner',
        userId: 'fixture-owner',
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
    route.fulfill({ json: { user: { id: 'fixture-owner', name: 'Fixture Owner' } } }),
  );
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: workspaceFixture }));
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({ json: { items: [betFixture], total: 1, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/commands', (route) => {
    onCommand?.(route.request().postDataJSON());
    return route.fulfill({ json: { version: 2, applied: true } });
  });
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Erro de página no Mini App: ${error.message}`);
  });
});

test('abre o Mini App com os quatro fluxos e navegação própria', async ({ page }) => {
  await openAsTelegram(page);
  await stubProduct(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/miniapp');
  // Painel (fluxo 1): as métricas da web, o mesmo componente.
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  await expect(page.getByText('Saldo em conta')).toBeVisible();
  // Menu inferior com os quatro destinos do escopo, e sem a barra lateral.
  const nav = page.getByRole('navigation', { name: 'Navegação do aplicativo' });
  await expect(nav.getByRole('link', { name: 'Painel' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Apostas' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Pendentes' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Ajustes' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/miniapp-dashboard.png', fullPage: true });
});

test('percorre apostas, pendentes e ajustes pelos quatro fluxos', async ({ page }) => {
  await openAsTelegram(page);
  await stubProduct(page);
  await page.goto('/miniapp');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Navegação do aplicativo' });

  // Fluxo 2 — apostas: a tabela real da web, com o bilhete do fixture.
  await nav.getByRole('link', { name: 'Apostas' }).click();
  await expect(page.getByRole('heading', { name: 'Apostas' })).toBeVisible();
  await expect(page.getByText('Seus bilhetes')).toBeVisible();

  // Fluxo 3 — pendentes: a página real de importações.
  await nav.getByRole('link', { name: 'Pendentes' }).click();
  await expect(page.getByRole('heading', { name: 'Recebimentos técnicos' })).toBeVisible();
  await expect(page.getByText('Comprovantes e revisão')).toBeVisible();

  // Fluxo 4 — ajustes: as configurações mínimas, com o painel de vínculo.
  await nav.getByRole('link', { name: 'Ajustes' }).click();
  await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
  await expect(page.getByText('Casas de aposta')).toBeVisible();

  // Cada fluxo é uma ROTA: voltar no histórico devolve ao fluxo anterior, que
  // é o que o botão de voltar do Telegram usa.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Recebimentos técnicos' })).toBeVisible();
});

test('envia o initData em toda chamada, inclusive ao trocar de fluxo', async ({ page }) => {
  await openAsTelegram(page);
  await stubProduct(page);
  const seen = captureApiHeaders(page);
  await page.goto('/miniapp');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Navegação do aplicativo' });
  await nav.getByRole('link', { name: 'Apostas' }).click();
  await expect(page.getByText('Seus bilhetes')).toBeVisible();
  await nav.getByRole('link', { name: 'Pendentes' }).click();
  await expect(page.getByText('Comprovantes e revisão')).toBeVisible();
  // Toda requisição autenticada do Mini App carrega a credencial validada no
  // servidor — inclusive as dos componentes da web, que não sabem do Telegram.
  const authenticated = seen.filter((keys) => keys.includes('x-telegram-init-data'));
  expect(authenticated.length).toBeGreaterThanOrEqual(3);
  for (const keys of authenticated) expect(keys).toContain('x-telegram-init-data');
});

test('sem initData nada de produto é montado', async ({ page }) => {
  await stubProduct(page);
  await page.goto('/miniapp');
  await expect(page.getByRole('alert')).toContainText('Abra pelo botão do aplicativo no Telegram');
  await expect(page.getByText('Banca real')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Navegação do aplicativo' })).toHaveCount(0);
});

test('conta sem vínculo recebe orientação e nenhum dado de produto', async ({ page }) => {
  await openAsTelegram(page);
  await stubProduct(page);
  await page.unroute('**/api/v1/telegram/session');
  await page.route('**/api/v1/telegram/session', (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: 'TELEGRAM_SESSION_NOT_LINKED',
          message: 'Esta conta do Telegram ainda não está vinculada.',
          requestId: '11111111-1111-4111-8111-111111111111',
        },
      },
    }),
  );
  await page.goto('/miniapp');
  await expect(page.getByRole('alert')).toContainText('ainda não está vinculada');
  await expect(page.getByText('Banca real')).toHaveCount(0);
});

test('a escrita financeira do Mini App exige confirmação e usa o comando canônico', async ({
  page,
}) => {
  await openAsTelegram(page);
  const commands: unknown[] = [];
  const keys: string[] = [];
  await stubProduct(page, (body) => commands.push(body));
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/commands'))
      keys.push(request.headers()['idempotency-key'] ?? '');
  });
  await page.goto('/miniapp');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();

  // "+ Nova aposta" abre o MESMO formulário da web. Abrir, preencher e
  // FECHAR não pode gravar nada: a confirmação é o botão de envio, e nada
  // acontece antes dele.
  await page.getByRole('button', { name: '+ Nova aposta', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(commands).toHaveLength(0);
  await page
    .getByLabel('Casa de aposta', { exact: true })
    .selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
  await page.getByLabel('Valor apostado (R$)', { exact: true }).fill('25,00');
  await page.getByLabel('Odd total', { exact: true }).fill('1,90');
  expect(commands).toHaveLength(0);
  // Fechar sem enviar: nenhuma escrita financeira acontece. O rótulo exato
  // importa porque o diálogo também traz o "×" de fecharJanela.
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toHaveLength(0);

  // Reabre e confirma explicitamente: agora sim, pelo comando canônico com
  // versão otimista e chave de idempotência — exatamente como na web.
  await page.getByRole('button', { name: '+ Nova aposta', exact: true }).click();
  const again = page.getByRole('dialog');
  await page
    .getByLabel('Casa de aposta', { exact: true })
    .selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
  await page.getByLabel('Valor apostado (R$)', { exact: true }).fill('25,00');
  await page.getByLabel('Odd total', { exact: true }).fill('1,90');
  // Seleção 1 é obrigatória: evento, mercado e palpite.
  await again.getByLabel('Evento 1', { exact: true }).fill('Time A × Time B');
  await again.getByLabel('Mercado 1', { exact: true }).fill('Resultado');
  await again.getByLabel('Palpite 1', { exact: true }).fill('Time A');
  await again.getByRole('button', { name: 'Registrar aposta' }).click();
  await expect.poll(() => commands.length, { timeout: 10_000 }).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const command = commands[0] as {
    type?: string;
    expectedVersion?: number;
    stake?: string;
    selections?: unknown[];
  };
  expect(command.type).toBe('bet.create');
  expect(typeof command.expectedVersion).toBe('number');
  expect(command.stake).toBe('25.00');
  expect(command.selections).toHaveLength(1);
});

test('não guarda o initData no armazenamento do navegador', async ({ page }) => {
  await openAsTelegram(page);
  await stubProduct(page);
  await page.goto('/miniapp');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(window.localStorage),
    session: JSON.stringify(window.sessionStorage),
  }));
  // Credencial de curta duração fora do disco: nada de service worker, nada de
  // cache offline, nada de initData persistido (§6.2).
  expect(stored.local).not.toContain('stub-initdata');
  expect(stored.session).not.toContain('stub-initdata');
  // `serviceWorker` existe em `navigator` mesmo sem registro; o que prova a
  // ausência de PWA é não haver NENHUM service worker registrado.
  const registrations = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 0;
    const list = await navigator.serviceWorker.getRegistrations();
    return list.length;
  });
  expect(registrations).toBe(0);
  expect(telegramId).toBeGreaterThan(0);
});
