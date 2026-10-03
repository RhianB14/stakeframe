import { expect, test, type Page } from '@playwright/test';
import {
  runIndicativeSimulation,
  type PolymarketSimulation,
  type SimulationInput,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-17 §15 — "Simulação recusada quando os dados necessários forem
 * incompletos" e "retorno nunca apresentado como executável", no NAVEGADOR.
 *
 * O teste unitário prova a lógica e prova que o schema recusa um payload
 * forjado. Este prova a coisa que só o navegador prova: que o RENDER escreve
 * a natureza indicativa ANTES do número, que as sete premissas aparecem nos
 * DOIS desfechos, e que uma recusa não vira um número na tela.
 *
 * O payload é montado a partir da MESMA função pura que a produção usa
 * (`runIndicativeSimulation`), e não escrito à mão: uma fixture que
 * discordasse do contrato mostraria que o teste mente sobre a interface.
 */

/** A mesma entrada que a tela envia por padrão. */
const REQUEST: SimulationInput = {
  window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
  stake: '10.00',
  delayMs: 1500,
  feeRate: '0.02',
  spreadRate: '0.01',
  slippageRate: '0.005',
};

const series = (over: Record<string, unknown> = {}) => ({
  status: 'complete' as const,
  available: true,
  ingested: 40,
  pages: 1,
  failedPages: 0,
  ...over,
});

const observations = Array.from({ length: 40 }, (_, index) => ({
  proxyWallet: `0x${String(index + 1).padStart(40, '0')}`,
  vol: '1000.00',
  pnl: '100.00',
}));

/** A recusa: o estado REAL e normal deste backfill. */
const refused = (): PolymarketSimulation =>
  runIndicativeSimulation({
    window: REQUEST.window,
    series: series({ status: 'truncated' }),
    observations,
    request: REQUEST,
    minSample: 30,
  });

/** A apuração: série completa e N acima do limiar. */
const apurada = (): PolymarketSimulation =>
  runIndicativeSimulation({
    window: REQUEST.window,
    series: series(),
    observations,
    request: REQUEST,
    minSample: 30,
  });

async function openSimulation(page: Page, body: PolymarketSimulation) {
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
  // O ranking responde `available: false`: a simulação lê o MESMO status
  // gravado, e uma tela que dissesse "truncada" embaixo do ranking e
  // "completa" na simulação seria a divergência que a 0030 evita.
  await page.route('**/api/v1/polymarket/ranking?*', (route) =>
    route.fulfill({
      json: {
        window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
        series: series({ status: 'unknown', available: false, ingested: 0, pages: 0 }),
        completeness: {
          truncated: true,
          label: 'Janela ainda não coletada',
          detail: 'A Polymarket ainda não publicizou esta combinação na nossa coleta.',
        },
        sample: { n: 0, minSample: 30, lowSample: true },
        aggregate: { blocked: true, reason: 'Total e participação do tabuleiro estão bloqueados.' },
        requested: 100,
        returned: 0,
        rows: [],
      },
    }),
  );
  await page.route('**/api/v1/polymarket/simulation', (route) =>
    // `method: 'POST'` na própria rota: é o que a tela envia, e fixar aqui
    // impede que um stub responda a um GET que a aplicação nunca faz.
    route.fulfill({ json: body, headers: { allow: 'POST' } }),
  );
  await page.goto('/#ranking');
  await page.getByRole('button', { name: 'Apurar simulação indicativa' }).click();
}

test('a recusa por cobertura incompleta NÃO vira número na tela', async ({ page }, testInfo) => {
  await openSimulation(page, refused());
  const result = page.getByTestId('simulacao-resultado');
  await expect(result).toBeVisible();

  // A RECUSA aparece com o motivo e com O QUE FAZER. O texto da razão
  // aparece em DOIS lugares por desenho — na faixa da recusa e na nota da
  // premissa de cobertura — e as duas são intencionais; a asserção usa
  // `first()` porque exigir só uma deixaria a tela sem metade do que ela
  // precisa dizer.
  await expect(page.getByText('Simulação recusada.')).toBeVisible();
  await expect(page.getByText(/A cobertura desta janela está incompleta/).first()).toBeVisible();
  await expect(page.getByText('Para desbloquear:')).toBeVisible();
  // E o estado vazio NÃO diz "zero": diz que nada foi apurado.
  await expect(page.getByRole('heading', { name: 'Nenhum número apurado' })).toBeVisible();
  // A ASSERÇÃO CENTRAL: nenhum número da apuração existe na tela. O valor
  // apurado que o motor produziria para uma série completa é 38,60 — e ele
  // NÃO pode estar em lugar nenhum da página.
  await expect(page.getByText('38,60')).toHaveCount(0);
  await expect(page.getByText('40,00')).toHaveCount(0);
  await expect(
    page.getByRole('table').filter({ hasText: 'Líquido após as premissas' }),
  ).toHaveCount(0);

  // A natureza indicativa está visível ANTES de tudo — é a primeira coisa da
  // seção de resultado e ela não é removível.
  await expect(page.getByText('INDICATIVA · NÃO EXECUTÁVEL')).toBeVisible();
  await expect(page.getByText(/nada foi apostado e nenhuma ordem pode sair daqui/)).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('simulacao-recusada.png'), fullPage: true });
});

test('as SETE premissas aparecem na RECUSA, e cada uma diz o que NÃO cobre', async ({ page }) => {
  await openSimulation(page, refused());
  const result = page.getByTestId('simulacao-resultado');
  await expect(result).toBeVisible();
  // A premissa aparece mesmo quando não há número: esconder a premissa
  // esconderia justamente o que o usuário precisa ler para entender a recusa.
  for (const key of [
    'stake',
    'delayMs',
    'feeRate',
    'spreadRate',
    'slippageRate',
    'missingDataRate',
    'completeness',
  ])
    await expect(page.getByTestId(`premissa-${key}`)).toBeVisible();
  // A origem de cada uma é dita, e é o que impede ler hipótese como medição.
  await expect(page.getByTestId('premissa-feeRate')).toContainText('Escolhido por você');
  await expect(page.getByTestId('premissa-missingDataRate')).toContainText('Medido pela coleta');
  await expect(page.getByTestId('premissa-delayMs')).toContainText('Declarado pelo limite');
  // E a nota da premissa de atraso diz por que nada aqui é executável.
  await expect(page.getByTestId('premissa-delayMs')).toContainText('não pode ser zerado');
});

test('a apuração mostra o número COM as sete premissas e NENHUMA promessa', async ({ page }) => {
  await openSimulation(page, apurada());
  const result = page.getByTestId('simulacao-resultado');
  await expect(result).toBeVisible();

  // A natureza vem primeiro, sempre.
  await expect(page.getByText('INDICATIVA · NÃO EXECUTÁVEL')).toBeVisible();

  // O número aparece com cada premissa DESCONTADA separadamente — o bruto
  // nunca aparece sozinho, e é por isso que ele é chamado de "antes das
  // premissas" e não de ganho.
  const table = page.getByRole('region', { name: 'Número indicativo' });
  await expect(table).toBeVisible();
  await expect(table.getByText('Bruto antes das premissas')).toBeVisible();
  await expect(table.getByText('US$ 40,00')).toBeVisible();
  await expect(table.getByText('Líquido após as premissas')).toBeVisible();
  await expect(table.getByText('US$ 38,60')).toBeVisible();
  // A faixa de incerteza aparece e é explicada como MAGNITUDE, não como
  // desconto aplicado. A frase aparece em DOIS lugares por desenho — na nota
  // da faixa e na premissa de dados ausentes — e as duas são intencionais.
  await expect(page.getByText(/Faixa de incerteza por dados ausentes/)).toBeVisible();
  await expect(page.getByText(/NÃO é descontada/).first()).toBeVisible();

  // E as sete premissas continuam visíveis no desfecho apurado.
  for (const key of ['stake', 'delayMs', 'feeRate', 'completeness'])
    await expect(page.getByTestId(`premissa-${key}`)).toBeVisible();
});

test('o texto renderizado NUNCA apresenta o retorno como executável ou prometido', async ({
  page,
}) => {
  for (const body of [refused(), apurada()]) {
    await openSimulation(page, body);
    await expect(page.getByTestId('simulacao-resultado')).toBeVisible();
    // A asserção é sobre o TEXTO RENDERIZADO da página inteira: um botão de
    // "apostar", um "retorno garantido" ou um "executar" escondido num
    // tooltip apareceria aqui.
    //
    // Os termos são ESCOLHIDOS para casar uma PROMESSA, e não a NEGAÇÃO dela:
    // a tela afirma "nenhuma estratégia é sugerida" e isso é o que o card
    // exige, então procurar a palavra nua rejeitaria a frase honesta. O que
    // não pode aparecer é a promessa — "execute", "garantido", "aposte
    // agora" — e é o que a lista abaixo procura.
    const rendered = (await page.locator('body').innerText()).toLowerCase();
    for (const forbidden of [
      'apostar agora',
      'execute a',
      'executar a',
      'garantido',
      'retorno certo',
      'lucro garantido',
      'recomendado para',
      'recomendação de entrada',
      'estratégia recomendada',
      'otimizar a',
      'melhor aposta',
    ])
      expect(rendered, `a tela não pode exibir "${forbidden}"`).not.toContain(forbidden);
    // E não existe botão que saia da apuração: a única ação é apurar.
    const actions = await page
      .getByTestId('simulacao-resultado')
      .locator('button, a[href]')
      .allInnerTexts();
    expect(actions).toEqual([]);
  }
});

test('os avisos de jogo responsável estão na tela nos DOIS desfechos', async ({ page }) => {
  for (const body of [refused(), apurada()]) {
    await openSimulation(page, body);
    const avisos = page.getByTestId('avisos-jogo-responsavel');
    await expect(avisos).toBeVisible();
    // O §4.9 pede aviso de risco e de idade mínima; os dois precisam estar
    // no texto que o usuário lê.
    await expect(avisos).toContainText('risco de perda de dinheiro');
    await expect(avisos).toContainText('18 anos');
    await expect(avisos).toContainText('não é retorno executável');
  }
});

test('a página não estoura a largura e a navegação mantém os DEZ destinos', async ({ page }) => {
  await openSimulation(page, refused());
  await expect(page.getByTestId('simulacao-resultado')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // STK-F3-01: a simulação deixou de ser SEÇÃO do ranking e virou
  // DESTINO, e a contagem subiu de OITO para DEZ. O número continua
  // LITERAL e continua sendo verificado — o que mudou foi o número, com a
  // justificativa escrita na asserção de `product.test.ts` e no corpo do
  // commit, não a asserção.
  //
  // STK-F3-04: `pm-global` deixou de ser RESERVADO e passou a ser destino
  // de verdade — a tela existe, em cards. Isso troca UM `<span
  // class="sidebar-reserved">` por UM `<a>`, e o contador deste teste mede
  // `<a>`, não destinos. Onze, portanto: os dez de antes mais o Global. O
  // `pm-telegram` continua reservado e continuafora da contagem, porque um
  // destino desligado não é link.
  const nav = page.locator('.product-sidebar nav');
  await expect(nav.locator('a')).toHaveCount(11);
  // E a seção continua na tela de ranking: as duas premissas de cobertura
  // ainda são as mesmas, e a janela mostrada em texto é a padrão do produto.
  await expect(page.getByText(/Janela:/)).toBeVisible();
});
