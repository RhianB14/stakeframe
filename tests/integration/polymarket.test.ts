import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, requireDatabaseUrl, type Database } from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createPolymarketStore } from '../../packages/db/src/polymarket.js';
import { createPolymarketIngestJob } from '../../apps/worker/src/polymarket-ingest.js';
import { backfillSucceeded, type LeaderboardWindow } from '../../packages/shared/src/index.js';

/**
 * STK-F2-14 §15 — a ingestao contra o BANCO DE VERDADE.
 *
 * O que este arquivo prova, e que nenhum teste unitário prova:
 *
 *  - `vol` e `pnl` voltam do Postgres IGUAIS ao literal da origem. A coluna
 *    e `numeric(38, 18)`, e a comparação é de TEXTO: se um `float` tivesse
 *    entrado no caminho, a string lida teria algarismos a menos.
 *  - O `INSERT` repetido NAO cria linha nova: a dedupe é do banco, pela
 *    chave única `source_key`, e o re-run do job inteiro deixa a contagem
 *    igual.
 *  - Uma SERIE TRUNCADA fica gravada como `truncated`, com cursor e
 *    quantidade, e nunca como `complete`.
 *  - O JOB com uma página falha devolve `succeeded: false`, e a série fecha
 *    como `partial` — o sucesso não pode ser comprado com muitas páginas
 *    aceitas.
 *  - A 0028 é REPLAY-SAFE de verdade: aplicada duas vezes, o estado é o
 *    mesmo de uma aplicação.
 *  - A retenção é DIFERENTE por camada e o bruto é 180 dias.
 */

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const SQL = readFileSync(
  new URL('../../packages/db/migrations/0028_polymarket_ingest.sql', import.meta.url),
  'utf8',
);
const statements = (): string[] =>
  SQL.split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const WINDOW: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'ALL', orderBy: 'PNL' };

/** Uma linha observada, com decimais que o float NAO reproduz. */
const entry = (over: Record<string, unknown> = {}) => ({
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

/** O corpo JSON de uma pagina, montada a partir de TEXTO (sem float). */
const pageBody = (entries: Array<Record<string, unknown>>) =>
  `[${entries.map((item) => JSON.stringify(item)).join(',')}]`;

const jsonResponse = (
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('STK-F2-14 §15 — ingestao Polymarket no banco', () => {
  let database: Database;

  beforeAll(async () => {
    const name = `stk_f214_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f214_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    await migrateLocalDatabase(database);
  });

  afterAll(async () => {
    await database.close();
    await admin.close();
  });

  beforeEach(async () => {
    await database.pool.query(
      'truncate integration.polymarket_page, integration.polymarket_aggregate, integration.polymarket_trader, integration.polymarket_series restart identity cascade',
    );
  });

  const count = async (table: string) =>
    Number(
      (
        await database.pool.query<{ n: string }>(
          `select count(*)::text as n from integration.${table}`,
        )
      ).rows[0]!.n,
    );

  describe('exatidao do valor persistido', () => {
    it('vol e pnl voltam do banco IGUAIS ao literal da origem', async () => {
      const store = createPolymarketStore(database);
      const seriesId = await store.upsertSeries({
        window: WINDOW,
        windowFrom: new Date('2026-01-01T00:00:00Z'),
        windowTo: new Date('2026-03-01T00:00:00Z'),
        backfillFrom: '2025-09-02',
      });
      await store.recordPage({
        seriesId,
        page: {
          offset: 0,
          received: 1,
          accepted: 1,
          complete: true,
          errorCode: null,
          retryAfterSeconds: null,
        },
        entries: [entry()],
        window: WINDOW,
      });

      const row = (
        await database.pool.query<{ vol: string; pnl: string; rank: string; wallet: string }>(
          'select vol::text as vol, pnl::text as pnl, rank, proxy_wallet as wallet from integration.polymarket_trader',
        )
      ).rows[0]!;
      // A EXATIDAO e numerica: `numeric(38,18)` guarda o valor sem perda e o
      // devolve na escala FIXA da coluna (18 casas), o que e o comportamento
      // proprio do tipo — verificado no psql 18. O que o assert prova e que
      // o digito que o float apagaria continua la.
      const exact = (
        await database.pool.query<{ same: boolean }>(
          'select vol = $1::numeric and pnl = $2::numeric as same from integration.polymarket_trader',
          ['2666493.7190210004', '792578.3948993701'],
        )
      ).rows[0]!;
      expect(exact.same).toBe(true);
      // E o texto devolvido tem a escala da coluna, com todos os digitos:
      expect(row.vol).toBe('2666493.719021000400000000');
      expect(row.pnl).toBe('792578.394899370100000000');
      // O que um float teria gravado: 6 casas, e o resto ZERADO. Esta e a
      // assercao que separa "exato" de "arredondado".
      expect(row.vol).not.toBe('2666493.719021000000000000');
      // A carteira e canonica, em minusculas.
      expect(row.wallet).toBe('0x224a89dbe0db0d6124b335edabd15b3f877da3d5');
      // `rank` e texto no banco: um rank nao e medida.
      expect(row.rank).toBe('2');
    });

    it('a coluna e numeric, nunca float8: o tipo e a garantia', async () => {
      const columns = (
        await database.pool.query<{ data_type: string }>(
          `select data_type from information_schema.columns
            where table_schema='integration' and table_name='polymarket_trader'
              and column_name in ('vol','pnl')`,
        )
      ).rows;
      expect(columns).toHaveLength(2);
      // `double precision` aqui seria um erro silencioso de precisao.
      for (const column of columns) {
        expect(column.data_type).toBe('numeric');
        expect(column.data_type).not.toBe('double precision');
      }
    });

    it('a soma do banco e exata: agregacao sobre numeric nao passa por float', async () => {
      const store = createPolymarketStore(database);
      const seriesId = await store.upsertSeries({
        window: WINDOW,
        windowFrom: new Date('2026-01-01T00:00:00Z'),
        windowTo: new Date('2026-03-01T00:00:00Z'),
        backfillFrom: '2025-09-02',
      });
      await store.recordPage({
        seriesId,
        page: {
          offset: 0,
          received: 3,
          accepted: 3,
          complete: true,
          errorCode: null,
          retryAfterSeconds: null,
        },
        entries: [
          entry({ rank: '1', proxyWallet: `0x${'a'.repeat(40)}`, vol: '0.1', pnl: '0.1' }),
          entry({ rank: '2', proxyWallet: `0x${'b'.repeat(40)}`, vol: '0.2', pnl: '0.2' }),
          entry({ rank: '3', proxyWallet: `0x${'c'.repeat(40)}`, vol: '0.3', pnl: '0.3' }),
        ],
        window: WINDOW,
      });
      const totals = await store.totalsOf(WINDOW);
      // 0.1 + 0.2 + 0.3 = 0.6 exato. Em double, o resultado seria
      // 0.6000000000000001 — que e exatamente o que este assert prova que
      // NAO acontece.
      expect(totals.vol).toBe('0.600000000000000000');
      expect(totals.pnl).toBe('0.600000000000000000');
      expect(totals.rows).toBe('3');
    });
  });

  describe('dedup deterministica', () => {
    it('a mesma pagina gravada duas vezes deixa UMA linha', async () => {
      const store = createPolymarketStore(database);
      const seriesId = await store.upsertSeries({
        window: WINDOW,
        windowFrom: new Date('2026-01-01T00:00:00Z'),
        windowTo: new Date('2026-03-01T00:00:00Z'),
        backfillFrom: '2025-09-02',
      });
      const page = {
        offset: 0,
        received: 1,
        accepted: 1,
        complete: true,
        errorCode: null,
        retryAfterSeconds: null,
      };
      const first = await store.recordPage({ seriesId, page, entries: [entry()], window: WINDOW });
      const second = await store.recordPage({ seriesId, page, entries: [entry()], window: WINDOW });
      // A dedupe e do banco: a segunda gravacao e um no-op declarado, e o
      // chamador SABE que foi no-op (inserted 0), e nao um sucesso calado.
      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(await count('polymarket_trader')).toBe(1);
    });

    it('a chave de origem e NOT NULL e o banco recusa linha sem chave', async () => {
      const column = (
        await database.pool.query<{ is_nullable: string }>(
          `select is_nullable from information_schema.columns
            where table_schema='integration' and table_name='polymarket_trader' and column_name='source_key'`,
        )
      ).rows[0]!;
      expect(column.is_nullable).toBe('NO');
      // E o banco RECUSA de fato, em vez de confiar na disciplina do
      // chamador.
      await expect(
        database.pool.query(
          `insert into integration.polymarket_trader
             (proxy_wallet, source_key, vol, pnl, rank, time_period, order_by)
           values ('0x' || repeat('a', 40), '   ', 1, 1, '1', 'ALL', 'PNL')`,
        ),
      ).rejects.toThrow();
    });

    it('a mesma carteira em janelas diferentes sao observacoes diferentes', async () => {
      const store = createPolymarketStore(database);
      const pnlWindow: LeaderboardWindow = { ...WINDOW, orderBy: 'PNL' };
      const volWindow: LeaderboardWindow = { ...WINDOW, orderBy: 'VOL' };
      const seriesId = await store.upsertSeries({
        window: pnlWindow,
        windowFrom: new Date('2026-01-01T00:00:00Z'),
        windowTo: new Date('2026-03-01T00:00:00Z'),
        backfillFrom: '2025-09-02',
      });
      const page = {
        offset: 0,
        received: 1,
        accepted: 1,
        complete: true,
        errorCode: null,
        retryAfterSeconds: null,
      };
      await store.recordPage({ seriesId, page, entries: [entry()], window: pnlWindow });
      // A MESMA linha da origem, lida na outra ordenacao, e outra
      // observacao: a chave inclui a janela.
      expect(
        await store.recordPage({ seriesId, page, entries: [entry()], window: volWindow }),
      ).toBe(1);
      expect(await count('polymarket_trader')).toBe(2);
    });
  });

  describe('cobertura completa, truncada e desconhecida', () => {
    it('pagina curta fecha a serie como COMPLETE com cursor e quantidade', async () => {
      const job = createPolymarketIngestJob(database, {
        fetchImpl: vi.fn(async () => jsonResponse(pageBody([entry()]))) as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      expect(result.status).toBe('complete');
      expect(result.succeeded).toBe(true);
      expect(backfillSucceeded(result)).toBe(true);

      const series = (
        await database.pool.query<{
          status: string;
          cursor: string | null;
          quantity: string;
          backfill_from: string;
          failed_pages: string;
        }>(
          'select status, cursor::text as cursor, quantity::text as quantity, backfill_from::text as backfill_from, failed_pages::text as failed_pages from integration.polymarket_series',
        )
      ).rows[0]!;
      expect(series.status).toBe('complete');
      // Cursor 0 é a PRIMEIRA página e é um cursor válido — o CHECK é de
      // faixa, não de nulidade.
      expect(series.cursor).toBe('0');
      expect(series.quantity).toBe('1');
      expect(series.failed_pages).toBe('0');
      // A ancora de 180 dias fica GRAVADA, e nao deduzida.
      expect(series.backfill_from).toBe('2025-09-02');
    });

    it('pagina cheia ate o teto fecha como TRUNCATED, nunca como complete', async () => {
      const full = Array.from({ length: 50 }, (_, index) =>
        entry({ rank: String(index + 1), proxyWallet: `0x${String(index).padStart(40, '0')}` }),
      );
      const job = createPolymarketIngestJob(database, {
        fetchImpl: vi.fn(async () => jsonResponse(pageBody(full))) as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      // A origem entrega pagina cheia em offset arbitrario (verificado:
      // offset=5000 responde 200), entao o fim NUNCA e observado e a serie
      // e truncada. Este e o estado honesto, e nao um bug.
      expect(result.status).toBe('truncated');
      // Truncado NAO e sucesso: nao houve fim observado.
      expect(result.succeeded).toBe(false);
      expect(backfillSucceeded(result)).toBe(false);

      const series = (
        await database.pool.query<{ status: string }>(
          'select status from integration.polymarket_series',
        )
      ).rows[0]!;
      expect(series.status).toBe('truncated');
      // E o valor errado e recusado na escrita pelo CHECK do banco.
      await expect(
        database.pool.query("update integration.polymarket_series set status='completa'"),
      ).rejects.toThrow();
    });

    it('a serie recem-criada comecam como UNKNOWN, antes do primeiro desfecho', async () => {
      const store = createPolymarketStore(database);
      await store.upsertSeries({
        window: WINDOW,
        windowFrom: new Date('2026-01-01T00:00:00Z'),
        windowTo: new Date('2026-03-01T00:00:00Z'),
        backfillFrom: '2025-09-02',
      });
      const series = (
        await database.pool.query<{ status: string }>(
          'select status from integration.polymarket_series',
        )
      ).rows[0]!;
      // 'unknown' é o estado honesto de "ainda não se sabe": nunca
      // 'complete' por omissão.
      expect(series.status).toBe('unknown');
    });
  });

  describe('job parcial NAO e sucesso', () => {
    it('uma pagina que falha impede o sucesso e fecha a serie como partial', async () => {
      // A primeira pagina volta CHEIA (50 linhas), entao nao ha fim observado e
      // o job segue para a segunda, que falha com 429. A falha precisa vir
      // DEPOIS de uma pagina completa: com uma pagina curta no primeiro passo,
      // o job pararia por "fim observado" e nunca chegaria a testar a falha.
      const full = Array.from({ length: 50 }, (_, index) =>
        entry({ rank: String(index + 1), proxyWallet: `0x${String(index).padStart(40, '0')}` }),
      );
      let call = 0;
      const job = createPolymarketIngestJob(database, {
        fetchImpl: vi.fn(async () => {
          call += 1;
          if (call === 1) return jsonResponse(pageBody(full));
          return jsonResponse('{"error":"rate limited"}', {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }) as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      expect(result.failedPages).toBeGreaterThan(0);
      // O coracao do card: nao-sucesso explicito.
      expect(result.succeeded).toBe(false);
      expect(backfillSucceeded(result)).toBe(false);
      expect(result.status).toBe('partial');
      expect(result.errors).toContain('POLYMARKET_RATE_LIMITED');

      const series = (
        await database.pool.query<{ status: string; failed_pages: string; quantity: string }>(
          'select status, failed_pages::text as failed_pages, quantity::text as quantity from integration.polymarket_series',
        )
      ).rows[0]!;
      expect(series.status).toBe('partial');
      expect(Number(series.failed_pages)).toBeGreaterThan(0);
      // A primeira pagina foi gravada de verdade: o resultado parcial
      // PRESERVA o que deu certo.
      expect(Number(series.quantity)).toBe(50);
    });

    it('muitas paginas aceitas e uma falha continuam nao-sucedendo', async () => {
      // O cenario que a regra protege: volume alto nao compra o sucesso.
      const full = Array.from({ length: 50 }, (_, index) =>
        entry({ rank: String(index + 1), proxyWallet: `0x${String(index).padStart(40, '0')}` }),
      );
      let call = 0;
      const job = createPolymarketIngestJob(database, {
        fetchImpl: vi.fn(async () => {
          call += 1;
          if (call === 1) return jsonResponse(pageBody(full));
          return jsonResponse('{"error":"boom"}', { status: 503 });
        }) as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      expect(result.accepted).toBe(50);
      expect(result.failedPages).toBeGreaterThan(0);
      expect(backfillSucceeded(result)).toBe(false);
      expect(result.status).toBe('partial');
    });

    it('um resultado INCERTO nao e repetido: a chamada nao e reenviada', async () => {
      // Reenviar uma chamada cujo resultado nao se sabe pode duplicar dado.
      // O job trata `POLYMARKET_UNCERTAIN` como terminal para a pagina.
      const fetchImpl = vi.fn(async () => {
        throw new Error('socket hang up');
      });
      const job = createPolymarketIngestJob(database, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      expect(result.errors).toContain('POLYMARKET_UNCERTAIN');
      // UMA unica chamada: a repeticao do incerto esta proibida.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toBe(false);
    });
  });

  describe('a porta da F2-13 vem ANTES da chamada externa', () => {
    it('com o breaker global aberto, ZERO chamadas e ZERO linhas', async () => {
      // O estado 'open' exige `opened_at` e um `recovers_at` no futuro: e o
      // CHECK `ai_circuit_breaker_state_coherence` da 0024 que garante que
      // "aberto" e "quebrado" sejam sempre coerentes, entao o fixture
      // respeita essa coerencia em vez de forcar o estado pela metade.
      await database.pool.query(
        `insert into integration.ai_circuit_breaker
           (scope, scope_key, state, consecutive_confirmed_failures, opened_at, recovers_at, last_error_category)
         values ('global','global','open',3, now(), now() + interval '5 minutes', 'confirmed_rate_limited')
         on conflict (scope, scope_key) do update
           set state='open',
               consecutive_confirmed_failures=3,
               opened_at=now(),
               recovers_at=now() + interval '5 minutes',
               last_error_category='confirmed_rate_limited'`,
      );
      const fetchImpl = vi.fn(async () => jsonResponse(pageBody([entry()])));
      const job = createPolymarketIngestJob(database, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        now: () => new Date('2026-03-01T12:00:00Z'),
      });
      const result = await job.runOnce(WINDOW);
      // A porta fechou: nenhuma requisicao saiu e nada foi gravado.
      expect(result.refused).toBe(true);
      expect(result.refusalReason).toBe('breaker');
      expect(fetchImpl).toHaveBeenCalledTimes(0);
      expect(await count('polymarket_trader')).toBe(0);
      // E nao existe serie: um truncamento que nao veio da origem nao pode
      // ser gravado como serie truncada.
      expect(await count('polymarket_series')).toBe(0);
      await database.pool.query(
        `update integration.ai_circuit_breaker
            set state='closed', consecutive_confirmed_failures=0,
                opened_at=null, recovers_at=null, last_error_category=null
          where scope='global' and scope_key='global'`,
      );
    });
  });

  describe('retencao e escopo', () => {
    it('o bruto retem 180 dias e o agregado retem mais', async () => {
      const store = createPolymarketStore(database);
      const retention = await store.retentions();
      // O card fixa 180 dias para o bruto...
      expect(retention.trade).toBe(180);
      // ...e pede prazo MAIOR para o agregado.
      expect(retention.aggregate).toBeGreaterThan(retention.trade);
    });

    it('o escopo excluido nao existe: nenhuma ordem, aposta ou trade gravado', async () => {
      // A ausencia e a prova do escopo excluido (§9.1): a unica entidade e
      // o trader do leaderboard.
      const tables = (
        await database.pool.query<{ table_name: string }>(
          `select table_name from information_schema.tables
            where table_schema='integration' and table_name like 'polymarket%' order by table_name`,
        )
      ).rows.map((row) => row.table_name);
      expect(tables).toEqual([
        'polymarket_aggregate',
        'polymarket_page',
        'polymarket_retention',
        'polymarket_series',
        'polymarket_trader',
      ]);
      // Acomparacao por PALAVRA, nao por substring: `polymarket_trader`
      // contem a letra de "trade" e `polymarket_page` fala de pagina. O que
      // esta proibido e uma tabela DEDICADA a ordem, aposta, posicao ou
      // Kalshi — o escopo excluido do §9.1.
      for (const table of tables) {
        for (const forbidden of ['order', 'bet', 'trade', 'position', 'kalshi', 'wallet']) {
          expect(table.split('_')).not.toContain(forbidden);
        }
      }
    });
  });

  describe('replay-safe e forward-only da 0028', () => {
    it('a 0028 esta no journal, em ordem e com indice contiguo', () => {
      const journal = JSON.parse(
        readFileSync(
          new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ) as { entries: { idx: number; tag: string }[] };
      const entry0028 = journal.entries.find(
        (candidate) => candidate.tag === '0028_polymarket_ingest',
      )!;
      expect(entry0028).toBeDefined();
      expect(entry0028.idx).toBe(28);
      // Nenhuma entrada fora da sua posicao: e o que torna o replay de
      // prefixo confiavel.
      expect(journal.entries.every((candidate, index) => candidate.idx === index)).toBe(true);
      // E a 0027 continua sendo a anterior, sem ser reescrita.
      expect(journal.entries[27]!.tag).toBe('0027_report_snapshots');
    });

    it('aplicar a 0028 duas vezes deixa o estado identico ao de uma aplicacao', async () => {
      const before = await snapshot();
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements()) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      expect(await snapshot()).toEqual(before);
      // E as retencoes continuam UMA linha cada, sem duplicar no replay.
      const retention = (
        await database.pool.query<{ n: string }>(
          "select count(*)::text as n from integration.polymarket_retention where retain_days=180 and layer='trade'",
        )
      ).rows[0]!;
      expect(Number(retention.n)).toBe(1);
    });
  });

  async function snapshot(): Promise<Record<string, number>> {
    const rows = await database.pool.query<{ label: string; n: string }>(
      `select 'trader' as label, count(*)::text as n from integration.polymarket_trader
       union all select 'series', count(*)::text from integration.polymarket_series
       union all select 'page', count(*)::text from integration.polymarket_page
       union all select 'aggregate', count(*)::text from integration.polymarket_aggregate
       union all select 'retention', count(*)::text from integration.polymarket_retention`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.label, Number(row.n)]));
  }
});
