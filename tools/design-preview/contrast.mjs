/**
 * STK-F2-18 — contraste medido no navegador, com conversão oklch → sRGB real.
 *
 * A primeira versão deste script lia `getComputedStyle().color` e quebrava a
 * string em números: `oklch(0.63 0 0)` virava `[0.63, 0, 0]`, ou seja quase
 * preto, e TODOS os pares saíam em 1:1. Um verificador que reporta 13 falhas
 * num texto branco sobre preto está errado, não o texto.
 *
 * A conversão abaixo é a matriz oklab → sRGB linear. Para cinza neutro
 * (C = 0) ela devolve exatamente `Y = L³`, o que dá 6,0:1 para `--text-3`.
 */
import { chromium } from '@playwright/test';

/** oklch(L C H) → sRGB linear [r,g,b], com gamut clipping. */
function linearFromOklch(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * Qualquer cor computada → { linear: [r,g,b], alpha }.
 *
 * O canal alfa é o que faltava na primeira versão: `oklch(0.82 0.13 82 / 0.12)`
 * é um fundo de aviso a 12% — sem compor, ele media como se fosse a cor cheia e
 * as três etiquetas davam 1,00:1 contra o próprio texto. A composição acontece
 * em luz linear, que é onde alpha blending é linear de fato.
 */
function parseColor(color) {
  if (!color) return { linear: [0, 0, 0], alpha: 0 };
  const numbers = (color.match(/-?[\d.]+/g) ?? []).map(Number);
  if (color.startsWith('oklch')) {
    const [L = 0, C = 0, H = 0] = numbers;
    const alpha = color.includes('/') ? (numbers[3] ?? 1) : 1;
    return { linear: linearFromOklch(L, C, H), alpha };
  }
  const [r = 0, g = 0, b = 0, a = 1] = numbers;
  const toLinear = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return {
    linear: [toLinear(r), toLinear(g), toLinear(b)],
    alpha: color.startsWith('rgba') ? a : 1,
  };
}

/** Compõe uma pilha de fundos, do mais baixo ao mais alto. */
function composite(layers) {
  let out = [0, 0, 0];
  for (const layer of layers) {
    const alpha = layer.alpha;
    out = out.map((channel, index) => channel * (1 - alpha) + layer.linear[index] * alpha);
  }
  return out;
}

const luminanceOfLinear = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const file = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file:///${file.replace(/\\/g, '/').replace(/ /g, '%20')}`);
await page.waitForTimeout(700);

const pairs = await page.evaluate(() => {
  const alpha = (color) => !color || color === 'transparent' || color.includes('rgba(0, 0, 0, 0)');
  // Pilha de fundos do elemento até a raiz, do mais alto para o mais baixo.
  const backgroundStack = (element) => {
    const stack = [];
    let node = element;
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (!alpha(color)) stack.push(color);
      node = node.parentElement;
    }
    return stack;
  };
  const seen = new Set();
  const rows = [];
  for (const element of document.querySelectorAll(
    'p,h1,h2,h3,h4,span,a,code,figcaption,li,button,td,th,label,strong,b,em',
  )) {
    const text = (element.textContent ?? '').trim();
    if (!text || element.children.length > 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.1)
      continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const background = backgroundStack(element).join(' sobre ');
    const key = `${style.color}|${background}|${style.fontSize}|${style.fontWeight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    rows.push({
      selector: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}`,
      sample: text.slice(0, 34),
      size,
      weight,
      fg: style.color,
      bgStack: backgroundStack(element),
      min: size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5,
    });
  }
  return rows;
});

const evaluated = pairs
  .map((pair) => {
    // `backgroundStack` chega do elemento para a raiz (mais próximo primeiro),
    // e `composite` empilha de baixo para cima: inverter, ou o fundo do corpo
    // pinta por cima do texto e tudo mede 1,00:1.
    const bgLayers = pair.bgStack.map(parseColor).reverse();
    const bgLinear = composite(bgLayers);
    const fg = parseColor(pair.fg);
    // O texto compõe SOBRE o fundo, nunca debaixo dele.
    const fgLinear = composite([{ linear: bgLinear, alpha: 1 }, fg]);
    const lf = luminanceOfLinear(fgLinear);
    const lb = luminanceOfLinear(bgLinear);
    return { ...pair, ratio: (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05) };
  })
  .sort((a, b) => a.ratio - b.ratio);

const failures = evaluated.filter((pair) => pair.ratio + 0.005 < pair.min);
for (const pair of evaluated) {
  const mark = pair.ratio + 0.005 < pair.min ? 'ABAIXO' : 'ok    ';
  console.log(
    `${mark} ${pair.ratio.toFixed(2).padStart(6)}:1  (min ${pair.min})  ${String(pair.size).padStart(5)}px/${pair.weight}  ${pair.selector.padEnd(18)} ${pair.sample}`,
  );
}
console.log(`\npares únicos medidos: ${evaluated.length} · abaixo do mínimo: ${failures.length}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
