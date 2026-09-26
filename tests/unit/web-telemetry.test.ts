// STK-F1-10 — política de telemetria do web: opt-in, superfícies sensíveis.
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CONSENT_KEY,
  pageIdFromHash,
  readTelemetryConsent,
  shouldRecordReplay,
  writeTelemetryConsent,
} from '../../apps/web/src/lib/telemetry-policy.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    dump: () => Object.fromEntries(data),
  };
}

describe('consentimento de telemetria (opt-in)', () => {
  it('é desligado por padrão — sem escolha, sem telemetria', () => {
    expect(readTelemetryConsent(fakeStorage())).toEqual({ analytics: false, replay: false });
    expect(readTelemetryConsent(undefined)).toEqual({ analytics: false, replay: false });
  });

  it('persiste e remove a preferência concedida', () => {
    const storage = fakeStorage();
    expect(writeTelemetryConsent(storage, 'analytics', true)).toEqual({
      analytics: true,
      replay: false,
    });
    expect(storage.dump()).toEqual({ [ANALYTICS_CONSENT_KEY]: 'granted' });
    expect(writeTelemetryConsent(storage, 'analytics', false)).toEqual({
      analytics: false,
      replay: false,
    });
    expect(storage.dump()).toEqual({});
  });

  it('degrada para desligado quando o storage falha (fail-closed)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTelemetryConsent(hostile)).toEqual({ analytics: false, replay: false });
    expect(writeTelemetryConsent(hostile, 'replay', true)).toEqual({
      analytics: false,
      replay: false,
    });
  });
});

describe('shouldRecordReplay (blocklist por superfície)', () => {
  const granted = { analytics: false, replay: true };
  const base = { pathname: '/', hash: '#overview', activeSensitiveSurfaces: new Set<string>() };

  it('exige opt-in de replay', () => {
    expect(shouldRecordReplay({ ...base, consent: { analytics: true, replay: false } })).toBe(
      false,
    );
    expect(shouldRecordReplay({ ...base, consent: { analytics: false, replay: false } })).toBe(
      false,
    );
    expect(shouldRecordReplay({ ...base, consent: granted })).toBe(true);
  });

  it('nunca grava bilhetes, finanças ou configurações', () => {
    for (const page of ['bets', 'finance', 'settings']) {
      expect(shouldRecordReplay({ ...base, hash: `#${page}`, consent: granted })).toBe(false);
    }
    expect(shouldRecordReplay({ ...base, hash: '#analytics', consent: granted })).toBe(true);
  });

  it('nunca grava o mini-app do Telegram nem com modal aberto', () => {
    expect(shouldRecordReplay({ ...base, pathname: '/miniapp', consent: granted })).toBe(false);
    expect(
      shouldRecordReplay({
        ...base,
        activeSensitiveSurfaces: new Set(['product-app']),
        consent: granted,
      }),
    ).toBe(false);
  });

  it('lê a página do hash com a convenção do ProductApp', () => {
    expect(pageIdFromHash('#bets')).toBe('bets');
    expect(pageIdFromHash('')).toBe('');
  });
});
