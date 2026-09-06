import { describe, expect, it } from 'vitest';
import { readAuthConfig } from '../../apps/api/src/auth-config.js';
import { isAllowedGoogleProfile } from '../../apps/api/src/auth.js';

const environment = {
  AUTH_ENABLED: 'true',
  APP_ORIGIN: 'http://127.0.0.1:8088',
  BETTER_AUTH_SECRET: 'unit-test-placeholder-not-a-real-secret',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-placeholder',
  AUTHORIZED_GOOGLE_EMAIL: 'owner@example.test',
  AUTHORIZED_GOOGLE_SUB: '111111111111111111111',
};
describe('owner auth configuration', () => {
  it('keeps authentication disabled by default', () =>
    expect(readAuthConfig({})).toEqual({ enabled: false }));
  it.each(['yes', '1', 'TRUE'])('rejects ambiguous enablement: %s', (AUTH_ENABLED) => {
    expect(() => readAuthConfig({ ...environment, AUTH_ENABLED })).toThrow(
      'INVALID_AUTH_CONFIGURATION',
    );
  });
  it.each([
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'AUTHORIZED_GOOGLE_EMAIL',
    'AUTHORIZED_GOOGLE_SUB',
    'BETTER_AUTH_SECRET',
    'APP_ORIGIN',
  ])('fails closed when %s is missing', (key) => {
    expect(() => readAuthConfig({ ...environment, [key]: '' })).toThrow();
  });
  it.each([
    'http://public.example.test',
    'https://user:private@example.test',
    'https://example.test/path',
    'https://example.test?redirect=elsewhere',
    'https://example.test/#hash',
  ])('rejects unsafe origins without reflecting them: %s', (APP_ORIGIN) => {
    expect(() => readAuthConfig({ ...environment, APP_ORIGIN })).toThrow('INVALID_AUTH_ORIGIN');
  });
  it('requires the exact verified Google subject and email, without alias normalization', () => {
    const config = readAuthConfig(environment);
    if (!config.enabled) throw new Error('Expected enabled config');
    const valid = { sub: config.ownerSubject, email: 'OWNER@example.test', email_verified: true };
    expect(isAllowedGoogleProfile(valid, config)).toBe(true);
    for (const profile of [
      undefined,
      { ...valid, sub: '222' },
      { ...valid, email_verified: 'true' },
      { ...valid, email_verified: false },
      { ...valid, email: 'owner+alias@example.test' },
    ])
      expect(isAllowedGoogleProfile(profile, config)).toBe(false);
  });
});
