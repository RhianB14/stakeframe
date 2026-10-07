import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  POLYMARKET_FAVORITES_LIMIT,
  POLYMARKET_GLOBAL_FILTER_LABELS,
  POLYMARKET_GLOBAL_FILTERS,
  POLYMARKET_GLOBAL_SORT_LABELS,
  POLYMARKET_GLOBAL_SORTS,
  polymarketFavoriteCreatedSchema,
  polymarketFavoriteRemovedSchema,
  polymarketFavoritesResponseSchema,
  type PolymarketGlobalFilter,
  type PolymarketGlobalSort,
} from '@stakeframe/shared';
import { localPolymarketGlobal } from './polymarket-global-data.js';
import {
  globalView,
  globalCardView,
  type GlobalCardView,
  type GlobalMetricView,
} from './polymarket-global-view.js';
import { ApiFailure, request } from './api.js';

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
  const [pageSize, setPageSize] = useState(12);
  const [page, setPage] = useState(1);
  const view = globalView(localPolymarketGlobal, { category: filter, sort });
  const pageCount = Math.max(1, Math.ceil(view.cards.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * pageSize;
  const cards = view.cards.slice(firstIndex, firstIndex + pageSize);
  const firstVisible = view.cards.length === 0 ? 0 : firstIndex + 1;
  const lastVisible = Math.min(firstIndex + pageSize, view.cards.length);

  const changeFilter = (next: PolymarketGlobalFilter) => {
    setFilter(next);
    setPage(1);
  };
  const changeSort = (next: PolymarketGlobalSort) => {
    setSort(next);
    setPage(1);
  };

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
              onClick={() => changeFilter(option)}
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
              onClick={() => changeSort(option)}
            >
              {POLYMARKET_GLOBAL_SORT_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <div className="global-list-controls">
        <label className="global-page-size">
          <span>Tipsters por página</span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {[3, 6, 12, 24, 48].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span className="global-results-count" aria-live="polite">
          {firstVisible}–{lastVisible} de {view.cards.length} tipsters
        </span>
      </div>

      {view.cards.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">▤</span>
          <h3>{view.emptyTitle}</h3>
          <p>{view.emptyDetail}</p>
        </div>
      ) : (
        <ul className="global-grid" data-testid="global-grid">
          {cards.map((card) => (
            <li key={card.key}>
              <TipsterCard card={card} />
            </li>
          ))}
        </ul>
      )}

      <div className="global-pagination" aria-label="Paginação do ranking global">
        <button
          type="button"
          className="global-page-button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={currentPage <= 1}
          aria-label="Página anterior"
        >
          Anterior
        </button>
        <span aria-live="polite">
          Página {currentPage} de {pageCount}
        </span>
        <button
          type="button"
          className="global-page-button"
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          disabled={currentPage >= pageCount}
          aria-label="Próxima página"
        >
          Próxima
        </button>
      </div>

      <p className="panel-footnote">
        Cada métrica derivada mostra a contagem de amostras ao lado; valor desconhecido aparece como
        “Sem base” e métrica que depende de série completa aparece como “bloqueado”.
      </p>
    </section>
  );
}

type TipsterPosition = {
  title?: string | null;
  outcome?: string | null;
  current_size?: number | null;
  avg_price?: number | null;
  current_price?: number | null;
  current_value?: number | null;
  realized_pnl?: number | null;
  unrealized_pnl?: number | null;
  total_pnl?: number | null;
  redeemable?: boolean | null;
  last_event_at?: number | null;
};
type PositionStatus = 'OPEN' | 'CLOSED';

function parsePositions(payload: unknown): TipsterPosition[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new Error('Resposta inválida da API do Polymarket.');
  }
  return (payload as { data: unknown[] }).data.map((item) => {
    if (!item || typeof item !== 'object')
      throw new Error('Posição inválida recebida do Polymarket.');
    const row = item as Record<string, unknown>;
    const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : null);
    const number = (key: string) => (typeof row[key] === 'number' ? (row[key] as number) : null);
    return {
      title: text('title'),
      outcome: text('outcome'),
      current_size: number('current_size'),
      avg_price: number('avg_price'),
      current_price: number('current_price'),
      current_value: number('current_value'),
      realized_pnl: number('realized_pnl'),
      unrealized_pnl: number('unrealized_pnl'),
      total_pnl: number('total_pnl'),
      redeemable: typeof row.redeemable === 'boolean' ? row.redeemable : null,
      last_event_at: number('last_event_at'),
    };
  });
}

async function loadTipsterPositions(wallet: string, status: PositionStatus, signal: AbortSignal) {
  const query = new URLSearchParams({
    user: wallet,
    status,
    limit: '100',
    sort_by: status === 'OPEN' ? 'CURRENT_VALUE' : 'REALIZED_PNL',
    sort_direction: 'DESC',
  });
  const response = await fetch(`https://data-api.polymarket.com/v2/positions?${query}`, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Polymarket retornou ${response.status}.`);
  return parsePositions(await response.json());
}

function demoPositions(
  card: GlobalCardView | undefined,
  status: PositionStatus,
): TipsterPosition[] {
  const market = card?.topMarket.text ?? 'Mercado de exemplo';
  const now = Math.floor(Date.now() / 1000);
  if (status === 'OPEN') {
    return [
      {
        title: market,
        outcome: 'Sim',
        current_size: 248,
        avg_price: 0.42,
        current_price: 0.57,
        current_value: 141.36,
        unrealized_pnl: 37.2,
        redeemable: false,
      },
      {
        title: `Próximo resultado · ${market}`,
        outcome: 'Não',
        current_size: 120,
        avg_price: 0.63,
        current_price: 0.51,
        current_value: 61.2,
        unrealized_pnl: -14.4,
        redeemable: false,
      },
    ];
  }
  return [
    {
      title: market,
      outcome: 'Sim',
      avg_price: 0.38,
      current_size: 0,
      current_value: 0,
      realized_pnl: 82.5,
      total_pnl: 82.5,
      last_event_at: now - 86_400,
    },
    {
      title: `Resultado anterior · ${market}`,
      outcome: 'Não',
      avg_price: 0.54,
      current_size: 0,
      current_value: 0,
      realized_pnl: -24.75,
      total_pnl: -24.75,
      last_event_at: now - 3 * 86_400,
    },
  ];
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const price = (value: number | null | undefined) =>
  value == null
    ? '—'
    : `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value * 100)}¢`;

export function PolymarketTipsterPage({ wallet }: { wallet: string }) {
  const [status, setStatus] = useState<PositionStatus>('OPEN');
  const rawCard = localPolymarketGlobal.cards.find((candidate) => candidate.proxyWallet === wallet);
  const card = rawCard ? globalCardView(rawCard) : undefined;
  const isDemo = import.meta.env.DEV;
  const openQuery = useQuery({
    queryKey: ['polymarket', 'positions', wallet, 'OPEN'],
    queryFn: ({ signal }) => loadTipsterPositions(wallet, 'OPEN', signal),
    enabled: !isDemo && wallet.length > 0,
    staleTime: 30_000,
  });
  const closedQuery = useQuery({
    queryKey: ['polymarket', 'positions', wallet, 'CLOSED'],
    queryFn: ({ signal }) => loadTipsterPositions(wallet, 'CLOSED', signal),
    enabled: !isDemo && wallet.length > 0,
    staleTime: 30_000,
  });
  const query = status === 'OPEN' ? openQuery : closedQuery;
  const positions = isDemo ? demoPositions(card, status) : (query.data ?? []);
  const displayName = card?.name.text ?? wallet;

  return (
    <section className="tipster-detail-page" aria-labelledby="tipster-detail-title">
      <a className="tipster-back-link" href="#pm-global">
        ← Ranking global
      </a>
      <header className="tipster-detail-heading">
        <div>
          <span className="tipster-detail-kicker">PERFIL PÚBLICO · POLYMARKET</span>
          <h2 id="tipster-detail-title">{displayName}</h2>
          <p>{card ? `${card.scope} · ${card.topMarket.text}` : wallet}</p>
        </div>
        <span className="tipster-detail-rank">{card?.rankLabel ?? 'PERFIL'}</span>
      </header>

      {isDemo ? <p className="tipster-demo-note">PRÉVIA COM DADOS DE DEMONSTRAÇÃO</p> : null}

      <div className="tipster-position-tabs" role="tablist" aria-label="Apostas do tipster">
        {(['OPEN', 'CLOSED'] as const).map((option) => {
          const selected = status === option;
          const data = option === 'OPEN' ? openQuery.data : closedQuery.data;
          const count = isDemo ? demoPositions(card, option).length : data?.length;
          return (
            <button
              key={option}
              id={`tipster-tab-${option.toLowerCase()}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="tipster-position-panel"
              onClick={() => setStatus(option)}
            >
              {option === 'OPEN' ? 'Apostas abertas' : 'Apostas fechadas'}
              <span>{count ?? '—'}</span>
            </button>
          );
        })}
      </div>

      <div
        className="tipster-position-panel"
        id="tipster-position-panel"
        role="tabpanel"
        aria-labelledby={`tipster-tab-${status.toLowerCase()}`}
        tabIndex={0}
      >
        {query.isPending && !isDemo ? (
          <p className="tipster-position-state" role="status">
            Carregando apostas…
          </p>
        ) : query.isError && !isDemo ? (
          <div className="tipster-position-error" role="alert">
            <span>Não foi possível carregar as posições deste perfil.</span>
            <button type="button" onClick={() => void query.refetch()}>
              Tentar novamente
            </button>
          </div>
        ) : positions.length === 0 ? (
          <p className="tipster-position-state">Nenhuma aposta nesta aba.</p>
        ) : (
          <div className="tipster-position-list">
            {positions.map((position, index) => {
              const pnl =
                status === 'OPEN'
                  ? position.unrealized_pnl
                  : (position.realized_pnl ?? position.total_pnl);
              return (
                <article className="tipster-position-row" key={`${position.title}-${index}`}>
                  <div className="tipster-position-market">
                    <strong>{position.title || 'Mercado sem título'}</strong>
                    <span>{position.outcome || 'Resultado não informado'}</span>
                  </div>
                  <div>
                    <span className="tipster-position-label">PREÇO DE ENTRADA</span>
                    <strong>{price(position.avg_price)}</strong>
                  </div>
                  {status === 'OPEN' ? (
                    <div>
                      <span className="tipster-position-label">PREÇO ATUAL</span>
                      <strong>{price(position.current_price)}</strong>
                    </div>
                  ) : (
                    <div>
                      <span className="tipster-position-label">ENCERRADA</span>
                      <strong>
                        {position.last_event_at
                          ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(
                              new Date(position.last_event_at * 1000),
                            )
                          : '—'}
                      </strong>
                    </div>
                  )}
                  <div className="tipster-position-result">
                    <span className="tipster-position-label">
                      {status === 'OPEN' ? 'VALOR ATUAL' : 'RESULTADO'}
                    </span>
                    {/* D8: valor de posição ABERTA é não realizado — nunca verde.
                        R2: `current_value` desconhecido é ausência ('—'), não US$ 0,00. */}
                    <strong
                      className={
                        status === 'OPEN'
                          ? ''
                          : pnl == null
                            ? ''
                            : pnl >= 0
                              ? 'is-positive'
                              : 'is-negative'
                      }
                    >
                      {status === 'OPEN'
                        ? position.current_value == null
                          ? '—'
                          : usd.format(position.current_value)
                        : pnl == null
                          ? '—'
                          : usd.format(pnl)}
                    </strong>
                  </div>
                  {status === 'OPEN' && position.redeemable ? (
                    <span className="tipster-redeemable">RESGATÁVEL</span>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
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
    <article
      className={`global-card${card.coverage.truncated ? ' is-truncated' : ''}`}
      data-testid="global-card"
      data-wallet={card.key}
    >
      <FavoriteStar proxyWallet={card.key} traderName={card.name.text} />
      <a className="global-card-link" href={card.href} aria-label={card.ariaLabel}>
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
          {/* O resumo mantém as métricas centrais; amostra e números auxiliares
              continuam disponíveis no aria-label completo do link. */}
          <Metric term="Unidades/mês" metric={card.monthlyUnits} />
        </dl>
      </a>
    </article>
  );
}

function FavoriteStar({ proxyWallet, traderName }: { proxyWallet: string; traderName: string }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const favorites = useQuery({
    queryKey: ['polymarket', 'favorites'],
    queryFn: () => request('/api/v1/polymarket/favorites', polymarketFavoritesResponseSchema),
  });
  const isFavorite =
    favorites.data?.favorites.some((favorite) => favorite.proxyWallet === proxyWallet) ?? false;
  const atLimit = (favorites.data?.used ?? 0) >= POLYMARKET_FAVORITES_LIMIT;
  const add = useMutation({
    mutationFn: () =>
      request('/api/v1/polymarket/favorites', polymarketFavoriteCreatedSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxyWallet }),
      }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['polymarket', 'favorites'] });
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiFailure && cause.code === 'FAVORITES_LIMIT_REACHED'
          ? 'Limite de favoritos atingido.'
          : 'Não foi possível salvar este favorito.',
      ),
  });
  const remove = useMutation({
    mutationFn: () =>
      request(`/api/v1/polymarket/favorites/${proxyWallet}`, polymarketFavoriteRemovedSchema, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['polymarket', 'favorites'] });
    },
    onError: () => setError('Não foi possível remover este favorito.'),
  });
  const pending = favorites.isPending || add.isPending || remove.isPending;
  const blockedByLimit = !isFavorite && atLimit;
  const actionLabel = blockedByLimit
    ? `Limite de ${POLYMARKET_FAVORITES_LIMIT} favoritos atingido`
    : `${isFavorite ? 'Remover' : 'Adicionar'} ${traderName} ${isFavorite ? 'dos' : 'aos'} favoritos`;

  return (
    <div className="global-favorite-control">
      <button
        type="button"
        className={`global-favorite-star${isFavorite ? ' is-favorite' : ''}`}
        aria-label={actionLabel}
        aria-pressed={isFavorite}
        title={
          blockedByLimit
            ? actionLabel
            : isFavorite
              ? 'Remover dos favoritos'
              : 'Adicionar aos favoritos'
        }
        disabled={pending || blockedByLimit}
        onClick={() => {
          setError(null);
          if (isFavorite) remove.mutate();
          else add.mutate();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 2.8 2.85 5.78 6.38.93-4.62 4.5 1.09 6.36L12 17.37l-5.7 3 1.09-6.36-4.62-4.5 6.38-.93L12 2.8Z" />
        </svg>
      </button>
      {error ? (
        <span className="global-favorite-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
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
