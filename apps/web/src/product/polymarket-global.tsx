import { useState } from 'react';
import {
  POLYMARKET_GLOBAL_FILTER_LABELS,
  POLYMARKET_GLOBAL_FILTERS,
  POLYMARKET_GLOBAL_SORT_LABELS,
  POLYMARKET_GLOBAL_SORTS,
  type PolymarketGlobalFilter,
  type PolymarketGlobalSort,
} from '@stakeframe/shared';
import { localPolymarketGlobal } from './polymarket-global-data.js';
import {
  globalView,
  type GlobalCardView,
  type GlobalMetricView,
} from './polymarket-global-view.js';

/**
 * STK-F3-04 — a tela Global do Polymarket em CARDS.
 *
 * O dono pediu esta tela três vezes, e cada uma das três reclamações é
 * respondida por uma decisão deste arquivo:
 *
 *  1) "eu queria os tipsters em cards" — é uma GRADE, não tabela e não
 *     gráfico. Os gráficos pequenos que ele viu eram o formato anterior, e
 *     a densidade vem de carregar mais dado por card, não de encolher.
 *
 *  2) "o filtro lateral não fazia nada" — os dois grupos de filtro estão no
 *     topo e ELEMENTS `<button>` de verdade, com `aria-pressed`. O estado
 *     vive em `useState` e a lista é derivada dele. Um filtro que não muda
 *     a lista não é um filtro, e o E2E mede a Mudança da lista.
 *
 *  3) "só sports e e-sports" — a lista vem de `POLYMARKET_GLOBAL_FILTERS`,
 *     que é a lista OFICIAL de 11 filtrada para duas. Não há onde clicar
 *     para pedir cripto ou política.
 *
 * R1/R2/R4/R5/R8 estão no módulo de view e são provadas lá. O que este
 * arquivo garante é o resto:
 *
 *  - O CARD INTEIRO é uma `<a>`, então é focável, responde a Enter e tem
 *    alvo ≥ 44px. Um `<div>` com `onClick` seria clicável e inacessível.
 *  - A RETICÊNCIAS é um caractere do texto (`…` dentro do `title` e do
 *    conteúdo), não `text-overflow`: o corte somem do `innerText`.
 *  - `N` é escrito ao lado de TODA métrica, e o texto da desconhecida é
 *    "Sem base" — nunca uma casa vazia.
 *  - Não há cor inline, não há `style={{}}` e não há termo de avaliação.
 *
 * A INTEGRAÇÃO ESTÁ PENDENTE: os dados vêm de `polymarket-global-data.ts`,
 * que é o que se substitui quando o gate F2-18 for autorizado. A tela acima
 * do dado não muda.
 */
export function PolymarketGlobalPage() {
  const [filter, setFilter] = useState<PolymarketGlobalFilter>('ALL');
  const [sort, setSort] = useState<PolymarketGlobalSort>('PNL');
  const view = globalView(localPolymarketGlobal, { category: filter, sort });

  return (
    <section className="panel" aria-labelledby="polymarket-global-title">
      <div className="section-heading">
        <div>
          <h2 id="polymarket-global-title">{view.title}</h2>
          <p>{view.subtitle}</p>
        </div>
        {/* A contagem é a do resultado FILTRADO, e ela diz de onde veio. */}
        <span className="live-label" data-testid="global-count">
          {view.shown} de {view.total} tipsters
        </span>
      </div>

      {/* Os DOIS grupos de filtro: categoria e ordenação. Ambos funcionam, e
          a distinção é o que impede a confusão do dono — filtro muda QUEM
          aparece, ordenação muda EM QUE ORDEM. */}
      <div className="global-filters">
        <div className="global-filter-group" role="group" aria-label="Filtrar por categoria">
          {POLYMARKET_GLOBAL_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`global-chip${filter === option ? ' is-active' : ''}`}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {POLYMARKET_GLOBAL_FILTER_LABELS[option]}
              {/* A contagem por categoria é DADO, não ornamento: ela mostra
                  que o filtro tem o que encontrar antes de ele ser usado. */}
              <span className="global-chip-count">{view.counts[option]}</span>
            </button>
          ))}
        </div>
        <div className="global-filter-group" role="group" aria-label="Ordenar por">
          {POLYMARKET_GLOBAL_SORTS.map((option) => (
            <button
              key={option}
              type="button"
              className={`global-chip${sort === option ? ' is-active' : ''}`}
              aria-pressed={sort === option}
              onClick={() => setSort(option)}
            >
              {POLYMARKET_GLOBAL_SORT_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {view.cards.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">▤</span>
          <h3>{view.emptyTitle}</h3>
          <p>{view.emptyDetail}</p>
        </div>
      ) : (
        <ul className="global-grid" data-testid="global-grid">
          {view.cards.map((card) => (
            <li key={card.key}>
              <TipsterCard card={card} />
            </li>
          ))}
        </ul>
      )}

      <p className="panel-footnote">
        {view.shown} cards exibidos. Cada métrica derivada mostra a contagem de amostras ao lado;
        valor desconhecido aparece como “Sem base” e métrica que depende de série completa aparece
        como “bloqueado”.
      </p>
    </section>
  );
}

/**
 * O card de um tipster, e ele é uma ÂNCORA.
 *
 * A âncora é a decisão de acessibilidade que importa aqui: o card inteiro
 * é o alvo, então ele recebe foco, responde a Enter e tem um `href` que
 * pode ser copiado e colado. O `title` do nome carrega o texto completo
 * quando a reticência cortou, e o `aria-label` do card carrega as métricas
 * em linguagem falada — inclusive o `N`auditado de cada uma.
 */
function TipsterCard({ card }: { card: GlobalCardView }) {
  return (
    <a
      className={`global-card${card.coverage.truncated ? ' is-truncated' : ''}`}
      href={card.href}
      aria-label={card.ariaLabel}
      data-testid="global-card"
      data-wallet={card.key}
    >
      <header className="global-card-head">
        {/* A inicial é decorativa: o nome está no texto do lado, e repetir
            o nome no `aria-label` do avatar faria o leitor de tela falar o
            mesmo nome duas vezes. */}
        <span className="global-avatar" aria-hidden="true">
          {card.avatar}
        </span>
        <span className="global-card-identity">
          <span
            className="global-card-name"
            title={card.name.truncated ? card.name.text : undefined}
          >
            {card.name.text}
          </span>
          <span className="global-card-scope">{card.scope}</span>
        </span>
        <span className="global-card-rank">{card.rankLabel}</span>
      </header>

      {card.coverage.truncated ? (
        // O aviso de truncamento fica DENTRO do card, e não como rodapé da
        // grade: o card truncado é o que precisa do aviso, e um aviso longe
        // do card obriga o usuário a casar duas informações.
        <p className="global-truncated" role="status">
          <strong>{card.coverage.label}</strong>
          <span>{card.coverage.reason}</span>
        </p>
      ) : null}

      {/* O mercado de maior participação. O rótulo é FACTUAL ("onde mais
          aposta"), e não "melhor mercado": superlativo é avaliação, e a R8
          proíbe a tela de avaliar. O dado é o mesmo, e ele não diz que aquele
          mercado é bom. */}
      <p
        className="global-card-market-label"
        title={card.topMarket.truncated ? card.topMarket.text : undefined}
      >
        Onde mais aposta
      </p>
      <p
        className="global-card-market"
        title={card.topMarket.truncated ? card.topMarket.text : undefined}
      >
        {card.topMarket.text}
      </p>

      <dl className="global-metrics">
        <Metric term="P&amp;L 30d" metric={card.pnl} emphasis />
        <Metric term="ROI" metric={card.roi} />
        <Metric term="Taxa de acerto" metric={card.hitRate} />
        <Metric term="Odd média" metric={card.averageOdds} />
        <Metric term="Seguidores" metric={card.followers} />
        <Metric term="Wins" metric={card.wins} />
        <Metric term="Losses" metric={card.losses} />
        <Metric term="Open bets" metric={card.openBets} />
        {/* Unidades/mês é a métrica que o dono nomeou como sempre visível, e
            ela fica na última linha por decisão de leitura: as contagens
            de carteira vêm antes, e a produção do tipster fecha o card. */}
        <Metric term="Unidades/mês" metric={card.monthlyUnits} />
      </dl>
    </a>
  );
}

/**
 * UMA métrica: o termo, o valor e a amostra.
 *
 * Este é o único lugar do arquivo que escreve uma métrica, e ele escreve as
 * TRÊS coisas sempre: termo, valor, `N`. Não existe uma segunda linha de
 * métrica em nenhum outro lugar da tela — é essa unicidade que torna a R1
 * impossível de violar por descuido.
 */
function Metric({
  term,
  metric,
  emphasis = false,
}: {
  term: string;
  metric: GlobalMetricView;
  emphasis?: boolean;
}) {
  // A cor vem do TOM, que a view calculou a partir do sinal — nunca de uma
  // comparação feita no JSX. E um valor desconhecido não recebe cor: "Sem
  // base" em verde seria uma leitura de resultado que não existe.
  const toneClass = metric.tone === 'pos' ? ' is-pos' : metric.tone === 'neg' ? ' is-neg' : '';
  const stateClass = metric.blocked ? ' is-blocked' : metric.unknown ? ' is-unknown' : '';
  return (
    <div className={`global-metric${emphasis ? ' is-emphasis' : ''}${stateClass}`}>
      <dt>{term}</dt>
      <dd>
        {/* `data-global-n` existe para o E2E medir que a amostra está NA
            TELA de cada métrica, e não só no atributo de acessibilidade. */}
        <span className={`global-metric-value${toneClass}`} data-global-metric={term}>
          {metric.value}
        </span>
        <span className="global-metric-n" data-global-n={term}>
          {metric.sample}
        </span>
      </dd>
    </div>
  );
}
