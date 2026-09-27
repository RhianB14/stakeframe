import { describe, expect, it } from 'vitest';
import type { Bet } from '../../packages/shared/src/index.js';
import {
  betResultLabel,
  betResultQualifier,
  betTableColumns,
  betTablePresentation,
  sortBetRows,
  type BetTableRow,
} from '../../packages/shared/src/index.js';

const baseBet = (overrides: Partial<Bet> = {}): Bet => ({
  id: '10000000-0000-4000-8000-000000000004',
  ticketNumber: 12,
  bookmakerId: null,
  tipsterId: null,
  stake: '25.00',
  odds: '2.00',
  placedAt: '2026-09-01T18:00:00Z',
  createdAt: '2026-09-01T18:00:00Z',
  freebetId: null,
  freebetStakeReturned: null,
  reference: null,
  state: 'open',
  ticketKind: 'simple',
  latestOutcome: null,
  remaining: '25.00',
  completionState: 'complete',
  unitMonth: '2026-09',
  unitAmount: '10.00',
  stakeUnits: '2.500000',
  returnAmount: '0.00',
  profit: '0.00',
  selections: [
    {
      event: 'Corinthians x Palmeiras',
      sport: 'Futebol',
      market: 'Resultado final',
      selection: 'Corinthians',
      odds: null,
      eventDate: '2026-09-25',
      eventAt: '2026-09-25T23:30:00Z',
      dateStatus: 'confirmed',
    },
  ],
  ...overrides,
});

const row = (overrides: Partial<Bet> = {}, extras: Partial<BetTableRow> = {}): BetTableRow => {
  const bet = baseBet(overrides);
  return {
    bet,
    details: betTablePresentation(bet),
    result: betResultLabel(bet),
    tipster: '—',
    bookmaker: 'Bet365',
    ...extras,
  };
};

describe('bets table presentation', () => {
  it('shows the game date and local kickoff time, not the bet placement timestamp', () => {
    expect(betTablePresentation(baseBet())).toMatchObject({
      gameDate: '25/09/2026',
      gameTime: '20:30',
      event: 'Corinthians x Palmeiras',
      selection: 'Corinthians',
      market: 'Resultado final',
      ticketKind: 'Simples',
      potentialReturn: '50.00',
    });
  });

  it('labels multiple tickets as Múltipla in both market and ticket type', () => {
    const bet = baseBet({
      ticketKind: 'multiple',
      selections: [
        ...baseBet().selections,
        {
          event: 'Flamengo x Santos',
          sport: 'Futebol',
          market: 'Mais de 2,5 gols',
          selection: 'Mais de 2,5',
          odds: null,
          eventDate: '2026-09-26',
          eventAt: '2026-09-27T00:00:00Z',
          dateStatus: 'confirmed',
        },
      ],
    });

    expect(betTablePresentation(bet)).toMatchObject({
      event: 'Corinthians x Palmeiras + Flamengo x Santos',
      selection: 'Corinthians + Mais de 2,5',
      market: 'Múltipla',
      ticketKind: 'Múltipla',
      gameDate: 'Vários jogos/horários',
      gameTime: '—',
    });
  });

  it('deduplicates the shared event in BetBuild and shows the approved labels', () => {
    const first = baseBet().selections[0]!;
    const bet = baseBet({
      ticketKind: 'betbuild',
      selections: [first, { ...first, market: 'Total de gols', selection: 'Mais de 1,5' }],
    });

    expect(betTablePresentation(bet)).toMatchObject({
      event: 'Corinthians x Palmeiras',
      selection: 'Corinthians + Mais de 1,5',
      market: 'BetBuild',
      ticketKind: 'BetBuild',
      gameDate: '25/09/2026',
      gameTime: '20:30',
    });
  });

  it('preserves repeated selection text when each selection is a separate BetBuild leg', () => {
    const selection = baseBet().selections[0]!;
    const bet = baseBet({
      ticketKind: 'betbuild',
      selections: [selection, { ...selection, market: 'Total de gols' }],
    });

    expect(betTablePresentation(bet).selection).toBe('Corinthians + Corinthians');
  });

  it('does not replace a missing or partially known game schedule with the bet date', () => {
    const bet = baseBet({
      selections: [
        { ...baseBet().selections[0]!, eventAt: null, eventDate: null, dateStatus: 'pending' },
        {
          ...baseBet().selections[0]!,
          event: 'Flamengo x Santos',
          eventAt: '2026-09-27T00:00:00Z',
          eventDate: '2026-09-26',
          dateStatus: 'confirmed',
        },
      ],
    });

    expect(betTablePresentation(bet)).toMatchObject({
      gameDate: 'Algumas pendentes',
      gameTime: 'Alguns pendentes',
    });
  });

  it('calculates potential return using the registered real/freebet/hybrid origin', () => {
    const hybrid = baseBet({ freebetId: '10000000-0000-4000-8000-000000000009' });
    const freebet = baseBet({
      stake: '10.00',
      odds: '2.00',
      freebetId: '10000000-0000-4000-8000-000000000009',
    });

    expect(betTablePresentation(baseBet()).potentialReturn).toBe('50.00');
    expect(betTablePresentation(hybrid, '10.00').potentialReturn).toBe('60.00');
    expect(betTablePresentation(freebet, '10.00').potentialReturn).toBe('10.00');
    expect(betTablePresentation(hybrid).potentialReturn).toBeNull();
  });

  it.each([
    ['win', 'Ganha'],
    ['loss', 'Perdida'],
    ['void', 'Reembolso'],
    ['half_win', 'Meio-Ganha'],
    ['half_loss', 'Meio-Perdida'],
    ['cashout', 'Cashout'],
    ['partial_cashout', 'Cashout parcial'],
  ] as const)('maps outcome %s to %s', (latestOutcome, label) => {
    expect(betResultLabel({ state: 'settled', latestOutcome })).toBe(label);
  });

  it('keeps a partial cashout explicitly open and gives pending/cancelled labels', () => {
    const partial = { state: 'open' as const, latestOutcome: 'partial_cashout' as const };
    expect(betResultLabel(partial)).toBe('Cashout parcial');
    expect(betResultQualifier(partial)).toBe('Ainda em aberto');
    expect(betResultLabel({ state: 'open', latestOutcome: null })).toBe('Pendente');
    expect(betResultLabel({ state: 'cancelled', latestOutcome: null })).toBe('Cancelada');
  });
});

describe('bets table columns and sorting', () => {
  it('exposes the approved 14-column order', () => {
    expect(betTableColumns.map((column) => column.label)).toEqual([
      'Nº do bilhete',
      'Data do jogo',
      'Hora do jogo',
      'Evento',
      'Aposta/seleção',
      'Mercado',
      'Tipo da aposta',
      'Tipster',
      'Casa de aposta',
      'Valor apostado',
      'Odd',
      'Retorno recebido',
      'Resultado/status',
      'ID técnico da aposta',
    ]);
  });

  it('sorts by ticket number in both directions', () => {
    const rows = [row({ ticketNumber: 3 }), row({ ticketNumber: 1 }), row({ ticketNumber: 2 })];
    expect(sortBetRows(rows, 'ticket', 'ascending').map((item) => item.bet.ticketNumber)).toEqual([
      1, 2, 3,
    ]);
    expect(sortBetRows(rows, 'ticket', 'descending').map((item) => item.bet.ticketNumber)).toEqual([
      3, 2, 1,
    ]);
  });

  it('sorts numeric columns by value and keeps undefined values last', () => {
    const rows = [
      row({ ticketNumber: 1, stake: null }),
      row({ ticketNumber: 2, stake: '50.00' }),
      row({ ticketNumber: 3, stake: '300.00' }),
    ];
    expect(sortBetRows(rows, 'stake', 'ascending').map((item) => item.bet.ticketNumber)).toEqual([
      2, 3, 1,
    ]);
    expect(sortBetRows(rows, 'stake', 'descending').map((item) => item.bet.ticketNumber)).toEqual([
      3, 2, 1,
    ]);
  });

  it('sorts by the earliest game schedule and keeps pending dates last', () => {
    const early = baseBet().selections[0]!;
    const later = {
      ...early,
      event: 'Flamengo x Santos',
      eventDate: '2026-09-30',
      eventAt: '2026-09-30T20:00:00Z',
    };
    const rows = [
      row({
        ticketNumber: 1,
        selections: [{ ...early, eventAt: null, eventDate: null, dateStatus: 'pending' }],
      }),
      row({ ticketNumber: 2, selections: [later] }),
      row({ ticketNumber: 3, selections: [early] }),
    ];
    expect(sortBetRows(rows, 'gameDate', 'ascending').map((item) => item.bet.ticketNumber)).toEqual(
      [3, 2, 1],
    );
    expect(
      sortBetRows(rows, 'gameDate', 'descending').map((item) => item.bet.ticketNumber),
    ).toEqual([2, 3, 1]);
  });

  it('sorts text columns accent-insensitively', () => {
    const base = baseBet().selections[0]!;
    const rows = [
      row({ ticketNumber: 1, selections: [{ ...base, event: 'Água x Fogo' }] }),
      row({ ticketNumber: 2, selections: [{ ...base, event: 'Zebra x Leão' }] }),
    ];
    expect(sortBetRows(rows, 'event', 'ascending').map((item) => item.bet.ticketNumber)).toEqual([
      1, 2,
    ]);
  });

  it('sorts by the canonical result label', () => {
    const rows = [
      row({ ticketNumber: 1, state: 'settled', latestOutcome: 'win' }),
      row({ ticketNumber: 2, state: 'open', latestOutcome: null }),
      row({ ticketNumber: 3, state: 'settled', latestOutcome: 'loss' }),
    ];
    expect(sortBetRows(rows, 'result', 'ascending').map((item) => item.bet.ticketNumber)).toEqual([
      1, 2, 3,
    ]);
  });
});
