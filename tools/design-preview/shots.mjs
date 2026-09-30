/**
 * STK-F2-18 — capturas da web real para revisão de design.
 *
 * Abre o produto de verdade (o bundle de `apps/web/dist` servido pelo preview) e
 * fotografa cada destino da navegação. Não é mock de tela: é o React de
 * produção, os tokens de `product/tokens.css` e os componentes reais, com dados
 * do portfólio de preview.
 *
 * Cada tela também coleta o console. Um erro de React apareceria como tela
 * vazia numa foto — indistinguível de "essa tela é assim". O console é o que
 * separa os dois casos, e por isso a captura nunca é aceita sem ele.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:4180';
const OUT = process.argv[2] ?? 'capturas/web';

const DESKTOP = [
  { nav: 'Visão geral', file: '01-visao-geral' },
  { nav: 'Apostas', file: '02-apostas' },
  { nav: 'Calendário', file: '03-calendario' },
  { nav: 'Análises', file: '04-analises' },
  { nav: 'Relatórios', file: '05-relatorios' },
  { nav: 'Ranking', file: '06-ranking' },
  { nav: 'Financeiro', file: '07-financeiro' },
  { nav: 'Configurações', file: '08-configuracoes' },
];
// Os quatro destinos da barra inferior do celular — os mesmos quatro do Mini App.
const MOBILE = [
  { nav: 'Visão geral', file: '09-mobile-painel' },
  { nav: 'Apostas', file: '10-mobile-apostas' },
  { nav: 'Configurações', file: '11-mobile-ajustes' },
];

const problems = [];

/** Espera o casco do produto montar e a rede assentar. */
async function settle(page) {
  await page.waitForSelector('#product-main', { timeout: 20_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  // Um quadro para o React pintar e as animações de entrada terminarem.
  await page.waitForTimeout(500);
}

async function shoot(page, { nav, file }) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (nav !== 'Visão geral') {
    const target = page.locator('nav').getByText(nav, { exact: true }).first();
    if (!(await target.count())) {
      problems.push(`${file}: destino "${nav}" não encontrado na navegação`);
      return null;
    }
    await target.click();
    await page.waitForTimeout(700);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await page.screenshot({ path: join(OUT, `${file}.png`), fullPage: true });
  return inspect(page, file);
}

/**
 * O que de fato foi renderizado. Uma foto mostra pixels; isto mostra o que a
 * tela DIZ — e é a diferença entre "o gráfico está vazio" e "o gráfico recebeu
 * uma série que não tem ponto nenhum". Também mede rolagem horizontal, que é o
 * defeito de layout mais caro e o mais fácil de deixar passar numa captura.
 */
async function inspect(page, file) {
  const report = await page.evaluate(() => {
    const main = document.querySelector('#product-main') ?? document.body;
    const text = (main.innerText ?? '').replace(/\s+\n/g, '\n').trim();
    const overflowing = [...document.querySelectorAll('*')]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return false;
        // `.sr-only` é recortado em 1px de propósito: o `scrollWidth` dele é
        // maior que a caixa por construção, não por defeito de layout.
        if (element.classList.contains('sr-only')) return false;
        if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath?.startsWith('inset(50%'))
          return false;
        return element.scrollWidth - element.clientWidth > 2 && element.clientWidth > 0;
      })
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className || '(sem classe)'}`);
    return {
      text: text.slice(0, 700),
      chars: text.length,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowing,
      tables: document.querySelectorAll('table').length,
      rows: document.querySelectorAll('tbody tr').length,
      svgs: document.querySelectorAll('svg').length,
      // Sinais de estado de erro que a UI renderiza em texto.
      errorish: /erro|falhou|não foi possível|tente novamente|indispon/i.test(text),
    };
  });
  const manifest = [
    `── ${file}`,
    `   caracteres: ${report.chars} · tabelas: ${report.tables} · linhas: ${report.rows} · svg: ${report.svgs}`,
    `   rolagem horizontal: ${report.docOverflow}px · overflow por elemento: ${report.overflowing.length ? report.overflowing.join(', ') : 'nenhum'}`,
    report.errorish ? '   ⚠ contém texto de erro' : '   sem texto de erro',
    `   texto: ${report.text.replace(/\n/g, ' ⏎ ').slice(0, 420)}`,
  ].join('\n');
  console.log(manifest);
  if (report.errorish) problems.push(`${file}: a tela renderizou texto de erro`);
  if (report.docOverflow > 1)
    problems.push(`${file}: rolagem horizontal de ${report.docOverflow}px`);
  if (report.overflowing.length)
    problems.push(`${file}: ${report.overflowing.length} elemento(s) com conteúdo estourando`);
  return report;
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

// ── Desktop ────────────────────────────────────────────────────────────────
const desktop = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await desktop.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 160)}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.slice(0, 160)}`));

for (const target of DESKTOP) {
  try {
    await shoot(page, target);
    console.log(`✓ ${target.file}.png`);
  } catch (error) {
    problems.push(`${target.file}: ${error.message.split('\n')[0]}`);
    console.log(`✗ ${target.file} — ${error.message.split('\n')[0]}`);
  }
}
await desktop.close();

// ── Celular ────────────────────────────────────────────────────────────────
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const phone = await mobile.newPage();
phone.on('pageerror', (error) => problems.push(`mobile pageerror: ${error.message.slice(0, 160)}`));

for (const target of MOBILE) {
  try {
    await shoot(phone, target);
    console.log(`✓ ${target.file}.png`);
  } catch (error) {
    problems.push(`${target.file}: ${error.message.split('\n')[0]}`);
    console.log(`✗ ${target.file} — ${error.message.split('\n')[0]}`);
  }
}
await mobile.close();

await browser.close();

if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const problem of [...new Set(problems)]) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`\n${DESKTOP.length + MOBILE.length} capturas em ${OUT} · console limpo`);
