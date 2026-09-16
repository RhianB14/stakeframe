import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  onboardingStatusSchema,
  onboardingUpdateSchema,
  timeZoneSchema,
} from '../../packages/shared/src/index.js';

describe('onboarding contract', () => {
  it('accepts real IANA time zones and rejects anything else', () => {
    for (const zone of [
      'America/Sao_Paulo',
      'America/Manaus',
      'Europe/Lisbon',
      'UTC',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+3',
    ])
      expect(isValidTimeZone(zone), zone).toBe(true);
    for (const zone of [
      'Invalid/Zone',
      'America/Sao_Paulo/Extra',
      '',
      'x'.repeat(65),
      'America Sao Paulo',
      '123',
      '../etc/passwd',
      'UTC;drop table',
    ])
      expect(isValidTimeZone(zone), zone).toBe(false);
  });

  it('trims the time zone and validates profile updates strictly', () => {
    expect(timeZoneSchema.parse('  America/Sao_Paulo  ')).toBe('America/Sao_Paulo');
    expect(
      onboardingUpdateSchema.safeParse({
        step: 'profile',
        displayName: ' Ana ',
        timezone: 'America/Sao_Paulo',
      }).success,
    ).toBe(true);
    expect(
      timeZoneSchema.safeParse('America/Sao_Paulo').success &&
        onboardingUpdateSchema.parse({
          step: 'profile',
          displayName: ' Ana ',
          timezone: 'America/Sao_Paulo',
        }),
    ).toMatchObject({ displayName: 'Ana' });
    for (const invalid of [
      { step: 'profile', displayName: 'Ana', timezone: 'nope/nope' },
      { step: 'profile', displayName: '', timezone: 'UTC' },
      { step: 'profile', displayName: 'Ana', timezone: 'UTC', admin: true },
      { step: 'finish', extra: 1 },
      { step: 'bankroll' },
      {},
    ])
      expect(onboardingUpdateSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(
        false,
      );
    expect(onboardingUpdateSchema.safeParse({ step: 'finish' }).success).toBe(true);
  });

  it('validates the status read model and serializes it without private extras', () => {
    const pending = {
      displayName: 'Ana',
      timezone: null,
      steps: {
        profile: { completed: false, completedAt: null },
        bankroll: { completed: false },
        firstBet: { completed: false },
      },
      completedAt: null,
    };
    expect(onboardingStatusSchema.safeParse(pending).success).toBe(true);
    const done = {
      ...pending,
      timezone: 'America/Sao_Paulo',
      steps: {
        profile: { completed: true, completedAt: '2026-09-16T12:00:00.000Z' },
        bankroll: { completed: true },
        firstBet: { completed: true },
      },
      completedAt: '2026-09-16T12:30:00.000Z',
    };
    expect(onboardingStatusSchema.safeParse(done).success).toBe(true);
    expect(onboardingStatusSchema.safeParse({ ...pending, displayName: 1 }).success).toBe(false);
    expect(onboardingStatusSchema.safeParse({ ...pending, steps: {} }).success).toBe(false);
  });
});
