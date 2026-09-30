import {
  POLYMARKET_CATEGORY_LABELS,
  POLYMARKET_ORDER_LABELS,
  POLYMARKET_PERIOD_LABELS,
  formatExactDecimal,
  rankingSampleLabel,
  type PolymarketRanking,
  type PolymarketRankingRow,
} from '@stakeframe/shared';

/**
 * STK-F2-15 — a apresentação do ranking oficial Polymarket.
 *
 * Este módulo é PURO e testável sem navegador: ele devolve a VIEW MODEL
 * (rótulos e textos) que o componente renderiza. A separação segue o padrão
 * que o repositório já usa em `splits-metrics` e `dashboard-metrics`, e ela
 * existe por um motivo concreto: a regra do card — truncamento visível,
 * Composite Score ausente, decimal exato — é verificável em um teste unitário
 * sobre funções, e não precisa de navegador para ser provada.
 *
 * O que este módulo NÃO faz, por decisão do card:
 *
 *  - NÃO calcula P&L próprio, ROI, razão, variação ou qualquer derivado. A
 *    tela mostra os DOIS números que a origem publica (`pnl` e `vol`) e nada
 *    derivado deles. Um "índice de desempenho" seria uma métrica nossa
 *    apresentada como da Polymarket, que é o que o card proíbe.
 *
 *  - NÃO produz badge, selo, avaliação, leitura, comparação ou recomendação.
 *    Não existe campo para isso no schema, então não existe valor para isso na
 *    view: a ausência é estrutural, não uma omissão de estilo.
 *
 *  - NÃO ordena nem escolhe quem aparece. A ordem é a posição que a origem
 *    declarou, e a view carrega o `rank` original.
 */

/** Uma linha pronta para a tabela. */
export type RankingRowView = {
  key: string;
  rank: string;
  /** Nome de exibição, com o identificador público como alternativa honesta. */
  trader: string;
  /** A carteira pública, sempre visível: identifica sem interpretar. */
  wallet: string;
  pnl: string;
  vol: string;
  negative: boolean;
};

export type RankingCompletenessView = {
  truncated: boolean;
  label: string;
  detail: string;
  /** O que a tela escreve sobre a métrica bloqueada, quando bloqueada. */
  aggregate: string;
};

export type RankingView = {
  title: string;
  /** O subtítulo diz qual é a MÉTRICA e a JANELA, em linguagem direta. */
  subtitle: string;
  completeness: RankingCompletenessView;
  sample: string;
  /** `N` + a regra aplicada, para o texto de baixa amostra. */
  lowSampleNotice: string | null;
  requested: number;
  returned: number;
  rows: RankingRowView[];
  emptyTitle: string;
  emptyDetail: string;
};

/**
 * O rótulo de `N` e o texto de baixa amostra, com a MESMA regra do produto.
 *
 * Com `N` abaixo do limiar, a tela mostra números crus e o aviso — nenhuma
 * leitura, nenhuma comparação, nenhuma conclusão. O texto é fixo e não
 * carrega nome de trader nem valor: ele descreve a REGRA, não o dado.
 */
export function rankingSampleViews(ranking: PolymarketRanking): {
  sample: string;
  lowSampleNotice: string | null;
} {
  const sample = rankingSampleLabel(ranking.sample.n);
  if (!ranking.sample.lowSample) return { sample, lowSampleNotice: null };
  const n = ranking.sample.n;
  const min = ranking.sample.minSample;
  return {
    sample,
    lowSampleNotice:
      `Baixa amostra: N = ${n} ${n === 1 ? 'trader' : 'traders'}, abaixo do mínimo de ` +
      `${min} exigido para leitura. A lista abaixo traz apenas os números oficiais da ` +
      'origem, sem interpretação, comparação ou recomendação.',
  };
}

/** Uma linha da view. O nome vem da origem; sem nome, a carteira aparece. */
export function rankingRowView(row: PolymarketRankingRow): RankingRowView {
  const name = row.userName.trim();
  return {
    // A chave é a carteira: ela identifica a observação sem depender do nome,
    // que a origem pode deixar vazio ou repetir.
    key: row.proxyWallet,
    rank: row.rank,
    trader: name === '' ? '(sem nome informado)' : name,
    wallet: row.proxyWallet,
    pnl: formatExactDecimal(row.pnl),
    vol: formatExactDecimal(row.vol),
    negative: row.pnl.startsWith('-'),
  };
}

/**
 * A view completa.
 *
 * A ordem das decisões é o que importa aqui. Primeiro a completude (que vem
 * GRAVADA), porque é ela que determina se existe o que chamar de "ranking
 * inteiro"; depois a amostra (que é a contagem exibida, não a inferida); e
 * só então as linhas. Um estado truncado NUNCA vira uma frase que prometa
 * cobertura total, mesmo com 100 linhas na tela.
 */
export function rankingView(ranking: PolymarketRanking): RankingView {
  const periodLabel = POLYMARKET_PERIOD_LABELS[ranking.window.timePeriod];
  const orderLabel = POLYMARKET_ORDER_LABELS[ranking.window.orderBy];
  const categoryLabel = POLYMARKET_CATEGORY_LABELS[ranking.window.category];
  const { sample, lowSampleNotice } = rankingSampleViews(ranking);
  const rows = ranking.rows.map(rankingRowView);

  return {
    title: `Ranking oficial · ${categoryLabel}`,
    subtitle:
      `${orderLabel} de ${periodLabel.toLowerCase()} publicado pela Polymarket. ` +
      'Posição, P&L e volume são os números da própria origem, exibidos sem arredondamento.',
    completeness: {
      truncated: ranking.completeness.truncated,
      label: ranking.completeness.label,
      detail: ranking.completeness.detail,
      // A métrica dependente de série completa é BLOQUEADA com o motivo, e o
      // texto entra na tela mesmo quando a lista está vazia — é ele que
      // distingue "bloqueado" de "não existe dado".
      aggregate: ranking.aggregate.blocked
        ? (ranking.aggregate.reason ?? 'Métrica bloqueada nesta janela.')
        : 'Cobertura completa: o total do tabuleiro é exibível nesta janela.',
    },
    sample,
    lowSampleNotice,
    requested: ranking.requested,
    returned: ranking.returned,
    rows,
    emptyTitle: ranking.series.available
      ? 'Nenhum trader nesta janela'
      : 'Janela ainda não coletada',
    emptyDetail: ranking.series.available
      ? 'A coleta gravou esta janela e não encontrou trader para os filtros escolhidos.'
      : ranking.completeness.detail,
  };
}

/** As opções de filtro, com o rótulo do enum oficial ao lado do valor. */
export const rankingPeriodOptions = Object.entries(POLYMARKET_PERIOD_LABELS).map(
  ([value, label]) => ({ value, label }),
);
export const rankingCategoryOptions = Object.entries(POLYMARKET_CATEGORY_LABELS).map(
  ([value, label]) => ({ value, label }),
);
export const rankingOrderOptions = Object.entries(POLYMARKET_ORDER_LABELS).map(
  ([value, label]) => ({ value, label }),
);
