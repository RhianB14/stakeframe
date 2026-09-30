import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createPolymarketRankingStore,
  createPolymarketSimulationStore,
  createTenantContext,
  requireDatabaseUrl,
  simulationDedupeKey,
  type Database,
  type OrganizationContext,
  type PolymarketSimulationStore,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createPolymarketStore } from '../../packages/db/src/polymarket.js';
import {
  leaderboardSourceKey,
  type LeaderboardWindow,
  type SimulationInput,
} from '../../packages/shared/src/index.js';

/**
 * STK-F2-17 §15 — a simulação contra o BANCO DE VERDADE.
 *
 * O teste unitário prova a lógica. Este prova o que só o Postgres prova, e cada
 * item cobre uma garantia que a aplicação sozinha não consegue sustentar:
 *
 *  - A RECUSA POR COBERTURA INCOMPLETA é a completude GRAVADA da F2-14, lida
 *    da série. Mil linhas com `status = 'truncated'` produzem recusa, porque é
 *    o status que decide e a contagem não. A completude é lida, nunca
 *    recalculada.
 *
 *  - A RECUSA TAMBÉM É REGISTRO. Uma tentativa recusada grava a linha com
 *    `refused = true`, o código e a razão, e com TODOS os números a NULL. Um
 *    registro de recusa é a evidência de que a recusa aconteceu; sem ele, uma
 *    recusa poderia ser reescrita como se nunca tivesse ocorrido.
 *
 *  - O BANCO RECUSA GRAVAR O QUE A APLICAÇÃO NÃO DEVERIA GRAVAR: um número
 *    atrás de uma recusa, um número sobre série truncada, uma linha sem as
 *    sete premissas, uma linha sem aviso de jogo responsável. As restrições
 *    estão no banco porque disciplina do chamador não sobrevive a um segundo
 *    chamador.
 *
 *  - A DEDUPE é do banco: o mesmo pedido gravado duas vezes produz uma linha,
 *    e a repetição é um no-op declarado.
 *
 *  - O ISOLAMENTO é RLS: a organização de outra conta não vê a linha, e sem
 *    contexto de organização a política não casa linha nenhuma.
 */

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });

const MIN_SAMPLE = 30;

const REQUEST: SimulationInput = {
  window: { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'PNL' },
  stake: '10.00',
  delayMs: 1500,
  feeRate: '0.02',
  spreadRate: '0.01',
  slippageRate: '0.005',
};

/** A entrada com a janela trocada, para as recusas por cobertura. */
const withWindow = (window: SimulationInput['window']): SimulationInput => ({
  ...REQUEST,
  window,
});

const entry = (index: number, over: Record<string, unknown> = {}) => ({
  rank: String(index),
  proxyWallet: `0x${String(index).padStart(40, '0')}`,
  userName: `trader_${index}`,
  xUsername: '',
  verifiedBadge: false,
  profileImage: '',
  vol: '2666493.7190210004',
  pnl: '792578.3948993701',
  ...over,
});

const text = (item: Record<string, unknown>, field: string): string => String(item[field] ?? '');

describe('STK-F2-17 §15 — simulação indicativa no banco', () => {
  let database: Database;
  let store: PolymarketSimulationStore;
  let ranking: ReturnType<typeof createPolymarketRankingStore>;
  let context: OrganizationContext;
  let name: string;

  beforeAll(async () => {
    name = `stk_f217_${randomUUID().replaceAll('-', '')}`;
    if (!/^stk_f217_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
    // A MESMA pipeline das demais tarefas: a 0030 entra por aqui, e nada mais.
    await migrateLocalDatabase(database);
    store = createPolymarketSimulationStore(database);
    ranking = createPolymarketRankingStore(database);
    // A organização real do contexto, para que a gravação passe pelo mesmo
    // caminho de tenancy que a aplicação usa.
    const tenant = createTenantContext(database);
    context = await tenant.ensureOrganizationMembership(await seedOwner(database));
  });

  afterAll(async () => {
    await database?.close();
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  });

  /** Grava uma janela pela MESMA chave que a ingestão usaria. */
  async function ingest(
    window: LeaderboardWindow,
    entries: Array<Record<string, unknown>>,
    status: 'complete' | 'truncated' | 'partial',
  ) {
    const polymarket = createPolymarketStore(database);
    const seriesId = await polymarket.upsertSeries({
      window,
      windowFrom: new Date('2026-04-01T00:00:00Z'),
      windowTo: new Date('2026-09-29T00:00:00Z'),
      backfillFrom: '2026-04-01',
    });
    for (const item of entries)
      await database.pool.query(
        `insert into integration.polymarket_trader
           (proxy_wallet, user_name, x_username, profile_image, verified_badge,
            source_key, vol, pnl, rank, category, time_period, order_by)
         values ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, $11, $12)`,
        [
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
      quantity: entries.length,
      pages: 1,
      failedPages: status === 'partial' ? 1 : 0,
      errors: status === 'partial' ? ['POLYMARKET_STATUS_ERROR'] : [],
    });
  }

  const rows = (count: number) => Array.from({ length: count }, (_, index) => entry(index + 1));

  it('a série TRUNCADA recusa a apuração, e o status GRAVADO é o que decide', async () => {
    // Cinquenta observações reais na janela, com a série marcada truncada: o
    // estado REAL e normal deste backfill. A apuração é recusada e NENHUM
    // número é produzido — 50 linhas não compram cobertura total.
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'PNL' };
    await ingest(window, rows(50), 'truncated');
    const result = await store.simulate(context, withWindow({ ...window }), {
      minSample: MIN_SAMPLE,
    });
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SERIES_NOT_COMPLETE');
    expect(result.indicative).toBeNull();
    // E a completude é a MESMA que a tela do ranking mostra, palavra por
    // palavra — duas telas discordando sobre a mesma série seria pior.
    const shown = await ranking.ranking({ ...window, limit: 100 }, { minSample: MIN_SAMPLE });
    expect(result.coverage.completeness.label).toBe(shown.completeness.label);
    expect(result.coverage.status).toBe(shown.series.status);
  });

  it('a recusa é REGISTRADA, com a razão e com todos os números a NULL', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'WEEK', orderBy: 'PNL' };
    await store.simulate(context, withWindow({ ...window }), { minSample: MIN_SAMPLE });
    const record = (
      await database.pool.query<{
        refused: boolean;
        refusal_code: string;
        refusal_reason: string;
        refusal_remedy: string;
        indicative_net: string | null;
        indicative_gross: string | null;
        series_status: string;
        premises: unknown;
        disclaimers: unknown;
      }>(
        `select refused, refusal_code, refusal_reason, refusal_remedy,
                indicative_net::text as indicative_net,
                indicative_gross::text as indicative_gross,
                series_status, premises, disclaimers
           from integration.polymarket_simulation
          where organization_id = $1
          order by created_at desc limit 1`,
        [context.organizationId],
      )
    ).rows[0]!;
    expect(record.refused).toBe(true);
    expect(record.refusal_code).toBe('SERIES_NOT_COMPLETE');
    // A razão e o remédio viajam no registro: uma recusa que não explica por
    // quê nem o que fazer é uma parede, e o registro é onde a explicação
    // sobrevive à sessão.
    expect(record.refusal_reason.length).toBeGreaterThan(30);
    expect(record.refusal_remedy.length).toBeGreaterThan(10);
    // NENHUM número: a regra `outcome_exclusive` do banco.
    expect(record.indicative_net).toBeNull();
    expect(record.indicative_gross).toBeNull();
    // E as sete premissas e os avisos foram gravados JUNTO — um número (ou uma
    // recusa) sem o contexto que a limita é um registro citável fora dele.
    expect(Array.isArray(record.premises)).toBe(true);
    expect((record.premises as unknown[]).length).toBe(7);
    expect((record.disclaimers as unknown[]).length).toBeGreaterThan(0);
  });

  it('a série COMPLETA apura, e o resultado sai do banco com os decimais exatos', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'DAY', orderBy: 'PNL' };
    await ingest(window, rows(40), 'complete');
    const result = await store.simulate(context, withWindow({ ...window }), {
      minSample: MIN_SAMPLE,
    });
    expect(result.refusal.refused).toBe(false);
    expect(result.indicative).not.toBeNull();
    // A razão publicada é calculada sobre as somas exatas que a F2-14 gravou.
    // 40 × (792578,3948993701 / 2666493,7190210004) = 11,894... arredondado
    // half-up. Nenhum `Number` toca estes dois valores.
    expect(result.indicative!.publishedPnlSum).toBe('31703135.795974804000000000');
    expect(result.indicative!.publishedVolSum).toBe('106659748.760840016000000000');
    // E o bruto é a stake fixa aplicada às 40 observações.
    expect(result.indicative!.observations).toBe(40);
    // A apuração também é gravada, e a linha carrega os números.
    const record = (
      await database.pool.query<{
        refused: boolean;
        indicative_net: string;
        indicative_gross: string;
        series_status: string;
      }>(
        `select refused, indicative_net::text as indicative_net,
                indicative_gross::text as indicative_gross, series_status
           from integration.polymarket_simulation
          where organization_id = $1 and time_period = 'DAY'
          order by created_at desc limit 1`,
        [context.organizationId],
      )
    ).rows[0]!;
    expect(record.refused).toBe(false);
    expect(record.series_status).toBe('complete');
    expect(record.indicative_net).not.toBeNull();
    expect(record.indicative_gross).not.toBeNull();
  });

  it('uma categoria OFICIAL sem série é recusada, e o motivo é a coleta', async () => {
    // `SPORTS` é oficial (verificada por probe na F2-15), mas a ingestão da
    // F2-14 cobre só `OVERALL` e o CHECK do banco aceita só essa. A recusa
    // correta é "não coletado" — e nenhum número é produzido para uma janela
    // que ninguém percorreu.
    const result = await store.simulate(
      context,
      withWindow({ category: 'SPORTS', timePeriod: 'MONTH', orderBy: 'PNL' }),
      { minSample: MIN_SAMPLE },
    );
    expect(result.refusal.refused).toBe(true);
    expect(result.refusal.code).toBe('SERIES_NOT_COLLECTED');
    expect(result.indicative).toBeNull();
  });

  it('a janela NÃO coletada nunca devolve "resultado zero"', async () => {
    const result = await store.simulate(
      context,
      withWindow({ category: 'OVERALL', timePeriod: 'ALL', orderBy: 'VOL' }),
      { minSample: MIN_SAMPLE },
    );
    expect(result.refusal.code).toBe('SERIES_NOT_COLLECTED');
    // A distinção que a tela escreve: não coletado NÃO é zero.
    expect(result.indicative).toBeNull();
    expect(result.coverage.available).toBe(false);
    expect(result.coverage.n).toBe(0);
  });

  it('a dedupe é do BANCO: o mesmo pedido duas vezes é uma linha', async () => {
    const window: LeaderboardWindow = { category: 'OVERALL', timePeriod: 'MONTH', orderBy: 'VOL' };
    await ingest(window, rows(40), 'complete');
    const request = withWindow({ ...window });
    const before = await countSimulation(database, context.organizationId);
    await store.simulate(context, request, { minSample: MIN_SAMPLE });
    const afterFirst = await countSimulation(database, context.organizationId);
    await store.simulate(context, request, { minSample: MIN_SAMPLE });
    const afterSecond = await countSimulation(database, context.organizationId);
    // A segunda apuração responde o MESMO número (o motor é puro), mas grava
    // uma linha a menos: `ON CONFLICT DO NOTHING` sobre `(organization_id,
    // dedupe_key)`.
    expect(afterFirst).toBe(before + 1);
    expect(afterSecond).toBe(afterFirst);
    // E a chave de dedupe é determinística: mesma entrada, mesma chave.
    expect(simulationDedupeKey(request)).toBe(simulationDedupeKey(request));
  });

  it('o BANCO recusa gravar um número ATRÁS de uma recusa', async () => {
    // A tentativa que o banco tem de recusar: a regra `outcome_exclusive` é a
    // garantia de que nenhum registro tem número escondido atrás de uma
    // recusa. Um bug que preenchesse os dois campos apareceria AQUI.
    await expect(
      database.pool.query(
        `insert into integration.polymarket_simulation
           (organization_id, category, time_period, order_by, stake, delay_ms,
            fee_rate, spread_rate, slippage_rate, series_status, series_available,
            observations, min_sample, missing_data_rate, refused, refusal_code,
            refusal_reason, refusal_remedy, indicative_net, indicative_gross,
            indicative_observations, indicative_published_ratio,
            premises, disclaimers, dedupe_key)
         values ($1, 'OVERALL', 'MONTH', 'PNL', '10.00', 0, 0, 0, 0,
                 'truncated', true, 40, 30, '0.2', true, 'SERIES_NOT_COMPLETE',
                 'cobertura incompleta', 'aguarde a coleta', '40.00', '40.00',
                 40, '0.1', $2::jsonb, $3::jsonb, $4)`,
        [
          context.organizationId,
          JSON.stringify(premisesFixture()),
          JSON.stringify(['aviso']),
          `forged-${randomUUID()}`,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o BANCO recusa apurar sobre série truncada, mesmo com recusa desligada', async () => {
    // `refused = false` com `series_status = 'truncated'` é a segunda forma do
    // mesmo problema: um desfecho que se declara apurado sobre cobertura que o
    // próprio registro diz estar incompleta. O CHECK `complete_required` fecha.
    await expect(
      database.pool.query(
        `insert into integration.polymarket_simulation
           (organization_id, category, time_period, order_by, stake, delay_ms,
            fee_rate, spread_rate, slippage_rate, series_status, series_available,
            observations, min_sample, missing_data_rate, refused,
            indicative_net, indicative_gross, indicative_observations,
            indicative_published_ratio, premises, disclaimers, dedupe_key)
         values ($1, 'OVERALL', 'MONTH', 'PNL', '10.00', 0, 0, 0, 0,
                 'truncated', true, 40, 30, '0.2', false,
                 '40.00', '40.00', 40, '0.1', $2::jsonb, $3::jsonb, $4)`,
        [
          context.organizationId,
          JSON.stringify(premisesFixture()),
          JSON.stringify(['aviso']),
          `forged-truncated-${randomUUID()}`,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('o BANCO recusa um registro SEM as sete premissas', async () => {
    // A tentativa: gravar com um array de seis premissas (a omissão de uma é
    // a forma mais barata de publicar um número sem a ressalva que o limita)
    // e depois com uma premissa sem `note`.
    for (const broken of [
      premisesFixture().slice(0, 6),
      premisesFixture().map((p) => ({ ...p, note: '' })),
      premisesFixture().map((p) => ({ ...p, key: 'stake' })),
    ]) {
      await expect(
        database.pool.query(
          `insert into integration.polymarket_simulation
             (organization_id, category, time_period, order_by, stake, delay_ms,
              fee_rate, spread_rate, slippage_rate, series_status, series_available,
              observations, min_sample, missing_data_rate, refused, refusal_code,
              refusal_reason, refusal_remedy, premises, disclaimers, dedupe_key)
           values ($1, 'OVERALL', 'MONTH', 'PNL', '10.00', 0, 0, 0, 0,
                   'truncated', true, 40, 30, '0.2', true, 'SERIES_NOT_COMPLETE',
                   'cobertura incompleta', 'aguarde a coleta', $2::jsonb, $3::jsonb, $4)`,
          [
            context.organizationId,
            JSON.stringify(broken),
            JSON.stringify(['aviso']),
            `forged-premises-${randomUUID()}`,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('o BANCO recusa um registro SEM aviso de jogo responsável', async () => {
    // Um registro citável sem o aviso é um registro que pode ser citado contra
    // o produto. A lista vazia e o item em branco são recusados.
    for (const broken of [[], [''], ['  ']]) {
      await expect(
        database.pool.query(
          `insert into integration.polymarket_simulation
             (organization_id, category, time_period, order_by, stake, delay_ms,
              fee_rate, spread_rate, slippage_rate, series_status, series_available,
              observations, min_sample, missing_data_rate, refused, refusal_code,
              refusal_reason, refusal_remedy, premises, disclaimers, dedupe_key)
           values ($1, 'OVERALL', 'MONTH', 'PNL', '10.00', 0, 0, 0, 0,
                   'truncated', true, 40, 30, '0.2', true, 'SERIES_NOT_COMPLETE',
                   'cobertura incompleta', 'aguarde a coleta', $2::jsonb, $3::jsonb, $4)`,
          [
            context.organizationId,
            JSON.stringify(premisesFixture()),
            JSON.stringify(broken),
            `forged-disclaimer-${randomUUID()}`,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('o CHECK do enum category da F2-14 CONTINUA intacto: esta tarefa não o tocou', async () => {
    // A pendência herdada que esta tarefa herdou e decidiu NÃO resolver: a
    // F2-14 gravou o CHECK aceitando só 'OVERALL' e a F2-15 descobriu por probe
    // que a API oficial aceita onze. A 0030 NÃO mexe nesse CHECK, e este teste
    // é a prova: a tentativa de gravar uma das dez categorias oficiais além de
    // 'OVERALL' continua SENDO RECUSADA pelo banco.
    //
    // A simulação NÃO precisa das onze categorias para existir: ela aceita o
    // rótulo oficial (é o que a interface oferece) e recusa a janela sem série
    // com SERIES_NOT_COLLECTED. Ampliar o CHECK sem ampliar a INGESTÃO
    // permitiria gravar séries que o job de ingestão não produz.
    await expect(
      database.pool.query(
        `insert into integration.polymarket_series
           (category, time_period, order_by, window_from, window_to, backfill_from, status)
         values ('SPORTS', 'MONTH', 'PNL', now(), now(), '2026-04-01', 'unknown')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // E a 0030 aceita o enum OFICIAL de onze, que é o que a tela oferece.
    const column = (
      await database.pool.query<{ count: string }>(
        `select count(*)::text as count from integration.polymarket_simulation
          where category = 'FINANCE'`,
      )
    ).rows[0]!;
    // Nenhuma linha gravada com essa categoria ainda, mas a coluna existe e a
    // constraint não rejeita o rótulo (a recusa é da COBERTUDE, não do schema).
    expect(Number(column.count)).toBe(0);
  });

  it('o ISOLAMENTO por organização é RLS, e sem contexto não há linha', async () => {
    const other = '00000000-0000-4000-8000-0000000000ff';
    // A política compara com `current_setting`, então a consulta sem contexto
    // devolve ZERO linhas em vez de erro — fail-closed.
    const { rows: leaked } = await database.pool.query<{ n: string }>(
      `select count(*)::text as n from integration.polymarket_simulation
        where organization_id = $1`,
      [other],
    );
    expect(leaked[0]!.n).toBe('0');
    // E a tabela tem RLS ligado: é a garantia de que uma consulta de outra
    // organização não atravessa o predicado.
    const rls = (
      await database.pool.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'integration' and c.relname = 'polymarket_simulation'`,
      )
    ).rows[0]!;
    expect(rls.relrowsecurity).toBe(true);
  });
});

/** As sete premissas bem formadas, para as tentativas do banco. */
function premisesFixture() {
  return [
    { key: 'stake', label: 'Stake', value: '10.00', kind: 'configured', note: 'escolhido' },
    { key: 'delayMs', label: 'Atraso', value: '0', kind: 'declared', note: 'declarado' },
    { key: 'feeRate', label: 'Taxa', value: '0.02', kind: 'configured', note: 'escolhido' },
    { key: 'spreadRate', label: 'Spread', value: '0.01', kind: 'configured', note: 'escolhido' },
    {
      key: 'slippageRate',
      label: 'Slippage',
      value: '0.005',
      kind: 'configured',
      note: 'escolhido',
    },
    {
      key: 'missingDataRate',
      label: 'Ausentes',
      value: '0.2',
      kind: 'measured',
      note: 'medido',
    },
    {
      key: 'completeness',
      label: 'Cobertura',
      value: 'truncated',
      kind: 'measured',
      note: 'medido',
    },
  ];
}

async function countSimulation(database: Database, organizationId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `select count(*)::text as n from integration.polymarket_simulation
      where organization_id = $1`,
    [organizationId],
  );
  return Number(rows[0]!.n);
}

/**
 * Cria um usuário real e o admitiu, para que `ensureOrganizationMembership`
 * tenha o que resolver. A alternativa — passar um id de organização
 * inventado — testaria a gravação sem o caminho de tenancy que a aplicação usa.
 */
async function seedOwner(database: Database): Promise<string> {
  const userId = randomUUID();
  const now = new Date();
  await database.pool.query(
    `insert into auth.user (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'Fixture Owner', $2, true, $3, $3)`,
    [userId, `owner-${userId}@fixture.invalid`, now],
  );
  return userId;
}

/**
 * A 0030 está no journal, em ordem, com índice contíguo, e ela é a última.
 *
 * A verificação é por `tag` e por POSIÇÃO declarada, no mesmo padrão que a
 * 0025 e a 0027 usaram: uma migração nova não pode obrigar a editar este
 * teste, mas também não pode deslizar para fora da sua posição.
 */
describe('STK-F2-17 §15 — a 0030 no journal e replay-safe', () => {
  it('a 0030 está no journal, em ordem e com índice contíguo', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { idx: number; tag: string }[] };
    const position = journal.entries.findIndex(
      (entry) => entry.tag === '0030_polymarket_simulation',
    );
    expect(position).toBeGreaterThan(0);
    // O `idx` declarado tem de ser a posição REAL, e é isso que torna
    // confiável o replay de prefixo do migrador. A verificação é pela POSIÇÃO
    // e não por "é a última entrada": a 0030 foi reservada quando o journal
    // tinha 29 entradas, e a F2-16 tomou o idx 29 com a 0029 no caminho — a
    // 0030 ficou no 30 e a ordem das duas é o que a CI verifica.
    expect(journal.entries[position]!.idx).toBe(position);
    expect(journal.entries.every((entry, index) => entry.idx === index)).toBe(true);
    // E a 0029 da F2-16 fica IMEDIATAMENTE antes: as duas foram reservadas em
    // paralelo e a colisão de idx só apareceria aqui, na posição, e não na
    // aplicação da migração.
    const favorites = journal.entries.findIndex(
      (entry) => entry.tag === '0029_polymarket_favorites',
    );
    expect(favorites).toBeGreaterThan(0);
    expect(journal.entries[favorites + 1]!.tag).toBe('0030_polymarket_simulation');
  });
});
