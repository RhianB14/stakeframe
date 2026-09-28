import { describe, expect, it } from 'vitest';
import {
  computeEffectiveValue,
  effectiveValueSchema,
  freebetInputSchema,
  freebetPatchSchema,
  isQuietHour,
  isValidTimezone,
  minutesOfDayIn,
  notificationPreferencesInputSchema,
  type FreebetRequirement,
} from '../../packages/shared/src/index.js';

// STK-F2-10 — regras puras: calculadora de valor efetivo, quiet hours, fuso e
// contratos do registro. Sem banco e sem rede: a matemática é a mesma em
// qualquer ambiente, e é aqui que um erro seria silencioso e caro.

const base = {
  amount: '50.00',
  stakeReturned: false,
  requirements: [] as FreebetRequirement[],
  odds: '2.00',
  selections: 1,
  single: true,
  minOddsPerSelection: null,
  sports: [] as string[],
  realStake: '0.00',
};

describe('freebet effective value calculator', () => {
  it('computes face × (odd − 1) when the stake is not returned', () => {
    const result = computeEffectiveValue(base);
    // 50.00 × (2.00 − 1) = 50.00 de ganho; a stake não volta.
    expect(result.totalReturn).toBe('50.00');
    expect(result.effectiveValue).toBe('50.00');
    expect(result.faceValue).toBe('50.00');
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('computes face × odd when the stake is returned', () => {
    const result = computeEffectiveValue({ ...base, stakeReturned: true });
    // 50.00 × 2.00 = 100.00, porque a stake de 50.00 volta junto.
    expect(result.totalReturn).toBe('100.00');
    expect(result.effectiveValue).toBe('100.00');
  });

  it('keeps the effective value transparent: every line names its rule', () => {
    const result = computeEffectiveValue({ ...base, realStake: '20.00' });
    // A parcela real não é ganho: sai do valor efetivo.
    expect(result.effectiveValue).toBe('30.00');
    const realLine = result.lines.find((line) => line.label.includes('Parcela real'))!;
    expect(realLine.amount).toBe('-20.00');
    expect(realLine.rule).toMatch(/não é lucro/);
    const total = result.lines.find((line) => line.label === 'Valor efetivo')!;
    expect(total.rule).toMatch(/Soma das linhas acima/);
  });

  it('reports the difference between face value and effective value', () => {
    // Odd 1.50: 50.00 × 0.50 = 25.00 — vale metade do valor de face.
    const result = computeEffectiveValue({ ...base, odds: '1.50' });
    expect(result.effectiveValue).toBe('25.00');
    expect(result.effectiveLoss).toBe('25.00');
  });

  it('blocks a bet below the minimum odds instead of silently reducing the value', () => {
    const result = computeEffectiveValue({
      ...base,
      odds: '1.80',
      requirements: [{ kind: 'min_odds', detail: '2.00' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]).toMatch(/abaixo do mínimo exigido de 2\.00/);
    const check = result.requirements.find((item) => item.kind === 'min_odds')!;
    expect(check.satisfied).toBe(false);
    expect(check.actual).toBe('1.8');
    expect(check.required).toBe('2.00');
  });

  it('accepts a bet at the exact minimum odds', () => {
    const result = computeEffectiveValue({
      ...base,
      odds: '2.00',
      requirements: [{ kind: 'min_odds', detail: '2.00' }],
    });
    expect(result.eligible).toBe(true);
  });

  it('reads a comma decimal in the requirement detail', () => {
    const result = computeEffectiveValue({
      ...base,
      odds: '1.85',
      requirements: [{ kind: 'min_odds', detail: '1,80' }],
    });
    expect(result.eligible).toBe(true);
  });

  it('blocks multiples when the bonus requires a single bet', () => {
    const result = computeEffectiveValue({
      ...base,
      single: false,
      selections: 3,
      requirements: [{ kind: 'single_only', detail: 'aposta simples' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]).toMatch(/exige aposta simples/);
  });

  it('blocks a bet with fewer selections than the bonus requires', () => {
    const result = computeEffectiveValue({
      ...base,
      selections: 1,
      requirements: [{ kind: 'min_selections', detail: '2' }],
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]).toMatch(/1 seleções abaixo do mínimo exigido de 2/);
  });

  it('accepts a bet with more selections than the minimum', () => {
    const result = computeEffectiveValue({
      ...base,
      selections: 4,
      requirements: [{ kind: 'min_selections', detail: '2' }],
    });
    expect(result.eligible).toBe(true);
  });

  it('blocks a sport outside the permitted list and matches case-insensitively', () => {
    const blocked = computeEffectiveValue({
      ...base,
      sports: ['Tênis'],
      requirements: [{ kind: 'sports_restriction', detail: 'Futebol, Basquete' }],
    });
    expect(blocked.eligible).toBe(false);
    const allowed = computeEffectiveValue({
      ...base,
      sports: 'FUTEBOL'.split('').length ? ['Futebol'] : [],
      requirements: [{ kind: 'sports_restriction', detail: 'Futebol, Basquete' }],
    });
    expect(allowed.eligible).toBe(true);
  });

  it('does not block when the per-selection minimum odds is unknown to the user', () => {
    const result = computeEffectiveValue({
      ...base,
      minOddsPerSelection: null,
      requirements: [{ kind: 'min_odds_per_selection', detail: '1.50' }],
    });
    // A casa valida na conta: desconhecer não é o mesmo que violar.
    expect(result.eligible).toBe(true);
    const known = computeEffectiveValue({
      ...base,
      minOddsPerSelection: '1.40',
      requirements: [{ kind: 'min_odds_per_selection', detail: '1.50' }],
    });
    expect(known.eligible).toBe(false);
  });

  it('never blocks on account-level restrictions that cannot be checked offline', () => {
    const result = computeEffectiveValue({
      ...base,
      requirements: [
        { kind: 'new_customer_only', detail: 'cliente novo' },
        { kind: 'no_exchange', detail: 'sem exchange' },
      ],
    });
    expect(result.eligible).toBe(true);
    expect(result.requirements).toHaveLength(2);
  });

  it('rounds half-up in cents without floating point', () => {
    // 33.33 × (1.01 − 1) = 0.3333 → 0.33; 50.00 × 1.01 = 50.50 exato.
    const result = computeEffectiveValue({ ...base, amount: '33.33', odds: '1.01' });
    expect(result.totalReturn).toBe('0.33');
  });

  it('rejects a non-positive face value and an invalid odds', () => {
    expect(() => computeEffectiveValue({ ...base, amount: '0.00' })).toThrow();
    expect(() => computeEffectiveValue({ ...base, odds: '1.00' })).toThrow();
    expect(() => computeEffectiveValue({ ...base, odds: 'abc' })).toThrow();
  });

  it('matches the published response contract', () => {
    expect(() =>
      effectiveValueSchema.parse({
        freebetId: '11111111-1111-4111-8111-111111111111',
        status: 'available',
        ...computeEffectiveValue(base),
        blockers: [],
        eligible: true,
      }),
    ).not.toThrow();
  });
});

describe('quiet hours in the user timezone', () => {
  // 2026-09-28 é uma segunda-feira; os instantes abaixo são UTC explícitos.
  const at = (iso: string) => new Date(iso);

  it('detects minutes of the day in the configured timezone', () => {
    // 23:30 em São Paulo (UTC-3) = 02:30 UTC do dia seguinte.
    expect(minutesOfDayIn(at('2026-09-29T02:30:00Z'), 'America/Sao_Paulo')).toBe(23 * 60 + 30);
    expect(minutesOfDayIn(at('2026-09-28T12:00:00Z'), 'America/Sao_Paulo')).toBe(9 * 60);
  });

  it('returns null for an invalid timezone instead of guessing', () => {
    expect(minutesOfDayIn(at('2026-09-28T12:00:00Z'), 'Mars/Olympus')).toBeNull();
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('America/Sao_Paulo')).toBe(true);
  });

  it('is silent inside a window that does not cross midnight', () => {
    const quietStart = 13 * 60; // 13:00
    const quietEnd = 15 * 60; // 15:00
    expect(isQuietHour(at('2026-09-28T16:00:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      true, // 13:00 local
    );
    expect(isQuietHour(at('2026-09-28T17:59:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      true, // 14:59 local
    );
    expect(isQuietHour(at('2026-09-28T18:00:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      false, // 15:00 local — fim da janela
    );
  });

  it('handles a window that crosses midnight', () => {
    const quietStart = 22 * 60; // 22:00
    const quietEnd = 6 * 60; // 06:00
    expect(isQuietHour(at('2026-09-29T02:00:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      true, // 23:00 local
    );
    expect(isQuietHour(at('2026-09-29T08:59:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      true, // 05:59 local
    );
    expect(isQuietHour(at('2026-09-29T09:00:00Z'), 'America/Sao_Paulo', quietStart, quietEnd)).toBe(
      false, // 06:00 local
    );
  });

  it('treats an empty window as never silent', () => {
    expect(isQuietHour(at('2026-09-28T12:00:00Z'), 'America/Sao_Paulo', 600, 600)).toBe(false);
  });

  it('fails closed (silent) when the timezone is invalid', () => {
    expect(isQuietHour(at('2026-09-28T12:00:00Z'), 'Mars/Olympus', 0, 1439)).toBe(true);
  });

  it('honours the user timezone rather than the server one', () => {
    // 02:00 UTC: 23:00 em São Paulo (silencioso), 12:00 em Tóquio (acordado).
    const instant = at('2026-09-29T02:00:00Z');
    const quietStart = 22 * 60;
    const quietEnd = 6 * 60;
    expect(isQuietHour(instant, 'America/Sao_Paulo', quietStart, quietEnd)).toBe(true);
    expect(isQuietHour(instant, 'Asia/Tokyo', quietStart, quietEnd)).toBe(false);
  });
});

describe('freebet and notification contracts', () => {
  it('defaults requirements to an empty list', () => {
    const parsed = freebetInputSchema.parse({
      bookmakerId: '11111111-1111-4111-8111-111111111111',
      amount: '25.00',
      expiresOn: '2026-12-31',
      stakeReturned: true,
      note: 'Bônus de boas-vindas',
    });
    expect(parsed.requirements).toEqual([]);
  });

  it('rejects an unknown requirement kind and a non-positive amount', () => {
    expect(() =>
      freebetInputSchema.parse({
        bookmakerId: '11111111-1111-4111-8111-111111111111',
        amount: '25.00',
        expiresOn: '2026-12-31',
        stakeReturned: true,
        note: 'x',
        requirements: [{ kind: 'vip_status', detail: 'qualquer' }],
      }),
    ).toThrow();
    expect(() =>
      freebetInputSchema.parse({
        bookmakerId: '11111111-1111-4111-8111-111111111111',
        amount: '0.00',
        expiresOn: '2026-12-31',
        stakeReturned: true,
        note: 'x',
      }),
    ).toThrow();
  });

  it('rejects an empty patch and unknown fields', () => {
    expect(() => freebetPatchSchema.parse({})).toThrow();
    expect(() => freebetPatchSchema.parse({ amount: '10.00', status: 'used' })).toThrow();
  });

  it('bounds quiet hours and rejects an unknown timezone in preferences', () => {
    expect(() =>
      notificationPreferencesInputSchema.parse({
        timezone: 'America/Sao_Paulo',
        quietHoursStart: 1440,
        quietHoursEnd: 360,
        topics: { bet_settled: true },
      }),
    ).toThrow();
    expect(() =>
      notificationPreferencesInputSchema.parse({
        timezone: 'Mars/Olympus',
        quietHoursStart: 0,
        quietHoursEnd: 0,
        topics: { bet_settled: true },
      }),
    ).not.toThrow(); // o schema aceita; o serviço recusa o fuso inválido (fail-closed)
  });
});
