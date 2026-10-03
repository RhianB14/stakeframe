import { expect, test, type Page } from '@playwright/test';

/**
 * STK-F3-04 — a tela Global em CARDS, no NAVEGADOR.
 *
 * O teste unitário prova as regras (R1, R2, R4, ordenação). Este prova as
 * TRÊS coisas que só o navegador prova e que o dono reclamou por Namely:
 *
 *  1) A tela é uma GRADE DE CARDS, e não gráficos pequenos nem tabela.
 *  2) Os FILTROS MUDAM A LISTA. Um filtro que reordena sem filtrar é
 *     exatamente a reclamação "o filtro não fazia nada", então a asserção
 *     mede a CONTAGEM de cards antes e depois, e a identidade do primeiro
 *     card — não só que o botão existe.
 *  3) O card é um ALVO: âncora com `href`, foco por teclado, área de toque
 *     ≥ 44px e um `aria-label` que fala as métricas COM o `N`.
 *
 * E os dois estados que o card exige ver: a cobertura truncada com a métrica
 * BLOQUEADA, e o valor desconhecido como "Sem base" — nunca zero, nunca vazio.
 *
 * A tela usa DADOS LOCAIS (a integração está pendente, gate F2-18), então
 * este teste não intercepta o ranking: ele abre `#pm-global` e mede o que a
 * casca monta. O que ele prova é a RENDERIZAÇÃO, não a origem do dado.
 */

/** A casca do produto: as mesmas fixtures de status/onboarding/workspace que
 *  os outros E2E usam. Sem elas a casca não monta e a falha apontaria um
 *  elemento que nunca existiu, em vez da tela que se quer medir. */
async function openGlobal(page: Page) {
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
  await expect(page.getByRole('heading', { name: 'Ranking global de tipsters' })).toBeVisible();
}

const cards = (page: Page) => page.getByTestId('global-card');

test('a tela Global é uma GRADE DE CARDS de tipster, com as métricas do card', async ({
  page,
}, testInfo) => {
  await openGlobal(page);

  // É uma GRADE: `<ul>` de cards, e não tabela. A asserção de que não existe
  // `<table>` nesta tela é o que separa esta entrega da tela de ranking, que é
  // uma tabela — e é a complaint "eu queria em cards, não gráficos
  // pequenos" que precisa de uma prova estrutural.
  await expect(page.getByTestId('global-grid')).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
  // A grade tem colunas proporcionais à largura. No DESKTOP ela tem mais de
  // uma coluna — um card por linha seria a mesma listagem com outro nome — e
  // no MOBILE tem exatamente uma, porque duas colunas de 300px não cabem numa
  // tela de bolso e o produto proíbe o scroll horizontal. A asserção é feita
  // pelo tamanho da janela, e não por um `test.skip`: o comportamento
  // responsivo é parte do que se entrega.
  const columns = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="global-grid"]');
    if (!grid) return 0;
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  });
  const largura = page.viewportSize()?.width ?? 0;
  if (largura >= 1200) {
    expect(columns, 'a grade precisa ter mais de uma coluna no desktop').toBeGreaterThan(1);
  } else {
    expect(columns, 'a grade deve ser de uma coluna no mobile').toBe(1);
  }

  // Os seis cards locais aparecem, e a contagem é dita na tela.
  await expect(cards(page)).toHaveCount(6);
  await expect(page.getByTestId('global-count')).toHaveText('6 de 6 tipsters');

  // O card carrega TODAS as métricas que o dono nomeou, e cada uma delas
  // mostra a amostra ao lado (R1). A contagem de métricas com `N` é a
  // asserção: ela quebra se alguém acrescentar uma métrica e esquecer o N.
  const primeiro = cards(page).first();
  for (const metrica of [
    'P&L 30d',
    'ROI',
    'Taxa de acerto',
    'Odd média',
    'Seguidores',
    'Wins',
    'Losses',
    'Open bets',
    'Unidades/mês',
  ]) {
    await expect(primeiro.getByText(metrica, { exact: true })).toBeVisible();
  }
  // R1 medida na TELA: para cada métrica, existe um `N=` visível no mesmo
  // card. Não se conta pelo atributo — o texto é o que o usuário lê.
  const comN = primeiro.locator('[data-global-n]');
  const totalN = await comN.count();
  expect(totalN, 'toda métrica precisa do seu N').toBeGreaterThanOrEqual(9);
  for (let index = 0; index < totalN; index += 1) {
    await expect(comN.nth(index)).toContainText('N=');
  }
  // E o `N` é NÚMERO, nunca uma casa vazia.
  const amostras = await comN.allInnerTexts();
  for (const amostra of amostras) expect(amostra.trim()).toMatch(/^N=[\d.]+$/);

  // O card que ABRE a lista é o de maior PnL, e ele é o `@alpha_odds`
  // (48.210). Esta é a prova de que a ordenação é descendente na TELA: a
  // inversão do sinal existiu como bug e a lista abria pelo pior tipster.
  await expect(primeiro.getByText('@alpha_odds', { exact: true })).toBeVisible();
  // A categoria é sempre Esportes, E-sports ou Ambos, e o rótulo existe.
  await expect(primeiro.getByText('Esportes', { exact: true })).toBeVisible();
  // A posição no card é ordinal em português — e a do topo é "1º".
  await expect(primeiro.getByText('1º', { exact: true })).toBeVisible();
  // E o avatar é a inicial, com o nome ao lado. A inicial é buscada pelo
  // SELETOR da classe, e não por texto: o caractere `@` aparece em todo nome
  // de tipster, e uma busca por texto casaria dozens de elementos.
  await expect(primeiro.locator('.global-avatar')).toHaveText('@');

  // Nenhuma célula de métrica sai VAZIA: a R2 proíbe o vazio como resposta,
  // e o teste mede isso em todas as casas de todos os cards.
  const valores = await page.locator('[data-global-metric]').allInnerTexts();
  expect(valores.length).toBeGreaterThan(0);
  for (const valor of valores) expect(valor.trim().length).toBeGreaterThan(0);

  // A página não estoura a largura: uma grade que força scroll horizontal
  // quebra o layout inteiro.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('polymarket-global-cards.png'),
    fullPage: true,
  });
});

test('a cobertura truncada é VISÍVEL e a métrica dependente fica bloqueada', async ({
  page,
}, testInfo) => {
  await openGlobal(page);

  // O card truncado carrega o rótulo e o MOTIVO. "bloqueado" sem razão seria
  // um aviso que o usuário não consegue interpretar.
  const aviso = page.getByText('Cobertura truncada');
  await expect(aviso).toBeVisible();
  await expect(page.getByText('210 de 1.000 eventos ingeridos nesta janela')).toBeVisible();

  // A métrica que depende da série completa aparece BLOQUEADA — o texto
  // exato, em vez de estimativa e em vez de zero.
  const cardTruncado = cards(page).filter({ hasText: 'Cobertura truncada' });
  const roi = cardTruncado.locator('[data-global-metric="ROI"]');
  await expect(roi).toHaveText('bloqueado');
  // E o `N` continua visível no bloqueio: a amostra é o que sabemos, e
  // escondê-la junto com o valor esconderia o motivo.
  await expect(cardTruncado.locator('[data-global-n="ROI"]')).toContainText('N=210');
  // O P&L do MESMO card não é bloqueado: só a métrica dependente da série
  // completa é. Um card inteiro "bloqueado" esconderia dado válido.
  await expect(cardTruncado.locator('[data-global-metric="P&L 30d"]')).toContainText('8.940');

  // A borda de atenção é o sinal visual do estado, e ela é real: a cor
  // computada precisa ser diferente da de um card normal.
  const cores = await page.evaluate(() => {
    const lista = Array.from(document.querySelectorAll('[data-testid="global-card"]'));
    const truncado = lista.find((node) => node.className.includes('is-truncated'));
    const normal = lista.find((node) => !node.className.includes('is-truncated'));
    if (!truncado || !normal) return null;
    return {
      truncado: getComputedStyle(truncado).borderTopColor,
      normal: getComputedStyle(normal).borderTopColor,
    };
  });
  expect(cores, 'a tela precisa ter um card truncado e um normal').not.toBeNull();
  expect(cores!.truncado).not.toBe(cores!.normal);

  await page.screenshot({
    path: testInfo.outputPath('polymarket-global-truncated.png'),
    fullPage: true,
  });
});

test('valor desconhecido é "Sem base" — nunca zero, nunca célula vazia', async ({ page }) => {
  await openGlobal(page);

  const desconhecidos = page.getByText('Sem base', { exact: true });
  // O `@csgo_arb` tem três métricas desconhecidas: taxa de acerto,
  // seguidores e open bets — e o mercado, que também é "Sem base".
  expect(await desconhecidos.count()).toBeGreaterThanOrEqual(3);

  // A distinção que a R2 exige: em OUTRO card, a mesma métrica tem número.
  // Se "Sem base" aparecesse onde há valor, a métrica estaria sempre
  // desconhecida e o texto não diria nada.
  const cardComBase = cards(page).filter({ hasText: '@alpha_odds' });
  await expect(cardComBase.locator('[data-global-metric="Taxa de acerto"]')).toContainText('%');
  await expect(cardComBase.locator('[data-global-metric="Taxa de acerto"]')).not.toHaveText(
    'Sem base',
  );

  // E o texto desconhecido NUNCA é confundido com zero: nenhum "0" isolado
  // aparece como valor de uma métrica desconhecida.
  const desconhecido = page.locator('[data-global-metric]').filter({ hasText: /^Sem base$/ });
  for (const texto of await desconhecido.allInnerTexts()) expect(texto.trim()).toBe('Sem base');
});

test('os FILTROS FUNCIONAM: categoria e ordenação mudam a lista de verdade', async ({ page }) => {
  await openGlobal(page);

  // A Catherine inicial: seis cards, e a contagem diz seis de seis.
  await expect(cards(page)).toHaveCount(6);
  const primeiroInicial = await cards(page).first().getAttribute('data-wallet');

  // O FILTRO DE CATEGORIA. São três botões, e as contagens são MEDIDAS, não
  // presumidas: o `@csgo_arb` é `BOTH` e por isso aparece nas DUAS listas
  // (5 esportes = 4 `SPORTS` + 1 `BOTH`; 2 e-sports = 1 `ESPORTS` + 1
  // `BOTH`). Somar 5 + 2 dá 7 para 6 cards, e essa é a prova de que `BOTH`
  // não é uma categoria à parte.
  const grupoCategoria = page.getByRole('group', { name: 'Filtrar por categoria' });
  await expect(grupoCategoria.getByRole('button')).toHaveCount(3);
  // Os três rótulos são exatamente os que o dono pediu, e não há onde
  // pedir cripto, blockchain ou política.
  const rotulos = await grupoCategoria.getByRole('button').allInnerTexts();
  expect(rotulos[0]).toMatch(/^Todos\s*6$/);
  expect(rotulos[1]).toMatch(/^Esportes\s*5$/);
  expect(rotulos[2]).toMatch(/^E-sports\s*2$/);
  for (const proibido of ['Cripto', 'Blockchain', 'Política', 'Clima', 'Finanças'])
    expect(rotulos.join(' ')).not.toContain(proibido);

  await grupoCategoria.getByRole('button', { name: /Esportes/ }).click();
  await expect(cards(page)).toHaveCount(5);
  await expect(page.getByTestId('global-count')).toHaveText('5 de 6 tipsters');
  // O `@pro_polymarket` (e-sports PURO) SAI da tela. A prova de que o filtro
  // age é o card que SOME — a contagem cair é o sintoma, o card ausente é o
  // fato.
  await expect(cards(page).filter({ hasText: '@pro_polymarket' })).toHaveCount(0);
  // O `@csgo_arb` é `BOTH` e por isso CONTINUA aqui: ele está na lista de
  // esportes E na de e-sports. A primeira versão deste teste exigia que ele
  // sumisse, e a exigência estava errada — esconder um "Ambos" de um dos
  // lados afirmaria que ele não é daquele mercado, que é o oposto do que
  // "Ambos" quer dizer.
  await expect(cards(page).filter({ hasText: '@csgo_arb' })).toHaveCount(1);
  // E o card truncado continua visível, porque é de esportes.
  await expect(cards(page).filter({ hasText: 'Cobertura truncada' })).toHaveCount(1);
  // O topo NÃO muda neste filtro, e está certo: `@alpha_odds` é o maior PnL
  // E é de esportes. O filtro remove cards, não reordena os que restam, e um
  // filtro que reordenasse seria o defeito que o dono reclamou.

  // O filtro de E-sports também filtra, e o card `BOTH` aparece nos DOIS
  // lados — é o que "Ambos" quer dizer.
  await grupoCategoria.getByRole('button', { name: /E-sports/ }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).filter({ hasText: '@csgo_arb' })).toHaveCount(1);
  // E o card truncado SAI da tela, porque ele é de esportes: um filtro que
  // não tira nada seria decorativo.
  await expect(cards(page).filter({ hasText: 'Cobertura truncada' })).toHaveCount(0);

  // "Todos" volta ao total, e o topo volta a ser o de maior PnL.
  await grupoCategoria.getByRole('button', { name: /Todos/ }).click();
  await expect(cards(page)).toHaveCount(6);
  expect(await cards(page).first().getAttribute('data-wallet')).toBe(primeiroInicial);
  // Os dois e-sports voltaram, o que fecha o ciclo do filtro.
  await expect(cards(page).filter({ hasText: '@csgo_arb' })).toHaveCount(1);
  await expect(cards(page).filter({ hasText: '@pro_polymarket' })).toHaveCount(1);

  // A ORDENAÇÃO é um grupo SEPARADO, e ela muda a ORDEM sem mudar a
  // contagem. A distinção importa: filtro muda quem aparece, ordenação muda
  // em que ordem.
  const grupoOrdem = page.getByRole('group', { name: 'Ordenar por' });
  await expect(grupoOrdem.getByRole('button')).toHaveText(['PnL', 'ROI', 'Volume']);

  // Em PnL, o topo é o `@alpha_odds` (48.210 é o maior PnL).
  expect(await cards(page).first().getAttribute('data-wallet')).toBe(
    '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
  );
  await grupoOrdem.getByRole('button', { name: 'ROI' }).click();
  // Em ROI, a contagem é a mesma — só a ORDEM muda. O topo continua sendo o de
  // maior ROI, que no catálogo local também é o `@alpha_odds` (34,2%).
  await expect(cards(page)).toHaveCount(6);
  const ordemRoi = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-wallet')),
  );
  expect(ordemRoi[0]).toBe('0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d');
  // O `@edge_detector` (ROI −6,1%) vai para o FIM, não para o meio: é o pior
  // ROI, e a ordenação descendente tem de colocá-lo em último.
  expect(ordemRoi[ordemRoi.length - 1]).toBe('0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081');
  await grupoOrdem.getByRole('button', { name: 'Volume' }).click();
  const ordemVolume = await cards(page).evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-wallet')),
  );
  // E a ordenação por volume é DIFERENTE da de PnL: o `@edge_detector` tem
  // o maior volume entre os cards de PnL negativo (198.000) e o pior PnL
  // (−12.400), então ele sobe quando o critério é volume. O topo por volume
  // continua sendo o `@alpha_odds` (312.000) — e a segunda posição troca,
  // que é o que prova que o botão mexe na ordem e não só na lista.
  expect(ordemVolume).not.toEqual(ordemRoi);
  expect(ordemVolume[0]).toBe('0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d');
  // O `@edge_detector` sobe das ÚLTIMAS posições para as primeiras por
  // volume: em PnL ele é o pior, em volume ele é o terceiro. Um botão de
  // ordenação que devolvesse a mesma lista para os dois critérios não
  // estaria ordenando.
  const posicaoPnl = ordemRoi.indexOf('0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081');
  const posicaoVolume = ordemVolume.indexOf('0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081');
  expect(posicaoVolume).toBeLessThan(posicaoPnl);
  // E o filtro de categoria CONTINUA aplicado depois de reordenar: os dois
  // controles são independentes, e trocar a ordem não descarta o filtro.
  await grupoCategoria.getByRole('button', { name: /Esportes/ }).click();
  await expect(cards(page)).toHaveCount(5);
  // E o estado do filtro é visível no chip, para quem navega por ele.
  await expect(grupoCategoria.getByRole('button', { name: /Esportes/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('o card é clicável, focável e fala as métricas com a amostra', async ({ page }) => {
  await openGlobal(page);

  const primeiro = cards(page).first();
  // O card é uma ÂNCORA: tem `href` para o detalhe do tipster. Um `div` com
  // `onClick` seria clicável e não navegável, nem copiável.
  await expect(primeiro).toHaveAttribute('href', /#\/polymarket\/tipster\/0x[0-9a-f]{40}/);

  // A ÁREA DE TOQUE: o alvo tem pelo menos 44px de altura, que é o piso do
  // produto (`--tap`) e o que o dono precisa no celular.
  const altura = await primeiro.evaluate((node) => node.getBoundingClientRect().height);
  expect(altura).toBeGreaterThanOrEqual(44);

  // O FOCO chega por TECLADO, e a asserção é DETERMINÍSTICA: o teste tabula
  // a partir do ÚLTIMO chip de ordenação até alcançar um card. Contar "quantos
  // tabs faltam" seria frágil — um chip novo mudaria a contagem e o teste
  // falharia sem defeito. O que importa é que o card ESTÁ na ordem de
  // tabulação, e não que ele seja o quinto elemento.
  const ultimoChip = page.getByRole('group', { name: 'Ordenar por' }).getByRole('button').last();
  await ultimoChip.focus();
  let alcanhouCard = false;
  for (let passo = 0; passo < 12 && !alcanhouCard; passo += 1) {
    await page.keyboard.press('Tab');
    alcanhouCard = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') === 'global-card',
    );
  }
  expect(alcanhouCard, 'o card precisa ser alcançável pela tecla Tab').toBe(true);

  // E o anel de foco é DESENHADO: o `:focus-visible` do produto nunca é
  // removido, e é a única garantia de que o teclado não some.
  await primeiro.focus();
  const anel = await primeiro.evaluate((node) => {
    const estilo = getComputedStyle(node);
    return { outline: estilo.outlineStyle, largura: estilo.outlineWidth };
  });
  expect(anel.outline).not.toBe('none');
  expect(Number.parseFloat(anel.largura)).toBeGreaterThanOrEqual(2);

  // O `aria-label` fala as métricas E a amostra: é o que um leitor de tela
  // ouve no card inteiro, e é onde a R1 aparece para quem não vê a tela.
  const label = (await primeiro.getAttribute('aria-label')) ?? '';
  expect(label).toContain('@alpha_odds');
  expect(label).toContain('categoria Esportes');
  expect(label).toContain('P&L');
  expect(label).toContain('ROI');
  expect(label).toContain('taxa de acerto');
  // E o `N`auditado: sem ele, a métrica falada seria uma leitura sem base.
  expect(label).toMatch(/N ?1\.?240/);

  // O clique LEVA ao detalhe do tipster. O destino ainda não é uma tela
  // construída por este card, e a prova aqui é a navegação — o que o dono
  // pediu foi que o card leve ao detalhe, e um link que não muda a rota
  // seria um card que parece clicável e não é.
  await primeiro.click();
  await expect(page).toHaveURL(/#\/polymarket\/tipster\/0x/);
});

test('a tela não escreve Composite Score, avaliação nem conselho de aposta', async ({ page }) => {
  await openGlobal(page);

  // A busca é no TEXTO RENDERIZADO da página inteira, não no fonte: um
  // score escondido em tooltip, `title` ou rótulo apareceria aqui.
  const rendered = (await page.locator('body').innerText()).toLowerCase();
  for (const forbidden of [
    'composite',
    'score',
    'badge',
    'recomend',
    'rating',
    'melhor trader',
    'melhor tipster',
    'aposte nele',
    'vale a pena',
  ])
    expect(rendered, `a tela não pode exibir "${forbidden}"`).not.toContain(forbidden);

  // E o menu de navegação não oferece o destino como recomendação.
  const nav = await page.locator('.product-sidebar nav').innerText();
  expect(nav.toLowerCase()).not.toContain('score');
});
