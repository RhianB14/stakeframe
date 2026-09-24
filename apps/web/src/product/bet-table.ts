import { deriveBetOrigin, potentialReturnFor, type Bet } from '@stakeframe/shared';

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
  const groups = new Map<
    string,
    { schedules: Set<string>; dates: Set<string>; times: Set<string>; missing: boolean }
  >();
  bet.selections.forEach((selection, index) => {
    const eventKey = normalize(selection.event ?? '') || `selection-${index}`;
    const group = groups.get(eventKey) ?? {
      schedules: new Set<string>(),
      dates: new Set<string>(),
      times: new Set<string>(),
      missing: false,
    };
    const schedule = eventSchedule(selection);
    if (!schedule) group.missing = true;
    else {
      group.dates.add(schedule.date);
      if (schedule.time) group.times.add(schedule.time);
      group.schedules.add(`${schedule.date}|${schedule.time ?? ''}`);
    }
    groups.set(eventKey, group);
  });

  if (!groups.size) return { date: 'Pendente', time: 'Pendente', qualifier: '' };
  const values = [...groups.values()];
  const dates = new Set(values.flatMap((group) => [...group.dates]));
  const times = new Set(values.flatMap((group) => [...group.times]));
  const hasMissingDate = values.some((group) => group.missing || group.dates.size === 0);
  const hasMissingTime = values.some(
    (group) => group.missing || group.times.size === 0 || group.schedules.size > 1,
  );

  const date =
    dates.size > 1
      ? 'Várias datas'
      : hasMissingDate
        ? dates.size > 0
          ? 'Algumas pendentes'
          : 'Pendente'
        : [...dates][0]!;
  const time =
    times.size > 1
      ? 'Vários horários'
      : hasMissingTime
        ? times.size > 0
          ? 'Alguns pendentes'
          : 'Pendente'
        : [...times][0]!;
  const qualifier = bet.selections.some((selection) => selection.dateStatus === 'estimated')
    ? 'Há data estimada'
    : '';
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
