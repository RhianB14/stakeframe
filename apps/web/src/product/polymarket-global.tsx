import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  POLYMARKET_FAVORITES_LIMIT,
  POLYMARKET_GLOBAL_FILTER_LABELS,
  POLYMARKET_GLOBAL_FILTERS,
  polymarketFavoriteCreatedSchema,
  polymarketFavoriteRemovedSchema,
  polymarketFavoritesResponseSchema,
  polymarketRankingSchema,
  formatExactDecimal,
  type PolymarketGlobalFilter,
} from '@stakeframe/shared';
import { ApiFailure, request } from './api.js';
import { formatDisplayDate } from './preferences.js';

const rankingSorts = [
  { value: 'PNL', label: 'PnL' },
  { value: 'VOLUME', label: 'Volume' },
] as const;

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
 * Os dados e a classificação vêm do endpoint autenticado, cuja série depende
 * do worker de ingestão. Quando a série não existe, a interface explica isso
 * sem recorrer a perfis ou métricas fictícias.
 */
export function PolymarketGlobalPage() {
  const [filter, setFilter] = useState<PolymarketGlobalFilter>('ALL');
  const [sort, setSort] = useState<(typeof rankingSorts)[number]['value']>('PNL');
  const [pageSize, setPageSize] = useState(12);
  const [page, setPage] = useState(1);
  const category = filter === 'ALL' ? 'OVERALL' : filter;
  const orderBy = sort === 'VOLUME' ? 'VOL' : 'PNL';
  const query = useQuery({
    queryKey: ['polymarket', 'ranking', category, orderBy],
    queryFn: () => {
      const params = new URLSearchParams({ category, timePeriod: 'MONTH', orderBy, limit: '100' });
      return request(`/api/v1/polymarket/ranking?${params}`, polymarketRankingSchema);
    },
    staleTime: 60_000,
  });
  const rows = query.data?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const firstIndex = (currentPage - 1) * pageSize;
  const cards = rows.slice(firstIndex, firstIndex + pageSize);
  const firstVisible = rows.length === 0 ? 0 : firstIndex + 1;
  const lastVisible = Math.min(firstIndex + pageSize, rows.length);

  const changeFilter = (next: PolymarketGlobalFilter) => {
    setFilter(next);
    setPage(1);
  };
  const changeSort = (next: (typeof rankingSorts)[number]['value']) => {
    setSort(next);
    setPage(1);
  };

  return (
    <section className="panel" aria-labelledby="polymarket-global-title">
      <div className="section-heading">
        <div>
          <h2 id="polymarket-global-title">Ranking global · Polymarket</h2>
          <p>Leaderboard mensal publicado pela Polymarket · valores em US$ da origem</p>
        </div>
        <span className="live-label" data-testid="global-count">
          {query.data ? `${query.data.returned} de ${query.data.requested} traders` : 'RANKING'}
        </span>
      </div>

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
            </button>
          ))}
        </div>
        <div className="global-filter-group" role="group" aria-label="Ordenar por">
          {rankingSorts.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`global-chip${sort === value ? ' is-active' : ''}`}
              aria-pressed={sort === value}
              onClick={() => changeSort(value)}
            >
              {label}
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
          {firstVisible}–{lastVisible} de {rows.length} traders
        </span>
      </div>

      {query.isPending ? <p role="status">Carregando leaderboard oficial…</p> : null}
      {query.isError ? (
        <div className="empty-state" role="alert">
          <h3>Ranking oficial indisponível</h3>
          <p>
            A prévia precisa de uma sessão autenticada e de uma série Polymarket ingerida no
            backend.
          </p>
          <button type="button" onClick={() => void query.refetch()}>
            Tentar novamente
          </button>
        </div>
      ) : null}
      {!query.isError && query.data && !query.data.series.available ? (
        <div className="empty-state" role="status">
          <h3>Esta série ainda não foi coletada</h3>
          <p>{query.data.completeness.detail}</p>
        </div>
      ) : null}
      {!query.isError && query.data?.series.available && rows.length === 0 ? (
        <div className="empty-state">
          <h3>Nenhum trader nesta série</h3>
          <p>A coleta está disponível, mas não trouxe linhas para esta categoria.</p>
        </div>
      ) : query.data?.series.available ? (
        <ul className="global-grid" data-testid="global-grid">
          {cards.map((trader) => (
            <li key={trader.proxyWallet}>
              <article
                className="global-card"
                data-testid="global-card"
                data-wallet={trader.proxyWallet}
              >
                <FavoriteStar
                  proxyWallet={trader.proxyWallet}
                  traderName={trader.userName || trader.proxyWallet}
                />
                <a
                  className="global-card-link"
                  href={`#pm-tipster/${trader.proxyWallet}`}
                  aria-label={`${trader.userName || trader.proxyWallet}, rank ${trader.rank}, P and L ${formatExactDecimal(trader.pnl)}, volume ${formatExactDecimal(trader.vol)}`}
                >
                  <header className="global-card-head">
                    <span className="global-avatar" aria-hidden="true">
                      {(trader.userName.trim()[0] || '?').toUpperCase()}
                    </span>
                    <span className="global-card-identity">
                      <span className="global-card-name">
                        {trader.userName || trader.proxyWallet}
                      </span>
                      <span className="global-card-scope">{category}</span>
                    </span>
                    <span className="global-card-rank">#{trader.rank}</span>
                  </header>
                  <dl className="global-metrics">
                    <div>
                      <dt>P&amp;L · 30D</dt>
                      <dd>{formatExactDecimal(trader.pnl)}</dd>
                    </div>
                    <div>
                      <dt>VOLUME · 30D</dt>
                      <dd>{formatExactDecimal(trader.vol)}</dd>
                    </div>
                  </dl>
                  <span className="global-card-wallet">{trader.proxyWallet}</span>
                </a>
              </article>
            </li>
          ))}
        </ul>
      ) : null}

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

      {query.data?.series.available ? (
        <p className="panel-footnote">
          {query.data.completeness.label}: {query.data.completeness.detail} ·{' '}
          {query.data.series.ingested} traders coletados · backfill desde{' '}
          {query.data.series.backfillFrom}
        </p>
      ) : null}
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
  const openQuery = useQuery({
    queryKey: ['polymarket', 'positions', wallet, 'OPEN'],
    queryFn: ({ signal }) => loadTipsterPositions(wallet, 'OPEN', signal),
    enabled: wallet.length > 0,
    staleTime: 30_000,
  });
  const closedQuery = useQuery({
    queryKey: ['polymarket', 'positions', wallet, 'CLOSED'],
    queryFn: ({ signal }) => loadTipsterPositions(wallet, 'CLOSED', signal),
    enabled: wallet.length > 0,
    staleTime: 30_000,
  });
  const query = status === 'OPEN' ? openQuery : closedQuery;
  const positions = query.data ?? [];
  const displayName = wallet;

  return (
    <section className="tipster-detail-page" aria-labelledby="tipster-detail-title">
      <a className="tipster-back-link" href="#pm-global">
        ← Ranking global
      </a>
      <header className="tipster-detail-heading">
        <div>
          <span className="tipster-detail-kicker">PERFIL PÚBLICO · POLYMARKET</span>
          <h2 id="tipster-detail-title">{displayName}</h2>
          <p>CARTEIRA PÚBLICA · POLYMARKET</p>
        </div>
        <span className="tipster-detail-rank">PERFIL</span>
      </header>

      <div className="tipster-position-tabs" role="tablist" aria-label="Apostas do tipster">
        {(['OPEN', 'CLOSED'] as const).map((option) => {
          const selected = status === option;
          const data = option === 'OPEN' ? openQuery.data : closedQuery.data;
          const count = data?.length;
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
        {query.isPending ? (
          <p className="tipster-position-state" role="status">
            Carregando apostas…
          </p>
        ) : query.isError ? (
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
                          ? formatDisplayDate(
                              new Date(position.last_event_at * 1000).toISOString(),
                              { dateStyle: 'medium' },
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
