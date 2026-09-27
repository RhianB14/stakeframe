import { deriveBetOrigin, potentialReturnFor } from './returns.js';
import { saoPauloDate } from './decimal.js';
import type { Bet } from './finance.js';

/**
 * Canonical presentation of a bet's list columns (STK-BETS-02 semantics, owner-approved):
 * game date/time come from the selections (never `placedAt`/`createdAt`), the market falls
 * back to the ticket kind for non-simple tickets, and the result uses the canonical outcome
 * labels. Shared by the product UI and by the account export so both always agree.
 */

const kindLabels: Record<Bet['ticketKind'], string> = {
  simple: 'Simples',
  multiple: 'Múltipla',
  betbuild: 'BetBuild',
};

const resultLabels: Record<NonNullable<Bet['latestOutcome']>, string> = {
  win: 'Ganha',
  loss: 'Perdida',
  void: 'Reembolso',
  half_win: 'Meio-Ganha',
  half_loss: 'Meio-Perdida',
  cashout: 'Cashout',
  partial_cashout: 'Cashout parcial',
};

/** Colunas da tabela de apostas, na ordem aprovada pelo proprietário. */
export const betTableColumns = [
  { key: 'ticket', label: 'Nº do bilhete' },
  { key: 'gameDate', label: 'Data do jogo' },
  { key: 'gameTime', label: 'Hora do jogo' },
  { key: 'event', label: 'Evento' },
  { key: 'selection', label: 'Aposta/seleção' },
  { key: 'market', label: 'Mercado' },
  { key: 'ticketKind', label: 'Tipo da aposta' },
  { key: 'tipster', label: 'Tipster' },
  { key: 'bookmaker', label: 'Casa de aposta' },
  { key: 'stake', label: 'Valor apostado' },
  { key: 'odds', label: 'Odd' },
  { key: 'return', label: 'Retorno recebido' },
  { key: 'result', label: 'Resultado/status' },
  { key: 'id', label: 'ID técnico da aposta' },
] as const;

export type BetTableColumnKey = (typeof betTableColumns)[number]['key'];
export type BetTableSortDirection = 'ascending' | 'descending';

/** Rótulo para seleções em jogos/horários distintos; nunca inventa um horário. */
const MULTIPLE_SCHEDULES_LABEL = 'Vários jogos/horários';

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const unique = (values: string[]) => {
  const result: string[] = [];
  const keys = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const key = normalize(value);
    if (key && !keys.has(key)) {
      keys.add(key);
      result.push(value);
    }
  }
  return result;
};

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function eventSchedule(selection: Bet['selections'][number]) {
  if (selection.dateStatus === 'pending') return null;
  if (selection.eventAt) {
    const instant = new Date(selection.eventAt);
    if (Number.isNaN(instant.valueOf())) return null;
    return { date: dateFormatter.format(instant), time: timeFormatter.format(instant) };
  }
  if (selection.eventDate) {
    const [year, month, day] = selection.eventDate.split('-');
    return { date: `${day}/${month}/${year}`, time: null };
  }
  return null;
}

function uniqueEvents(bet: Bet) {
  const events = unique(bet.selections.map((selection) => selection.event ?? ''));
  if (events.length) return events;
  if (bet.selections.length > 1) return ['Vários eventos'];
  return ['Evento não informado'];
}

function scheduleLabels(bet: Bet) {
  const schedules = new Set<string>();
  const dates = new Set<string>();
  const times = new Set<string>();
  let missing = false;
  bet.selections.forEach((selection) => {
    const schedule = eventSchedule(selection);
    if (!schedule) {
      missing = true;
      return;
    }
    dates.add(schedule.date);
    if (schedule.time) times.add(schedule.time);
    schedules.add(`${schedule.date}|${schedule.time ?? ''}`);
  });

  if (!bet.selections.length) return { date: 'Pendente', time: 'Pendente', qualifier: '' };

  const qualifier = bet.selections.some((selection) => selection.dateStatus === 'estimated')
    ? 'Há data estimada'
    : '';

  // Seleções em jogos/horários diferentes não podem exibir um único horário: o
  // detalhe/expansão lista cada seleção com o próprio evento, data e hora.
  if (schedules.size > 1) {
    return { date: MULTIPLE_SCHEDULES_LABEL, time: '—', qualifier };
  }

  const date = dates.size === 0 ? 'Pendente' : missing ? 'Algumas pendentes' : [...dates][0]!;
  const time = times.size === 0 ? 'Pendente' : missing ? 'Alguns pendentes' : [...times][0]!;
  return { date, time, qualifier };
}

export function betTablePresentation(bet: Bet, freebetAmount: string | null = null) {
  const events = uniqueEvents(bet);
  const selections = bet.selections.map((selection) => selection.selection.trim()).filter(Boolean);
  const markets = unique(bet.selections.map((selection) => selection.market));
  const schedule = scheduleLabels(bet);
  const potentialReturn =
    bet.stake !== null && bet.odds !== null && (bet.freebetId === null || freebetAmount !== null)
      ? potentialReturnFor(
          deriveBetOrigin(bet.stake, freebetAmount),
          bet.stake,
          bet.odds,
          freebetAmount,
        )
      : null;
  return {
    event: events.join(' + '),
    selection: selections.join(' + ') || 'Aposta não informada',
    market:
      bet.ticketKind === 'simple'
        ? markets.join(' + ') || 'Não informado'
        : kindLabels[bet.ticketKind],
    ticketKind: kindLabels[bet.ticketKind],
    gameDate: schedule.date,
    gameTime: schedule.time,
    scheduleQualifier: schedule.qualifier,
    potentialReturn,
  };
}

export function betResultLabel(bet: Pick<Bet, 'state' | 'latestOutcome'>) {
  if (bet.state === 'cancelled') return 'Cancelada';
  if (bet.latestOutcome) return resultLabels[bet.latestOutcome];
  return bet.state === 'settled' ? 'Liquidada' : 'Pendente';
}

export function betResultQualifier(bet: Pick<Bet, 'state' | 'latestOutcome'>) {
  return bet.state === 'open' && bet.latestOutcome === 'partial_cashout' ? 'Ainda em aberto' : '';
}

/** Linha já resolvida da tabela: aposta + apresentação + nomes de catálogo. */
export type BetTableRow = {
  bet: Bet;
  details: ReturnType<typeof betTablePresentation>;
  result: string;
  tipster: string;
  bookmaker: string;
};

type SortableValue = { missing: boolean; value: string | number };

const missingValue: SortableValue = { missing: true, value: '' };

const kindOrder: Record<Bet['ticketKind'], number> = { simple: 0, multiple: 1, betbuild: 2 };

function textValue(value: string): SortableValue {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '—') return missingValue;
  return { missing: false, value: normalize(trimmed) };
}

/** Primeiro jogo conhecido do bilhete (menor data; seleção sem hora vai ao fim do dia). */
function firstKnownSchedule(bet: Bet) {
  let best: { date: string; minute: number | null } | null = null;
  for (const selection of bet.selections) {
    if (selection.dateStatus === 'pending') continue;
    let candidate: { date: string; minute: number | null } | null = null;
    if (selection.eventAt) {
      const instant = new Date(selection.eventAt);
      if (!Number.isNaN(instant.valueOf())) {
        const [hour, minute] = timeFormatter.format(instant).split(':').map(Number);
        candidate = { date: saoPauloDate(instant), minute: (hour ?? 0) * 60 + (minute ?? 0) };
      }
    } else if (selection.eventDate) {
      candidate = { date: selection.eventDate, minute: null };
    }
    if (!candidate) continue;
    const afterBest =
      best !== null &&
      (candidate.date > best.date ||
        (candidate.date === best.date &&
          (candidate.minute ?? 24 * 60) >= (best.minute ?? 24 * 60)));
    if (!afterBest) best = candidate;
  }
  return best;
}

function sortValue(row: BetTableRow, column: BetTableColumnKey): SortableValue {
  const { bet } = row;
  switch (column) {
    case 'ticket':
      return { missing: false, value: bet.ticketNumber };
    case 'gameDate': {
      const schedule = firstKnownSchedule(bet);
      return schedule ? { missing: false, value: schedule.date } : missingValue;
    }
    case 'gameTime': {
      const schedule = firstKnownSchedule(bet);
      return schedule && schedule.minute !== null
        ? { missing: false, value: schedule.minute }
        : missingValue;
    }
    case 'event':
      return textValue(row.details.event);
    case 'selection':
      return textValue(row.details.selection);
    case 'market':
      return textValue(row.details.market);
    case 'ticketKind':
      return { missing: false, value: kindOrder[bet.ticketKind] };
    case 'tipster':
      return textValue(row.tipster);
    case 'bookmaker':
      return textValue(row.bookmaker);
    case 'stake':
      return bet.stake === null ? missingValue : { missing: false, value: Number(bet.stake) };
    case 'odds':
      return bet.odds === null ? missingValue : { missing: false, value: Number(bet.odds) };
    case 'return':
      return { missing: false, value: Number(bet.returnAmount) };
    case 'result':
      return textValue(row.result);
    case 'id':
      return { missing: false, value: bet.id };
  }
}

function compareValues(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const a = String(left);
  const b = String(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Ordena as linhas exibidas na página atual. A ordenação é local (nenhuma
 * chamada nova de API); registros sem o dado (data pendente, valor a definir,
 * catálogo ausente) ficam no fim em qualquer direção.
 */
export function sortBetRows(
  rows: BetTableRow[],
  column: BetTableColumnKey,
  direction: BetTableSortDirection,
): BetTableRow[] {
  const factor = direction === 'ascending' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValue(left, column);
    const b = sortValue(right, column);
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    return compareValues(a.value, b.value) * factor;
  });
}
