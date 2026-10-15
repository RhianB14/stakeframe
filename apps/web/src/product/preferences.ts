import { formatBRL } from '@stakeframe/shared';

export type DisplayPreferences = {
  language: 'en' | 'pt-BR';
  currency: 'USD' | 'BRL' | 'EUR' | 'MXN';
  odds: 'decimal' | 'fractional' | 'american';
  timezone: string;
};

const preferencesKey = 'bettrack.preview.preferences';
const defaults: DisplayPreferences = {
  language: 'pt-BR',
  currency: 'USD',
  odds: 'decimal',
  timezone: 'America/Sao_Paulo',
};

let referenceRates: {
  date: string;
  rates: Partial<Record<DisplayPreferences['currency'], number>>;
} | null = null;

export function readDisplayPreferences(): DisplayPreferences {
  if (typeof window === 'undefined') return defaults;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(preferencesKey) ?? '{}',
    ) as Partial<DisplayPreferences>;
    const timezone =
      typeof stored.timezone === 'string' && stored.timezone.length > 0
        ? stored.timezone
        : defaults.timezone;
    let validTimezone = defaults.timezone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
      validTimezone = timezone;
    } catch {
      // Invalid localStorage values fall back to the supported product default.
    }
    return {
      language:
        stored.language === 'en' || stored.language === 'pt-BR'
          ? stored.language
          : defaults.language,
      currency:
        stored.currency === 'BRL' || stored.currency === 'EUR' || stored.currency === 'MXN'
          ? stored.currency
          : 'USD',
      odds: stored.odds === 'fractional' || stored.odds === 'american' ? stored.odds : 'decimal',
      timezone: validTimezone,
    };
  } catch {
    return defaults;
  }
}

export function setReferenceRates(
  value: { date: string; rates: Partial<Record<DisplayPreferences['currency'], number>> } | null,
) {
  referenceRates = value;
}

export async function fetchReferenceRates() {
  const response = await fetch('https://api.frankfurter.dev/v2/rates?base=BRL&quotes=USD,EUR,MXN', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Exchange-rate source returned ${response.status}.`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error('Invalid exchange-rate response.');
  const rates: Partial<Record<DisplayPreferences['currency'], number>> = {};
  let date: string | null = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as { date?: unknown; quote?: unknown; rate?: unknown };
    if (
      typeof item.date !== 'string' ||
      typeof item.quote !== 'string' ||
      typeof item.rate !== 'number'
    )
      continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(item.rate) || item.rate <= 0)
      continue;
    if (date === null || item.date.localeCompare(date) > 0) date = item.date;
    if (item.quote === 'USD') rates.USD = item.rate;
    if (item.quote === 'EUR') rates.EUR = item.rate;
    if (item.quote === 'MXN') rates.MXN = item.rate;
  }
  if (!date || !rates.USD || !rates.EUR || !rates.MXN)
    throw new Error('Exchange-rate response is incomplete.');
  return { date, rates };
}

export function referenceRateDate() {
  return referenceRates?.date ?? null;
}

export function displayCurrencyReady() {
  const { currency } = readDisplayPreferences();
  return currency === 'BRL' || typeof referenceRates?.rates[currency] === 'number';
}

function formatAccountingBRL(value: string): string {
  const largeAmount = /^(-?)(\d{13,})(?:\.(\d{1,2}))?$/.exec(value);
  if (!largeAmount) return formatBRL(value);

  const [, sign, whole, fraction = ''] = largeAmount;
  if (whole === undefined) return formatBRL(value);
  const wholeAmount = BigInt(whole);
  const amount = sign === '-' ? -wholeAmount : wholeAmount;
  const parts = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(amount);
  return parts
    .map((part) => (part.type === 'fraction' ? fraction.padEnd(2, '0') : part.value))
    .join('')
    .replace(/[\u00a0\u202f]/g, ' ');
}

/** BRL remains the accounting currency; other currencies are approximate display conversions. */
export function formatDisplayMoney(value: string | null | undefined): string {
  if (value == null) return '—';
  const preferences = readDisplayPreferences();
  if (preferences.currency === 'BRL') return formatAccountingBRL(value);
  const rate = referenceRates?.rates[preferences.currency];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return formatAccountingBRL(value);
  const locale = preferences.language === 'pt-BR' ? 'pt-BR' : 'en-US';
  const converted = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: preferences.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) * rate);
  return `≈${converted}`;
}

/** Format stored decimal odds for display without changing the canonical value. */
export function formatDisplayOdds(value: string | null | undefined): string {
  if (value == null || value.trim() === '') return '—';
  const decimalOdds = Number(value);
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return value;
  const format = readDisplayPreferences().odds;
  if (format === 'decimal') return value;
  if (format === 'american') {
    const american = decimalOdds >= 2 ? (decimalOdds - 1) * 100 : -100 / (decimalOdds - 1);
    const rounded = Math.round(american);
    return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}`;
  }
  const target = decimalOdds - 1;
  let bestNumerator = Math.round(target * 1000);
  let bestDenominator = 1000;
  for (let denominator = 1; denominator <= 1000; denominator += 1) {
    const numerator = Math.round(target * denominator);
    if (
      Math.abs(numerator / denominator - target) <
      Math.abs(bestNumerator / bestDenominator - target)
    ) {
      bestNumerator = numerator;
      bestDenominator = denominator;
    }
  }
  let left = Math.abs(bestNumerator);
  let right = bestDenominator;
  while (right) [left, right] = [right, left % right];
  return `${bestNumerator / left}/${bestDenominator / left}`;
}

export function displayLocale() {
  const language = readDisplayPreferences().language;
  return language === 'pt-BR' ? 'pt-BR' : 'en-US';
}

export function displayTimeZone() {
  return readDisplayPreferences().timezone;
}

export function displayDateInTimeZone(date: Date, timezone = displayTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatDisplayDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isDateOnly ? `${value}T12:00:00Z` : value);
  return new Intl.DateTimeFormat(displayLocale(), {
    ...options,
    timeZone: isDateOnly ? 'UTC' : displayTimeZone(),
  }).format(date);
}
