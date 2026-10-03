import {
  GLOBAL_MARKET_MAX,
  GLOBAL_NAME_MAX,
  METRIC_BLOCKED,
  POLYMARKET_GLOBAL_SCOPE_LABELS,
  SEM_BASE,
  formatGlobalDecimal,
  formatGlobalPercent,
  globalAvatarInitial,
  globalCategoryMatches,
  globalMarketView,
  globalNameView,
  globalSampleLabel,
  globalSortCards,
  type PolymarketDerivedMetric,
  type PolymarketGlobalCard,
  type PolymarketGlobalFilter,
  type PolymarketGlobalResponse,
  type PolymarketGlobalSort,
  type TruncatedText,
} from '@stakeframe/shared';

/**
 * STK-F3-04 — a apresentação da tela Global, como VIEW MODEL puro.
 *
 * Este módulo é o mesmo padrão de `ranking-view` e `favorites-view`: ele
 * devolve rótulos e textos, e o componente só renderiza. A separação não é
 * estética — é o que torna a R1 ("N visível"), a R2 ("Sem base") e a R4
 * (truncamento visível) verificáveis em um teste de função, sem navegador.
 *
 * A regra estrutural que este módulo garante: NENHUMA métrica é renderizada
 * sem o seu `N`. `globalMetricView` é o ÚNICO caminho que produz o par
 * (valor, amostra), então não existe linha no componente que escreva uma
 * métrica derivada e esqueça a amostra.
 *
 * O que este módulo NÃO faz, por R8: não produz avaliação, selo, badge,
 * comentário, leitura ou recomendação. Não existe campo para isso na view, e
 * a ausência é estrutural — não há como o texto "o melhor" aparecer, porque
 * ninguém escreve "o melhor" aqui.
 */

/** O par que a tela escreve: o valor e a amostra, sempre juntos. */
export type GlobalMetricView = {
  /** O texto do valor. "Sem base" quando desconhecido; "bloqueado" quando a
   *  cobertura trunca a métrica. Nunca vazio. */
  value: string;
  /** O rótulo de `N`, sempre presente — inclusive com o valor desconhecido. */
  sample: string;
  /** `null` só quando a MÉTRICA é que é desconhecida; `0` é uma medida. */
  unknown: boolean;
  /** A métrica foi BLOQUEADA por truncagem de cobertura. */
  blocked: boolean;
  /** O sinal do resultado, para a cor. `null` não recebe cor de resultado. */
  tone: 'pos' | 'neg' | null;
};

/** O rótulo do valor: o que a tela escreve na casa do número. */
function toneFor(token: string | null): 'pos' | 'neg' | null {
  if (token === null) return null;
  if (token === '0' || token === '0.0' || token === '0.00') return null;
  return token.startsWith('-') ? 'neg' : 'pos';
}

/**
 * A MÉTRICA com a sua amostra — o único jeito de renderizar uma métrica
 * derivada nesta tela.
 *
 * A ordem de decisão importa e é a do produto: primeiro a BLOQUEADA (a
 * cobertura manda), depois a DESCONHIDA (`null` vira "Sem base"), e só então
 * o valor. Uma métrica bloqueada nunca sai como número estimado, e uma
 * desconhecida nunca sai como zero.
 */
export function globalMetricView(
  metric: PolymarketDerivedMetric,
  options: { blocked?: boolean; percent?: boolean } = {},
): GlobalMetricView {
  const sample = globalSampleLabel(metric.n);
  if (options.blocked === true) {
    // A métrica foi avaliada e recusada. A amostra continua visível: ela é
    // o que sabemos, e escondê-la junto com o valor esconderia o motivo do
    // bloqueio.
    return { value: METRIC_BLOCKED, sample, unknown: false, blocked: true, tone: null };
  }
  if (metric.value === null) {
    return { value: SEM_BASE, sample, unknown: true, blocked: false, tone: null };
  }
  return {
    value:
      options.percent === true
        ? formatGlobalPercent(metric.value)
        : formatGlobalDecimal(metric.value),
    sample,
    unknown: false,
    blocked: false,
    tone: toneFor(metric.value),
  };
}

/** O texto de uma métrica inteira, que não leva separador de milhar. */
export function globalCountView(
  metric: PolymarketDerivedMetric,
  options: { blocked?: boolean } = {},
): GlobalMetricView {
  const view = globalMetricView(metric, options);
  if (view.blocked || view.unknown) return view;
  // Contagens não são dinheiro: "1.240" é o formato pt-BR e não "1,240".
  return { ...view, value: new Intl.NumberFormat('pt-BR').format(Number(metric.value)) };
}

/** Um card pronto para renderizar. */
export type GlobalCardView = {
  key: string;
  /** O nome já truncado com reticência de propósito. */
  name: TruncatedText;
  avatar: string;
  /** O rótulo "Esportes" / "E-sports" / "Ambos". */
  scope: string;
  rank: string;
  /** A posição, escrita como ordinal em português ("1º", "2ª"). */
  rankLabel: string;
  pnl: GlobalMetricView;
  roi: GlobalMetricView;
  hitRate: GlobalMetricView;
  averageOdds: GlobalMetricView;
  followers: GlobalMetricView;
  wins: GlobalMetricView;
  losses: GlobalMetricView;
  openBets: GlobalMetricView;
  monthlyUnits: GlobalMetricView;
  volume: GlobalMetricView;
  /** O mercado de maior participação, truncado. */
  topMarket: TruncatedText;
  coverage: { truncated: boolean; reason: string | null; label: string };
  /** O `aria-label` do card inteiro, com `N`auditado no texto. */
  ariaLabel: string;
  /** O destino do clique, para o detalhe do tipster. */
  href: string;
};

/** O ordinal em português, com o gênero do número. */
export function globalRankLabel(rank: string): string {
  const value = Number(rank);
  if (!Number.isInteger(value) || value < 1) return rank;
  if (value === 1) return '1º';
  // A regra do português: o ordinal masculino é "º" para quase todo número
  // (2º, 3º, 4º, 5º) e o feminino é "ª" apenas na série que o português
  // trata como feminina — o segundo e os demais até a nona (2ª, 3ª, 6ª, 8ª).
  // A DÉCIMA muda ("10º") e vale até a décima quarta, onde a concordância
  // volta ao masculino ("11º" a "14º"). Errar essa regra escreveria "3ª"
  // para o terceiro lugar, que é erro de português visível numa tela de
  // e-sports — e é o tipo de detalhe que faz uma tela parecer amadora.
  const lastTwo = value % 100;
  const last = value % 10;
  const feminine = lastTwo >= 11 && lastTwo <= 14 ? false : last === 2 || last === 6 || last === 8;
  return `${value}${feminine ? 'ª' : 'º'}`;
}

/**
 * O rótulo falado de um número, para o `aria-label`.
 *
 * O `aria-label` do card é lido por um leitor de tela, e "R$ 48.210" lido
 * como "R quarenta e oito mil" ou "R quarenta e oito ponto dois" são leituras
 * ruins. Os sinais viram palavras e a vírgula vira " vírgula ", que é o que o
 * leitor espera.
 */
function spokenNumber(text: string): string {
  return text.replace(/−/g, ' menos ').replace(/\./g, ' mil ').replace(/,/g, ' vírgula ');
}

/** O texto de uma métrica para o leitor de tela, com `N`auditado. */
function spokenMetric(view: GlobalMetricView): string {
  if (view.blocked) return `${view.value}, sem base de cálculo`;
  if (view.unknown) return `${view.value}, ${view.sample.replace(/=/g, ' ')}`;
  return `${spokenNumber(view.value)}, ${view.sample.replace(/=/g, ' ')}`;
}

/**
 * Um card na view.
 *
 * A métrica BLOQUEADA por truncagem é a de ROI, e isso vem do próprio card
 * (`coverage.roiBlocked`) — não de uma decisão do componente. O dado continua
 * no payload porque a origem o publicou; o que a tela faz é recusar a
 * exibição dele com o motivo visível, que é a diferença entre "não medido" e
 * "medido e omitido".
 */
export function globalCardView(card: PolymarketGlobalCard): GlobalCardView {
  const name = globalNameView(card.userName);
  const roi = globalMetricView(card.roi, {
    blocked: card.coverage.roiBlocked,
    percent: true,
  });
  const pnl = globalMetricView(card.pnl);
  const view: GlobalCardView = {
    key: card.proxyWallet,
    name,
    avatar: globalAvatarInitial(card.userName),
    scope: POLYMARKET_GLOBAL_SCOPE_LABELS[card.scope],
    rank: card.rank,
    rankLabel: globalRankLabel(card.rank),
    pnl,
    roi,
    hitRate: globalMetricView(card.hitRate, { percent: true }),
    averageOdds: globalMetricView(card.averageOdds),
    followers: globalCountView(card.followers),
    wins: globalCountView(card.wins),
    losses: globalCountView(card.losses),
    openBets: globalCountView(card.openBets),
    monthlyUnits: globalCountView(card.monthlyUnits),
    volume: globalMetricView(card.volume),
    topMarket: globalMarketView(card.topMarket),
    coverage: {
      truncated: card.coverage.truncated,
      reason: card.coverage.reason,
      label: card.coverage.truncated ? 'Cobertura truncada' : '',
    },
    // O destino do detalhe. É uma âncora de verdade, com o mesmo padrão de
    // rota de tela da web, e não um `<div>` com `onClick`: o teclado precisa
    // alcançar o card e o link precisa ser copiável.
    href: `#/polymarket/tipster/${card.proxyWallet}`,
    ariaLabel: '',
  };
  view.ariaLabel = [
    view.name.text,
    `categoria ${view.scope}`,
    `posição ${spokenNumber(view.rankLabel)}`,
    `P&L ${spokenMetric(pnl)}`,
    `ROI ${spokenMetric(roi)}`,
    `taxa de acerto ${spokenMetric(view.hitRate)}`,
    `unidades por mês ${spokenMetric(view.monthlyUnits)}`,
  ].join(', ');
  return view;
}

/** A tela inteira: título, contagem e os cards já filtrados e ordenados. */
export type GlobalView = {
  title: string;
  subtitle: string;
  /** Quantos cards a tela mostra DEPOIS do filtro. */
  shown: number;
  /** Quantos existem antes do filtro. */
  total: number;
  cards: GlobalCardView[];
  emptyTitle: string;
  emptyDetail: string;
  /** A contagem por categoria, para o rótulo de cada filtro. */
  counts: Record<PolymarketGlobalFilter, number>;
};

/**
 * A tela: FILTRO e ORDENAÇÃO aplicados de verdade.
 *
 * A ordem das três operações é o que prova que os filtros funcionam: filtrar
 * a lista, ORDENAR o resultado e só então presentations. Um filtro aplicado
 * depois da ordenação daria o mesmo conjunto com outra ordem, e um filtro que
 * só reordena seria a reclamação do dono ("o filtro não fazia nada").
 */
export function globalView(
  response: PolymarketGlobalResponse,
  filters: { category: PolymarketGlobalFilter; sort: PolymarketGlobalSort },
): GlobalView {
  const all = response.cards;
  const filtered = all.filter((card) => globalCategoryMatches(card, filters.category));
  const ordered = globalSortCards(filtered, filters.sort);
  const counts = {
    ALL: all.length,
    SPORTS: all.filter((card) => globalCategoryMatches(card, 'SPORTS')).length,
    ESPORTS: all.filter((card) => globalCategoryMatches(card, 'ESPORTS')).length,
  } as Record<PolymarketGlobalFilter, number>;
  return {
    title: 'Ranking global de tipsters',
    subtitle:
      'Somente esportes e e-sports. Cada métrica derivada traz a contagem de ' +
      'amostras ao lado, e valor desconhecido aparece como "Sem base" — nunca ' +
      'como zero.',
    shown: ordered.length,
    total: all.length,
    cards: ordered.map(globalCardView),
    counts,
    emptyTitle:
      filters.category === 'ALL'
        ? 'Nenhum tipster nesta tela'
        : `Nenhum tipster em ${filters.category === 'SPORTS' ? 'Esportes' : 'E-sports'}`,
    emptyDetail:
      'A coleta local ainda não trouxe tipster para esta combinação de filtro. ' +
      'Isso é ausência de dado, e não um resultado sobre o mercado.',
  };
}

/** Os limites de truncamento, exportados para o E2E medir na tela. */
export const GLOBAL_TRUNCATION_LIMITS = {
  name: GLOBAL_NAME_MAX,
  market: GLOBAL_MARKET_MAX,
} as const;
