import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  saoPauloDate,
  type Workspace,
  type Bet,
  type ImportDetail,
} from '../../packages/shared/src/index.js';

const house = '10000000-0000-4000-8000-000000000001';
const reserve = '10000000-0000-4000-8000-000000000002';
const houseAccount = '10000000-0000-4000-8000-000000000003';
const betId = '10000000-0000-4000-8000-000000000004';
function fixture(): Workspace {
  return {
    version: 1,
    initialized: true,
    unitPercent: '1.00',
    bankroll: '1000.00',
    available: '900.00',
    exposure: '100.00',
    accounts: [
      { id: reserve, kind: 'reserve', name: 'Reserva', bookmakerId: null, balance: '500.00' },
      {
        id: houseAccount,
        kind: 'bookmaker',
        name: 'Bet365',
        bookmakerId: house,
        balance: '400.00',
      },
    ],
    catalog: [{ id: house, kind: 'bookmaker', name: 'Bet365', aliases: ['bet 365'], active: true }],
    units: [
      {
        month: saoPauloDate(new Date()).slice(0, 7),
        amount: '10.00',
        base: '1000.00',
        percent: '1.00',
        source: 'initial',
      },
    ],
    freebets: [],
    warnings: [],
  };
}
const bet: Bet = {
  id: betId,
  bookmakerId: house,
  tipsterId: null,
  stake: '100.00',
  odds: '2.00',
  placedAt: '2026-09-01T18:00:00Z',
  createdAt: '2026-09-01T18:00:00Z',
  freebetId: null,
  freebetStakeReturned: null,
  reference: '',
  state: 'open',
  remaining: '100.00',
  unitMonth: '2026-09',
  unitAmount: '10.00',
  stakeUnits: '10.000000',
  returnAmount: '0.00',
  profit: '0.00',
  selections: [
    {
      event: 'Aurora × Central',
      sport: 'Futebol',
      market: 'Gols',
      selection: 'Mais de 2,5',
      odds: null,
      eventDate: null,
      eventAt: null,
      dateStatus: 'pending',
    },
  ],
};
async function enabledProduct(page: Page, workspace = fixture(), bets: Bet[] = []) {
  await page.route('**/api/v1/system/status', (route) =>
    route.fulfill({
      json: {
        name: 'Stakeframe',
        stage: 'local-setup',
        database: 'available',
        authentication: 'google',
        productEnabled: true,
      },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'fixture-owner', name: 'Fixture Owner' },
        expiresAt: '2099-09-01T00:00:00Z',
      },
    }),
  );
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/v1/bets?*', (route) =>
    route.fulfill({ json: { items: bets, total: bets.length, page: 1, pageSize: 25 } }),
  );
  await page.route(`**/api/v1/bets/${betId}`, (route) =>
    route.fulfill({ json: { bet, settlements: [] } }),
  );
  await page.route('**/api/v1/journal?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }),
  );
}
test('private workspace renders real fixture amounts, usable navigation and responsive layouts', async ({
  page,
}, info) => {
  await enabledProduct(page, fixture(), [bet]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible();
  await expect(page.getByText('R$ 1.000,00', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= (visualViewport?.width ?? innerWidth),
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('product-overview.png'), fullPage: true });
  await page.getByRole('link', { name: 'Apostas', exact: true }).click();
  await expect(page.getByLabel('Situação')).toBeVisible();
  await page.getByRole('button', { name: 'Ver aposta Aurora × Central' }).click();
  await expect(page.getByRole('dialog')).toContainText('Data do evento pendente');
  await page.screenshot({ path: info.outputPath('product-detail.png'), fullPage: true });
  await page.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByRole('link', { name: 'Configurações', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unidades mensais' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('first use requires explicit balance confirmation and preserves decimal strings', async ({
  page,
}) => {
  const workspace = fixture();
  workspace.initialized = false;
  workspace.units = [];
  workspace.bankroll = '0.00';
  workspace.available = '0.00';
  workspace.exposure = '0.00';
  workspace.accounts.forEach((item) => {
    item.balance = '0.00';
  });
  await enabledProduct(page, workspace);
  const commands: unknown[] = [];
  await page.route('**/api/v1/commands', (route) => {
    commands.push(route.request().postDataJSON());
    workspace.initialized = true;
    workspace.version++;
    return route.fulfill({ json: { id: 'initial', version: workspace.version } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '+ Nova aposta', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Conferir saldos iniciais' }).click();
  await page.getByLabel('Reserva (R$)', { exact: true }).fill('1.234,56');
  await page.getByLabel('Bet365 (R$)', { exact: true }).fill('765,44');
  await page.getByRole('button', { name: 'Confirmar saldos iniciais' }).click();
  expect(commands).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirmar saldos iniciais' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands[0]).toMatchObject({
    type: 'bankroll.initialize',
    expectedVersion: 1,
    reserve: '1234.56',
    balances: [{ bookmakerId: house, amount: '765.44' }],
  });
});
test('ambiguous network result is recovered with the same key and body after reload', async ({
  page,
}) => {
  const workspace = fixture();
  await enabledProduct(page, workspace);
  const requests: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/v1/commands', async (route) => {
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (requests.length === 1) {
      workspace.version = 2;
      await route.abort('failed');
    } else {
      await route.fulfill({ json: { id: 'committed-once', version: 2 } });
    }
  });
  await page.goto('/#finance');
  await page.getByRole('button', { name: '+ Entrada', exact: true }).click();
  await page.getByLabel('Valor (R$)', { exact: true }).fill('25,50');
  await page.getByLabel('Motivo / observação').fill('Aporte conferido');
  await page.getByRole('button', { name: 'Registrar movimentação' }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Verificar operação' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Verificar operação', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verificar operação', exact: true }).click();
  await expect(page.getByText('Uma operação aguarda confirmação.')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.body).toMatchObject({ expectedVersion: 1, amount: '25.50' });
  expect(
    await page.evaluate(() => sessionStorage.getItem('stakeframe.pending-command')),
  ).toBeNull();
});
test('partial cashout sends closed principal independently from received money', async ({
  page,
}) => {
  await enabledProduct(page, fixture(), [bet]);
  let command: unknown;
  await page.route('**/api/v1/commands', (route) => {
    command = route.request().postDataJSON();
    return route.fulfill({ json: { id: betId, version: 2 } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ver aposta Aurora × Central' }).click();
  await page.getByRole('button', { name: 'Liquidar aposta', exact: true }).click();
  await page.getByLabel('Resultado', { exact: true }).selectOption('partial_cashout');
  await page.getByLabel('Principal encerrado (R$)', { exact: true }).fill('40,00');
  await page.getByLabel('Valor recebido (R$)', { exact: true }).fill('25,00');
  await page.getByLabel('Conferência / justificativa').fill('Conferido na casa');
  await page.getByRole('button', { name: 'Confirmar liquidação' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(command).toMatchObject({
    type: 'bet.settle',
    outcome: 'partial_cashout',
    closedPrincipal: '40.00',
    returnAmount: '25.00',
  });
});
test('an expired API session removes cached private records', async ({ page }) => {
  await enabledProduct(page, fixture(), [bet]);
  await page.goto('/');
  await expect(page.getByText('R$ 1.000,00', { exact: true })).toBeVisible();
  await page.route('**/api/v1/me', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/v1/journal?*', (route) => route.fulfill({ status: 401, json: {} }));
  await page.getByRole('link', { name: 'Financeiro', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
  await expect(page.getByText('R$ 1.000,00', { exact: true })).toHaveCount(0);
});

const importId = '10000000-0000-4000-8000-000000000005';
const imageFile = fileURLToPath(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
function importFixture(): ImportDetail {
  return {
    item: {
      id: importId,
      source: 'web',
      caption: 'Analista\nBet365',
      state: 'review',
      version: 2,
      attempts: 1,
      createdAt: '2026-09-01T18:00:00Z',
      updatedAt: '2026-09-01T18:00:01Z',
      errorCode: null,
      betId: null,
      imageAvailable: true,
    },
    extraction: {
      bookmaker: 'Superbet',
      reference: 'BILHETE-FICTICIO',
      placedAtText: 'ontem, 15h',
      currency: null,
      stake: '25.50',
      odds: '2.10',
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'Aurora × Central',
          sport: 'Futebol',
          market: 'Gols',
          selection: 'Mais de 2,5',
          odds: null,
          eventDateText: 'amanhã',
        },
      ],
      warnings: ['Confira a casa e as datas'],
    },
    labels: { tipster: 'Analista', bookmaker: 'Bet365', requiresReview: false },
    matches: {
      tipsterId: null,
      captionBookmakerId: house,
      extractedBookmakerId: null,
      conflict: true,
    },
    duplicates: [],
    duplicateCount: 0,
    automatic: false,
    automaticReason: 'LAYOUT_NOT_VALIDATED',
  };
}
async function importRoutes(page: Page, detail = importFixture()) {
  await page.route('**/api/v1/imports?*', (route) =>
    route.fulfill({ json: { items: [detail.item], total: 1, page: 1, pageSize: 25 } }),
  );
  await page.route(`**/api/v1/imports/${importId}`, (route) => route.fulfill({ json: detail }));
  await page.route(`**/api/v1/imports/${importId}/image`, (route) =>
    route.fulfill({ contentType: 'image/png', body: readFileSync(imageFile) }),
  );
}
test('review displays conflicting evidence, leaves unknown dates blank and confirms one financial command', async ({
  page,
}, info) => {
  await enabledProduct(page);
  await importRoutes(page);
  const commands: unknown[] = [];
  await page.route('**/api/v1/commands', (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: betId, version: 2 } });
  });
  await page.goto('/#imports');
  await page.getByRole('button', { name: /Analista · Bet365/ }).click();
  await expect(page.getByRole('dialog')).toContainText('A casa da legenda diverge');
  await expect(page.getByLabel('Casa de aposta', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Data e hora da aposta', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Data do evento 1', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Valor apostado (R$)', { exact: true })).toHaveValue('25.50');
  expect(commands).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('import-review.png'), fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= (visualViewport?.width ?? innerWidth),
    ),
  ).toBe(true);
  await page.getByLabel('Casa de aposta', { exact: true }).selectOption(house);
  await page.getByLabel('Origem da aposta', { exact: true }).selectOption('');
  await page.getByLabel('Data e hora da aposta', { exact: true }).fill('2026-09-01T15:00');
  await page.getByRole('checkbox', { name: /Conferi casa, valor/ }).check();
  await page.getByRole('button', { name: 'Confirmar importação e registrar aposta' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    type: 'import.confirm',
    importId,
    expectedInboxVersion: 2,
    expectedVersion: 1,
    decision: {
      kind: 'create',
      bet: {
        bookmakerId: house,
        stake: '25.50',
        odds: '2.10',
        placedAt: '2026-09-01T18:00:00.000Z',
        freebetId: null,
        selections: [{ eventDate: null, eventAt: null, dateStatus: 'pending' }],
      },
    },
  });
});
test('upload recovers its original image, caption and key from durable browser storage after reload', async ({
  page,
}) => {
  await enabledProduct(page);
  await importRoutes(page);
  const sent: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/v1/imports', async (route) => {
    sent.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (sent.length === 1) await route.abort('failed');
    else await route.fulfill({ json: { id: importId } });
  });
  await page.goto('/#imports');
  await page.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
  await page.getByLabel('Imagem do comprovante').setInputFiles(imageFile);
  await page.getByLabel('Legenda (opcional)').fill('Analista\nBet365');
  await page.getByRole('button', { name: 'Enviar para revisão' }).click();
  await expect(page.getByRole('button', { name: 'Verificar envio' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
  await page.getByRole('button', { name: 'Verificar envio' }).click();
  await expect(
    page.getByRole('heading', { name: 'Revisar importação', exact: true }),
  ).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  await page.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
  await expect(page.getByLabel('Imagem do comprovante')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verificar envio' })).toHaveCount(0);
});
test('duplicate review links a selected existing bet without posting another stake', async ({
  page,
}) => {
  const detail = importFixture();
  detail.duplicates = [
    {
      betId,
      reference: 'Mesmo bilhete',
      bookmakerId: house,
      stake: '100.00',
      placedAt: bet.placedAt,
      reasons: ['image'],
    },
  ];
  detail.duplicateCount = 1;
  await enabledProduct(page, fixture(), [bet]);
  await importRoutes(page, detail);
  const commands: unknown[] = [];
  await page.route('**/api/v1/commands', (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: betId, version: 2 } });
  });
  await page.goto('/#imports');
  await page.getByRole('button', { name: /Analista · Bet365/ }).click();
  await expect(page.getByRole('heading', { name: 'Possíveis bilhetes repetidos' })).toBeVisible();
  await page.getByRole('button', { name: 'Vincular existente', exact: true }).click();
  await page.getByLabel('Aposta existente', { exact: true }).selectOption(betId);
  await page.getByLabel('Motivo do vínculo').fill('Mesmo bilhete reenviado');
  await page.getByRole('checkbox', { name: /Conferi que o comprovante/ }).check();
  await page.getByRole('button', { name: 'Vincular sem novo lançamento' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    type: 'import.confirm',
    decision: { kind: 'link', betId, reason: 'Mesmo bilhete reenviado' },
  });
  expect(commands[0]).not.toHaveProperty('decision.bet');
});
