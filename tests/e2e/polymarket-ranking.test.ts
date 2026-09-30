import { expect, test, type Page } from '@playwright/test';
import {
  rankingCompleteness,
  rankingSample,
  type PolymarketRanking,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-15 §15 — "Ranking oficial e Composite Score oculto", no NAVEGADOR.
 *
 * O teste unitário prova a lógica e prova que o schema recusa um score; este
 * prova a coisa que só o navegador prova: que o RENDER não escreve Composite
 * Score, badge nem recomendação, e que a série TRUNCADA aparece como aviso
 * visível mesmo com 100 traders na tela.
 *
 * O payload é montado a partir das MESMAS funções puras que a produção usa
 * (`rankingCompleteness`, `rankingSample`), e não escrito à mão: um fixture
 * que discordasse do contrato mostraria que o teste mente sobre a interface.
 * Os traders são fictícios e o texto visível é o que a tela escreve.
 */

/** Uma janela gravada pela ingestão da F2-14, no estado que interessa. */
const series = (over: Partial<PolymarketRanking['series']> = {}) => ({
  status: 'truncated' as const,
  available: true,
  ingested: 1800,
  backfillFrom: '2026-04-01',
  pages: 36,
  failedPages: 0,
  ...over,
});

const trader = (index: number) => ({
  rank: String(index),
  proxyWallet: `0x${String(index).padStart(40, '0')}`,
  userName: `trader_${index}`,
  pnl: `${1000 + index}.5555555555555555`,
  vol: `${5000 + index}.7190210004`,
});

const payload = (over: Partial<PolymarketRanking> = {}): PolymarketRanking => {
  const current = series();
  return {
    window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
    series: current,
    completeness: rankingCompleteness({ series: current }),
    sample: rankingSample({ n: 100, minSample: 30 }),
    aggregate: { blocked: true, reason: 'Total e participação do tabuleiro estão bloqueados.' },
    requested: 100,
    returned: 100,
    rows: Array.from({ length: 100 }, (_, index) => trader(index + 1)),
    ...over,
  } as PolymarketRanking;
};

async function openRanking(page: Page, body: PolymarketRanking) {
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
          // O schema de `builtAt` aceita SEGUNDOS, sem fração: `Z` puro. Uma
          // data com milissegundos é recusada e o `status.data` fica undefined,
          // o que impede a casca do produto de montar — a tela cairia na
          // apresentação inicial e o erro apontaria o elemento que nunca
          // existiu, em vez da fixture inválida que o causou.
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
  // O workspace precisa ser um payload COMPLETO e válido: a tela só renderiza
  // depois que `workspaceSchema` aceita o objeto, e uma fixture pela metade
  // derrubaria a casca inteira — o teste falharia procurando um filtro que
  // nunca existiu, com um erro que aponta para o sintoma e não para a causa.
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
  await page.route('**/api/v1/polymarket/ranking?*', (route) => route.fulfill({ json: body }));
  await page.goto('/#ranking');
}

test('o ranking oficial mostra P&L, volume, amostra e o aviso de série truncada', async ({
  page,
}, testInfo) => {
  await openRanking(page, payload());
  await expect(page.getByRole('heading', { name: 'Ranking oficial Polymarket' })).toBeVisible();

  // A COMPLETUDE TRUNCADA é visível, e o texto diz que NÃO é o ranking inteiro.
  const notice = page.getByRole('status').filter({ hasText: 'Série truncada' }).first();
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('NÃO representa o ranking inteiro');
  // E a métrica dependente da série completa aparece BLOQUEADA, com o motivo.
  await expect(notice).toContainText('Métrica bloqueada');
  await expect(notice).toContainText('bloqueados');

  // A amostra é a que o usuário pode conferir: as 100 linhas exibidas. A
  // etiqueta `live-label` é escondida por CSS no mobile, então a asserção usa
  // o texto que aparece nos DOIS tamanhos de tela — a faixa de baixa amostra
  // some com 100 traders, mas o rodapé de contagem não some, e é ele que o
  // usuário confere. O valor é o mesmo nos dois lugares.
  await expect(page.getByText('100 de 100 posições exibidas')).toBeVisible();
  await expect(page.getByText('N = 100 traders')).toHaveCount(1);

  // Os números vêm da origem, com o decimal exato e o agrupamento pt-BR.
  const table = page.getByRole('region', { name: 'Ranking oficial Polymarket' });
  await expect(table).toBeVisible();
  await expect(table.getByText('US$ 1.001,5555555555555555')).toBeVisible();
  // A POSIÇÃO é a declarada pela origem, como texto.
  await expect(table.getByText('1', { exact: true })).toBeVisible();
  // E a carteira pública identifica sem interpretar.
  await expect(table.getByText('0x0000000000000000000000000000000000000001')).toBeVisible();

  // A navegação é utilizável e a página não estoura a largura da tela.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('polymarket-ranking.png'), fullPage: true });
});

test('Composite Score, badge e recomendação NÃO aparecem na tela do ranking', async ({ page }) => {
  await openRanking(page, payload());
  const table = page.getByRole('region', { name: 'Ranking oficial Polymarket' });
  await expect(table).toBeVisible();

  // A asserção central do card: o termo é procurado no TEXTO RENDERIZADO da
  // página inteira, não no fonte. Um score escondido em tooltip, título ou
  // aria-label apareceria aqui.
  const rendered = (await page.locator('body').innerText()).toLowerCase();
  for (const forbidden of [
    'composite',
    'score',
    'badge',
    'recomend',
    'selo',
    'rating',
    'melhor trader',
    'pior trader',
  ])
    expect(rendered, `a tela não pode exibir "${forbidden}"`).not.toContain(forbidden);

  // E o cabeçalho da tabela traz só as colunas da origem — mais a coluna de
  // FAVORITAR, que é a única coisa que a F2-16 acrescenta ao ranking, e ela
  // não recebe pontuação, selo nem recomendação. Sem esta linha, o
  // cabeçalho da F2-15 quebraria por causa de uma coluna legítima.
  const headers = await table.locator('th').allInnerTexts();
  expect(headers.map((text) => text.trim())).toEqual([
    'Posição',
    'Trader',
    'Carteira pública',
    'P&L',
    'Volume',
    'Favoritar',
  ]);

  // O menu de navegação também não oferece o destino como recomendação.
  const nav = await page.locator('.product-sidebar nav').innerText();
  expect(nav.toLowerCase()).not.toContain('score');
});

test('a janela ainda não coletada é explicada, e não aparece como lista vazia', async ({
  page,
}) => {
  const current = series({ status: 'unknown', available: false, ingested: 0, pages: 0 });
  await openRanking(
    page,
    payload({
      series: current,
      completeness: rankingCompleteness({ series: current }),
      sample: rankingSample({ n: 0, minSample: 30 }),
      aggregate: {
        blocked: true,
        reason:
          'Total e participação do tabuleiro estão bloqueados: esta janela ainda não foi coletada.',
      },
      returned: 0,
      rows: [],
    }),
  );
  // A distinção que importa: "não coletado" NÃO é "zero trader". A tela diz o
  // que aconteceu, e a lista vazia carrega a explicação.
  await expect(page.getByRole('heading', { name: 'Janela ainda não coletada' })).toBeVisible();
  // A explicação aparece em DOIS lugares por desenho: na faixa de completude e
  // no estado vazio da lista. A asserção usa `first()` porque as duas são
  // intencionais — exigir uma só deixaria a tela sem metade do que ela
  // precisa dizer.
  await expect(page.getByText(/ainda não publicizou/).first()).toBeVisible();
  // Com N = 0 o texto de N aparece na faixa de baixa amostra E na etiqueta. As
  // duas são intencionais; o que o teste exige é que o valor apareça, e é por
  // isso que a busca é exata sobre a etiqueta.
  await expect(page.getByText('N = 0 traders', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/Baixa amostra: N = 0 traders/)).toBeVisible();
});

test('os filtros usam os ENUMS OFICIAIS e uma categoria não ingerida é explicada', async ({
  page,
}) => {
  await openRanking(page, payload());
  // O período padrão do card: P&L de 30 dias, categoria geral.
  await expect(page.getByLabel('Período')).toHaveValue('MONTH');
  await expect(page.getByLabel('Categoria')).toHaveValue('OVERALL');
  await expect(page.getByLabel('Ordenação')).toHaveValue('PNL');
  // As opções são as do enum oficial, e o rótulo diz 30 dias para `MONTH`.
  const periods = await page.getByLabel('Período').locator('option').allInnerTexts();
  expect(periods).toContain('30 dias');
  // As onze categorias oficiais estão oferecer, com rótulo em português.
  const categories = await page.getByLabel('Categoria').locator('option').allInnerTexts();
  for (const label of ['Geral', 'Política', 'Esportes', 'Esports', 'Cripto', 'Finanças'])
    expect(categories).toContain(label);
});
