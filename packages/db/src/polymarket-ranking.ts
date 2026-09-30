import type { Database } from './index.js';
import {
  canonicalDecimalToken,
  rankingAggregatePolicy,
  rankingCompleteness,
  rankingSample,
  type BackfillStatus,
  type LeaderboardOrderBy,
  type LeaderboardTimePeriod,
  type PolymarketRanking,
  type PolymarketRankingCategory,
  type PolymarketRankingQuery,
  type PolymarketRankingRow,
  type PolymarketRankingSeries,
} from '@stakeframe/shared';

/**
 * STK-F2-15 — a LEITURA do ranking oficial Polymarket.
 *
 * Esta camada é somente de leitura e não altera o schema: ela lê as MESMAS
 * tabelas que a F2-14 criou (`integration.polymarket_series` e
 * `integration.polymarket_trader`) e nada mais. Não há migração nesta tarefa,
 * e a ausência dela é o ponto: a completude que a tela mostra é a que o
 * BANCO gravou, não uma coluna nova criada para a tela.
 *
 * Três garantias moram aqui, e as três são do BANCO, não da disciplina do
 * chamador:
 *
 *  1) O DECIMAL SAI COMO TEXTO. `numeric(38, 18)` volta do Postgres como
 *     string, e ela vai para a resposta sem passar por `Number`. Um
 *     `parseFloat` aqui devolveria `3654334.78878601` para um literal que a
 *     origem publicou como `3654334.788786006` — a tela passaria a exibir um
 *     número que a Polymarket nunca publicou, e a interface deixa de ser
 *     transparente justamente no ponto em que ela promete ser.
 *
 *  2) A COMPLETUDE É LIDA, NUNCA CALCULADA. `status` vem da coluna que a
 *     F2-14 gravou. A função `rankingCompleteness` traduz esse valor em
 *     frase; ela não o deduz da contagem de linhas. Uma lista com 100 linhas
 *     continua sendo declarada truncada se o status gravado é `truncated`,
 *     que é o estado real deste backfill.
 *
 *  3) A JANELA INGERIDA E A JANELA PEDIDA SÃO COISAS DIFERENTES. A ingestão da
 *     F2-14 percorre uma única categoria (`OVERALL`, imposto pelo CHECK
 *     `polymarket_series_category_check`), então as outras dez categorias
 *     oficiais são filtros REAIS da API oficial que ainda não têm série
 *     gravada. A resposta para elas é `available: false` com a explicação
 *     escrita — nunca uma lista vazia, que a interface leria como "não existe
 *     trader nesta categoria". Esta é a divergência entre o enum oficial e o
 *     contrato da F2-14, e ela é REPORTADA na tela em vez de escondida.
 */

/** Erro de leitura com código estável; a API o mapeia para 4xx/5xx. */
export class PolymarketRankingError extends Error {
  constructor(public readonly code: 'RANKING_WINDOW_NOT_INGESTED' | 'RANKING_INTERNAL') {
    super(code);
  }
}

export type PolymarketRankingStore = ReturnType<typeof createPolymarketRankingStore>;

/** O limiar de amostra do produto; injetado para não presumir valor aqui. */
export type RankingOptions = { minSample: number };

export function createPolymarketRankingStore(database: Database) {
  /**
   * O estado da SÉRIE de uma janela, lido da linha gravada pela ingestão.
   *
   * A ausência de linha é um RESPOSTA (`available: false`), não um erro: a
   * janela pode simplesmente nunca ter sido ingerida, e essa é uma informação
   * que a tela precisa mostrar com clareza. É o oposto de tratar ausência
   * como zero, que foi a mentira que o `status` gravado veio para impedir.
   */
  async function seriesOf(input: {
    category: PolymarketRankingCategory;
    timePeriod: LeaderboardTimePeriod;
    orderBy: LeaderboardOrderBy;
  }): Promise<PolymarketRankingSeries> {
    const row = (
      await database.pool.query<{
        status: string;
        quantity: string;
        pages: string;
        failed_pages: string;
        backfill_from: string;
      }>(
        `select status, quantity, pages, failed_pages, backfill_from
           from integration.polymarket_series
          where category = $1 and time_period = $2 and order_by = $3`,
        [input.category, input.timePeriod, input.orderBy],
      )
    ).rows[0];
    if (!row) {
      return {
        status: 'unknown' as BackfillStatus,
        available: false,
        ingested: 0,
        backfillFrom: '0001-01-01',
        pages: 0,
        failedPages: 0,
      };
    }
    return {
      // O CHECK do banco é o enum ('complete','truncated','partial','unknown'),
      // então o valor recebido é um deles por construção; o cast documenta
      // isso e o schema da API valida de novo na borda.
      status: row.status as BackfillStatus,
      available: true,
      ingested: Number(row.quantity),
      pages: Number(row.pages),
      failedPages: Number(row.failed_pages),
      backfillFrom: row.backfill_from,
    };
  }

  /**
   * O TOP N da janela, na POSIÇÃO DECLARADA pela origem.
   *
   * A ordem é `rank::bigint`, e não `pnl` nem `observed_at`: o `rank` é a
   * posição que a Polymarket publicou, e reordenar por uma medida nossa
   * trocaria a resposta oficial por uma ordenação própria. O `rank` é texto no
   * banco (a F2-14 o guardou assim), então o cast para `bigint` acontece AQUI e
   * só para ORDENAR — o valor devolvido ao cliente volta ao texto original.
   *
   * Nenhuma linha de outra janela entra: o filtro é as três colunas da
   * janela, e é a mesma chave que a deduplicação da F2-14 usa.
   */
  async function topOf(input: {
    category: PolymarketRankingCategory;
    timePeriod: LeaderboardTimePeriod;
    orderBy: LeaderboardOrderBy;
    limit: number;
  }): Promise<PolymarketRankingRow[]> {
    const rows = (
      await database.pool.query<{
        rank: string;
        proxy_wallet: string;
        user_name: string;
        pnl: string;
        vol: string;
      }>(
        `select rank, proxy_wallet, user_name, pnl::text as pnl, vol::text as vol
           from integration.polymarket_trader
          where category = $1 and time_period = $2 and order_by = $3
          order by rank::bigint asc
          limit $4`,
        [input.category, input.timePeriod, input.orderBy, input.limit],
      )
    ).rows;
    return rows.map((row) => ({
      rank: row.rank,
      proxyWallet: row.proxy_wallet,
      userName: row.user_name,
      // `pnl` e `vol` são repassados como TEXTO, e o TEXTO que volta do
      // Postgres é o `numeric(38, 18)` com a escala CHEIA. A normalização
      // abaixo remove apenas os zeros à direita do padding — nenhum dígito
      // significativo muda — e devolve a MESMA grafia que a origem publica, o
      // que permite ao teste comparar caractere a caractere. Nenhum `Number`
      // toca estes dois valores em lugar nenhum deste arquivo.
      pnl: canonicalDecimalToken(row.pnl),
      vol: canonicalDecimalToken(row.vol),
    }));
  }

  /**
   * O RANKING montado: janela, completude traduzida, amostra pela regra do
   * produto e as linhas.
   *
   * A ordem das operações é deliberada. A completude é resolvida ANTES de
   * listar as linhas, e a política do agregado é consultada no fim para
   * produzir a recusa que acompanha a resposta. Uma janela não ingerida
   * NÃO é exceção: ela devolve `available: false` com a lista vazia e a
   * explicação, que é a informação verdadeira.
   */
  async function ranking(
    query: PolymarketRankingQuery,
    options: RankingOptions,
  ): Promise<PolymarketRanking> {
    const window = {
      category: query.category,
      timePeriod: query.timePeriod,
      orderBy: query.orderBy,
    };
    const series = await seriesOf(window);
    const rows = series.available ? await topOf({ ...window, limit: query.limit }) : [];
    const completeness = rankingCompleteness({ series });
    const sample = rankingSample({ n: rows.length, minSample: options.minSample });
    // A política do agregado é CONSULTADA e o resultado viaja na resposta como
    // estado explícito. Enquanto a série não for `complete`, a recusa com o
    // motivo acompanha o payload e a interface escreve que a métrica está
    // BLOQUEADA — o card pede "bloqueada ou rotulada explicitamente", e
    // bloquear sem rotular seria indistinguishable de um esquecimento.
    const aggregate = rankingAggregatePolicy(series);
    return {
      window,
      series,
      completeness,
      sample,
      aggregate: aggregate.allowed
        ? { blocked: false, reason: null }
        : {
            blocked: true,
            reason: aggregate.reason,
          },
      requested: query.limit,
      returned: rows.length,
      rows,
    };
  }

  /**
   * O nome publicado pela origem para UMA carteira, ou `''` quando ela não
   * está na janela ingerida.
   *
   * A ausência é uma RESPOSTA, não um erro: um trader pode ter saído da janela
   * entre a tela e o clique, e a F2-16 grava o favorito com o nome vazio em vez
   * de recusar. É o mesmo nome que a F2-14 gravou, e o mesmo que a tela de
   * ranking mostra — os dois leem a MESMA observação, então favoritar e
   * procurar nunca divergem sobre quem é o trader.
   */
  async function traderNameOf(proxyWallet: string): Promise<string> {
    const row = (
      await database.pool.query<{ user_name: string }>(
        `select user_name from integration.polymarket_trader
          where proxy_wallet=$1
          order by observed_at desc, id desc limit 1`,
        [proxyWallet.toLowerCase()],
      )
    ).rows[0];
    return row?.user_name ?? '';
  }

  return { seriesOf, topOf, ranking, traderNameOf };
}
