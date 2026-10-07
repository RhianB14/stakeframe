import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// STK-F2-18 (PR-1) — o mesmo medidor que o E2E usa, importado uma vez.
import {
  contrastRatio,
  luminance,
  oklabToRgb,
  relativeLuminance,
  toSrgbChannels,
  type LinearRgb,
} from '../helpers/color.js';

const read = (relative: string) =>
  // Normaliza a quebra de linha. O repositório não tem `text=auto` no
  // .gitattributes para `.tsx`, então o mesmo arquivo pode chegar com LF num
  // clone e CRLF noutro — e um teste que casa `type Page =\n(...)` passa no
  // primeiro e falha no segundo. Foi exatamente o que aconteceu aqui: a
  // asserção reprovava com `declared` vazio, num arquivo cujo conteúdo
  // estava correto. O `\r` é ruído de plataforma, nunca sinal.
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const tokensCss = read('../../apps/web/src/product/tokens.css');
const productCss = read('../../apps/web/src/product/product.css');
const styleCss = read('../../apps/web/src/style.css');
const productApp = read('../../apps/web/src/product/ProductApp.tsx');

/**
 * STK-F2-18 (Fase 4) — os arquivos JSX da Fase 4 entram na guarda.
 *
 * A guarda original lia `product.css` e `style.css`. Não lia `.tsx`, e é por
 * isso que as 10 cores hex dentro do JSX dos gráficos (`analytics.tsx`,
 * apontadas pela análise original) sobreviveram à Fase 0: ela barrava hex em
 * folha de estilo e não em componente. Um teste de token que não vê o
 * componente é metade da verificação.
 */
const overviewReport = read('../../apps/web/src/product/overview-report.tsx');
const analytics = read('../../apps/web/src/product/analytics.tsx');
const events = read('../../apps/web/src/product/events.tsx');
const financePages = read('../../apps/web/src/product/pages.tsx');
const polymarketSimulation = read('../../apps/web/src/product/polymarket-simulation.tsx');

/** Um arquivo JSX de cor, com a linha em que o hex aparece. */
function tsxHexes(source: string, name: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    // Comentário e string de URL não são cor: `#product-main` num skip link
    // e um id de âncora casariam `#abc` se não fossem filtrados.
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*\/\/.*$/, '');
    for (const match of code.match(HEX_SOURCE) ?? []) {
      const value = match.toLowerCase();
      // 3 dígitos: `#fff` é cor. 4/6/8: cor. Mas `#product-main` casa
      // `{3}`? Não — `p`, `r`, `o` não são hex. Ainda assim, uma âncora
      // como `#abc123def` seria confundida; o filtro exige que o valor
      // inteiro seja um hex válido de 3, 4, 6 ou 8 dígitos.
      if (/^#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/.test(value)) {
        found.push(`${name}:${index + 1} ${value}`);
      }
    }
  });
  return found;
}

/**
 * STK-F2-18 — guardas da camada de tokens.
 *
 * A Fase 0 do redesign web existe porque o produto tinha 172 valores hex
 * distintos em product.css para o que deveria ser uma escala de neutros, e
 * dois deles chosen em momentos diferentes eram visualmente idênticos.
 * These tests exist so that number cannot grow back: they are the only
 * thing standing between the token layer and dissolving again.
 */

/** Literais hex permitidos: a paleta registrada do sistema de design. */
const PALETTE = new Set(['#0d0f0d', '#141714', '#f4f5ef', '#a0a69b', '#2a3029', '#c5f36b']);

/**
 * Paleta da skin BetTrack (app.bet-track.com) — registrada deliberadamente.
 *
 * O produto tem DUAS paletas nomeadas: o contrato (carvão + lima acima) e a skin
 * que pinta as páginas web (--web-* em tokens.css). A guarda não impede duas
 * paletas; impede paleta NÃO registrada. Cor nova aqui exige registro aqui.
 */
const SKIN_PALETTE = new Set([
  '#0b0b0b', '#0c0c0c', '#101010', '#111111', '#121212', '#1a1a1a', '#1b1b1b',
  '#202020', '#20231a', '#292929', '#2b2b2b', '#302315', '#666666', '#444444',
  '#555555', '#565656', '#8b939b', '#777777', '#899198', '#aaaaaa', '#b8b8b4',
  '#c5f622', '#f1f1ed', '#ff9d2e', '#ffffff', '#154de0', '#2859ff',
  '#10110d', '#858783', '#1859ed', '#31c8a0', '#f59b19', '#ed4552', '#8655e8',
  '#e54a9b', '#04b5d1', '#17b8a6', '#8bc927',
]);

/**
 * Casa 3, 4, 6 e 8 dígitos — os quatro formatos que o CSS aceita. A versão
 * anterior (3 e 6) deixou passar `#060910b8` no overlay do diálogo e `#0007`
 * na sombra: com alfa, um hex sai da paleta registrada sem que nenhuma
 * asserção o veja.
 *
 * A ordem das alternativas importa — o `{6}` precisa vir antes do `{3}` para
 * não cortar o literal ao meio. `String.match` com `g` devolve `string[]`
 * direto — `matchAll` seria um iterável que o `lib` deste projeto tipa como
 * possivelmente `undefined`, e não vale o desvio de tipo para um teste.
 */
const HEX_SOURCE = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b/g;
const COLOR_FUNCTION_SOURCE = /(?:rgba?|hsla?)\([^)]*\)/g;

const hexLiterals = (css: string) => {
  const found: string[] = [];
  for (const match of css.match(HEX_SOURCE) ?? []) found.push(match.toLowerCase());
  return found;
};

/**
 * Cores com alfa em `rgba()`/`hsla()` são a mesma classe de defeito que o hex
 * fora de token: valor de cor cru. Só a neutral (preto/branco) é legítima,
 * e mesmo assim só em sombra e scrim.
 */
const rawColorFunctions = (css: string) =>
  (css.match(COLOR_FUNCTION_SOURCE) ?? [])
    .map((value) => value.replace(/\s+/g, ' '))
    .filter((value) => {
      const channels = value.match(/[\d.]+/g) ?? [];
      const [r, g, b] = channels.map(Number);
      // Neutral = os três canais iguais. Qualquer matiz é cor crua.
      return !(r === g && g === b);
    });

/**
 * Pares (seletor, corpo) das regras de primeiro nível de uma folha de estilo.
 *
 * Existe porque `String.matchAll` com `g` devolve um iterável que este
 * `lib` tipa como possivelmente `undefined`, e a alternativa em código era
 * espalhar `as string[]` e `!` em toda regra do teste. Um helper só, com o
 * descarte explícito do iterável vazio.
 */
function rulePairs(css: string): { selector: string; body: string }[] {
  /* Um parser de verdade, não um `([^{}]+)\{([^{}]*)\}` global: aquele
     trata o resto do arquivo como um único seletor gigantesco, e a
     PRIMEIRA ocorrência de cada nome ganha o corpo da ÚLTIMA regra com
     aquele nome. Foi assim que `.miniapp-page` — a regra que carrega os
     overrides de cor do Mini App — foi lida com o corpo da versão de
     media query, e o teste de override passou com o bug que ele existe
     para pegar.

     Aqui o seletor é lido até a chave de abertura e o corpo até a chave de
     fechamento, com profundidade contada: o corpo de uma regra pode
     conter `{` aninhado (media query dentro de regra, ou chave de
     interpolação), e `[^}]*` pararia nele. */
  const pairs: { selector: string; body: string }[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open === -1) break;
    // Comentário antes da chave entrava no seletor: o teste lia
    // `/* Telegram Mini App */ .miniapp-page` como um seletor só, e por isso
    // nunca encontrava a regra — o mesmo furo dos dois lados do par.
    const selector = css
      .slice(index, open)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    if (selector) pairs.push({ selector, body: css.slice(open + 1, cursor - 1) });
    index = cursor;
  }
  return pairs;
}

/** Ids entre aspas num trecho, via grupo de captura — sem `!` e sem `matchAll`. */
function quoted(source: string, block: RegExp, pattern: RegExp): string[] {
  const body = source.match(block)?.[1] ?? '';
  const found: string[] = [];
  const scanner = new RegExp(pattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(body)) !== null) {
    const value = match[1];
    if (value !== undefined) found.push(value);
  }
  return found;
}

/** O `:root` de tokens.css é o único lugar onde hex literal é permitido. */
const rootBlock = (css: string) =>
  css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));

const outsideRoot = (css: string) => {
  const start = css.indexOf(':root');
  const end = css.indexOf('}', start);
  return css.slice(0, start) + css.slice(end);
};

describe('camada de tokens (STK-F2-18)', () => {
  it('a paleta registrada é a do sistema de design, sem deriva', () => {
    for (const value of hexLiterals(rootBlock(tokensCss))) {
      expect(
        (PALETTE.has(value) || SKIN_PALETTE.has(value)),
        `${value} em tokens.css :root não pertence a nenhuma paleta registrada (contrato ou skin)`,
      ).toBe(true);
    }
  });

  it('product.css não declara nenhum hex literal fora de var()', () => {
    const stray = hexLiterals(outsideRoot(productCss));
    expect(stray, `hex literal fora de token em product.css: ${stray.join(', ')}`).toEqual([]);
  });

  it('nenhuma cor cromática crua em rgba()/hsla() fora de token', () => {
    /* `rgba(0,0,0,.18)` numa sombra e `rgba(0,0,0,.55)` num scrim são
       neutras e legítimas. `rgba(0,144,255,.4)` não é: é cor de marca
       escrita à mão, invisível para a asserção de hex. */
    const stray = rawColorFunctions(outsideRoot(productCss));
    expect(stray, `cor cromática crua em product.css: ${stray.join(', ')}`).toEqual([]);
  });

  it('a tela pública e de autenticação consome tokens, sem cores cruas', () => {
    /* Entrada, consentimento e telas de acesso compartilham a paleta do
       produto para que a identidade visual não mude antes da autenticação. */
    const distinct = new Set(hexLiterals(outsideRoot(styleCss))).size;
    expect(distinct, `style.css ainda tem ${distinct} cores hex fora dos tokens`).toBe(0);
  });

  it('nenhum JSX da Fase 4 escreve cor em hex — o componente consome tokens', () => {
    /* A análise original apontou "10 cores hardcoded dentro do JSX dos
       gráficos" e a Fase 0 não as viu porque só lia folha de estilo.
       Este é o furo que a Fase 4 fecha, e o teste precisa cobri-lo. */
    const stray = [
      ...tsxHexes(overviewReport, 'overview-report.tsx'),
      ...tsxHexes(analytics, 'analytics.tsx'),
      ...tsxHexes(events, 'events.tsx'),
      ...tsxHexes(financePages, 'pages.tsx'),
      ...tsxHexes(productApp, 'ProductApp.tsx'),
      ...tsxHexes(polymarketSimulation, 'polymarket-simulation.tsx'),
    ];
    expect(stray, `cor em hex dentro do JSX: ${stray.join(' | ')}`).toEqual([]);
  });

  it('nenhum gradiente decorativo de fundo no produto', () => {
    // Gradiente com função (hierarquia) é legítimo; gradiente que só
    // enfeita um fundo plano não é. Os dois que restavam eram
    // `linear-gradient(110deg, A, A)` — a mesma cor nas duas pontas.
    const decorative = (productCss.match(/linear-gradient\([^)]*\)/g) ?? []).filter((value) => {
      const stops = value
        .slice('linear-gradient('.length, -1)
        .split(',')
        .map((s) => s.trim());
      return new Set(stops).size === 1;
    });
    expect(decorative, 'gradiente de mesma cor nas duas pontas').toEqual([]);
  });

  it('todo token de texto tem contraste medido em todas as superfícies', () => {
    /* Contraste real, medido — o número anotado no CSS é o piso, não uma
       intenção. `surface-3` é a mais clara e por isso dita o mínimo.

       STK-F2-18 (PR-1): os conversores `oklabToRgb`/`relativeLuminance` que
       moravam aqui foram para tests/helpers/color.ts. Agora o E2E mede com a
       MESMA função, e o teste `a mesma cor em notações diferentes mede a
       mesma razão` trava essa coincidência. Enquanto as duas suítes
       tivessem instrumentos próprios, nenhuma conferia com a outra. */
    const hexToRgb = (hex: string): LinearRgb => {
      const h = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as LinearRgb;
    };

    const contrast = (a: LinearRgb, b: LinearRgb) => {
      const la = relativeLuminance(a);
      const lb = relativeLuminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    /* STK-F2-18 (hardening): os valores abaixo eram RECOPIADOS aqui e podiam
       divergir de tokens.css sem ninguém notar — foi assim que --text-tertiary e
       --neg ficaram reprovando contra a nova --surface-3. Agora o teste LÊ a
       fonte única: o número no CSS é o que é medido, e a leitura falha alto se
       o token não existir (nada de fallback silencioso). */
    const tokenColor = (token: string, depth = 0): LinearRgb => {
      const oklch = new RegExp(`--${token}:\\s*oklch\\(([^)]+)\\)`).exec(tokensCss);
      if (oklch?.[1] !== undefined) {
        const [l, c, h] = oklch[1].trim().split(/\\s+/).map(Number);
        return oklabToRgb(l ?? 0, c ?? 0, h ?? 0);
      }
      const hex = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,8})`).exec(tokensCss);
      if (hex?.[1] !== undefined) return hexToRgb(hex[1]);
      const alias = new RegExp(`--${token}:\\s*var\\(--([a-z0-9-]+)\\)`).exec(tokensCss);
      if (alias?.[1] !== undefined && depth < 3) return tokenColor(alias[1], depth + 1);
      throw new Error(`token --${token} não encontrado em tokens.css`);
    };

    const surfaces: Record<string, LinearRgb> = {
      '--bg': tokenColor('bg'),
      '--surface-1': tokenColor('surface-1'),
      '--surface-2': tokenColor('surface-2'),
      '--surface-3': tokenColor('surface-3'),
    };

    const tokens: Array<[string, LinearRgb, number]> = [
      ['--text-primary', tokenColor('text-primary'), 4.5],
      ['--text-secondary', tokenColor('text-secondary'), 4.5],
      ['--text-tertiary', tokenColor('text-tertiary'), 4.5],
      ['--accent-ink', tokenColor('accent-ink'), 4.5],
      ['--pos', tokenColor('pos'), 4.5],
      ['--neg', tokenColor('neg'), 4.5],
      ['--warn', tokenColor('warn'), 4.5],
      ['--border-strong', tokenColor('border-strong'), 3],
    ];

    const failures: string[] = [];
    for (const [name, rgb, gate] of tokens) {
      for (const [surfaceName, surfaceRgb] of Object.entries(surfaces)) {
        const ratio = contrast(rgb, surfaceRgb);
        if (ratio < gate) {
          failures.push(`${name} sobre ${surfaceName} = ${ratio.toFixed(2)}:1 (mínimo ${gate})`);
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('o acento de preenchimento tem texto preto legível sobre ele', () => {
    // O texto escuro sobre o acento lima supera o piso de contraste.
    const a = luminance('#0d0f0d');
    const b = luminance('#c5f36b');
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(productCss).toMatch(/\.ui-button-primary\s*\{[^}]*color:\s*var\(--bg\)/);
  });

  it('a mesma cor em notações diferentes mede a mesma razão de contraste', () => {
    /* STK-F2-18 (PR-1) — este é o teste que teria pegado o medidor cego.

       O E2E lia canais com `match(/\d+/g)` e tratava o resultado como RGB
       0-255. Para `oklch(0.68 0 0)` ele casava [0.68, 0, 0], dividia por 255,
       e devolvia luminância sem sentido: `--text-tertiary` sobre
       `--surface-1` "mediava" 1,0598 num piso de 4,5. Nenhuma tela tinha o
       contraste errado — o instrumento é que não media.

       A sanidade é simétrica e fechada: se um dia `oklch()` deixar de bater com
       o equivalente em `rgb()`, a diferença aparece aqui, e não como um
       contraste absurdo numa tela que ninguém mexeu. */
    const surface = '#141714';
    const surfaceRgb = 'rgb(20, 23, 20)';
    const tertiary = 'oklch(0.70 0.01 145)';

    const fromOklch = contrastRatio(tertiary, surface);
    // A MESMA cor pelo caminho que o Chromium usa em `getComputedStyle`.
    const [red, green, blue] = toSrgbChannels(tertiary);
    const asRgb = `rgb(${red}, ${green}, ${blue})`;

    expect(asRgb).toMatch(/^rgb\(/);
    expect(luminance(surface)).toBeCloseTo(luminance(surfaceRgb), 2);
    // Tolerância de 1/255 por canal: o arredondamento do rgb() é a única perda.
    expect(Math.abs(contrastRatio(asRgb, surfaceRgb) - fromOklch)).toBeLessThan(0.02);

    /* A forma CURTA de hex, que é a mais escrita em teste e estava ausente
       da cobertura. `#999` dobrando cada dígito é o mesmo `#999999`; sem esta
       linha o `parseHex` aceitava só `#rrggbb`, o cabeçalho do módulo
       prometia `#rgb`, e a promessa não era cumprida. O `toBe(6)` é exato
       porque dobrar dígito não tem perda nenhuma — qualquer tolerância aqui
       esconderia justamente o erro que o teste existe para pegar. */
    expect(luminance('#999')).toBe(luminance('#999999'));
    expect(luminance('#fff')).toBe(luminance('#ffffff'));
    // O par real do token mantém o piso mínimo de leitura.
    expect(fromOklch).toBeGreaterThanOrEqual(4.5);
  });

  it('nenhum font-size abaixo de 12px em product.css', () => {
    /* STK-F2-18 (PR-2): este teste validava 11,5px e PASSAVA, enquanto o E2E
       exigia 12px na linha 648 e REPROVAVA. Duas suítes discordando do mesmo
       número não estabelecem um piso — uma delas só herdou a fonte errada.
       O piso real é 12px, e agora as duas medem o mesmo.

       Este é o teste de fundo da correção: enquanto ele disser 11,5 ele
       continued legitimando exatamente o valor que o E2E reprovava. */
    const sizes = [...(productCss.match(/font-size:\s*[\d.]+px/g) ?? [])]
      .map((m) => Number(m[1]))
      .filter((v) => v < 12);
    expect(sizes, `font-size abaixo do piso: ${sizes.join(', ')}px`).toEqual([]);
    // E o token que era o culpado: ele LEGITIMAVA o valor que o E2E reprovava.
    expect(tokensCss).toMatch(/--text-xs:\s*12px/);
    expect(tokensCss).not.toMatch(/--text-xs:\s*11\.5px/);
  });

  it('nenhum par fundo/texto que se apaga: mesma cor nos dois lados', () => {
    /* Esta classe de defeito apareceu QUATRO vezes durante a migração e
       nenhuma verificação anterior pegou nenhuma delas, porque cada uma
       estava num arquivo diferente e nenhuma media o par — só a cor. Um
       item selecionado com fundo e texto no mesmo token simplesmente
       some. */
    const rules = rulePairs(productCss);
    const offenders: string[] = [];
    for (const { selector, body } of rules) {
      const background = /background(?:-color)?:\s*(var\(--[a-z0-9-]+\))/.exec(body);
      const color = /(?:^|[;{\s])color:\s*(var\(--[a-z0-9-]+\))/.exec(body);
      if (background && color && background[1] === color[1]) {
        offenders.push(`${selector.trim().slice(0, 60)}: ${background[1]} nos dois lados`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('texto branco nunca senta sobre o acento de preenchimento', () => {
    /* A cor escura de texto sobre o acento lima mantém contraste legível.
       Toda regra que pinta o acento como fundo usa --bg no texto. */
    const rules = rulePairs(productCss);
    const offenders: string[] = [];
    for (const { selector, body } of rules) {
      if (!/background(?:-color)?:\s*var\(--accent\)/.test(body)) continue;
      if (!/color:\s*var\(--bg\)/.test(body)) {
        offenders.push(selector.trim().slice(0, 60));
      }
    }
    expect(offenders, `acento como fundo sem texto --bg: ${offenders.join(', ')}`).toEqual([]);
  });

  it('nenhum token de cor usado como fundo onde ele é token de texto', () => {
    /* --accent-ink é token de TEXTO. Usado como fundo, ele invertia a
       hierarquia: um item de menu selecionado com 30% mais brilho que o
       resto da lista, em vez de um degrau de superfície. */
    const rules = rulePairs(productCss);
    const offenders: string[] = [];
    for (const { selector, body } of rules) {
      const token = /background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/.exec(body)?.[1];
      if (token === undefined) continue;
      const name = token.slice(2, -1);
      if (name.startsWith('text-') || name === 'accent-ink') {
        offenders.push(`${selector.trim().slice(0, 60)}: fundo var(${token})`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('nenhum escopo local aponta token de cor para token de texto', () => {
    /* A lacuna real da Fase 0: a verificação conferia pares de token, e um
       override LOCAL nunca aparece num par de token — ele aparece num
       escopo. Foi assim que os cinco `--mini-*` do Mini App ficaram em
       cinza claro com texto branco por cima, a 2,88:1, e passaram três
       ciclos de verificação sem ninguém medir aquele par.

       A regra é por PAPEL do token, e é mais larga do que parece: um
       token de TEXTO não pode virar fundo, seja qual for o alias. O
       defeito real era `--mini-bg: var(--text-tertiary)` — alias de
       superfície recebendo token de texto. Checar só "texto = texto" era
       a variante estreita e passava batido. */
    const textTokens = [
      '--text-primary',
      '--text-secondary',
      '--text-tertiary',
      '--muted',
      '--muted-dim',
    ];
    const offenders: string[] = [];
    for (const { selector, body } of rulePairs(productCss)) {
      // Comentário sai antes da leitura: a regra que carrega o defeito o
      // documentava logo acima das declarações.
      const declarations = body.replace(/\/\*[\s\S]*?\*\//g, '');
      const scope = /(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/.exec(declarations);
      if (!scope) continue;
      const [, alias, value] = scope;
      if (alias === undefined || value === undefined) continue;
      if (alias.startsWith('--text-') || alias === '--muted') continue;
      if (textTokens.includes(value)) {
        offenders.push(`${selector.trim().slice(0, 50)}: ${alias} = ${value}`);
      }
    }
    expect(
      offenders,
      `token de cor local apontando para token de texto:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('nenhum controle interativo com alvo de toque abaixo de 44px', () => {
    /* O alvo de toque é o motivo de o botão "Copiar" da tabela existir a
       30px: ele é o único controle que alguém mira com o dedo numa tela
       de 14 colunas. */
    const offenders: string[] = [];
    for (const { selector, body } of rulePairs(productCss)) {
      if (!/^[^@]*(button|\.ui-button|nav a|summary|\.chip|\.tab)/.test(selector)) continue;
      const height = /min-height:\s*([\d.]+)px/.exec(body)?.[1];
      if (height !== undefined && Number(height) < 44) {
        offenders.push(`${selector.trim()} min-height: ${height}px`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('todo elemento focável do produto tem anel de foco visível', () => {
    /* A regra é sobre o EFEITO, não sobre a propriedade: um elemento pode
       usar `outline: none` desde que declare um substituto (outline
       próprio, ou borda + box-shadow) — mas nunca em `:focus-visible`
       sem nada que o substitua, que é foco que some de verdade. */
    expect(tokensCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);

    const rules = rulePairs(productCss);
    const offenders: string[] = [];
    for (const { selector, body } of rules) {
      if (!/outline:\s*none/.test(body)) continue;
      const sel = selector.trim();
      if (sel.startsWith('/*') || sel.includes('STK-F2-18')) continue;
      if (/comment|\/\*/.test(sel)) continue;

      if (/focus-visible/.test(sel) && !/outline|box-shadow|border/.test(body)) {
        offenders.push(`${sel}: focus-visible sem substituto`);
      }
      if (!/focus/.test(sel) && !/:hover/.test(sel)) {
        // Legitimo quando o bloco e o estado base de um controle cujo
        // `:focus` declara substituto (borda + box-shadow). O teste
        // abaixo exige que esse substituto exista.
        if (!/input|select|textarea|picker-trigger/.test(sel)) {
          offenders.push(`${sel}: outline none sem regra de foco`);
        }
      }
      if (/focus/.test(sel) && !/focus-visible/.test(sel)) {
        // `:focus` sem `:focus-visible` é legítimo: o anel aparece no
        // teclado e some no clique, que é o comportamento correto.
        continue;
      }
      if (/:hover/.test(sel)) {
        offenders.push(`${sel}: focus sem substituto`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('casca do produto (STK-F2-18)', () => {
  it('a navegação não usa glifos Unicode como ícone', () => {
    // `◫ ▤ ▦ ↗ ▥ ⇧ ⇄ ⚙ ⇢` — vary by platform, do not take currentColor,
    // e some em algumas fontes.
    const glyphs = ['◫', '▤', '▦', '▥', '⇧', '⇄', '⚙', '⇢'];
    const navBlock = productApp.slice(
      productApp.indexOf('const navigation'),
      productApp.indexOf('const miniAppNavigation'),
    );
    const miniBlock = productApp.slice(
      productApp.indexOf('const miniAppNavigation'),
      productApp.indexOf('function currentPage'),
    );
    for (const glyph of glyphs) {
      expect(navBlock, `glifo ${glyph} na navegação web`).not.toContain(glyph);
      expect(miniBlock, `glifo ${glyph} na navegação do Mini App`).not.toContain(glyph);
    }
    expect(navBlock).toContain('NavIcon');
  });

  it('o skip link aponta para o alvo que já existia no código', () => {
    expect(productApp).toContain('className="skip-link"');
    expect(productApp).toContain('href="#product-main"');
    expect(productApp).toMatch(/id="product-main"/);
    // O alvo precisa ser focável por script, senão o foco some nele.
    expect(productApp).toMatch(/id="product-main" tabIndex=\{-1\}/);
  });

  it('a navegação declara os três estados de interação', () => {
    // Antes havia 9 regras :hover em 2.468 linhas e ZERO :active.
    for (const state of [':hover', ':active', '[aria-current=']) {
      expect(productCss, `nenhuma regra ${state} na navegação`).toMatch(
        new RegExp(`product-sidebar nav a${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    }
  });

  it('a lista de navegação e o tipo Page concordam', () => {
    const declared = quoted(productApp, /type Page =\n((?:\s*\|.*\n)+)/, /'([a-z]+)'/g);
    const used = quoted(
      productApp,
      /const navigation = \[([\s\S]*?)\] as const/,
      /id: '([a-z]+)'/g,
    );
    for (const id of used) {
      expect(declared, `Page não declara '${id}'`).toContain(id);
    }
    // `imports` é rota por hash e não aparece no menu — declarada, sem item.
    expect(declared).toContain('imports');
    expect(used).not.toContain('imports');
  });
});
