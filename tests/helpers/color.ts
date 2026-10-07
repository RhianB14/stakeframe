/**
 * STK-F2-18 (PR-1) — medidor de contraste único para unit e E2E.
 *
 * POR QUE ESTE MÓDULO EXISTE
 *
 * Desde a Fase 0 os tokens do produto são `oklch()`. O E2E media contraste com
 *
 *     color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3)
 *
 * e tratava os números como canais RGB 0-255. Para `oklch(0.68 0 0)` isso
 * casa `[0.68, 0, 0]` — três "canais" inválidos — e a luminância resultante é
 * lixo. O sintoma visível era `product.test.ts` reprovando com 1,0598 num piso
 * de 4,5, mas o defeito real era pior que a falha: **todo** `contrastRatio()`
 * do arquivo devolvia lixo sempre que a cor não vinha em `rgb()`, e nenhuma
 * cor ruim estava sendo detectada porque o teste que deveria reprovar mediava
 * uma cor errada. O instrumento estava cego — só que ainda falhava alto, o
 * que mascarava o problema como "uma tela com contraste ruim".
 *
 * A segunda consequência era silenciosa: o unit tinha `oklabToRgb()` próprio
 * e media corretamente. Duas suítes, dois instrumentos, nenhum conferindo
 * com o outro. Este arquivo é a resposta: uma implementação, importada pelas
 * duas.
 *
 * CONVENÇÃO DE ESPAÇO DE COR
 *
 * `oklabToRgb` devolve sRGB **codificado em gama** (0-1), que é a convenção
 * do CSSOM e a que os números anotados em `tokens.css` assumem
 * (`--text-secondary: oklch(0.76 0 0) // rgb 177`). `parseCssColor` devolve
 * canais **linearizados**, porque é a entrada que a fórmula de luminância
 * relativa da WCAG exige. Misturar os dois foi o erro que a primeira versão
 * deste arquivo cometeu, e ele derrubou dois testes de uma vez.
 *
 * FORMATOS ACEITOS
 *
 * - `rgb(r, g, b)` / `rgb(r g b / a)` — o que `getComputedStyle` devolve no
 *   Chromium, e o caminho quente do E2E.
 * - `#rgb` e `#rrggbb`, com ou sem alfa.
 * - `oklch(L C H)`, com L em 0-1, C sem unidade e H em graus, alfa opcional.
 *
 * Qualquer outra notação LANÇA em vez de devolver um número. Um medidor que
 * inventa um valor para uma cor que não entende é pior do que um medidor
 * ausente: transforma um instrumento cego em um instrumento que confirma
 * cegueira.
 */

/** Três canais sRGB linearizados, cada um em 0-1. */
export type LinearRgb = readonly [number, number, number];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Curva de transferência do sRGB: codificado em gama -> linear. */
function linearize(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Curva inversa: linear -> codificado em gama. */
function gammaEncode(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * OKLCh -> sRGB codificado em gama, 0-1 por canal.
 *
 * Mesma matriz do CSS Color 4 (Björn Ottosson). O sinal de gamut fica de
 * fora de propósito: o Browser já recorta para sRGB ao converter, e recortar
 * aqui daria a mesma resposta para toda cor que o CSS aceita, sem divergir do
 * que a tela mostra.
 */
export function oklabToRgb(L: number, C: number, H: number): LinearRgb {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gammaEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gammaEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gammaEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Número em notação de cor, com vírgula ou espaço e unidade opcional. */
function number(token: string): number {
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) throw new Error(`Número inválido na cor: "${token}"`);
  return value;
}

function parseRgb(body: string): LinearRgb {
  const parts = body
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) throw new Error(`rgb() incompleto: "${body}"`);
  // Chromium entrega canais já em 0-255.
  const channels = parts.slice(0, 3).map((token) => linearize(clamp01(number(token) / 255)));
  return [channels[0]!, channels[1]!, channels[2]!];
}

function parseHex(value: string): LinearRgb {
  const hex = value.slice(1);
  // `#rgb` e `#rgba` dobram cada dígito. Precisa ser `join('')`: um `map`
  // devolve um array de pares de 2 caracteres (comprimento 3 para `#fff`),
  // e o guard de comprimento abaixo rejeitaria a forma curta — que é a forma
  // mais comum de escrever cor em teste.
  const digits = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex;
  if (digits.length < 6 || digits.length % 3 !== 0) {
    throw new Error(`hex inválido: "${value}"`);
  }
  const channels = [0, 2, 4].map((i) => {
    const parsed = Number.parseInt(digits[i]! + digits[i + 1]!, 16);
    if (!Number.isFinite(parsed)) throw new Error(`hex inválido: "${value}"`);
    return linearize(parsed / 255);
  });
  return [channels[0]!, channels[1]!, channels[2]!];
}

function parseOklch(body: string): LinearRgb {
  const parts = body
    .split('/')[0]!
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) throw new Error(`oklch() incompleto: "${body}"`);
  const [encodedR, encodedG, encodedB] = oklabToRgb(
    clamp01(number(parts[0]!)),
    Math.max(0, number(parts[1]!)),
    number(parts[2]!),
  );
  return [linearize(encodedR), linearize(encodedG), linearize(encodedB)];
}

/**
 * `oklab()` é a MESMA cor de `oklch()`, com eixos cartesianos no lugar de
 * croma e matiz — e o Chromium serializa alguns tokens assim. Sem isto o
 * medidor lança "notação não suportada" em vez de medir, que é o defeito que
 * este arquivo existe para não repetir.
 */
function parseOklab(body: string): LinearRgb {
  const parts = body
    .split('/')[0]!
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) throw new Error(`oklab() incompleto: "${body}"`);
  const lightness = clamp01(number(parts[0]!));
  const aAxis = number(parts[1]!);
  const bAxis = number(parts[2]!);
  const hue = (Math.atan2(bAxis, aAxis) * 180) / Math.PI;
  const [encodedR, encodedG, encodedB] = oklabToRgb(
    lightness,
    Math.hypot(aAxis, bAxis),
    hue < 0 ? hue + 360 : hue,
  );
  return [linearize(encodedR), linearize(encodedG), linearize(encodedB)];
}

/** Converte qualquer notação suportada para canais sRGB linearizados. */
export function parseCssColor(color: string): LinearRgb {
  const value = color.trim();
  if (value.startsWith('#')) return parseHex(value);
  const call = /^(rgba?|oklch|oklab)\((.*)\)$/is.exec(value);
  if (!call) throw new Error(`Notação de cor não suportada: "${color}"`);
  const name = call[1]!.toLowerCase();
  if (name === 'oklch') return parseOklch(call[2]!);
  if (name === 'oklab') return parseOklab(call[2]!);
  return parseRgb(call[2]!);
}

/**
 * Os três canais que `getComputedStyle` reportaria para esta cor, em 0-255.
 * Existe para o teste de sanidade poder construir o `rgb()` equivalente ao
 * token `oklch()` e comparar as duas notações lado a lado.
 */
export function toSrgbChannels(color: string): readonly [number, number, number] {
  const [red, green, blue] = parseCssColor(color);
  return [
    Math.round(gammaEncode(red) * 255),
    Math.round(gammaEncode(green) * 255),
    Math.round(gammaEncode(blue) * 255),
  ];
}

/**
 * Luminância relativa WCAG 2.x a partir de canais JÁ linearizados.
 * Exportada porque o unit compara token contra token sem passar por notação
 * de string e precisa da mesma aritmética.
 */
export function relativeLuminance([red, green, blue]: LinearRgb): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Luminância relativa WCAG 2.x. Aceita qualquer notação suportada. */
export function luminance(color: string): number {
  return relativeLuminance(parseCssColor(color));
}

/** Razão de contraste WCAG 2.x, independente da ordem dos argumentos. */
export function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}
