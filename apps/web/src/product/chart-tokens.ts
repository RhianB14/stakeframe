/**
 * STK-F2-18 (Fase 4) — cor de gráfico resolvida a partir da camada de tokens.
 *
 * A análise original apontou 10 cores hex dentro do JSX dos gráficos
 * (`analytics.tsx`). Duas coisas estavam erradas na forma de resolver isso, e
 * ambas já custaram retrabalho:
 *
 * 1. `stroke="var(--pos)"` NÃO funciona. `stroke` e `fill` como atributo de
 *    apresentação SVG não aceitam `var()` — custom properties só valem em
 *    declaração CSS. A linha sairia preta ou invisível.
 * 2. Trocar o hex por outro hex dentro do JSX continua sendo a mesma classe de
 *    defeito: o gráfico passa a ter uma segunda fonte de cor, e um tema novo
 *    exigiria editar componente em vez de tema.
 *
 * A solução é resolver o token do CSS uma vez, em runtime, e devolver a cor
 * concreta para a biblioteca de gráfico. A fonte da verdade continua sendo
 * `tokens.css`: mudar o tema é mudar `:root`, não editar componente.
 */

/** Tokens que os gráficos leem, na ordem em que aparecem na paleta. */
const CHART_TOKENS = [
  '--surface-2',
  '--surface-3',
  '--border',
  '--border-strong',
  '--text-secondary',
  '--text-tertiary',
  '--accent-ink',
  '--pos',
  '--neg',
  '--warn',
] as const;

export type ChartTokens = Record<(typeof CHART_TOKENS)[number], string>;

/**
 * Lê os tokens uma vez por montagem. O gráfico é a única superfície do
 * produto que precisa do valor CONCRETO da cor, porque a biblioteca escreve
 * atributo SVG — e atributo não resolve custom property.
 *
 * Sem `document` (SSR, teste de node) devolve string vazia: o gráfico então
 * não pinta, o que é visível, em vez de pintar na cor errada em silêncio.
 */
export function readChartTokens(): ChartTokens {
  const empty = Object.fromEntries(CHART_TOKENS.map((token) => [token, ''])) as ChartTokens;
  if (typeof document === 'undefined') return empty;
  const style = getComputedStyle(document.documentElement);
  const read = (token: string) => style.getPropertyValue(token).trim();
  return Object.fromEntries(CHART_TOKENS.map((token) => [token, read(token)])) as ChartTokens;
}
