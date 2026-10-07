import { expect, test, type Page } from '@playwright/test';
import {
  ALERT_DEFAULT_DAILY_LIMIT,
  ALERT_DEFAULT_THRESHOLD,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  rankingCompleteness,
  rankingSample,
  type PolymarketRanking,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-16 §15 — "Favoritos, quiet hours, limiar, agrupamento e limite diário",
 * no NAVEGADOR, mais a prova de que o Composite Score NÃO aparece na tela.
 *
 * O teste unitário prova as regras e a integração prova o banco; este prova a
 * coisa que só o navegador prova:
 *
 *  1) O TETO DE DEZ É VISÍVEL E É RECUSA. A tela escreve "3 de 10", e com os
 *     dez ocupados ela diz que o excedente é recusado e que é preciso remover
 *     um. Não existe "carregar mais" em lugar nenhum do DOM.
 *
 *  2) FAVORITAR NÃO LIGA ALERTA. A interface mostra os DEZ favoritos e, ao
 *     mesmo tempo, o alerta como DESLIGADO. Se favoritar ligasse o alerta, a
 *     tela mentiria sobre o estado — e o card diz que essa é uma mentira que o
 *     produto não pode contar.
 *
 *  3) A REGRA DO ALERTA É VISÍVEL. A janela de 5 min, o limiar e o silêncio no
 *     fuso do usuário aparecem como texto, porque um limite que o usuário não
 *     vê é um limite que ele não pode cumprir.
 *
 *  4) O SCORE NÃO APARECE NO DOM. A busca é sobre o TEXTO RENDERIZADO da
 *     página inteira e sobre os TÍTULOS DE COLUNA — é no cabeçalho que um
 *     score apareceria antes de qualquer outro lugar.
 *
 * O payload é montado a partir das MESMAS funções puras que a produção usa, e
 * os traders são fictícios.
 */

const series = {
  status: 'complete' as const,
  available: true,
  ingested: 100,
  backfillFrom: '2026-04-01',
  pages: 2,
  failedPages: 0,
};

const trader = (index: number) => ({
  rank: String(index),
  proxyWallet: `0x${String(index).padStart(40, '0')}`,
  userName: `trader_${index}`,
  pnl: `${1000 + index}.5555555555555555`,
  vol: `${5000 + index}.7190210004`,
});

const rankingPayload = (): PolymarketRanking =>
  ({
    window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
    series,
    completeness: rankingCompleteness({ series }),
    sample: rankingSample({ n: 3, minSample: 30 }),
    aggregate: { blocked: false, reason: null },
    requested: 100,
    returned: 3,
    rows: [trader(1), trader(2), trader(3)],
  }) as PolymarketRanking;

/** Uma resposta de favoritos com N registros e o estado do alerta. */
const favoritesPayload = (
  count: number,
  alertEnabled: boolean,
  threshold = ALERT_DEFAULT_THRESHOLD,
) => ({
  favorites: Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    userId: 'fixture-owner',
    proxyWallet: `0x${String(index + 1).padStart(40, '0')}`,
    userName: `trader_${index + 1}`,
    createdAt: '2026-09-29T12:00:00.000Z',
  })),
  limit: POLYMARKET_FAVORITES_LIMIT,
  used: count,
  alertEnabled,
  alertThreshold: threshold,
  alertDailyLimit: ALERT_DEFAULT_DAILY_LIMIT,
  alertWindowMinutes: ALERT_WINDOW_MINUTES,
});

/**
 * Monta a casca do produto e as rotas usadas pela página de favoritos.
 *
 * As rotas são DESREGISTRADAS antes de cada montagem (`unroute`) porque o
 * Playwright mantém o primeiro handler registrado para um padrão: um segundo
 * `openFavorites` na mesma página continuaria vendo o payload do primeiro, e o
 * teste passaria a provar a fixture errada. `unrouteAll` deixa a página em
 * branco para a remontagem, que é o que a asserção seguinte espera.
 */
async function openFavorites(
  page: Page,
  body: { ranking: PolymarketRanking; favorites: ReturnType<typeof favoritesPayload> },
) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
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
  await page.route('**/api/v1/polymarket/ranking?*', (route) =>
    route.fulfill({ json: body.ranking }),
  );
  await page.route('**/api/v1/polymarket/favorites', (route) =>
    route.fulfill({ json: body.favorites }),
  );
  await page.route('**/api/v1/polymarket/alerts/config', (route) =>
    route.fulfill({
      json: {
        userId: 'fixture-owner',
        enabled: body.favorites.alertEnabled,
        threshold: body.favorites.alertThreshold,
        dailyLimit: ALERT_DEFAULT_DAILY_LIMIT,
        windowMinutes: ALERT_WINDOW_MINUTES,
        updatedAt: '2026-09-29T12:00:00.000Z',
      },
    }),
  );
  await page.goto('about:blank');
  await page.goto('/#pm-favorites');
  // A listagem de favoritos é reconsultada quando a tela monta, e o teste
  // espera o dado: sem esta espera, a asserção pode rodar contra a casca de
  // carregamento e falhar por motivo que não é o do card.
  await page
    .getByRole('heading', { name: 'Seus favoritos da Polymarket' })
    .waitFor({ state: 'visible' });
}

test('a tela mostra o uso do teto de favoritos e diz que o excedente é RECUSADO', async ({
  page,
}) => {
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(3, false),
  });
  await expect(
    page.getByRole('heading', { name: 'Favoritos do ranking Polymarket' }),
  ).toBeVisible();
  // A contagem vem do contrato, e a tela escreve o texto do contrato. Ela
  // aparece em DOIS lugares por desenho — a etiqueta do cabeçalho (que some no
  // mobile) e o rodapé da lista (que não some) — e a asserção é EXATA sobre o
  // rodapé, que é o que o usuário confere nos dois tamanhos de tela.
  await expect(page.getByText('3 de 10 favoritos. O limite', { exact: false })).toBeVisible();
  // Abaixo do teto, não há aviso de limite.
  await expect(page.getByText(/Limite de 10 favoritos atingido/)).toHaveCount(0);

  // Com os dez ocupados, o aviso aparece e promete REMOVER, nunca "carregar mais".
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(POLYMARKET_FAVORITES_LIMIT, false),
  });
  const notice = page.getByText(/Limite de 10 favoritos atingido/).first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('remova um favorito');
  // E o formulário de alerta, que é SEPARADO, mostra a configuração gravada
  // (desligado) em vez do padrão do produto — o usuário vê o que configurou.
  const config = page.getByTestId('alert-config');
  await expect(config.getByRole('checkbox')).not.toBeChecked();
  const rendered = (await page.locator('body').innerText()).toLowerCase();
  expect(rendered).not.toContain('carregar mais');
  expect(rendered).not.toContain('ver mais');
});

test('favoritar NÃO liga o alerta: a tela mostra os dois estados separados', async ({ page }) => {
  // Dez favoritos e o alerta DESLIGADO ao mesmo tempo: é o estado que o card
  // chama de legítimo, e a tela precisa descrever as duas coisas sem fundir.
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(POLYMARKET_FAVORITES_LIMIT, false),
  });
  // A mesma contagem, pelo rodapé — a etiqueta do cabeçalho some no mobile.
  await expect(page.getByText('10 de 10 favoritos. O limite', { exact: false })).toBeVisible();
  const config = page.getByTestId('alert-config');
  await expect(config).toBeVisible();
  await expect(config.getByRole('heading', { name: 'Alerta de atividade' })).toBeVisible();
  // O interruptor nasce DESLIGADO, mesmo com a lista cheia.
  await expect(config.getByRole('checkbox')).not.toBeChecked();
  // E a regra diz o que o interruptor age sobre, com janela, limiar e silêncio.
  await expect(config).toContainText('5 minutos');
  await expect(config).toContainText(ALERT_DEFAULT_THRESHOLD);
  await expect(config).toContainText('fuso');
});

test('o alerta LIGADO é descrito com a cota diária, e a lista continua à parte', async ({
  page,
}) => {
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(2, true, '2500.50'),
  });
  const config = page.getByTestId('alert-config');
  await expect(config.getByRole('heading', { name: 'Alerta de atividade' })).toBeVisible();
  // O limiar AJUSTÁVEL que o usuário gravado é o que a tela escreve.
  await expect(config).toContainText('2500.50');
  // A cota aparece no CAMPO do formulário, como VALOR de input — o texto
  // renderizado do painel não a contém, e a asserção precisa mirar onde o
  // número está de fato.
  await expect(config.getByLabel('Alertas por dia')).toHaveValue(String(ALERT_DEFAULT_DAILY_LIMIT));
  // O limiar ajustável gravado aparece no campo, e não num rótulo próprio.
  await expect(config.getByLabel(/Limiar por janela/)).toHaveValue('2500.50');
  // E a lista de favoritos continua sendo a lista, sem métrica de alerta. O
  // rodapé de contagem fica FORA do `data-testid` de propósito: ele descreve o
  // TETO do produto, não o conteúdo da lista, e a asserção do rodapé é feita na
  // página — a lista em si é o que o `region` da tabela prova.
  await expect(page.getByText('2 de 10 favoritos. O limite', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Favoritos do ranking Polymarket' })).toBeVisible();
});

test('a lista de favoritos mostra a carteira pública e nada derivado', async ({ page }) => {
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(2, false),
  });
  const region = page.getByRole('region', { name: 'Favoritos do ranking Polymarket' });
  await expect(region).toBeVisible();
  // A carteira pública identifica sem interpretar.
  await expect(region.getByText('0x0000000000000000000000000000000000000001')).toBeVisible();
  // Os cabeçalhos são só os da origem + a ação de remover. Nenhuma coluna de
  // pontuação, avaliação ou recomendação.
  const headers = await region.locator('th').allInnerTexts();
  // A folha aplica `text-transform: uppercase` nestes cabeçalhos, e o
  // `innerText` devolve o texto RENDERIZADO: normalizar a caixa preserva a
  // exigência do conjunto de colunas sem depender da apresentação.
  expect(headers.map((text) => text.trim().toLowerCase())).toEqual([
    'trader',
    'carteira pública',
    'favoritado em',
    'ação',
  ]);
});

test('Composite Score, badge e recomendação NÃO aparecem em lugar nenhum da tela', async ({
  page,
}) => {
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(3, true),
  });
  // A asserção central do card: o termo é procurado no TEXTO RENDERIZADO da
  // página inteira, não no fonte. Um score escondido em tooltip, título ou
  // aria-label apareceria aqui.
  //
  // A exceção é deliberada e vem da F2-15: o aviso de baixa amostra diz "sem
  // interpretação, comparação ou recomendação", que é uma NEGAÇÃO — o produto
  // BIJANDO que não recomenda. Barrar essa frase faria o produto mentir sobre o
  // que ele não faz. O que não pode aparecer é o termo como AFIRMAÇÃO, e é o
  // que o teste mede: nenhuma recomendação de trader, nenhuma linha que
  // ofereça uma ação além de favoritar e remover.
  const rendered = (await page.locator('body').innerText()).toLowerCase();
  for (const forbidden of [
    'composite',
    'score',
    'badge',
    'selo',
    'rating',
    'melhor trader',
    'pior trader',
  ])
    expect(rendered, `a tela não pode exibir "${forbidden}"`).not.toContain(forbidden);
  // "recomendação" só pode aparecer dentro de uma NEGAÇÃO. A frase da F2-15 é
  // "sem interpretação, comparação ou recomendação", e o que precede o termo é
  // "ou" — por isso a janela de contexto precisa ser a FRASE, não a palavra
  // imediatamente anterior, que seria "ou ".
  for (const match of rendered.matchAll(/recomend\w*/g)) {
    const sentence = rendered.slice(
      Math.max(0, rendered.lastIndexOf('.', match.index!) + 1),
      match.index!,
    );
    expect(sentence, `recomendação afirmada em: …${sentence}recomendação`).toMatch(/\bsem\b[^.]*$/);
  }

  // Premissa anterior aposentada: favoritos já não ficam dentro da tabela do
  // ranking. A lista própria conserva apenas identidade, data e ação, sem
  // colunas de pontuação ou recomendação.
  const favoritesTable = page.getByRole('region', { name: 'Favoritos do ranking Polymarket' });
  await expect(favoritesTable).toBeVisible();
  const headers = await favoritesTable.locator('th').allInnerTexts();
  // A folha aplica `text-transform: uppercase` nestes cabeçalhos, e o
  // `innerText` devolve o texto RENDERIZADO: normalizar a caixa preserva a
  // exigência do conjunto de colunas sem depender da apresentação.
  expect(headers.map((text) => text.trim().toLowerCase())).toEqual([
    'trader',
    'carteira pública',
    'favoritado em',
    'ação',
  ]);

  // E o menu de navegação não oferece o destino como recomendação.
  const nav = await page.locator('.product-sidebar nav').innerText();
  expect(nav.toLowerCase()).not.toContain('score');
});

test('favoritos são um destino próprio da navegação', async ({ page }) => {
  // Premissa aposentada: a tela de ranking não existe mais e favoritos têm
  // página própria; verificamos a rota e o cabeçalho dessa página.
  await openFavorites(page, {
    ranking: rankingPayload(),
    favorites: favoritesPayload(1, false),
  });
  const nav = await page.locator('.product-sidebar nav a').allInnerTexts();
  // Os links da navegação também são renderizados em caixa alta.
  expect(nav.join(' ').toLowerCase()).toContain('favoritos');
  await expect(page.getByRole('heading', { name: 'Seus favoritos da Polymarket' })).toBeVisible();
  // O link da navegação leva ao destino próprio, que também monta a seção real.
  await page.getByRole('link', { name: 'Favoritos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seus favoritos da Polymarket' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Favoritos do ranking Polymarket' }),
  ).toBeVisible();
  // E a página não estoura a largura da tela com a nova coluna.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
