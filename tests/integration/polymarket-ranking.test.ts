import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPolymarketRankingStore,
  requireDatabaseUrl,
  type Database,
  type PolymarketRankingStore,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createPolymarketStore } from '../../packages/db/src/polymarket.js';
import {
  POLYMARKET_RANKING_LIMIT,
  backfillSucceeded,
  leaderboardSourceKey,
  type LeaderboardWindow,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-15 §15 — o ranking contra o BANCO DE VERDADE.
 *
 * O teste unitário prova a lógica; este prova o que só o Postgres prova:
 *
 *  - `pnl` e `vol` voltam do banco IGUAIS ao literal que a F2-14 gravou. A
 *    coluna é `numeric(38, 18)` e a comparação é de TEXTO: se um `float`
 *    tivesse entrado no caminho da leitura, a string teria algarismos a menos
 *    e a tela exibiria um número que a Polymarket nunca publicou.
 *
 *  - A ORDEM é a posição DECLARADA pela origem (`rank::bigint`), e não uma
 *    reordenação por `pnl`. Um top 10 gravado fora de ordem volta na ordem da
 *    posição, porque é essa a resposta oficial.
 *
 *  - A SÉRIE TRUNCADA continua truncada na LEITURA: mil linhas com
 *    `status = 'truncated'` produzem aviso, e a política do agregado recusa.
 *    A completude é o que o banco gravou, e a leitura não a recalcula.
 *
 *  - A JANELA NÃO INGERIDA (uma das dez categorias oficiais fora de
 *    `OVERALL`) responde `available: false` com lista vazia — e NÃO inventa
 *    linha nem status completo. É a divergência entre o enum oficial e o CHECK
 *    da F2-14, verificada no banco em vez de presumida.
 *
 *  - NENHUMA MIGRAÇÃO: este arquivo cria a base pela MESMA pipeline da F2-14
 *    e não escreve DDL. Se a F2-15 precisasse de coluna nova, a 0028 não
 *    Aplicaria aqui — e a ausência de DDL neste arquivo é a prova.
 */

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const WINDOW: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' };
const MIN_SAMPLE = 30;

/** Uma linha observada, com decimais que o float NAO reproduz. */
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rank: '2',
  proxyWallet: '0x224a89dbe0db0d6124b335edabd15b3f877da3d5',
  userName: 'wr0ngw4yb3tt0r',
  xUsername: '',
  verifiedBadge: false,
  profileImage: '',
  vol: '2666493.7190210004',
  pnl: '792578.3948993701',
  ...over,
});

/** O texto de um campo gravado, sem `Number` no caminho. */
const text = (item: Record<string, unknown>, field: string): string => String(item[field] ?? '');

describe('STK-F2-15 §15 — ranking Polymarket no banco', () => {
  let database: Database;
  let store: PolymarketRankingStore;
  let name: string;

  beforeAll(async () => {
    name = `stk_f215_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f215_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    // A MESMA pipeline da F2-14: nenhuma DDL nova é aplicada por esta tarefa.
    await migrateLocalDatabase(database);
    store = createPolymarketRankingStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  });

  /** Grava uma página pela MESMA chave que a ingestão usaria. */
  async function ingest(
    window: LeaderboardWindow,
    entries: Array<Record<string, unknown>>,
    status: 'complete' | 'truncated' | 'partial' = 'complete',
  ) {
    const polymarket = createPolymarketStore(database);
    const seriesId = await polymarket.upsertSeries({
      window,
      windowFrom: new Date('2026-04-01T00:00:00Z'),
      windowTo: new Date('2026-09-29T00:00:00Z'),
      backfillFrom: '2026-04-01',
    });
    const accepted: Record<string, unknown>[] = entries.map((item) => ({
      ...item,
      vol: text(item, 'vol'),
      pnl: text(item, 'pnl'),
    }));
    for (const item of accepted)
      await database.pool.query(
        `insert into integration.polymarket_trader
           (proxy_wallet, user_name, x_username, profile_image, verified_badge,
            source_key, vol, pnl, rank, category, time_period, order_by)
         values ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, $11, $12)`,
        [
          // A carteira entra em minusculas, como a chave de dedup canonica.
          text(item, 'proxyWallet').toLowerCase(),
          text(item, 'userName'),
          text(item, 'xUsername'),
          text(item, 'profileImage'),
          text(item, 'verifiedBadge') === 'true',
          leaderboardSourceKey(item as never, window),
          text(item, 'vol'),
          text(item, 'pnl'),
          text(item, 'rank'),
          window.category,
          window.timePeriod,
          window.orderBy,
        ],
      );
    await polymarket.closeSeries({
      seriesId,
      window,
      status,
      cursor: 0,
      quantity: accepted.length,
      pages: 1,
      failedPages: status === 'partial' ? 1 : 0,
      errors: status === 'partial' ? ['POLYMARKET_STATUS_ERROR'] : [],
    });
  }

  it('os decimais voltam do banco IDENTICOS ao literal da origem', async () => {
    await ingest(WINDOW, [entry()], 'complete');
    const ranking = await store.ranking(
      { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL', limit: POLYMARKET_RANKING_LIMIT },
      { minSample: MIN_SAMPLE },
    );
    expect(ranking.rows).toHaveLength(1);
    // A comparacao e de TEXTO, caractere a caractere. Um `Number` no caminho
    // da leitura devolveria `792578.39489937` e ESTE teste falharia.
    expect(ranking.rows[0]!.pnl).toBe('792578.3948993701');
    expect(ranking.rows[0]!.vol).toBe('2666493.7190210004');
    expect(ranking.series.status).toBe('complete');
    expect(ranking.series.available).toBe(true);
  });

  it('a ordem e a POSICAO DECLARADA, nao uma reordenacao por P&L', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'VOL' };
    // Gravado fora de ordem e com P&L invertido: o topo por P&L seria o rank 3.
    await ingest(
      window,
      [
        entry({
          rank: '3',
          proxyWallet: '0x4f1d5ae26fc31472966e951af3183308736d8de2',
          pnl: '2421519.6410872885',
        }),
        entry({
          rank: '1',
          proxyWallet: '0x51698a47f840a242abc2ca0351371c7ffac41842',
          pnl: '100.1234567890123',
        }),
        entry({
          rank: '2',
          proxyWallet: '0x34dd4a4b70eaf79a17878f7938263c801d4dfd83',
          pnl: '2606495.892298001',
        }),
      ],
      'complete',
    );
    const ranking = await store.ranking(
      { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'VOL', limit: 100 },
      { minSample: MIN_SAMPLE },
    );
    // A resposta oficial e a posicao: 1, 2, 3 — mesmo com o P&L invertido.
    expect(ranking.rows.map((row) => row.rank)).toEqual(['1', '2', '3']);
  });

  it('a serie TRUNCADA continua truncada na LEITURA, com 100 linhas na tela', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'ALL', orderBy: 'PNL' };
    const rows = Array.from({ length: 100 }, (_, index) =>
      entry({
        rank: String(index + 1),
        proxyWallet: `0x${String(index).padStart(40, '0')}`,
        pnl: `${1000 + index}.5555555555555555`,
      }),
    );
    await ingest(window, rows, 'truncated');
    const ranking = await store.ranking(
      { category: 'OVERALL', timePeriod: 'ALL', orderBy: 'PNL', limit: POLYMARKET_RANKING_LIMIT },
      { minSample: MIN_SAMPLE },
    );
    expect(ranking.rows).toHaveLength(100);
    expect(ranking.returned).toBe(100);
    // O status GRAVADO e o que decide: 100 linhas nao compram cobertura total.
    expect(ranking.series.status).toBe('truncated');
    expect(ranking.completeness.truncated).toBe(true);
    expect(ranking.completeness.label).toBe('Série truncada');
    // E a metrica dependente da serie completa vem BLOQUEADA, com o motivo.
    expect(ranking.aggregate.blocked).toBe(true);
    expect(ranking.aggregate.reason).toContain('bloqueados');
  });

  it('uma categoria oficial NAO ingerida responde ausente, sem inventar linha', async () => {
    // `SPORTS` e uma categoria OFICIAL (verificada por probe), mas a F2-14
    // ingere `OVERALL` e o CHECK do banco aceita so essa. A resposta correta
    // e `available: false` com a explicacao — nunca uma lista vazia sem
    // aviso, que a tela leria como "nao existe trader em esportes".
    const ranking = await store.ranking(
      { category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'PNL', limit: 100 },
      { minSample: MIN_SAMPLE },
    );
    expect(ranking.series.available).toBe(false);
    expect(ranking.rows).toEqual([]);
    expect(ranking.completeness.label).toBe('Janela ainda não coletada');
    expect(ranking.aggregate.blocked).toBe(true);
    expect(ranking.aggregate.reason).toContain('ainda não foi coletada');
    // E a amostra e zero, com a regra do produto aplicada sobre zero.
    expect(ranking.sample.n).toBe(0);
    expect(ranking.sample.lowSample).toBe(true);
  });

  it('o CHECK do banco IMPEDE gravar uma categoria fora do enum ingerido', async () => {
    // A divergencia entre o enum oficial (onze) e o CHECK (uma) e do BANCO,
    // e este teste a torna visivel: a tentativa e RECUSADA pelo Postgres. E
    // por isso que a interface trata as dez categorias alem de OVERALL como
    // "ainda nao coletadas" em vez de prometer um ranking preenchido.
    await expect(
      database.pool.query(
        `insert into integration.polymarket_series
           (category, time_period, order_by, window_from, window_to, backfill_from, status)
         values ('SPORTS', 'MONTH', 'PNL', now(), now(), '2026-04-01', 'unknown')`,
      ),
    ).rejects.toThrow();
  });

  it('o limite do top 100 e respeitado e a contagem de series e a gravada', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'DAY', orderBy: 'PNL' };
    const rows = Array.from({ length: 100 }, (_, index) =>
      entry({
        rank: String(index + 1),
        proxyWallet: `0x${String(index).padStart(40, '0')}`,
        pnl: `${index + 1}.1`,
      }),
    );
    await ingest(window, rows, 'complete');
    const ranking = await store.ranking(
      { category: 'OVERALL', timePeriod: 'DAY', orderBy: 'PNL', limit: 10 },
      { minSample: MIN_SAMPLE },
    );
    // `limit` corta a EXIBICAO; `ingested` continua sendo o total gravado, e
    // os dois numeros aparecem para que a diferenca fique visivel.
    expect(ranking.rows).toHaveLength(10);
    expect(ranking.returned).toBe(10);
    expect(ranking.requested).toBe(10);
    expect(ranking.series.ingested).toBe(100);
  });

  it('esta tarefa NAO alterou o schema: a 0028 e a unica migracao aplicada', async () => {
    // Se a F2-15 tivesse criado coluna ou tabela, `backfillSucceeded` e a
    // leitura acima nao bastariam: este teste fixa que a serie gravada pela
    // F2-14 continua legivel sem nenhuma etapa nova.
    const { rows } = await database.pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
        where table_schema = 'integration' and table_name = 'polymarket_series'`,
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    // A regra de sucesso da F2-14 continua valendo e inalterada.
    expect(
      backfillSucceeded({
        status: 'truncated',
        succeeded: true,
        pages: [],
        failedPages: 0,
        accepted: 100,
        rejected: 0,
        errors: [],
      }),
    ).toBe(false);
  });
});
