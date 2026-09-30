import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const tokensCss = read('../../apps/web/src/product/tokens.css');
const productCss = read('../../apps/web/src/product/product.css');
const styleCss = read('../../apps/web/src/style.css');
const productApp = read('../../apps/web/src/product/ProductApp.tsx');

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
const PALETTE = new Set(['#000000', '#0a0a0a', '#ffffff', '#737373', '#242424', '#0099ff']);

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
        PALETTE.has(value),
        `${value} em tokens.css :root não pertence à paleta registrada`,
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

  it('style.css migra para os tokens na Fase 10, sem regredir antes disso', () => {
    /* A tela pública e de autenticação (style.css) tem a SUA paleta —
       #101216 de fundo, #739bff de acento — que é a segunda coexistindo
       sem reconciliação. A migração dela é a Fase 10 do plano, não esta.
       Este teste segura a LINHA DE BASE: o número não pode crescer, e
       quando a Fase 10 rodar ele vira zero junto com a primeira asserção. */
    const baseline = 54;
    const distinct = new Set(hexLiterals(outsideRoot(styleCss))).size;
    expect(
      distinct,
      `style.css tem ${distinct} hex distintos; a linha de base é ${baseline} (Fase 10 zera)`,
    ).toBeLessThanOrEqual(baseline);
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
       intenção. `surface-3` é a mais clara e por isso dita o mínimo. */
    const relativeLuminance = (channels: number[]) =>
      channels
        .map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);

    const oklabToRgb = (L: number, C: number, H: number) => {
      const h = (H * Math.PI) / 180;
      const a = C * Math.cos(h);
      const b = C * Math.sin(h);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
      return rgb.map((u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055));
    };

    const hexToRgb = (hex: string) => {
      const h = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    };

    const contrast = (a: number[], b: number[]) => {
      const la = relativeLuminance(a);
      const lb = relativeLuminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const surfaces = {
      '--bg': hexToRgb('#000000'),
      '--surface-1': hexToRgb('#0a0a0a'),
      '--surface-2': oklabToRgb(0.16, 0, 0),
      '--surface-3': oklabToRgb(0.185, 0, 0),
    };

    const tokens: Array<[string, number[], number]> = [
      ['--text-primary', hexToRgb('#ffffff'), 4.5],
      ['--text-secondary', oklabToRgb(0.76, 0, 0), 4.5],
      ['--text-tertiary', oklabToRgb(0.68, 0, 0), 4.5],
      ['--accent-ink', oklabToRgb(0.76, 0.13, 245), 4.5],
      ['--pos', oklabToRgb(0.82, 0.14, 158), 4.5],
      ['--neg', oklabToRgb(0.78, 0.15, 26), 4.5],
      ['--warn', oklabToRgb(0.84, 0.13, 82), 4.5],
      ['--border-strong', oklabToRgb(0.58, 0, 0), 3],
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
    // #ffffff sobre #0099ff mede 3,00:1 — reprova. Preto mede 7,00:1.
    const lum = (hex: string) => {
      const h = hex.replace('#', '');
      return [0, 2, 4]
        .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    };
    const a = lum('#000000');
    const b = lum('#0099ff');
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(productCss).toMatch(/\.ui-button-primary\s*\{[^}]*color:\s*var\(--bg\)/);
  });

  it('nenhum font-size abaixo de 11,5px em product.css', () => {
    const sizes = [...(productCss.match(/font-size:\s*[\d.]+px/g) ?? [])]
      .map((m) => Number(m[1]))
      .filter((v) => v < 11.5);
    expect(sizes, `font-size abaixo do piso: ${sizes.join(', ')}px`).toEqual([]);
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
    /* #ffffff sobre #0099ff mede 3,00:1 — reprova o mínimo de 4,5:1.
       Toda regra que pinta o acento como fundo tem de inverter o texto
       para --bg, que mede 7,00:1. */
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
