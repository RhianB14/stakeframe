import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  POLYMARKET_DEFAULT_WINDOW,
  POLYMARKET_RANKING_LIMIT,
  polymarketRankingSchema,
  type PolymarketRanking,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';
import { PolymarketFavoritesSection, FavoriteButton } from './polymarket-favorites.js';
import {
  rankingCategoryOptions,
  rankingOrderOptions,
  rankingPeriodOptions,
  rankingView,
} from './ranking-view.js';

/**
 * STK-F2-15 — a página do ranking oficial Polymarket.
 *
 * A tela tem três jobs e nenhum quarto:
 *
 *  1) MOSTRAR O QUE A ORIGEM PUBLICOU. Posição, P&L, volume e nome, com os
 *     decimais exatos (sem arredondamento) e na ordem que a origem declarou.
 *     Nenhum número é recalculado aqui.
 *
 *  2) DEIXAR A COMPLETUDE VISÍVEL. O aviso de truncamento não é um detalhe
 *     pequeno: é uma faixa na tela, presente sempre que a série gravada não
 *     for `complete`, e ela diz o que isso significa em português. Uma lista
 *     de 100 traders com a série truncada ainda é uma lista de 100 traders
 *     REAIS — o que ela não é, e a tela não afirma que seja, é o ranking
 *     inteiro.
 *
 *  3) NÃO EXIBIR O QUE ESTÁ PROIBIDO. Não há Composite Score, badge,
 *     recomendação nem qualquer métrica derivada. O esquema da resposta é
 *     `strictObject`, então um campo de pontuação acrescentado no servidor
 *     quebraria o parse em vez de aparecer em silêncio, e o teste §15 varre
 *     também este arquivo.
 *
 * Os filtros usam os ENUMS OFICIAIS, e o período padrão é o do card: P&L de
 * 30 dias (`MONTH` na API) na categoria geral. Uma categoria oficial ainda
 * não ingerida responde com a série ausente e a explicação — nunca uma lista
 * vazia sem aviso.
 */
export function PolymarketRankingPage() {
  const [timePeriod, setTimePeriod] = useState<string>(POLYMARKET_DEFAULT_WINDOW.timePeriod);
  const [category, setCategory] = useState<string>(POLYMARKET_DEFAULT_WINDOW.category);
  const [orderBy, setOrderBy] = useState<string>(POLYMARKET_DEFAULT_WINDOW.orderBy);
  const params = new URLSearchParams({
    timePeriod,
    category,
    orderBy,
    limit: String(POLYMARKET_RANKING_LIMIT),
  });
  const query = useQuery({
    queryKey: ['polymarket', 'ranking', params.toString()],
    queryFn: () => request(`/api/v1/polymarket/ranking?${params}`, polymarketRankingSchema),
  });

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Ranking oficial Polymarket</h2>
          <p>
            Dados do leaderboard público da Polymarket, com posição, P&amp;L, volume e amostra. Só
            entram as métricas publicadas pela própria origem.
          </p>
        </div>
      </div>
      <div className="filter-grid">
        <Field label="Período">
          <select value={timePeriod} onChange={(event) => setTimePeriod(event.target.value)}>
            {rankingPeriodOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Categoria">
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {rankingCategoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ordenação">
          <select value={orderBy} onChange={(event) => setOrderBy(event.target.value)}>
            {rankingOrderOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {query.isPending ? (
        <p className="loading-note" role="status">
          Carregando o ranking…
        </p>
      ) : null}
      {query.isError ? (
        <div className="notice warning" role="alert">
          Não foi possível carregar o ranking oficial.
          <Button variant="secondary" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : null}
      {query.data ? <RankingTable ranking={query.data} /> : null}
      {/* STK-F2-16: favoritos e alerta de atividade, na MESMA tela do ranking.
          A carteira que o usuário está olhando é a carteira que ele favorita, e
          o teto de dez é visível sem sair da lista. A seção vem DEPOIS da
          tabela de propósito: a leitura do ranking oficial vem primeiro, e o
          que o usuário configurou vem depois. */}
      <PolymarketFavoritesSection />
    </section>
  );
}

/**
 * A tabela e os avisos. Ela recebe o payload JÁ validado pelo schema, então
 * tudo que ela escreve vem de dado verificado pela borda.
 */
function RankingTable({ ranking }: { ranking: PolymarketRanking }) {
  const view = rankingView(ranking);
  return (
    <>
      {/* A COMPLETUDE PRIMEIRO. Uma faixa visível, não um rodapé: a leitura de
          "este é o ranking inteiro" não pode acontecer antes do aviso. */}
      {view.completeness.truncated ? (
        <div className="notice warning" role="status">
          <strong>{view.completeness.label}</strong>
          <p>{view.completeness.detail}</p>
          <p>
            <strong>Métrica bloqueada.</strong> {view.completeness.aggregate}
          </p>
        </div>
      ) : (
        <p className="muted">{view.completeness.detail}</p>
      )}
      {view.lowSampleNotice ? (
        <div className="notice warning" role="status">
          <p>{view.lowSampleNotice}</p>
        </div>
      ) : null}
      <div className="section-heading">
        <div>
          <h3>{view.title}</h3>
          <p>{view.subtitle}</p>
        </div>
        <span className="live-label">{view.sample}</span>
      </div>
      {view.rows.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">▤</span>
          <h3>{view.emptyTitle}</h3>
          <p>{view.emptyDetail}</p>
        </div>
      ) : (
        <>
          <p className="bet-table-scroll-hint">
            A tabela é mais larga que a tela. Deslize horizontalmente para ver todas as colunas.
          </p>
          <div
            className="table-scroll"
            role="region"
            aria-label="Ranking oficial Polymarket"
            tabIndex={0}
          >
            <table className="product-table">
              <caption className="sr-only">
                Posição, trader, P&amp;L e volume publicados pela Polymarket
              </caption>
              <thead>
                <tr>
                  <th>Posição</th>
                  <th>Trader</th>
                  <th>Carteira pública</th>
                  <th>P&amp;L</th>
                  <th>Volume</th>
                  <th>Favoritar</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="tabular">{row.rank}</td>
                    <td>
                      <strong>{row.trader}</strong>
                    </td>
                    <td className="tabular">
                      <code className="bet-id-compact">{row.wallet}</code>
                    </td>
                    <td className={`tabular ${row.negative ? 'negative' : ''}`}>{row.pnl}</td>
                    <td className="tabular">{row.vol}</td>
                    {/* STK-F2-16: o botão fica na LINHA, ao lado da carteira que
                        o usuário está olhando. A coluna é a ÚNICA coisa que a
                        F2-16 acrescenta ao ranking, e ela não recebe pontuação,
                        selo nem recomendação — só a ação de guardar. */}
                    <td>
                      <FavoriteButton proxyWallet={row.wallet} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="panel-footnote">
            {view.returned} de {view.requested} posições exibidas. Os valores são os decimais exatos
            que a Polymarket publicou, sem arredondamento e sem conversão de moeda.
          </p>
        </>
      )}
    </>
  );
}
