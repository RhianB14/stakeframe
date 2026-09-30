/**
 * STK-F2-18 — dataset de preview do redesign web.
 *
 * Por que isto existe: os fixtures de `tests/e2e` são mínimos de propósito (uma
 * aposta, uma importação) porque testa comportamento, não densidade. Julgar uma
 * tabela de 14 colunas, um calendário de 3 meses ou um relatório com 12 splits
 * exige um portfólio que pareça real — e, sobretudo, que seja *internamente
 * coerente*: um dashboard que soma 42 apostas e um relatório que soma 17 é
 * defeito de design, não de código.
 *
 * A regra que mantém a coerência: existe UMA fonte de verdade, `BETS`. Tudo o
 * mais — dashboard, relatório, splits, calendário, financeiro — é DERIVADO
 * dela. Nenhum número é escrito à mão em dois lugares.
 *
 * A aritmética é inteira, em centavos, nunca em ponto flutuante.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética
// ─────────────────────────────────────────────────────────────────────────────

/** Converte reais em centavos inteiros. Todo cálculo passa por aqui. */
const cents = (reais) => Math.round(reais * 100);
/** Formata centavos como money string ("1234.50"), que é o formato do contrato. */
const money = (c) => (c / 100).toFixed(2);
/** Formata como unidade com 6 casas, que é o formato de `profitUnits`. */
const units = (u) => u.toFixed(6);
/** Percentual com 2 casas; `null` quando não há base — o schema exige string|null. */
const percent = (num, den) => (den > 0 ? ((num / den) * 100).toFixed(2) : null);

/** PRNG determinístico. A mesma seed produz sempre o mesmo portfólio. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260930);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (min, max) => min + rand() * (max - min);
/** UUID v4 válido — `betSchema` usa `z.uuid()`, que valida o formato. */
let uuidCounter = 0;
const uuid = () => {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `10000000-0000-4000-8000-${hex}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo — casas e tipsters reais, porque o nome aparece na tela e um nome
// inventado denuncia Immediately um mock.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKMAKERS = [
  { id: '20000000-0000-4000-8000-000000000001', name: 'PIXBET' },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Sportingbet' },
  { id: '20000000-0000-4000-8000-000000000003', name: 'Bet365' },
  { id: '20000000-0000-4000-8000-000000000004', name: 'Betano' },
  { id: '20000000-0000-4000-8000-000000000005', name: 'Kalsbet' },
];
const bookmakerById = new Map(BOOKMAKERS.map((b) => [b.id, b.name]));

const TIPSTERS = [
  { id: '30000000-0000-4000-8000-000000000001', name: 'Ana Ribeiro' },
  { id: '30000000-0000-4000-8000-000000000002', name: 'Carlos Menezes' },
  { id: '30000000-0000-4000-8000-000000000003', name: 'Patrícia Lopes' },
];
const tipsterById = new Map(TIPSTERS.map((t) => [t.id, t.name]));

/** Eventos reais do calendário brasileiro/internacional — nomes longos de propósito. */
const EVENTS = [
  { event: 'Flamengo × Palmeiras', sport: 'Futebol', market: 'Resultado', pick: 'Flamengo' },
  { event: 'Corinthians × São Paulo', sport: 'Futebol', market: 'Resultado', pick: 'Corinthians' },
  { event: 'Grêmio × Internacional', sport: 'Futebol', market: 'Gols', pick: 'Mais de 2,5' },
  {
    event: 'Atlético Mineiro × Cruzeiro',
    sport: 'Futebol',
    market: 'Resultado',
    pick: 'Atlético Mineiro',
  },
  { event: 'Vasco da Gama × Fluminense', sport: 'Futebol', market: 'Gols', pick: 'Menos de 3,5' },
  { event: 'Botafogo × Santos', sport: 'Futebol', market: 'Resultado', pick: 'Botafogo' },
  { event: 'Bahia × Ceará', sport: 'Futebol', market: 'Resultado', pick: 'Bahia' },
  {
    event: 'Fortaleza × Athletico Paranaense',
    sport: 'Futebol',
    market: 'Gols',
    pick: 'Mais de 1,5',
  },
  { event: 'Real Madrid × Manchester City', sport: 'Futebol', market: 'Resultado', pick: 'Empate' },
  { event: 'Liverpool × Bayern de Munique', sport: 'Futebol', market: 'Gols', pick: 'Mais de 2,5' },
  { event: 'Paris Saint-Germain × Benfica', sport: 'Futebol', market: 'Resultado', pick: 'PSG' },
  { event: 'Inter Miami × Orlando City', sport: 'Futebol', market: 'Gols', pick: 'Mais de 3,5' },
  {
    event: 'Golden State Warriors × Boston Celtics',
    sport: 'Basquete',
    market: 'Resultado',
    pick: 'Celtics',
  },
  { event: 'Lakers × Denver Nuggets', sport: 'Basquete', market: 'Totais', pick: 'Mais de 215,5' },
  {
    event: 'A von Radrix × B v Borussia Monchengladbach',
    sport: 'Futebol',
    market: 'Resultado',
    pick: "Borussia M'gladbach",
  },
];

const SPORT_BY_MARKET = { Resultado: '1X2', Gols: 'Gols', Totais: 'Totais' };
const TICKET_KIND_LABEL = { simple: 'Simples', multiple: 'Múltipla', betbuild: 'BetBuild' };

// ─────────────────────────────────────────────────────────────────────────────
// Unidades — uma por mês, que é como o produto funciona
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = [
  { month: '2026-07', amount: cents(50) },
  { month: '2026-08', amount: cents(60) },
  { month: '2026-09', amount: cents(50) },
];
const unitByMonth = new Map(MONTHS.map((u) => [u.month, u.amount]));

/** Converte um instante UTC para a data em São Paulo (UTC−3), que é o `dateBasis` do produto. */
function saoPauloDate(iso) {
  return new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// A carteira — fonte única de verdade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Datas: as apostas são geradas CAMINHANDO pelos dias de 1/jul a 28/set, e não
 * sorteadas por mês. A versão anterior sorteava o mês pelo índice, o que
 * coincidia de todas as apostas abertas ficarem em setembro — e o painel de
 * setembro aparecia com lucro zero, que é um portfolio inventado que não existe
 * na vida real: quem aposta, aposta no mês corrente e liquidou parte dele.
 */
const FIRST_DAY = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAYS = 90; // 1/jul → 28/set
/** Depois desta data a aposta continua aberta: é o que o painel mostra em aberto. */
const OPEN_FROM_DAY = Date.UTC(2026, 8, 22, 12, 0, 0);

function buildBets() {
  const bets = [];
  let ticket = 0;
  for (let offset = 0; offset < DAYS; offset += 1) {
    const dayStart = FIRST_DAY + offset * 86400000;
    const day = new Date(dayStart).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    // `monthUnit`, não `units`: um `units` local aqui SOMBRARIA a função
    // formatadora do módulo e `units(stakeC / unitAmount)` viraria
    // "units is not a function" só nas apostas de setembro.
    const monthUnit = unitByMonth.get(month);
    if (!monthUnit) continue;
    // Aposta em dia útil é mais frequente que em domingo.
    const weekday = new Date(dayStart).getUTCDay();
    const chance = weekday === 0 ? 0.3 : weekday === 6 ? 0.5 : 0.72;
    const count = rand() < chance ? (rand() < 0.22 ? 2 : 1) : 0;

    for (let n = 0; n < count; n += 1) {
      ticket += 1;
      const hour = 12 + Math.floor(rand() * 8);
      const placedAt = `${day}T${String(hour).padStart(2, '0')}:15:00Z`;
      const eventDate = new Date(new Date(placedAt).getTime() + (1 + rand() * 4) * 86400000)
        .toISOString()
        .slice(0, 10);

      const ticketKind = pick(['simple', 'simple', 'simple', 'multiple', 'multiple', 'betbuild']);
      const odds =
        ticketKind === 'simple'
          ? Number(between(1.4, 3.2).toFixed(2))
          : ticketKind === 'multiple'
            ? Number(between(3.4, 9.5).toFixed(2))
            : Number(between(14, 52).toFixed(2));
      const stakeC = cents(
        ticketKind === 'simple'
          ? between(20, 180)
          : ticketKind === 'multiple'
            ? between(10, 60)
            : between(4, 15),
      );
      const unitAmount = monthUnit;

      // Liquidação honesta. A versão anterior devolvia `stake * odds` para
      // TODOS os resultados não-derrotas — inclusive void e meia-vitória — e o
      // painel abria com ROI de 188%, que nenhum bookmaker entrega. Um void
      // devolve o stake; meia-vitória devolve metade do lucro.
      const grossReturnC = stakeC * odds;
      const isOpen = dayStart >= OPEN_FROM_DAY;
      // A chance de vitória cai com a odd: é isso que impede um "venha sempre"
      // de virar ROI de três dígitos. `skill` é uma margem pequena e plausível.
      const skill = 1.03;
      const roll = rand();
      const voidChance = 0.012;
      const halfWinChance = 0.018;
      const winChance = Math.min(0.8, skill / odds);
      let outcome = null;
      if (!isOpen) {
        if (roll < voidChance) outcome = 'void';
        else if (roll < voidChance + halfWinChance) outcome = 'half_win';
        else outcome = roll < voidChance + halfWinChance + winChance ? 'win' : 'loss';
      }
      let settledReturnC = 0;
      if (outcome === 'win') settledReturnC = Math.round(grossReturnC);
      else if (outcome === 'void') settledReturnC = stakeC;
      else if (outcome === 'half_win')
        settledReturnC = stakeC + Math.round((grossReturnC - stakeC) / 2);
      const profitC = settledReturnC - stakeC;

      const selectionCount =
        ticketKind === 'simple' ? 1 : ticketKind === 'multiple' ? 2 + Math.floor(rand() * 3) : 4;
      const selections = Array.from({ length: selectionCount }, (_, index) => {
        const source = EVENTS[(ticket + index * 3) % EVENTS.length];
        return {
          id: uuid(),
          event: source.event,
          sport: source.sport,
          market: source.market,
          selection: source.pick,
          // `oddsSchema` é string: o contrato trata odd como decimal literal, e
          // `Number(...)` aqui viraria um `number` que o parse rejeita.
          odds: String(ticketKind === 'simple' ? odds : between(1.5, 3.0).toFixed(2)),
          eventDate,
          eventAt: `${eventDate}T19:00:00Z`,
          // Datas não confirmadas existem de verdade na carteira e acionam o
          // aviso de conferência em fonte externa — o painel precisa exibir.
          dateStatus: rand() > 0.82 ? 'estimated' : 'confirmed',
        };
      });

      bets.push({
        id: uuid(),
        ticketNumber: ticket,
        bookmakerId: pick(BOOKMAKERS).id,
        tipsterId: rand() > 0.25 ? pick(TIPSTERS).id : null,
        stake: money(stakeC),
        odds: String(odds),
        placedAt,
        createdAt: placedAt,
        freebetId: null,
        reference: `Bilhete ${ticket}`,
        freebetStakeReturned: null,
        state: isOpen ? 'open' : 'settled',
        ticketKind,
        latestOutcome: outcome,
        remaining: isOpen ? money(stakeC) : money(0),
        completionState: 'complete',
        unitMonth: month,
        unitAmount: money(unitAmount),
        stakeUnits: units(stakeC / unitAmount),
        returnAmount: money(settledReturnC),
        profit: money(profitC),
        selections,
      });
    }
  }
  return bets;
}

const BETS = buildBets();

// ─────────────────────────────────────────────────────────────────────────────
// Derivações — todo número exibido sai daqui
// ─────────────────────────────────────────────────────────────────────────────

const toC = (value) => cents(Number(value));
const betUnit = (bet) => cents(Number(bet.unitAmount ?? 0));

/**
 * `ReportMetrics` — o contrato que painel, relatório e splits compartilham.
 * Calculado de uma lista de apostas para que as três telas nunca discordem.
 */
export function metricsFor(bets) {
  const settled = bets.filter((b) => b.state === 'settled');
  const open = bets.filter((b) => b.state === 'open');
  const stakeC = bets.reduce((sum, b) => sum + toC(b.stake), 0);
  const closedC = settled.reduce((sum, b) => sum + toC(b.stake), 0);
  const returnsC = settled.reduce((sum, b) => sum + toC(b.returnAmount), 0);
  const profitC = returnsC - closedC;
  const profitUnits = settled.reduce((sum, b) => sum + toC(b.profit) / betUnit(b), 0);
  const missingUnitBets = bets.filter((b) => !b.unitAmount).length;
  // Void não conta como acerto nem como erro — é a definição de hit rate do produto.
  const eligible = settled.filter((b) => b.latestOutcome !== 'void');
  const wins = eligible.filter((b) => b.latestOutcome === 'win' || b.latestOutcome === 'half_win');
  return {
    bets: bets.length,
    settledBets: settled.length,
    openBets: open.length,
    realStake: money(stakeC),
    freebetStake: money(0),
    realPrincipalClosed: money(closedC),
    realReturns: money(returnsC),
    freebetReturns: money(0),
    realProfit: money(profitC),
    freebetProfit: money(0),
    profit: money(profitC),
    profitUnits: units(profitUnits),
    knownProfitUnits: units(missingUnitBets ? profitUnits : profitUnits),
    missingUnitBets,
    exposure: money(open.reduce((sum, b) => sum + toC(b.remaining ?? 0), 0)),
    roiReal: percent(profitC, closedC),
    yieldReal: percent(profitC, stakeC),
    hitRateReal: percent(wins.length, eligible.length),
    hitWinsReal: wins.length,
    hitEligibleReal: eligible.length,
  };
}

const FILTER_SEPT = {
  from: '2026-09-01',
  to: '2026-09-30',
  kind: 'all',
  includeEstimated: 'false',
};
const inFilter = (bet, filter) => {
  const day = saoPauloDate(bet.placedAt);
  return day >= filter.from && day <= filter.to;
};

export const REPORT_METRICS = metricsFor(BETS.filter((b) => inFilter(b, FILTER_SEPT)));

/**
 * Série diária do relatório. Cada ponto é o MESMO `ReportMetrics` de qualquer
 * outra tela, não um par profit/cumulative feito à mão: é o que impede o
 * relatório de contar uma história diferente da que o painel conta.
 */
function timelineFor(bets, filter) {
  const settled = bets.filter((b) => b.state === 'settled' && inFilter(b, filter));
  const byDay = new Map();
  for (const bet of settled) {
    const day = saoPauloDate(bet.placedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(bet);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayBets]) => ({ date, metrics: metricsFor(dayBets) }));
}

/** Agregação por dimensão, com as mesmas `ReportMetrics` por linha. */
function groupMetrics(bets, keyOf, labelOf) {
  const groups = new Map();
  for (const bet of bets) {
    const key = keyOf(bet) ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bet);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      label: labelOf(key, list),
      lowSample: list.length < 30,
      metrics: metricsFor(list),
    }))
    .sort((a, b) => b.metrics.bets - a.metrics.bets);
}

const ODDS_BANDS = [
  { id: '1.00-1.49', label: '1,00 a 1,49', test: (o) => o < 1.5 },
  { id: '1.50-1.99', label: '1,50 a 1,99', test: (o) => o >= 1.5 && o < 2 },
  { id: '2.00-2.49', label: '2,00 a 2,49', test: (o) => o >= 2 && o < 2.5 },
  { id: '2.50-3.99', label: '2,50 a 3,99', test: (o) => o >= 2.5 && o < 4 },
  { id: '4.00+', label: '4,00 ou mais', test: (o) => o >= 4 },
];
const WEEKDAYS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

/**
 * As 12 dimensões de `/api/v1/analytics/splits`.
 * Três delas (`team`, `player`, `live`) são `unavailable` de verdade: o modelo
 * atual não guarda esses dados. Deixá-las como fake seria pior que admitir a
 * lacuna — é a diferença que a revisão de design precisa enxergar.
 */
function splitsFixture(bets) {
  const metrics = metricsFor(bets);
  const dim = (id, label, source, rows, available = true, note = null) => ({
    id,
    label,
    source,
    available,
    note,
    rows,
  });
  const oddsBandKey = (bet) => ODDS_BANDS.find((b) => b.test(Number(bet.odds)))?.id;
  const weekdayKey = (bet) => WEEKDAYS[new Date(bet.placedAt).getUTCDay()];
  return {
    generatedAt: '2026-09-30T12:00:00.000Z',
    version: 1,
    filters: FILTER_SEPT,
    minSample: 30,
    lowSample: bets.length < 30,
    metrics,
    dimensions: [
      dim(
        'sport',
        'Esporte',
        'finance.selection.sport',
        groupMetrics(
          bets,
          (b) => b.selections[0]?.sport ?? null,
          (k) => k,
        ),
      ),
      dim(
        'market',
        'Mercado',
        'finance.selection.market',
        groupMetrics(
          bets,
          (b) => b.selections[0]?.market ?? null,
          (k) => k,
        ),
      ),
      dim(
        'ticketKind',
        'Tipo de aposta',
        'derived:finance.selection',
        groupMetrics(
          bets,
          (b) => b.ticketKind,
          (k) => TICKET_KIND_LABEL[k] ?? k,
        ),
      ),
      dim(
        'bookmaker',
        'Casa',
        'finance.bet.bookmaker_id',
        groupMetrics(
          bets,
          (b) => b.bookmakerId,
          (k) => bookmakerById.get(k) ?? 'Sem casa',
        ),
      ),
      dim(
        'tipster',
        'Tipster',
        'finance.bet.tipster_id',
        groupMetrics(
          bets,
          (b) => b.tipsterId,
          (k) => (k === 'none' ? 'Sem tipster' : (tipsterById.get(k) ?? k)),
        ),
      ),
      dim(
        'oddsBand',
        'Faixa de odd',
        'derived:finance.bet.odds',
        groupMetrics(bets, oddsBandKey, (k) => ODDS_BANDS.find((b) => b.id === k)?.label ?? k),
      ),
      dim(
        'weekday',
        'Dia da semana',
        'derived:finance.bet.placed_at',
        groupMetrics(bets, weekdayKey, (k) => k),
      ),
      dim(
        'hour',
        'Hora',
        'derived:finance.bet.placed_at',
        groupMetrics(
          bets,
          (b) => `${new Date(b.placedAt).getUTCHours()}`,
          (k) => `${k}:00–${k}:59`,
        ),
      ),
      dim(
        'tournament',
        'Liga/torneio',
        'integration.inbox.metadata.userOverrides.tournament',
        [{ key: 'unknown', label: 'Torneio a conferir', lowSample: true, metrics }],
        true,
        'Somente o torneio informado manualmente na importação.',
      ),
      dim(
        'team',
        'Time',
        'unavailable',
        [{ key: 'unknown', label: 'Sem base', lowSample: true, metrics }],
        false,
        'O modelo atual não guarda time.',
      ),
      dim(
        'player',
        'Jogador',
        'unavailable',
        [{ key: 'unknown', label: 'Sem base', lowSample: true, metrics }],
        false,
        'O modelo atual não guarda jogador.',
      ),
      dim(
        'live',
        'Live/pré-jogo',
        'unavailable',
        [{ key: 'unknown', label: 'Sem base', lowSample: true, metrics }],
        false,
        'O modelo atual não guarda se a aposta foi ao vivo.',
      ),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────────────────────

export const workspace = {
  version: 1,
  initialized: true,
  unitPercent: '1.00',
  bankroll: money(cents(5000)),
  available: money(cents(3180)),
  exposure: money(REPORT_METRICS.exposure ? toC(REPORT_METRICS.exposure) : 0),
  accounts: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      kind: 'reserve',
      name: 'Reserva',
      bookmakerId: null,
      balance: money(cents(2500)),
    },
    ...BOOKMAKERS.map((b, i) => ({
      id: `40000000-0000-4000-8000-0000000001${String(i + 10).padStart(2, '0')}`,
      kind: 'bookmaker',
      name: b.name,
      bookmakerId: b.id,
      balance: money(cents(180 + i * 37)),
    })),
  ],
  catalog: [
    ...BOOKMAKERS.map((b) => ({
      id: b.id,
      kind: 'bookmaker',
      name: b.name,
      aliases: [],
      active: true,
    })),
    ...TIPSTERS.map((t) => ({
      id: t.id,
      kind: 'tipster',
      name: t.name,
      aliases: [],
      active: true,
    })),
  ],
  units: MONTHS.map((u) => ({
    month: u.month,
    amount: money(u.amount),
    base: money(cents(5000)),
    percent: '1.00',
    source: 'manual',
  })),
  freebets: [],
  // Avisos: vazio de propósito. A primeira versão semeava `UNIT_PENDING` aqui e
  // a faixa "Não há unidade positiva para este mês" apareceu em TODAS as telas —
  // o preview estava anunciando uma pendência que ele mesmo não tinha, porque a
  // carteira tem as três unidades preenchidas.
  warnings: [],
};

export const bets = BETS;
export const betsSeptember = BETS.filter((b) => inFilter(b, FILTER_SEPT));

export const dashboard = {
  generatedAt: '2026-09-30T12:00:00.000Z',
  version: 1,
  filters: FILTER_SEPT,
  minSample: 30,
  lowSample: REPORT_METRICS.bets < 30,
  metrics: REPORT_METRICS,
};

export const report = {
  generatedAt: '2026-09-30T12:00:00.000Z',
  version: 1,
  filters: FILTER_SEPT,
  dateBasis: 'last_event_sao_paulo',
  granularity: 'day',
  metrics: REPORT_METRICS,
  previous: {
    from: '2026-08-02',
    to: '2026-08-31',
    metrics: metricsFor(BETS.filter((b) => inFilter(b, { from: '2026-08-02', to: '2026-08-31' }))),
  },
  exclusions: { unknownDateBets: 3, estimatedDateBets: 5 },
  timeline: timelineFor(BETS, FILTER_SEPT),
  byBookmaker: groupMetrics(
    betsSeptember,
    (b) => b.bookmakerId,
    (k) => bookmakerById.get(k) ?? 'Sem casa',
  ),
  byTipster: groupMetrics(
    betsSeptember,
    (b) => b.tipsterId,
    (k) => (k === 'unknown' ? 'Sem tipster' : (tipsterById.get(k) ?? k)),
  ),
  bySport: groupMetrics(
    betsSeptember,
    (b) => b.selections[0]?.sport ?? null,
    (k) => k,
  ),
};

export const splits = splitsFixture(betsSeptember);

/** Calendário: uma entrada por seleção com data, deduzindo a aposta que a contém. */
export const calendar = BETS.flatMap((bet) =>
  bet.selections
    .filter((selection) => selection.eventDate)
    .map((selection) => ({
      selection,
      betId: bet.id,
      betReference: bet.reference,
      bookmaker: bookmakerById.get(bet.bookmakerId) ?? 'Sem casa',
      betState: bet.state,
      // `dateSource` é o provedor real que confirmou a data — não um
      // genérico "external", que o contrato não aceita.
      dateSource: selection.dateStatus === 'confirmed' ? 'thesportsdb' : 'manual',
      dateEvidence: null,
      // O calendário acompanha o AGENDAMENTO do evento, não o resultado da
      // aposta: uma aposta liquidada cujo evento já rolled continua
      // "scheduled" do ponto de vista deste contrato.
      scheduleStatus: 'scheduled',
    })),
).sort((a, b) => (a.selection.eventDate < b.selection.eventDate ? -1 : 1));

/** Importações pendentes — os estados que a triagem precisa distinguir. */
const IMPORT_STATES = [
  { state: 'review', attempts: 1 },
  { state: 'review', attempts: 2 },
  { state: 'imported', attempts: 1 },
  { state: 'failed', attempts: 3, errorCode: 'IMAGE_UNREADABLE' },
  { state: 'processing', attempts: 1 },
  { state: 'discarded', attempts: 1 },
  { state: 'review', attempts: 1 },
  { state: 'imported', attempts: 1 },
  { state: 'pending', attempts: 2 },
];

export const imports = IMPORT_STATES.map((entry, index) => {
  const bookmaker = BOOKMAKERS[index % BOOKMAKERS.length];
  const event = EVENTS[index % EVENTS.length];
  const id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  const createdAt = `2026-09-${String(28 - index).padStart(2, '0')}T14:20:00Z`;
  return {
    item: {
      id,
      source: index % 3 === 0 ? 'telegram' : 'web',
      caption: `${pick(TIPSTERS).name}\n${bookmaker.name}\nreal`,
      state: entry.state,
      version: entry.attempts,
      attempts: entry.attempts,
      createdAt,
      updatedAt: createdAt,
      errorCode: entry.errorCode ?? null,
      betId: entry.state === 'confirmed' ? (BETS[index]?.id ?? null) : null,
      imageAvailable: true,
    },
    extraction: {
      reference: `BR-${4820 + index}`,
      placedAtText: 'hoje, 14h',
      currency: 'BRL',
      stake: (25 + index * 7.5).toFixed(2),
      odds: (1.6 + index * 0.15).toFixed(2),
      potentialReturn: (45 + index * 12).toFixed(2),
      freebet: null,
      selections: [
        {
          event: event.event,
          sport: event.sport,
          market: event.market,
          selection: event.pick,
          odds: null,
          eventDateText: 'amanhã',
        },
      ],
      warnings: index % 3 === 0 ? ['Confira a casa e as datas'] : [],
    },
    labels: {
      tipster: pick(TIPSTERS).name,
      bookmaker: bookmaker.name,
      requiresReview: entry.state === 'review',
    },
    betOrigin: null,
    freebetId: null,
    eventAt: null,
    eventDateStatus: index % 3 === 0 ? 'pending' : 'confirmed',
    telegramReceivedAt: index % 3 === 0 ? createdAt : null,
    bookmakerOverrideId: null,
    tipsterOverrideId: null,
    sportOverride: null,
    tournamentOverride: null,
    countryOverride: null,
    ticketKindOverride: null,
    stakeOverride: null,
    oddsOverride: null,
    selectionOverrides: [],
    bookmakers: BOOKMAKERS.map((b) => ({ id: b.id, name: b.name })),
    tipsters: TIPSTERS.map((t) => ({ id: t.id, name: t.name })),
    bet: null,
    automaticPolicy: 'disabled',
    credits: [],
    matches: {
      tipsterId: null,
      captionBookmakerId: bookmaker.id,
      extractedBookmakerId: null,
      conflict: index % 4 === 0,
    },
    duplicates:
      index % 3 === 0
        ? [
            {
              betId: BETS[index]?.id ?? null,
              reference: `BR-${4820 + index}`,
              bookmakerId: bookmaker.id,
              stake: (25 + index * 7.5).toFixed(2),
              placedAt: createdAt,
              // `reasons` é um enum do contrato — o que a triagem mostra é o rótulo
              // traduzido de cada código, não uma frase livre.
              reasons: ['reference', 'similar'],
            },
          ]
        : [],
    duplicateCount: index % 3 === 0 ? 1 : 0,
    automatic: false,
    automaticReason: 'LAYOUT_NOT_VALIDATED',
  };
});

export { BOOKMAKERS, TIPSTERS, saoPauloDate };
