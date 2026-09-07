const MAX_CENTS = 99_999_999_999_999n;

export function cents(value: string): bigint {
  if (!/^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) throw new Error('INVALID_MONEY');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > MAX_CENTS) throw new Error('MONEY_OUT_OF_RANGE');
  return negative ? -result : result;
}

export function money(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  if (absolute > MAX_CENTS) throw new Error('MONEY_OUT_OF_RANGE');
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

export function oddsInteger(value: string): bigint {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/.test(value)) throw new Error('INVALID_ODDS');
  const [whole = '0', fraction = ''] = value.split('.');
  const result = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (result < 10_000n || result > 1_000_000_000n) throw new Error('INVALID_ODDS');
  return result;
}

// Half-up is explicit, including negative corrections; no binary floating-point money.
export function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_DENOMINATOR');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator * sign;
  return sign * ((absolute + denominator / 2n) / denominator);
}

export type StandardOutcome = 'win' | 'loss' | 'void' | 'half_win' | 'half_loss';
export function suggestedReturn(
  stake: string,
  odds: string,
  outcome: StandardOutcome,
  freebet = false,
  promotionalStakeReturned = false,
): string {
  const principal = cents(stake);
  if (principal <= 0n) throw new Error('INVALID_STAKE');
  const price = oddsInteger(odds);
  const winning = principal * (price - (freebet && !promotionalStakeReturned ? 10_000n : 0n));
  const refund = freebet ? 0n : principal * 10_000n;
  const numerator =
    outcome === 'win'
      ? winning
      : outcome === 'loss'
        ? 0n
        : outcome === 'void'
          ? refund
          : outcome === 'half_win'
            ? winning + refund
            : refund;
  return money(
    roundedDivide(numerator, outcome === 'half_win' || outcome === 'half_loss' ? 20_000n : 10_000n),
  );
}

export function unitsFor(stake: string, unit: string | null): string | null {
  if (!unit || cents(unit) <= 0n) return null;
  const scaled = roundedDivide(cents(stake) * 1_000_000n, cents(unit));
  const absolute = scaled < 0n ? -scaled : scaled;
  return `${scaled < 0n ? '-' : ''}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, '0')}`;
}

export function saoPauloDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatBRL(value: string): string {
  const amount = cents(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}R$ ${(absolute / 100n).toLocaleString('pt-BR')},${String(absolute % 100n).padStart(2, '0')}`;
}
