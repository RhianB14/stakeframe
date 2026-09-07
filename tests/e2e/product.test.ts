import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  saoPauloDate,
  type Workspace,
  type Bet,
  type ImportDetail,
  type CalendarItem,
  type EventSearch,
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
test('tabs with copied session storage recover their own uncertain uploads independently', async ({
  page,
  context,
}) => {
  await enabledProduct(page);
  await importRoutes(page);
  await page.goto('/#imports');
  await page.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enviar para revisão' })).toBeEnabled();
  const inheritedSlot = await page.evaluate(() => sessionStorage.getItem('stakeframe.upload-slot'));
  expect(inheritedSlot).toBeTruthy();
  const duplicate = await context.newPage();
  await enabledProduct(duplicate);
  await importRoutes(duplicate);
  await duplicate.goto('/#imports');
  // Match the copied sessionStorage of a duplicated tab/opener before the form claims ownership.
  await duplicate.evaluate(
    (slot) => sessionStorage.setItem('stakeframe.upload-slot', slot!),
    inheritedSlot,
  );
  await duplicate.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
  await expect(duplicate.getByRole('button', { name: 'Enviar para revisão' })).toBeEnabled();
  expect(await duplicate.evaluate(() => sessionStorage.getItem('stakeframe.upload-slot'))).not.toBe(
    inheritedSlot,
  );
  const attempts: { key: string | undefined; body: unknown }[][] = [[], []];
  for (const [index, tab] of [page, duplicate].entries()) {
    await tab.route('**/api/v1/imports', async (route) => {
      attempts[index]!.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      if (attempts[index]!.length === 1) await route.abort('failed');
      else await route.fulfill({ json: { id: importId } });
    });
    await tab.getByLabel('Imagem do comprovante').setInputFiles(imageFile);
    await tab.getByLabel('Legenda (opcional)').fill(`Analista ${index + 1}\nBet365`);
    await tab.getByRole('button', { name: 'Enviar para revisão' }).click();
    await expect(tab.getByRole('button', { name: 'Verificar envio' })).toBeVisible();
  }
  expect(attempts[0]![0]!.key).not.toBe(attempts[1]![0]!.key);
  for (const [index, tab] of [page, duplicate].entries()) {
    await tab.reload();
    await tab.getByRole('button', { name: 'Enviar comprovante', exact: true }).click();
    await tab.getByRole('button', { name: 'Verificar envio' }).click();
    await expect(
      tab.getByRole('heading', { name: 'Revisar importação', exact: true }),
    ).toBeVisible();
    expect(attempts[index]).toHaveLength(2);
    expect(attempts[index]![0]).toEqual(attempts[index]![1]);
    expect(attempts[index]![1]!.body).toMatchObject({ caption: `Analista ${index + 1}\nBet365` });
  }
  await duplicate.close();
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

const selectionId = '10000000-0000-4000-8000-000000000010';
function calendarItem(): CalendarItem {
  return {
    selection: {
      ...bet.selections[0]!,
      id: selectionId,
      eventDate: '2026-09-05',
      dateStatus: 'confirmed',
    },
    betId,
    betReference: 'Bilhete 12',
    bookmaker: 'Bet365',
    betState: 'open',
    dateSource: 'manual',
    dateEvidence: null,
    scheduleStatus: 'scheduled',
  };
}
async function eventRoutes(
  page: Page,
  item = calendarItem(),
  searches: EventSearch[] = [],
  enabled = false,
) {
  await page.route('**/api/v1/calendar?*', (route) => {
    const pending = new URL(route.request().url()).searchParams.get('view') === 'pending';
    return route.fulfill({
      json: {
        items: pending
          ? [
              {
                ...item,
                selection: {
                  ...item.selection,
                  eventDate: null,
                  eventAt: null,
                  dateStatus: 'pending',
                },
              },
            ]
          : [
              item,
              {
                ...item,
                selection: {
                  ...item.selection,
                  id: '10000000-0000-4000-8000-000000000011',
                  market: 'Gols',
                },
              },
            ],
        total: pending ? 1 : 2,
        distinctBets: 1,
        pendingSelections: 1,
        page: 1,
        pageSize: 25,
      },
    });
  });
  await page.route(`**/api/v1/events/${selectionId}`, (route) => route.fulfill({ json: item }));
  await page.route('**/api/v1/event-search/status', (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            provider: 'thesportsdb',
            enabled,
            dailyUsed: 1,
            dailyLimit: 60,
            monthlyUsed: 2,
            monthlyLimit: 1500,
          },
          {
            provider: 'tavily',
            enabled: false,
            dailyUsed: 0,
            dailyLimit: 20,
            monthlyUsed: 0,
            monthlyLimit: 600,
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/event-search?*', (route) => route.fulfill({ json: searches }));
}
test('calendar distinguishes selections from bets and saves a partial date without inventing a time', async ({
  page,
}, info) => {
  await enabledProduct(page);
  await eventRoutes(page);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/v1/commands', (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: betId, version: 2 } });
  });
  await page.goto('/#calendar');
  await page.getByLabel('Mês do calendário').fill('2026-09');
  await expect(page.getByText('2 seleções · 1 aposta distinta')).toBeVisible();
  const agenda = page.getByRole('region', { name: 'Agenda de eventos' });
  await expect(agenda).not.toContainText('R$');
  await page.screenshot({ path: info.outputPath('product-calendar.png'), fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= (visualViewport?.width ?? innerWidth),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Pendências (1)' }).click();
  await expect(page.getByRole('heading', { name: 'Datas a conferir' })).toBeVisible();
  await expect(page.getByText('Sem data', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Conferir data', exact: true }).click();
  await expect(
    page.getByText('Fonte desativada neste ambiente. O preenchimento manual está disponível.'),
  ).toBeVisible();
  await page.getByLabel('Data do evento', { exact: true }).fill('2026-09-09');
  await page.getByLabel('Motivo da atualização').fill('Data confirmada na programação oficial');
  await page.getByRole('checkbox', { name: /Conferi o evento, a data e o fuso/ }).check();
  await page.getByRole('button', { name: 'Salvar data conferida' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    type: 'event.update',
    selectionId,
    eventDate: '2026-09-09',
    eventAt: null,
    dateStatus: 'confirmed',
    candidateId: null,
    expectedVersion: 1,
  });
});
test('source results preserve a manual date until explicitly selected and reviewed across a UTC day boundary', async ({
  page,
}, info) => {
  const item = calendarItem();
  const candidateId = '10000000-0000-4000-8000-000000000012';
  const search: EventSearch = {
    id: '10000000-0000-4000-8000-000000000013',
    selectionId,
    provider: 'thesportsdb',
    query: item.selection.event,
    dateHint: null,
    state: 'complete',
    errorCode: null,
    cached: false,
    createdAt: '2026-09-01T12:00:00Z',
    candidates: [
      {
        id: candidateId,
        provider: 'thesportsdb',
        title: 'Aurora vs Central',
        url: 'https://www.thesportsdb.com/event/123',
        excerpt: 'Liga fictícia',
        rawDate: '2026-09-01',
        rawTime: '00:30:00Z',
        suggestedAt: '2026-09-01T00:30:00Z',
        postponed: false,
      },
    ],
  };
  await enabledProduct(page);
  await eventRoutes(page, item, [search]);
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/v1/commands', (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: betId, version: 2 } });
  });
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Conferir data', exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'Aurora vs Central ↗' })).toBeVisible();
  await expect(page.getByLabel('Data do evento', { exact: true })).toHaveValue('2026-09-05');
  expect(commands).toHaveLength(0);
  await page.getByRole('button', { name: 'Usar esta fonte na conferência' }).click();
  await expect(page.getByLabel('Data do evento', { exact: true })).toHaveValue('2026-08-31');
  await expect(page.getByLabel('Horário em São Paulo (opcional)')).toHaveValue('21:30:00');
  await expect(page.getByLabel('Confiança na data')).toHaveValue('estimated');
  await page.getByLabel('Confiança na data').selectOption('confirmed');
  await page.getByLabel('Motivo da atualização').fill('Mesmo evento, horário e fuso conferidos');
  await page.getByRole('checkbox', { name: /Conferi o evento, a data e o fuso/ }).check();
  await page.screenshot({ path: info.outputPath('event-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Salvar data conferida' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands[0]).toMatchObject({
    type: 'event.update',
    eventDate: '2026-08-31',
    eventAt: '2026-09-01T00:30:00.000Z',
    candidateId,
    dateStatus: 'confirmed',
  });
});
test('an uncertain event search reuses its key and input after reloading without retrying automatically', async ({
  page,
}) => {
  const item = calendarItem();
  await enabledProduct(page);
  await eventRoutes(page, item, [], true);
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route('**/api/v1/event-search', async (route) => {
    attempts.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    });
    if (attempts.length === 1) await route.abort('failed');
    else
      await route.fulfill({
        json: {
          id: attempts[0]!.key,
          selectionId,
          provider: 'thesportsdb',
          query: item.selection.event,
          dateHint: '2026-09-05',
          state: 'pending',
          candidates: [],
          errorCode: null,
          cached: false,
          createdAt: '2026-09-01T12:00:00Z',
        },
      });
  });
  await page.goto('/#calendar');
  await page.getByRole('button', { name: 'Conferir data', exact: true }).first().click();
  await page.getByRole('button', { name: 'Buscar programação' }).click();
  await expect(page.getByRole('button', { name: 'Verificar consulta' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Conferir data', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Verificar consulta' })).toBeVisible();
  expect(attempts).toHaveLength(1);
  await page.getByRole('button', { name: 'Verificar consulta' }).click();
  await expect(page.getByRole('button', { name: 'Buscar programação' })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
});
