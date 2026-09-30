/**
 * STK-F2-18 (Fase 4) — verificação das três telas da Fase 4 no bundle real.
 *
 * A leitura por imagem segue indisponível (quota do gateway), e para o que
 * esta fase precisa medir ela é a via mais rígida de qualquer forma: alinhamento
 * de coluna, contraste computado, transbordo e sobreposição são números, não
 * impressões. O que esta fase mudou é GEOMETRIA — o razão virou tabela, a
 * grade do calendário ganhou chips, as métricas ganharam famílias de cor — e
 * geometria tem resposta exata.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:4180';
const browser = await chromium.launch();
const problems = [];
const notes = [];

/** Contraste WCAG a partir de uma cor computada e seu fundo real. */
const script = `
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const parse = (value) => {
    const m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };
  const comp = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));
  const over = (fg, bg) => [comp(fg, bg), bg];
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => {
    let node = el;
    while (node) {
      const s = getComputedStyle(node);
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.95) return c.rgb;
      node = node.parentElement;
    }
    return [0, 0, 0];
  };
`;

async function check(name, { nav, viewport }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#product-main', { timeout: 20000 });
  await page.waitForTimeout(900);
  if (nav) {
    await page.locator('nav').getByText(nav, { exact: true }).first().click();
    await page.waitForTimeout(1100);
  }

  const result = await page.evaluate((helperSrc) => {
    const ratio = new Function(`${helperSrc}; return (a, b) => { const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05); };`)();
    const parse = (v) => {
      const m = v.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
    };
    const bgOf = (el) => {
      let n = el;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.95) return c.rgb;
        n = n.parentElement;
      }
      return [0, 0, 0];
    };
    const out = { falhas: [], colunas: [], alvos: [], cores: {}, texto: '' };

    // 1. Contraste de TODO texto visível, no fundo real.
    const walker = document.createTreeWalker(document.querySelector('#product-main'), NodeFilter.SHOW_TEXT);
    let node;
    const vistos = new Set();
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!el || vistos.has(el)) continue;
      vistos.add(el);
      const txt = node.textContent?.trim();
      if (!txt || txt.length < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const fg = parse(st.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const composited = fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));
      const r = ratio(composited, bg);
      const size = Number.parseFloat(st.fontSize);
      const bold = Number(st.fontWeight) >= 700;
      const min = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (r < min) {
        out.falhas.push(`contraste ${r.toFixed(2)}:1 (min ${min}) em "${txt.slice(0, 34)}" ${size}px`);
      }
    }

    // 2. Alinhamento: colunas numéricas de tabela que NÃO alinham à direita.
    for (const table of document.querySelectorAll('.product-table')) {
      const rows = [...table.querySelectorAll('tbody tr')];
      if (rows.length < 2) continue;
      const heads = [...table.querySelectorAll('thead th')];
      heads.forEach((th, i) => {
        const cells = rows.map((r) => r.children[i]).filter(Boolean);
        if (cells.length < 2) return;
        const rights = cells.map((c) => c.getBoundingClientRect().right);
        const spread = Math.max(...rights) - Math.min(...rights);
        const numeric = cells.every((c) => /[R$−\d]/.test(c.textContent ?? ''));
        out.colunas.push({
          coluna: th.textContent?.trim().slice(0, 22) ?? `#${i}`,
          desvioPx: Math.round(spread),
          numerica: numeric,
        });
      });
    }

    // 3. Alvos de toque < 44px em elementos clicáveis.
    for (const el of document.querySelectorAll('#product-main button, #product-main a')) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.height < 44) {
        out.alvos.push(`${(el.textContent ?? el.getAttribute('aria-label') ?? el.className).trim().slice(0, 30)}: ${Math.round(r.height)}px`);
      }
    }

    // 4. As famílias de cor que a Fase 4 introduziu. `backgroundColor`, não
    //    `color`: o chip e o cartão comprometido são preenchimentos, e ler
    //    `color` devolvia branco — um alarme falso que treina a ignorar o
    //    verificador. Foi o que aconteceu na primeira execução.
    for (const sel of ['.metric-card.committed', '.metric-card.metric-tone-positive strong', '.metric-card.metric-tone-negative strong', '.calendar-chip.chip-open', '.calendar-chip.chip-settled', '.journal-table tr.journal-reversed']) {
      const el = document.querySelector(sel);
      if (el) out.cores[sel] = getComputedStyle(el).backgroundColor;
    }

    // 5. Transbordo horizontal real.
    out.transbordo = document.documentElement.scrollWidth - (window.innerWidth ?? 0);
    out.texto = (document.querySelector('#product-main')?.innerText ?? '').slice(0, 400);
    return out;
  }, script);

  if (errors.length) problems.push(`${name}: erro de console — ${errors.slice(0, 2).join(' | ')}`);
  if (result.falhas.length) problems.push(`${name}: ${result.falhas.length} falha(s) de contraste`);
  if (result.transbordo > 0) problems.push(`${name}: transbordo horizontal de ${result.transbordo}px`);
  const badColumns = result.colunas.filter((c) => c.numerica && c.desvioPx > 2);
  if (badColumns.length) {
    problems.push(`${name}: coluna numérica desalinhada — ${badColumns.map((c) => `${c.coluna} (${c.desvioPx}px)`).join(', ')}`);
  }
  const small = [...new Set(result.alvos)];
  if (small.length) notes.push(`${name}: ${small.length} alvo(s) < 44px — ${small.slice(0, 4).join(' · ')}`);

  console.log(`\n── ${name}`);
  console.log(`   contraste: ${result.falhas.length === 0 ? 'todas as amostras >= minimo' : result.falhas.slice(0, 5).join(' ; ')}`);
  console.log(`   colunas numericas: ${result.colunas.filter((c) => c.numerica).length} (desalinhadas: ${badColumns.length})`);
  console.log(`   alvos < 44px: ${small.length}${small.length ? ` — ${small.slice(0, 3).join(' · ')}` : ''}`);
  console.log(`   transbordo: ${result.transbordo}px`);
  console.log(`   cores: ${JSON.stringify(result.cores)}`);
  await page.close();
}

await check('visao-geral', { nav: null, viewport: { width: 1440, height: 1000 } });
await check('calendario', { nav: 'Calendário', viewport: { width: 1440, height: 1000 } });
await check('financeiro', { nav: 'Financeiro', viewport: { width: 1440, height: 1000 } });
await check('financeiro-390', { nav: 'Financeiro', viewport: { width: 390, height: 844 } });
await check('calendario-390', { nav: 'Calendário', viewport: { width: 390, height: 844 } });

console.log('\n══ PROBLEMAS');
console.log(problems.length ? problems.map((p) => ` ✗ ${p}`).join('\n') : ' nenhum');
console.log('\n══ NOTAS');
console.log(notes.length ? notes.map((n) => ` · ${n}`).join('\n') : ' nenhuma');
await browser.close();
