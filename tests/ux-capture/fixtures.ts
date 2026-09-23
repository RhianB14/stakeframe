// Fixtures sintéticas para a auditoria visual STK-UX-01/02.
// Nenhum dado real: valores, casas, tipsters e eventos são inventados.
// Telegram e provedores externos permanecem fora deste escopo.
import type {
  PerformanceReport,
  ReportMetrics,
  Workspace,
  Bet,
  ImportDetail,
} from '../../packages/shared/src/index.js';
import { saoPauloDate } from '../../packages/shared/src/index.js';

export const house = '10000000-0000-4000-8000-000000000001';
export const house2 = '10000000-0000-4000-8000-00000000000b';
export const house3 = '10000000-0000-4000-8000-00000000000c';
export const reserve = '10000000-0000-4000-8000-000000000002';
export const houseAccount = '10000000-0000-4000-8000-000000000003';
export const house2Account = '10000000-0000-4000-8000-00000000000d';
export const betId = '10000000-0000-4000-8000-000000000004';
export const betId2 = '10000000-0000-4000-8000-00000000000e';
export const betId3 = '10000000-0000-4000-8000-00000000000f';
export const betId4 = '10000000-0000-4000-8000-000000000010';
export const freebetId = '10000000-0000-4000-8000-000000000009';
export const importId = '10000000-0000-4000-8000-000000000005';

const metrics = (over: Partial<ReportMetrics> = {}): ReportMetrics => ({
  bets: 42,
  settledBets: 35,
  openBets: 7,
  realStake: '4820.00',
  freebetStake: '310.00',
  realPrincipalClosed: '4110.00',
  realReturns: '5236.40',
  freebetReturns: '612.00',
  realProfit: '426.40',
  freebetProfit: '302.00',
  profit: '728.40',
  profitUnits: '14.568000',
  knownProfitUnits: '14.568000',
  missingUnitBets: 0,
  exposure: '710.00',
  roiReal: '10.37',
  hitRateReal: '57.14',
  hitWinsReal: 20,
  hitEligibleReal: 35,
  ...over,
});

const empty = (bets = 0): ReportMetrics =>
  metrics({
    bets,
    settledBets: 0,
    openBets: 0,
    realStake: '0.00',
    freebetStake: '0.00',
    realPrincipalClosed: '0.00',
    realReturns: '0.00',
    freebetReturns: '0.00',
    realProfit: '0.00',
    freebetProfit: '0.00',
    profit: '0.00',
    profitUnits: '0.000000',
    knownProfitUnits: '0.000000',
    exposure: '0.00',
    roiReal: null,
    hitRateReal: null,
    hitWinsReal: 0,
    hitEligibleReal: 0,
  });

export function richReport(): PerformanceReport {
  const days = [
    ['2026-09-01', 3, '180.00', '96.00', '-84.00'],
    ['2026-09-02', 2, '240.00', '486.00', '246.00'],
    ['2026-09-03', 1, '60.00', '0.00', '-60.00'],
    ['2026-09-04', 4, '520.00', '742.00', '222.00'],
    ['2026-09-05', 2, '150.00', '315.00', '165.00'],
    ['2026-09-06', 3, '410.00', '180.00', '-230.00'],
    ['2026-09-07', 2, '275.00', '618.00', '343.00'],
    ['2026-09-08', 1, '90.00', '0.00', '-90.00'],
    ['2026-09-09', 3, '330.00', '451.20', '121.20'],
    ['2026-09-10', 2, '260.00', '0.00', '-260.00'],
    ['2026-09-11', 4, '585.00', '1024.00', '439.00'],
    ['2026-09-12', 2, '200.00', '410.00', '210.00'],
    ['2026-09-13', 3, '370.00', '150.00', '-220.00'],
    ['2026-09-14', 2, '245.00', '532.40', '287.40'],
    ['2026-09-15', 1, '120.00', '0.00', '-120.00'],
    ['2026-09-16', 2, '185.00', '396.00', '211.00'],
    ['2026-09-17', 3, '290.00', '420.00', '130.00'],
    ['2026-09-18', 2, '330.00', '0.00', '-330.00'],
    ['2026-09-19', 1, '75.00', '162.00', '87.00'],
    ['2026-09-20', 2, '240.00', '0.00', '-240.00'],
  ] as const;
  return {
    generatedAt: '2026-09-23T12:00:00Z',
    version: 7,
    filters: { from: '2026-09-01', to: '2026-09-30', kind: 'all', includeEstimated: 'false' },
    dateBasis: 'last_event_sao_paulo',
    granularity: 'day',
    metrics: metrics(),
    previous: { from: '2026-08-02', to: '2026-08-31', metrics: empty() },
    exclusions: { unknownDateBets: 2, estimatedDateBets: 1 },
    timeline: days.map(([date, bets, stake, ret, profit]) => ({
      date,
      metrics: metrics({
        bets,
        realStake: stake,
        realReturns: ret,
        realProfit: profit,
        profit,
        settledBets: bets,
        openBets: 0,
      }),
    })),
    byBookmaker: [
      { key: house, label: 'Bet365', metrics: metrics({ bets: 21 }) },
      { key: house2, label: 'Sportingbet', metrics: metrics({ bets: 13 }) },
      { key: house3, label: 'Betano', metrics: metrics({ bets: 8 }) },
    ],
    byTipster: [
      {
        key: '10000000-0000-4000-8000-00000000000a',
        label: 'Analista',
        metrics: metrics({ bets: 26 }),
      },
      { key: 'ninguem', label: 'Sem tipster', metrics: metrics({ bets: 16 }) },
    ],
    bySport: [
      { key: 'futebol', label: 'Futebol', metrics: metrics({ bets: 31 }) },
      { key: 'basquete', label: 'Basquete', metrics: metrics({ bets: 7 }) },
      { key: 'tenis', label: 'Tênis', metrics: metrics({ bets: 4 }) },
    ],
  };
}

export function richWorkspace(): Workspace {
  return {
    version: 7,
    initialized: true,
    unitPercent: '1.00',
    bankroll: '2480.00',
    available: '1770.00',
    exposure: '710.00',
    accounts: [
      { id: reserve, kind: 'reserve', name: 'Reserva', bookmakerId: null, balance: '980.00' },
      {
        id: houseAccount,
        kind: 'bookmaker',
        name: 'Bet365',
        bookmakerId: house,
        balance: '540.00',
      },
      {
        id: house2Account,
        kind: 'bookmaker',
        name: 'Sportingbet',
        bookmakerId: house2,
        balance: '250.00',
      },
    ],
    catalog: [
      { id: house, kind: 'bookmaker', name: 'Bet365', aliases: ['bet 365'], active: true },
      {
        id: house2,
        kind: 'bookmaker',
        name: 'Sportingbet',
        aliases: ['sporting'],
        active: true,
      },
      { id: house3, kind: 'bookmaker', name: 'Betano', aliases: [], active: true },
    ],
    units: [
      {
        month: saoPauloDate(new Date()).slice(0, 7),
        amount: '24.80',
        base: '2480.00',
        percent: '1.00',
        source: 'initial',
      },
    ],
    freebets: [
      {
        id: freebetId,
        bookmakerId: house,
        amount: '40.00',
        expiresOn: '2026-12-31',
        stakeReturned: false,
        usedBy: null,
        note: 'Boas-vindas',
      },
    ],
    warnings: [],
  };
}

export function richBets(): Bet[] {
  return [
    {
      id: betId,
      ticketNumber: 42,
      bookmakerId: house,
      tipsterId: null,
      stake: '100.00',
      odds: '2.00',
      placedAt: '2026-09-20T18:00:00Z',
      createdAt: '2026-09-20T18:00:00Z',
      freebetId: null,
      freebetStakeReturned: null,
      reference: 'BIL-4821',
      completionState: 'complete',
      state: 'open',
      remaining: '100.00',
      unitMonth: '2026-09',
      unitAmount: '24.80',
      stakeUnits: '4.032258',
      returnAmount: '0.00',
      profit: '0.00',
      selections: [
        {
          event: 'Aurora × Central',
          sport: 'Futebol',
          market: 'Gols',
          selection: 'Mais de 2,5',
          odds: '2.00',
          eventDate: '2026-09-21',
          eventAt: '2026-09-21T20:00:00Z',
          dateStatus: 'confirmed',
        },
      ],
    },
    {
      id: betId2,
      ticketNumber: 41,
      bookmakerId: house2,
      tipsterId: '10000000-0000-4000-8000-00000000000a',
      stake: '80.00',
      odds: '1.85',
      placedAt: '2026-09-19T15:30:00Z',
      createdAt: '2026-09-19T15:30:00Z',
      freebetId: null,
      freebetStakeReturned: null,
      reference: 'BIL-4820',
      completionState: 'complete',
      state: 'settled',
      remaining: '0.00',
      unitMonth: '2026-09',
      unitAmount: '24.80',
      stakeUnits: '3.225806',
      returnAmount: '148.00',
      profit: '68.00',
      selections: [
        {
          event: 'Vila Nova × Remo',
          sport: 'Futebol',
          market: 'Resultado final',
          selection: 'Vila Nova',
          odds: '1.85',
          eventDate: '2026-09-20',
          eventAt: '2026-09-20T19:00:00Z',
          dateStatus: 'confirmed',
        },
      ],
    },
    {
      id: betId3,
      ticketNumber: 40,
      bookmakerId: house3,
      tipsterId: null,
      stake: '40.00',
      odds: '3.10',
      placedAt: '2026-09-18T21:00:00Z',
      createdAt: '2026-09-18T21:00:00Z',
      freebetId,
      freebetStakeReturned: false,
      reference: 'BIL-4819',
      completionState: 'complete',
      state: 'settled',
      remaining: '0.00',
      unitMonth: '2026-09',
      unitAmount: '24.80',
      stakeUnits: '0.000000',
      returnAmount: '0.00',
      profit: '-40.00',
      selections: [
        {
          event: 'Grêmio × Bahia',
          sport: 'Futebol',
          market: 'Ambas marcam',
          selection: 'Sim',
          odds: '3.10',
          eventDate: '2026-09-19',
          eventAt: '2026-09-19T22:30:00Z',
          dateStatus: 'confirmed',
        },
      ],
    },
    {
      id: betId4,
      ticketNumber: 39,
      bookmakerId: house,
      tipsterId: null,
      stake: '25.50',
      odds: '2.10',
      placedAt: '2026-09-17T14:00:00Z',
      createdAt: '2026-09-17T14:00:00Z',
      freebetId: null,
      freebetStakeReturned: null,
      reference: '',
      completionState: 'incomplete',
      state: 'open',
      remaining: '25.50',
      unitMonth: '2026-09',
      unitAmount: '24.80',
      stakeUnits: '1.028226',
      returnAmount: '0.00',
      profit: '0.00',
      selections: [
        {
          event: 'Palmeiras × São Paulo',
          sport: 'Futebol',
          market: 'Gols',
          selection: 'Mais de 1,5',
          odds: null,
          eventDate: null,
          eventAt: null,
          dateStatus: 'pending',
        },
      ],
    },
  ];
}

// Detalhe de importação para o fluxo de edição no Mini App.
export function miniAppImport(): ImportDetail {
  return {
    item: {
      id: importId,
      source: 'telegram',
      caption: 'Analista\nBet365\nreal',
      state: 'review',
      version: 2,
      attempts: 1,
      createdAt: '2026-09-22T18:00:00Z',
      updatedAt: '2026-09-22T18:00:01Z',
      errorCode: null,
      betId: null,
      imageAvailable: false,
    },
    extraction: {
      reference: 'BILHETE-FICTICIO',
      placedAtText: 'ontem, 15h',
      currency: null,
      stake: '25.50',
      odds: '2.10',
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'Aurora × Central',
          sport: 'Futebol',
          market: 'Gols',
          selection: 'Mais de 2,5',
          odds: null,
          eventDateText: 'amanhã',
        },
      ],
      warnings: ['Confira a casa e as datas'],
    },
    labels: { tipster: 'Analista', bookmaker: 'Bet365', requiresReview: false },
    betOrigin: 'real',
    freebetId: null,
    eventAt: '2026-09-23T20:00:00Z',
    eventDateStatus: 'confirmed',
    telegramReceivedAt: '2026-09-22T18:00:02Z',
    bookmakerOverrideId: house,
    tipsterOverrideId: null,
    sportOverride: 'Futebol',
    tournamentOverride: 'Brasileirão',
    countryOverride: 'Brasil',
    ticketKindOverride: null,
    stakeOverride: null,
    oddsOverride: null,
    selectionOverrides: [],
    bookmakers: [
      { id: house, name: 'Bet365' },
      { id: house2, name: 'Sportingbet' },
      { id: house3, name: 'Betano' },
    ],
    tipsters: [{ id: '10000000-0000-4000-8000-00000000000a', name: 'Analista' }],
    bet: null,
    automaticPolicy: 'disabled',
    credits: [],
    matches: {
      tipsterId: '10000000-0000-4000-8000-00000000000a',
      captionBookmakerId: house,
      extractedBookmakerId: house,
      conflict: false,
    },
    duplicates: [],
    duplicateCount: 0,
    automatic: false,
    automaticReason: 'LAYOUT_NOT_VALIDATED',
  };
}
