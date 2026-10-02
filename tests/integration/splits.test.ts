import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  createFinanceService,
  createReportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ReportService,
  type OrganizationContext,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import {
  reportQuerySchema,
  type AnalyticsSplitDimension,
  type AnalyticsSplits,
  type BetInput,
  type FinanceCommand,
  type SplitDimensionId,
} from '../../packages/shared/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
let database: Database;
let finance: FinanceService;
let reports: ReportService;
let context: OrganizationContext;
let name: string;
let bet365: string;
let pinnacle: string;
let tipsterAlpha: string;
let b7: string;
type Input = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
const run = async (input: Input) =>
  finance.command(context, randomUUID(), {
    ...input,
    expectedVersion: (await finance.workspace(context)).version,
  } as FinanceCommand);
const query = reportQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' });

const selection = (input: {
  event: string;
  sport: string | null;
  market: string;
  selection: string;
  eventDate: string;
}) => ({
  ...input,
  odds: null,
  eventAt: null,
  dateStatus: 'confirmed' as const,
});

async function createBet(input: Partial<BetInput> = {}) {
  return run({
    type: 'bet.create',
    bookmakerId: bet365,
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: '2026-09-07T13:00:00Z',
    freebetId: null,
    reference: 'fixture',
    allowMissingUnit: false,
    selections: [
      selection({
        event: 'Aurora x Central',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Aurora',
        eventDate: '2026-09-05',
      }),
    ],
    ...input,
  });
}

async function settle(id: string, outcome: 'win' | 'loss', returnAmount: string) {
  return run({
    type: 'bet.settle',
    id,
    outcome,
    returnAmount,
    closedPrincipal: '100.00',
    settledAt: new Date().toISOString(),
    reason: 'Liquidação de teste',
  });
}

const dimensionOf = (payload: AnalyticsSplits, id: SplitDimensionId) => {
  const found = payload.dimensions.find((item) => item.id === id);
  if (!found) throw new Error(`MISSING_DIMENSION_${id}`);
  return found;
};
const rowOf = (dimension: AnalyticsSplitDimension, key: string) => {
  const found = dimension.rows.find((row) => row.key === key);
  if (!found) throw new Error(`MISSING_ROW_${key}`);
  return found;
};
const betsOf = (dimension: AnalyticsSplitDimension) =>
  dimension.rows.reduce((total, row) => total + row.metrics.bets, 0);

beforeAll(async () => {
  name = `stk_splits_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_splits_test_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  finance = createFinanceService(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Fixture Owner','fixture-owner@stk.test') on conflict (id) do nothing",
  );
  context = await finance.ensureContext('fixture-owner');
  reports = createReportService(database);
  const workspace = await finance.workspace(context);
  bet365 = workspace.catalog.find((row) => row.name === 'Bet365')!.id;
  await run({ type: 'catalog.create', kind: 'bookmaker', name: 'Pinnacle', aliases: [] });
  await run({ type: 'catalog.create', kind: 'tipster', name: 'Tipster Alpha', aliases: [] });
  const catalogued = await finance.workspace(context);
  pinnacle = catalogued.catalog.find((row) => row.name === 'Pinnacle')!.id;
  tipsterAlpha = catalogued.catalog.find((row) => row.name === 'Tipster Alpha')!.id;
  await run({
    type: 'bankroll.initialize',
    reserve: '10000.00',
    balances: [
      { bookmakerId: bet365, amount: '5000.00' },
      { bookmakerId: pinnacle, amount: '5000.00' },
    ],
    unitPercent: '1.00',
  });
  // A unidade é devida no mês da aposta (finance-commands.ts:56) e o mês corrente
  // é a única que nasce sozinha, em ensureCurrentUnit. As apostas deste relatório são
  // todas de setembro, então setembro precisa da sua unidade declarada — senão
  // allowMissingUnit:false esbarra em UNIT_REQUIRED. O valor é 1% da reserva, a mesma
  // regra que a unidade inicial usa; nenhum assert deste arquivo depende dele.
  await run({
    type: 'unit.set',
    month: '2026-09',
    amount: '100.00',
    reason: 'Unidade de setembro conferida pelo cenário de splits',
  });
  const freebet = await run({
    type: 'freebet.create',
    bookmakerId: pinnacle,
    amount: '100.00',
    expiresOn: '2099-01-01',
    stakeReturned: false,
    note: 'Promoção de teste',
  });
  // 1 — futebol simples liquidado, segunda de manhã (10:00 em São Paulo).
  await settle(
    (
      await createBet({
        reference: 'b1',
        odds: '1.50',
        placedAt: '2026-09-07T13:00:00Z',
        selections: [
          selection({
            event: 'Aurora x Central',
            sport: 'Futebol',
            market: 'Resultado',
            selection: 'Aurora',
            eventDate: '2026-09-05',
          }),
        ],
      })
    ).id,
    'win',
    '200.00',
  );
  // 2 — tênis, segunda casa, tipster, terça 15:30.
  await createBet({
    reference: 'b2',
    bookmakerId: pinnacle,
    tipsterId: tipsterAlpha,
    odds: '2.00',
    placedAt: '2026-09-08T18:30:00Z',
    selections: [
      selection({
        event: 'Nadal x Alcaraz',
        sport: 'Tênis',
        market: 'Handicap',
        selection: 'Nadal',
        eventDate: '2026-09-06',
      }),
    ],
  });
  // 3 — esporte sem informar (unknown) e aposta aberta, domingo 22:00.
  await createBet({
    reference: 'b3',
    odds: '3.50',
    placedAt: '2026-09-07T01:00:00Z',
    selections: [
      selection({
        event: 'Jogo x Adversário',
        sport: null,
        market: 'Mais de 2.5',
        selection: 'Acima',
        eventDate: '2026-09-07',
      }),
    ],
  });
  // 4 — múltipla de dois jogos/mercados, aposta perdida.
  await settle(
    (
      await createBet({
        reference: 'b4',
        tipsterId: tipsterAlpha,
        odds: '7.00',
        placedAt: '2026-09-09T12:15:00Z',
        selections: [
          selection({
            event: 'Flamengo x Palmeiras',
            sport: 'Futebol',
            market: 'Resultado',
            selection: 'Flamengo',
            eventDate: '2026-09-08',
          }),
          selection({
            event: 'Corinthians x São Paulo',
            sport: 'Futebol',
            market: 'Ambas marcam',
            selection: 'Sim',
            eventDate: '2026-09-09',
          }),
        ],
      })
    ).id,
    'loss',
    '0.00',
  );
  // 5 — BetBuild: duas seleções no mesmo evento, quinta 20:00.
  await createBet({
    reference: 'b5',
    odds: '12.00',
    placedAt: '2026-09-10T23:00:00Z',
    selections: [
      selection({
        event: 'Grêmio x Internacional',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Grêmio',
        eventDate: '2026-09-10',
      }),
      selection({
        event: 'Grêmio x Internacional',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Empate',
        eventDate: '2026-09-10',
      }),
    ],
  });
  // 6 — freebet de basquete: grupo sem dinheiro real, ROI e yield sem base.
  await settle(
    (
      await createBet({
        reference: 'b6',
        bookmakerId: pinnacle,
        freebetId: freebet.id,
        odds: '1.90',
        placedAt: '2026-09-12T14:00:00Z',
        selections: [
          selection({
            event: 'Lakers x Celtics',
            sport: 'Basquete',
            market: 'Linha',
            selection: 'Acima',
            eventDate: '2026-09-11',
          }),
        ],
      })
    ).id,
    'win',
    '190.00',
  );
  // 7 — importada com torneio e tipo de aposta declarados manualmente.
  const imported = await createBet({
    reference: 'b7',
    tipsterId: tipsterAlpha,
    odds: '2.50',
    placedAt: '2026-09-14T11:00:00Z',
    selections: [
      selection({
        event: 'Bahia x Fortaleza',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'Bahia',
        eventDate: '2026-09-13',
      }),
    ],
  });
  b7 = imported.id;
  await settle(b7, 'win', '250.00');
  await database.pool.query(
    `insert into integration.inbox
       (id, organization_id, source_key, sha256, caption, metadata, imported_bet_id, state)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'imported')`,
    [
      randomUUID(),
      context.organizationId,
      `fixture-${randomUUID()}`,
      'f'.repeat(64),
      'Comprovante de teste',
      JSON.stringify({ userOverrides: { tournament: 'Copa do Brasil', ticketKind: 'multiple' } }),
      b7,
    ],
  );
  // 8 — bilhete incompleto sem odd registrada: faixa unknown (Sem odds).
  const noOdds = await createBet({
    reference: 'b8',
    bookmakerId: pinnacle,
    odds: '2.00',
    placedAt: '2026-09-11T19:00:00Z',
    selections: [
      selection({
        event: 'Sinner x Medvedev',
        sport: 'Tênis',
        market: 'Sets',
        selection: 'Sinner',
        eventDate: '2026-09-11',
      }),
    ],
  });
  await database.pool.query(
    'update finance.bet set odds = null, completion_state = $2 where id = $1 and organization_id = $3',
    [noOdds.id, 'incomplete', context.organizationId],
  );
});
afterAll(async () => {
  await database?.close();
  if (/^stk_splits_test_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
});

describe('analytics splits (STK-F2-03)', () => {
  it('entrega as 12 dimensões do card, com N somando a população em cada uma', async () => {
    const payload = await reports.splits(context, query);
    expect(payload.dimensions.map((item) => item.id)).toEqual([
      'sport',
      'tournament',
      'team',
      'player',
      'ticketKind',
      'market',
      'bookmaker',
      'oddsBand',
      'weekday',
      'hour',
      'live',
      'tipster',
    ]);
    expect(payload.metrics.bets).toBe(8);
    expect(payload.minSample).toBe(30);
    expect(payload.lowSample).toBe(true);
    for (const dimension of payload.dimensions) {
      expect(betsOf(dimension)).toBe(payload.metrics.bets);
      expect(dimension.rows.length).toBeGreaterThan(0);
    }
    // Mesma agregação do relatório: splits e relatório não divergem.
    expect((await reports.report(context, query)).metrics).toEqual(payload.metrics);
  });

  it('esporte: agrupa por esporte e preserva unknown', async () => {
    const sport = dimensionOf(await reports.splits(context, query), 'sport');
    expect(sport.rows.map((row) => row.key)).toEqual([
      'sport:futebol',
      'sport:tenis',
      'sport:basquete',
      'unknown',
    ]);
    expect(rowOf(sport, 'sport:futebol')).toMatchObject({ label: 'Futebol' });
    expect(rowOf(sport, 'sport:futebol').metrics.bets).toBe(4);
    expect(rowOf(sport, 'sport:tenis')).toMatchObject({ label: 'Tenis' });
    expect(rowOf(sport, 'sport:tenis').metrics.bets).toBe(2);
    expect(rowOf(sport, 'unknown')).toMatchObject({ label: 'Esporte a conferir' });
    expect(rowOf(sport, 'unknown').metrics.bets).toBe(1);
    // Freebet pura no grupo: ROI e yield sem base, nunca zero.
    const basket = rowOf(sport, 'sport:basquete');
    expect(basket.metrics).toMatchObject({ bets: 1, roiReal: null, yieldReal: null });
    expect(basket.metrics.roiReal).not.toBe('0.00');
    expect(basket.lowSample).toBe(true);
  });

  it('liga/torneio: lê o torneio manual e mantém unknown no restante', async () => {
    const tournament = dimensionOf(await reports.splits(context, query), 'tournament');
    expect(tournament).toMatchObject({
      source: 'integration.inbox.metadata.userOverrides.tournament',
      available: true,
    });
    expect(tournament.rows.map((row) => [row.key, row.metrics.bets])).toEqual([
      ['unknown', 7],
      ['copa do brasil', 1],
    ]);
    expect(rowOf(tournament, 'unknown').label).toBe('Torneio a conferir');
    expect(rowOf(tournament, 'copa do brasil').label).toBe('Copa do Brasil');
  });

  it('time: sem coluna no modelo, a dimensão sai inteira em unknown documentado', async () => {
    const team = dimensionOf(await reports.splits(context, query), 'team');
    expect(team).toMatchObject({ available: false, source: 'unavailable' });
    expect(team.note).toContain('não guarda time');
    expect(team.rows).toHaveLength(1);
    expect(team.rows[0]).toMatchObject({ key: 'unknown', label: 'Sem base' });
    expect(team.rows[0]!.metrics.bets).toBe(8);
  });

  it('jogador: sem coluna no modelo, a dimensão sai inteira em unknown documentado', async () => {
    const player = dimensionOf(await reports.splits(context, query), 'player');
    expect(player).toMatchObject({ available: false, source: 'unavailable' });
    expect(player.note).toContain('não guarda jogador');
    expect(player.rows).toHaveLength(1);
    expect(player.rows[0]).toMatchObject({ key: 'unknown', label: 'Sem base', lowSample: true });
    expect(player.rows[0]!.metrics.bets).toBe(8);
  });

  it('tipo de aposta: deriva Simples/Múltipla/BetBuild e aplica o override manual', async () => {
    const kinds = dimensionOf(await reports.splits(context, query), 'ticketKind');
    expect(kinds.rows.map((row) => row.key)).toEqual(['simple', 'multiple', 'betbuild']);
    expect(kinds.rows.map((row) => [row.label, row.metrics.bets])).toEqual([
      ['Simples', 5],
      ['Múltipla', 2],
      ['BetBuild', 1],
    ]);
    // b7 é uma seleção única reclassificada na importação: o override vence.
    expect(kinds.note).toContain('sobrepõe o derivado');
  });

  it('mercado: agrupa por mercado e separa bilhetes com mercados mistos', async () => {
    const market = dimensionOf(await reports.splits(context, query), 'market');
    expect(market.rows.map((row) => row.key)).toEqual([
      'market:resultado',
      'market:handicap',
      'market:linha',
      'market:mais de 2 5',
      'market:sets',
      'mixed',
    ]);
    expect(rowOf(market, 'market:resultado').metrics.bets).toBe(3);
    expect(rowOf(market, 'market:resultado').label).toBe('Resultado');
    expect(rowOf(market, 'market:mais de 2 5').label).toBe('Mais de 2.5');
    expect(rowOf(market, 'mixed')).toMatchObject({ label: 'Múltiplos mercados' });
    expect(rowOf(market, 'mixed').metrics.bets).toBe(1);
  });

  it('casa: separa as casas com N e métricas próprios', async () => {
    const bookmakers = dimensionOf(await reports.splits(context, query), 'bookmaker');
    expect(bookmakers.rows.map((row) => [row.key, row.label, row.metrics.bets])).toEqual([
      [bet365, 'Bet365', 5],
      [pinnacle, 'Pinnacle', 3],
    ]);
    expect(rowOf(bookmakers, bet365).metrics.profit).toBe('150.00');
  });

  it('faixa de odd: bandas ordenadas pela odd e sem odd vira unknown', async () => {
    const bands = dimensionOf(await reports.splits(context, query), 'oddsBand');
    expect(bands.rows.map((row) => row.key)).toEqual([
      '1.50-1.99',
      '2.00-2.99',
      '3.00-4.99',
      '5.00-9.99',
      '>=10.00',
      'unknown',
    ]);
    expect(bands.rows.map((row) => row.metrics.bets)).toEqual([2, 2, 1, 1, 1, 1]);
    expect(rowOf(bands, '1.50-1.99').label).toBe('1,50 a 1,99');
    expect(rowOf(bands, '>=10.00').label).toBe('10,00 ou mais');
    expect(rowOf(bands, 'unknown')).toMatchObject({ label: 'Sem base' });
  });

  it('dia da semana: usa a aposta em São Paulo e a ordem seg..dom', async () => {
    const weekdays = dimensionOf(await reports.splits(context, query), 'weekday');
    expect(weekdays.rows.map((row) => row.key)).toEqual([
      'seg',
      'ter',
      'qua',
      'qui',
      'sex',
      'sab',
      'dom',
    ]);
    expect(weekdays.rows.map((row) => row.metrics.bets)).toEqual([2, 1, 1, 1, 1, 1, 1]);
    expect(rowOf(weekdays, 'seg').label).toBe('Segunda-feira');
    expect(rowOf(weekdays, 'dom').label).toBe('Domingo');
    expect(weekdays.note).toContain('São Paulo');
  });

  it('hora: usa a aposta em São Paulo, de 00 a 23', async () => {
    const hours = dimensionOf(await reports.splits(context, query), 'hour');
    expect(hours.rows.map((row) => row.key)).toEqual([
      '08',
      '09',
      '10',
      '11',
      '15',
      '16',
      '20',
      '22',
    ]);
    expect(rowOf(hours, '10').label).toBe('10:00–10:59');
    expect(rowOf(hours, '22').metrics.bets).toBe(1);
    expect(betsOf(hours)).toBe(8);
  });

  it('live/pré-jogo: sem flag no modelo, a dimensão sai inteira em unknown documentado', async () => {
    const live = dimensionOf(await reports.splits(context, query), 'live');
    expect(live).toMatchObject({ available: false, source: 'unavailable' });
    expect(live.note).toContain('ao vivo');
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0]).toMatchObject({ key: 'unknown', label: 'Sem base' });
    expect(live.rows[0]!.metrics.bets).toBe(8);
  });

  it('tipster: separa apostas com e sem tipster', async () => {
    const tipsters = dimensionOf(await reports.splits(context, query), 'tipster');
    expect(tipsters.rows.map((row) => [row.key, row.label, row.metrics.bets])).toEqual([
      ['none', 'Sem tipster', 5],
      [tipsterAlpha, 'Tipster Alpha', 3],
    ]);
  });

  it('combina filtros e mantém N coerente em todas as dimensões', async () => {
    const combined = await reports.splits(context, {
      ...query,
      bookmakerId: bet365,
      sport: 'sport:futebol',
      state: 'settled',
    });
    expect(combined.metrics.bets).toBe(3); // b1, b4 e b7
    expect(combined.filters).toMatchObject({
      bookmakerId: bet365,
      sport: 'sport:futebol',
      state: 'settled',
    });
    for (const dimension of combined.dimensions) expect(betsOf(dimension)).toBe(3);
    expect(combined.dimensions.find((item) => item.id === 'bookmaker')!.rows).toHaveLength(1);
    expect(
      combined.dimensions.find((item) => item.id === 'sport')!.rows.map((row) => row.key),
    ).toEqual(['sport:futebol']);
    expect(
      combined.dimensions
        .find((item) => item.id === 'tipster')!
        .rows.map((row) => [row.key, row.metrics.bets]),
    ).toEqual([
      [tipsterAlpha, 2],
      ['none', 1],
    ]);
    // Origem do valor + tipster ausente, somados ao mesmo tempo.
    const freebets = await reports.splits(context, { ...query, kind: 'freebet' });
    expect(freebets.metrics.bets).toBe(1);
    expect(dimensionOf(freebets, 'sport').rows.map((row) => row.key)).toEqual(['sport:basquete']);
    expect(rowOf(dimensionOf(freebets, 'sport'), 'sport:basquete').metrics.roiReal).toBeNull();
    const withoutTipster = await reports.splits(context, {
      ...query,
      tipsterId: 'none',
      bookmakerId: pinnacle,
    });
    expect(withoutTipster.metrics.bets).toBe(2);
    // Recorte de período também vale para cada split.
    const since = await reports.splits(context, { ...query, from: '2026-09-07' });
    expect(since.metrics.bets).toBe(6);
    for (const dimension of since.dimensions) expect(betsOf(dimension)).toBe(6);
  });

  it('marca baixa amostra por split pelo limiar configurado', async () => {
    const payload = await reports.splits(context, query);
    expect(payload.minSample).toBe(30);
    for (const dimension of payload.dimensions)
      for (const row of dimension.rows) expect(row.lowSample).toBe(row.metrics.bets < 30);
    const strict = createReportService(database, { dashboardMinSample: 1 });
    const strictPayload = await strict.splits(context, query);
    expect(strictPayload.minSample).toBe(1);
    expect(strictPayload.lowSample).toBe(false);
    for (const dimension of strictPayload.dimensions)
      for (const row of dimension.rows) expect(row.lowSample).toBe(false);
    expect(() => createReportService(database, { dashboardMinSample: 0 })).toThrow(
      'INVALID_DASHBOARD_MIN_SAMPLE',
    );
  });

  it('cacheia por organização, versão e filtros — e invalida a cada movimentação', async () => {
    const service = createReportService(database);
    const first = await service.splits(context, query);
    expect(await service.splits(context, query)).toBe(first);
    // Movimentação fora do período: muda a versão, não muda os números de setembro.
    await createBet({
      reference: 'fora-do-periodo',
      placedAt: '2026-08-10T12:00:00Z',
      allowMissingUnit: true,
      selections: [
        selection({
          event: 'Evento de agosto',
          sport: 'Futebol',
          market: 'Resultado',
          selection: 'X',
          eventDate: '2026-08-15',
        }),
      ],
    });
    const refreshed = await service.splits(context, query);
    expect(refreshed).not.toBe(first);
    expect(refreshed.version).toBeGreaterThan(first.version);
    expect(refreshed.metrics.bets).toBe(8);
    // Filtro diferente: chave própria, agregação própria.
    const filtered = await service.splits(context, { ...query, kind: 'freebet' });
    expect(filtered).not.toBe(refreshed);
    expect(filtered.metrics.bets).toBe(1);
    // TTL 0 desliga o cache (mesma regra da F2-02).
    const uncached = createReportService(database, { dashboardCacheTtlMs: 0 });
    const off = await uncached.splits(context, query);
    expect(await uncached.splits(context, query)).not.toBe(off);
  });

  it('expõe o endpoint na API com a mesma sessão dos relatórios', async () => {
    const { createReportService: createApiReportService } =
      await import('../../packages/db/dist/index.js');
    const auth = {
      origin: 'http://localhost',
      getOwner: vi.fn(async () => null),
    } as unknown as OwnerAuth;
    const app = createApp({
      checkDatabase: database.check,
      ownerAuth: auth,
      reports: createApiReportService(database),
    });
    try {
      const unauthenticated = await app.inject(
        '/api/v1/analytics/splits?from=2026-09-01&to=2026-09-30',
      );
      expect(unauthenticated.statusCode).toBe(401);
      vi.mocked(auth.getOwner).mockResolvedValue({ user: { id: 'fixture-owner' } } as Awaited<
        ReturnType<OwnerAuth['getOwner']>
      >);
      const response = await app.inject('/api/v1/analytics/splits?from=2026-09-01&to=2026-09-30');
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.dimensions).toHaveLength(12);
      expect(payload.minSample).toBe(30);
      expect(payload.metrics).toMatchObject({ bets: 8, roiReal: '50.00', yieldReal: '21.43' });
      expect(payload.dimensions[0].rows[0].metrics.bets).toBeGreaterThan(0);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        (await app.inject('/api/v1/analytics/splits?from=2026-09-30&to=2026-09-01')).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
