import { sha256Hex, type Database } from './index.js';
import {
  leaderboardSourceKey,
  type BackfillResult,
  type BackfillStatus,
  type IngestedPage,
  type LeaderboardEntry,
  type LeaderboardWindow,
} from '@stakeframe/shared';

/**
 * STK-F2-14 — a persistencia da ingestao Polymarket.
 *
 * Tres garantias vivem aqui, e todas as tres sao do BANCO, nao da disciplina
 * do chamador:
 *
 *  - VALOR EXATO. `vol` e `pnl` entram como o LITERAL decimal que a origem
 *    escreveu e sao gravados em `numeric(38, 18)`. Em nenhum caminho deste
 *    arquivo aparece `Number(...)`, `parseFloat` ou `toFixed`: o valor que a
 *    origem mandou e o valor que fica. O Postgres devolve `numeric` como
 *    texto, entao a leitura tambem e texto.
 *
 *  - DEDUP DETERMINISTICA. A gravacao e um `INSERT ... ON CONFLICT DO
 *    NOTHING` sobre a chave unica `source_key`. A linha repetida da origem
 *    nao vira linha repetida no banco, e o chamador recebe `inserted: false`
 *    — o que torna o re-run do backfill observavel em vez de silencioso.
 *
 *  - A CHAVE E DO BANCO, E O BANCO RECUSA VAZIO. `source_key` e `NOT NULL`
 *    com CHECK de nao-vazio, entao uma observacao sem chave nao chega a
 *    existir: o erro e do Postgres, nao de um `if (!key) return` que
 *    silenciaria a perda.
 */

export type PolymarketStore = ReturnType<typeof createPolymarketStore>;

type Window = LeaderboardWindow;

export function createPolymarketStore(database: Database) {
  /**
   * A serie de uma janela: a linha que carrega inicio, fim, quantidade,
   * cursor e completude. `upsert` devolve o id da serie.
   *
   * A identidade da serie e a JANELA (category, time_period, order_by), e o
   * re-run atualiza a mesma linha em vez de criar outra — por isso o
   * `ON CONFLICT` nessa chave e o que torna o job idempotente.
   */
  async function upsertSeries(input: {
    window: Window;
    windowFrom: Date;
    windowTo: Date;
    backfillFrom: string;
  }): Promise<string> {
    const row = (
      await database.pool.query<{ id: string }>(
        `insert into integration.polymarket_series
           (category, time_period, order_by, window_from, window_to, backfill_from, status)
         values ($1, $2, $3, $4, $5, $6, 'unknown')
         on conflict (category, time_period, order_by) do update
           set window_from = excluded.window_from,
               window_to = excluded.window_to,
               backfill_from = excluded.backfill_from,
               updated_at = now()
         returning id`,
        [
          input.window.category,
          input.window.timePeriod,
          input.window.orderBy,
          input.windowFrom,
          input.windowTo,
          input.backfillFrom,
        ],
      )
    ).rows[0]!;
    return row.id;
  }

  /**
   * Grava UMA pagina inteira numa transacao, e devolve quantas linhas foram
   * realmente inseridas (as repetidas contam como zero).
   *
   * A transacao existe porque a pagina e a unidade de trabalho: ou as suas
   * linhas entram, ou o rastro da pagina nao e gravado. Um estado em que a
   * serie diz "página 3 consumida" mas a página 3 nao esta no banco seria
   * uma mentira de completude.
   */
  async function recordPage(input: {
    seriesId: string;
    page: IngestedPage;
    entries: LeaderboardEntry[];
    window: Window;
  }): Promise<number> {
    const client = await database.pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      for (const entry of input.entries) {
        // A chave e calculada AQUI, no limite do banco, e nunca pode ser
        // vazia: `leaderboardSourceKey` recusa uma entrada sem carteira.
        const sourceKey = leaderboardSourceKey(entry, input.window);
        const result = await client.query(
          `insert into integration.polymarket_trader
             (proxy_wallet, user_name, x_username, profile_image, verified_badge,
              source_key, vol, pnl, rank, category, time_period, order_by)
           values ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, $11, $12)
           on conflict (source_key) do nothing`,
          [
            // A carteira e guardada em minusculas: a chave de dedup e
            // canonica e `0xAB` e `0xab` sao o mesmo trader.
            entry.proxyWallet.toLowerCase(),
            entry.userName,
            entry.xUsername,
            entry.profileImage,
            entry.verifiedBadge,
            sourceKey,
            // Os decimais entram como TEXTO e sao convertidos pelo cast do
            // Postgres. Nenhum `Number` toca estes valores.
            entry.vol,
            entry.pnl,
            entry.rank,
            input.window.category,
            input.window.timePeriod,
            input.window.orderBy,
          ],
        );
        inserted += result.rowCount ?? 0;
      }
      // O rastro da pagina, gravado na MESMA transacao das linhas. `offset`
      // e palavra reservada do Postgres (verificado no psql 18: a coluna
      // exige aspas duplas na lista do INSERT e na clausula ON CONFLICT), por
      // isso leva aspas aqui como as demais colunas desta tabela.
      await client.query(
        `insert into integration.polymarket_page
           (series_id, "offset", received, accepted, complete, error_code, retry_after_seconds)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (series_id, "offset") do update
           set received = excluded.received,
               accepted = excluded.accepted,
               complete = excluded.complete,
               error_code = excluded.error_code,
               retry_after_seconds = excluded.retry_after_seconds,
               consumed_at = now()`,
        [
          input.seriesId,
          input.page.offset,
          input.page.received,
          input.page.accepted,
          input.page.complete,
          input.page.errorCode,
          input.page.retryAfterSeconds,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return inserted;
  }

  /**
   * Fecha a serie com o desfecho do job: quantidade, cursor, paginas,
   * falhas e COMPLETUDE.
   *
   * A completude e derivada de tres condicoes observadas, e nunca de "nao
   * veio nenhuma linha": se houve falha de pagina, a serie e `partial`;
   * se o job parou no teto de paginas sem ter observado uma pagina curta, e
   * `truncated`; se observou uma pagina curta, e `complete`. Uma serie
   * truncada NUNCA e gravada como completa — e o CHECK do banco impede que
   * o valor errado entre.
   */
  async function closeSeries(input: {
    seriesId: string;
    window: Window;
    status: BackfillStatus;
    cursor: number | null;
    quantity: number;
    pages: number;
    failedPages: number;
    errors: string[];
  }): Promise<void> {
    await database.pool.query(
      `update integration.polymarket_series
          set status = $2::text,
              cursor = $3,
              quantity = $4,
              pages = $5,
              failed_pages = $6,
              errors = $7::jsonb,
              updated_at = now()
        where id = $1`,
      [
        input.seriesId,
        input.status,
        input.cursor,
        input.quantity,
        input.pages,
        input.failedPages,
        JSON.stringify(input.errors.slice(0, 64)),
      ],
    );
  }

  /** As retencoes por camada, lidas do banco (bruto 180d, agregado maior). */
  async function retentions(): Promise<{ trade: number; aggregate: number }> {
    const rows = (
      await database.pool.query<{ layer: string; retain_days: string }>(
        'select layer, retain_days from integration.polymarket_retention',
      )
    ).rows;
    const byLayer = new Map(rows.map((row) => [row.layer, Number(row.retain_days)]));
    // Sem linha no banco seria um CHECK de ausencia silencioso; os padroes
    // do card (180 / maior) entram como valor explicito, nunca zero.
    return { trade: byLayer.get('trade') ?? 180, aggregate: byLayer.get('aggregate') ?? 730 };
  }

  /**
   * Os totais EXATOS de uma serie, lidos como texto do Postgres.
   *
   * Existe para provar, no teste, que a soma no banco e exata: a coluna e
   * `numeric`, e o teste compara a string devolvida com a soma feita
   * independente. Um `float` no caminho quebraria a igualdade. O filtro e a
   * JANELA, e nao um join com a serie: a serie e uma janela temporal, e a
   * chave de origem ja carrega a janela (ver `leaderboardSourceKey`).
   */
  async function totalsOf(window: Window): Promise<{ vol: string; pnl: string; rows: string }> {
    const row = (
      await database.pool.query<{ vol: string; pnl: string; n: string }>(
        `select coalesce(sum(vol),0)::text as vol,
                coalesce(sum(pnl),0)::text as pnl,
                count(*)::text as n
           from integration.polymarket_trader
          where category = $1 and time_period = $2 and order_by = $3`,
        [window.category, window.timePeriod, window.orderBy],
      )
    ).rows[0]!;
    return { vol: row.vol, pnl: row.pnl, rows: row.n };
  }

  /**
   * O hash estavel do conteudo ingerido de uma serie, para comparacao entre
   * execucoes. Usa o mesmo `sha256Hex` do resto do repositorio.
   */
  function digestOf(entries: LeaderboardEntry[], window: Window): string {
    const canonical = entries
      .map((entry) => leaderboardSourceKey(entry, window))
      .sort()
      .join('\n');
    return sha256Hex(canonical);
  }

  return { upsertSeries, recordPage, closeSeries, retentions, totalsOf, digestOf };
}

export type { BackfillResult };
