import { describe, it, expect } from 'vitest';
import {
  cents,
  money,
  oddsInteger,
  suggestedReturn,
  unitsFor,
  saoPauloDate,
  financeCommandSchema,
} from '../../packages/shared/src/index.js';

describe('exact decimal financial rules', () => {
  it('preserves cents through arithmetic without binary rounding', () => {
    expect(money(cents('0.10') + cents('0.20'))).toBe('0.30');
    expect(money(cents('-12.3'))).toBe('-12.30');
    expect(money(cents('999999999999.99'))).toBe('999999999999.99');
    expect(() => cents('1e3')).toThrow();
    expect(() => cents('1.001')).toThrow();
    expect(() => cents('NaN')).toThrow();
    expect(() => oddsInteger('0.99')).toThrow();
    expect(() => oddsInteger('2.00001')).toThrow();
  });
  it.each([
    ['win', '185.00'],
    ['loss', '0.00'],
    ['void', '100.00'],
    ['half_win', '142.50'],
    ['half_loss', '50.00'],
  ] as const)('calculates %s without confusing return with profit', (outcome, expected) => {
    expect(suggestedReturn('100.00', '1.85', outcome)).toBe(expected);
  });
  it('keeps promotional stake out of real refunds and handles stake-returned winnings', () => {
    expect(suggestedReturn('20.00', '3.00', 'win', true, false)).toBe('40.00');
    expect(suggestedReturn('20.00', '3.00', 'win', true, true)).toBe('60.00');
    expect(suggestedReturn('20.00', '3.00', 'void', true, true)).toBe('0.00');
    expect(suggestedReturn('20.00', '3.00', 'half_win', true, false)).toBe('20.00');
  });
  it('rounds only at the cent boundary and uses six decimal places for units', () => {
    expect(suggestedReturn('0.01', '1.50', 'win')).toBe('0.02');
    expect(suggestedReturn('0.01', '2.00', 'half_loss')).toBe('0.01');
    expect(unitsFor('100.00', '30.00')).toBe('3.333333');
    expect(unitsFor('100.00', null)).toBeNull();
    expect(unitsFor('10.00', '0.00')).toBeNull();
  });
  it('uses São Paulo calendar dates across UTC month boundaries', () => {
    expect(saoPauloDate(new Date('2026-09-01T02:59:59Z'))).toBe('2026-08-31');
    expect(saoPauloDate(new Date('2026-09-01T03:00:00Z'))).toBe('2026-09-01');
  });
  it('rejects malformed financial input as validation errors rather than exceptions', () => {
    expect(
      financeCommandSchema.safeParse({
        type: 'settings.update',
        expectedVersion: 1,
        unitPercent: 'garbage',
      }).success,
    ).toBe(false);
    expect(
      financeCommandSchema.safeParse({
        type: 'settings.update',
        expectedVersion: 1,
        unitPercent: 1,
      }).success,
    ).toBe(false);
  });
});
