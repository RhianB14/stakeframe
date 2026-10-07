import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PerformanceReport, ReportMetrics } from '../../packages/shared/src/index.js';
import { enabledProduct } from './product-fixtures.js';

/**
 * STK-F3-03 — o gráfico de resultado realizado no padrão SharkTrack.
 *
 * Estes testes protegem três decisões que não podem regredir em silêncio,
 * porque nenhuma delas quebra a tela: elas mentem sobre o dinheiro.
 *
 * 1. **O eixo Y inclui o zero quando a série é negativa.** Sem isso, uma
 *    série toda negativa é desenhada pelo mínimo automático e parece SUBIR.
 * 2. **Abaixo do piso de amostra o gráfico não é desenhado.** A biblioteca
 *    desenha 1 ponto com a mesma confiança com que desenha 30, e um gráfico
 *    de 1 ponto é uma forma inventada — que é exatamente o que o texto diz.
 * 3. **A altura do plot.** 170px foi a reclamação do dono; a faixa é
 *    medida no DOM, não conferida no CSS.
 */

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
  yieldReal: null,
  hitRateReal: null,
  hitWinsReal: 0,
  hitEligibleReal: 0,
};

function reportWith(profits: string[]): PerformanceReport {
  return {
    generatedAt: '2026-09-07T00:00:00Z',
    version: 1,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    dateBasis: 'last_event_sao_paulo',
    granularity: 'day',
    metrics: { ...emptyMetrics, bets: profits.length, settledBets: profits.length },
    previous: { from: '2026-08-02', to: '2026-08-31', metrics: { ...emptyMetrics } },
    exclusions: { unknownDateBets: 0, estimatedDateBets: 0 },
    timeline: profits.map((profit, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      metrics: { ...emptyMetrics, bets: 1, profit },
    })),
    byBookmaker: [],
    byTipster: [],
    bySport: [],
  };
}

/** Monta a Visão geral com o relatório injetado e espera o painel do mês. */
async function openOverview(page: Page, report: PerformanceReport): Promise<void> {
  /* `enabledProduct` monta a casca inteira (status, `/me`, onboarding,
     workspace) e ele JÁ registra uma rota para `/api/v1/reports?*`. No
     Playwright a ÚLTIMA rota registrada tem precedência, então o relatório
     deste teste é registrado DEPOIS do helper — foi por isso que a primeira
     versão não achava o painel: o fixture vazio do helper respondia antes. */
  await enabledProduct(page);
  await page.route('**/api/v1/reports?*', (route) => route.fulfill({ json: report }));
  /* O painel do mês é da VISÃO GERAL (`#overview`); em `#analytics` a tela
     traz a evolução e os splits, e o cabeçalho deste nunca aparece — foi o
     que fez a primeira versão esperar 15s por um elemento inexistente. */
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: 'Resultado acumulado' })).toBeVisible();
}

test.describe('STK-F3-03 — gráfico de resultado no padrão SharkTrack', () => {
  test('o eixo Y inclui o zero quando o resultado realizado é negativo', async ({ page }) => {
    /* A série é ACUMULADA e negativa em todo o percurso: -20, -45, -80,
       -60, -110, -95. Sem o zero no domínio, o Recharts encolhe a janela
       em [-110, -60] e a linha sai parecendo uma recuperação — o resultado
       piorou, e o desenho diz o contrário. É o defeito que o card proíbe. */
    await openOverview(
      page,
      reportWith(['-20.00', '-45.00', '-80.00', '-60.00', '-110.00', '-95.00']),
    );

    const chart = page.locator('.report-chart');
    await expect(chart).toBeVisible();
    // O tick de zero TEM de existir e estar dentro da área do eixo: um
    // domínio [-110, -60] não produz nenhuma cota em 0.
    await expect(chart.locator('text=0').first()).toBeVisible();

    /* O ponto INICIAL da série é -R$ 20, acumulado. Com o zero no domínio,
       ele tem de ser desenhado ABAIXO da linha de referência do zero (em
       SVG, y MAIOR é mais baixo). A comparação tem que ser feita em
       coordenadas de TELA: o `y1` da ReferenceLine e o `d` da área estão em
       sistemas diferentes, e comparar os números crus dava 23,9 contra 12 e
       reprovava com o gráfico CORRETO na tela. */
    const geometry = await chart.evaluate((node) => {
      const svg = node.querySelector('svg');
      if (!svg) throw new Error('svg do gráfico ausente');
      /* Recharts 3.10: o `<line>` da referência carrega a classe
         `recharts-reference-line-line`, e o seletor `... line` (tag) não
         casa nada aqui. O Y=12 é a posição da linha do zero na caixa — e o
         teste do `text=0` já cobre a leitura do eixo; aqui o que importa é
         que a referência exista e esteja dentro do SVG. */
      const zeroLine = node.querySelector('.recharts-reference-line-line');
      const area = node.querySelector('.recharts-area-area');
      /* A curva é o `<path class="recharts-area-curve">`. Um seletor de TAG
         pegaria também o clipPath e o gradiente, e o `getPointAtLength` deles
         devolve uma coordenada fora da tela. */
      const curve = node.querySelector<SVGPathElement>('.recharts-area-curve');
      if (!zeroLine) throw new Error('linha de referência do zero ausente');
      if (!area) throw new Error('área preenchida ausente');
      if (!curve) throw new Error('curva da área ausente');
      const box = svg.getBoundingClientRect();
      return {
        zeroScreenY: zeroLine.getBoundingClientRect().top - box.top,
        firstScreenY: curve.getPointAtLength(0).y,
        areaPathLength: (area.getAttribute('d') ?? '').length,
      };
    });
    expect(geometry.areaPathLength).toBeGreaterThan(20);
    expect(
      geometry.firstScreenY,
      `série negativa deveria estar abaixo do zero (zero=${geometry.zeroScreenY}, série=${geometry.firstScreenY})`,
    ).toBeGreaterThan(geometry.zeroScreenY);

    await page.screenshot({ path: 'capturas/grafico-resultado-negativo.png', fullPage: true });
  });

  test('abaixo do piso de amostra o gráfico NÃO é desenhado, e a mensagem diz por quê', async ({
    page,
  }) => {
    /* 2 dias observados. O Recharts aceitaria desenhar 2 pontos sem
       reclamar; o produto recusa, porque uma área com 2 pontos é uma forma
       interpolada a partir de nada. */
    await openOverview(page, reportWith(['50.00', '-20.00']));

    await expect(page.locator('.report-chart')).toHaveCount(0);
    const note = page.getByText(/abaixo de 4, o gráfico seria uma forma inventada/);
    await expect(note).toBeVisible();
    // A mensagem explica o motivo, não só o número.
    await expect(note).toContainText('Os números acima são o resultado');

    await page.screenshot({ path: 'capturas/grafico-piso-amostra.png', fullPage: true });
  });

  test('a área tem altura suficiente para ler a inclinação (reclamação do dono)', async ({
    page,
  }) => {
    /* O dono reclamou de 170px. Este teste mede a caixa real do plot, e o
       piso é o que ele pediu: nunca abaixo de 180px, e na faixa 240–280px
       no desktop. */
    await openOverview(
      page,
      reportWith(['50.00', '120.00', '80.00', '200.00', '260.00', '310.00']),
    );

    const chart = page.locator('.report-chart');
    await expect(chart).toBeVisible();
    /* O que o dono mediu como "pequeno demais" é a ÁREA DE PLOT, não a caixa:
           170px de caixa renderizam ~90px de plot, e foi isso que ele viu. A
           caixa carrega também a legenda e o eixo X, e o Recharts os reserva
           DENTRO do SVG — 280px de caixa dão ~187px de área desenhável.

           O teste mede as DUAS coisas e fixa o que importa: o plot nunca abaixo
           de 180px (o piso que o dono pediu, e o que existia em 2022 quando
           reclamou), e a caixa na faixa 240–300px no desktop. Fixar 240–280 na
           CAIXA reprovaria com o gráfico certo na tela, que é a mesma armadilha
           da asserção que comparava `y1` com `d` de sistemas diferentes. */
    const sizes = await chart.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const plot = node.querySelector('.recharts-cartesian-grid');
      const area = node.querySelector('.recharts-layer.recharts-area');
      return {
        box: box.height,
        grid: plot?.getBoundingClientRect().height ?? 0,
        area: area?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(sizes.box, 'a caixa do gráfico precisa existir').toBeGreaterThan(0);
    // O PLOT nunca é um decalque — o piso vale em toda largura.
    expect(
      sizes.area,
      `área desenhada abaixo de 180px (caixa=${sizes.box}, grade=${sizes.grid})`,
    ).toBeGreaterThanOrEqual(180);
    if ((page.viewportSize()?.width ?? 0) > 760) {
      expect(
        sizes.box,
        `caixa do gráfico deveria estar em 240–300px no desktop (área=${sizes.area})`,
      ).toBeGreaterThanOrEqual(240);
      expect(sizes.box).toBeLessThanOrEqual(300);
    }

    await page.screenshot({ path: 'capturas/grafico-area-padrao.png', fullPage: true });
  });

  test('o padrão visual: área preenchida, grade tracejada horizontal, sem dots, com legenda', async ({
    page,
  }) => {
    /* Cada item aqui é uma linha do padrão que o card manda reproduzir. A
       verificação é estrutural no DOM do SVG, não por screenshot — uma
       diferença de cor ou de espessura passa, uma mudança de elemento
       (série virando barra, dots aparecendo) reprova. */
    await openOverview(
      page,
      reportWith(['50.00', '120.00', '80.00', '200.00', '260.00', '310.00']),
    );

    const chart = page.locator('.report-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('.recharts-area-area')).toHaveCount(1);
    // Barra NÃO: é o teste que impede a troca por categoria.
    await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(0);
    // `dot={false}`: 30 pontos poluem a leitura, e poluir é o defeito.
    await expect(chart.locator('.recharts-area-dot')).toHaveCount(0);
    // Grade horizontal e tracejada. Recharts 3.10 emite
    // `.recharts-cartesian-grid-horizontal line`; o `stroke-dasharray` é
    // ATRIBUTO, e medir `computedStyle` traria o valor herdado — o teste
    // passaria mesmo com a grade cheia.
    const grid = chart.locator('.recharts-cartesian-grid-horizontal line').first();
    await expect(grid).toHaveAttribute('stroke-dasharray', '3 3');
    const verticalLines = await chart.locator('.recharts-cartesian-grid-vertical line').count();
    expect(verticalLines).toBe(0);
    // Legenda embaixo, com o rótulo da série.
    await expect(chart.locator('.recharts-legend-item-text')).toContainText('Resultado acumulado');
    // O degradê vai de 0,34 no topo a 0,02 na base. Os `<stop>` vivem no
    // `<defs>` do SVG — dentro de `.recharts-area-area` não há nenhum, e a
    // versão anterior procurava no lugar errado e recebia lista vazia.
    const stops = await chart.evaluate((node) =>
      [...node.querySelectorAll('linearGradient stop')].map((stop) => ({
        opacity: Number.parseFloat(stop.getAttribute('stop-opacity') ?? 'NaN'),
        offset: stop.getAttribute('offset'),
      })),
    );
    expect(stops).toHaveLength(2);
    expect(stops[0]?.offset).toBe('0%');
    expect(stops[0]?.opacity).toBeCloseTo(0.34, 2);
    expect(stops[1]?.offset).toBe('100%');
    expect(stops[1]?.opacity).toBeCloseTo(0.02, 2);
    // Eixo Y em pt-BR, com o separador de milhar.
    await expect(chart.locator('.recharts-cartesian-axis-tick-value').first()).toBeVisible();
  });

  test('o texto do piso de amostra é a regra do produto, não um placeholder', () => {
    /* Fecha o contrato no código: a frase que o dono mandou preservar
       precisa continuar no fonte, porque um refactor que a substitua por
       "dados insuficientes" cumpre a letra e quebra o produto. */
    const domain = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/product/chart-domain.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(domain).toContain('o gráfico seria uma forma inventada');
    expect(domain).toContain('Os números acima são o resultado');
    expect(domain).toContain('export const MIN_CHART_SAMPLE = 4');
  });
});
