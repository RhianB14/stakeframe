// STK-F1-10 — política de telemetria do cliente web (módulo puro, sem imports
// de browser além dos tipos): opt-in persistido, superfícies sensíveis e
// decisões de replay/flags. Testável isoladamente; o runtime vive em
// ./telemetry.ts.

export const ANALYTICS_CONSENT_KEY = 'stakeframe.analytics-consent';
export const REPLAY_CONSENT_KEY = 'stakeframe.replay-consent';

/** Páginas do produto cujo conteúdo nunca é gravado (Plano Master §6.1). */
export const SENSITIVE_PAGES = new Set(['bets', 'finance', 'settings']);

export interface TelemetryConsent {
  analytics: boolean;
  replay: boolean;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Opt-in explícito, persistido em localStorage POR DISPOSITIVO: nada é enviado
 * ao servidor e o padrão é sempre desligado (sem escolha = sem telemetria).
 * Storage indisponível (modo restrito/privado) degrada para desligado.
 */
export function readTelemetryConsent(storage: StorageLike | undefined): TelemetryConsent {
  try {
    if (!storage) return { analytics: false, replay: false };
    return {
      analytics: storage.getItem(ANALYTICS_CONSENT_KEY) === 'granted',
      replay: storage.getItem(REPLAY_CONSENT_KEY) === 'granted',
    };
  } catch {
    return { analytics: false, replay: false };
  }
}

export function writeTelemetryConsent(
  storage: StorageLike | undefined,
  kind: 'analytics' | 'replay',
  granted: boolean,
): TelemetryConsent {
  const key = kind === 'analytics' ? ANALYTICS_CONSENT_KEY : REPLAY_CONSENT_KEY;
  try {
    if (storage) {
      if (granted) storage.setItem(key, 'granted');
      else storage.removeItem(key);
    }
  } catch {
    // Preferência não persistida: o fail-closed mantém a telemetria desligada.
  }
  return readTelemetryConsent(storage);
}

/**
 * Decide se o evento de replay pode ser gravado. A gravação exige o opt-in de
 * replay E superfície não sensível: páginas de bilhetes/finanças/configurações,
 * o mini-app do Telegram e modais do produto nunca são gravados.
 */
export function shouldRecordReplay(input: {
  pathname: string;
  hash: string;
  activeSensitiveSurfaces: ReadonlySet<string>;
  consent: TelemetryConsent;
}): boolean {
  if (!input.consent.replay) return false;
  if (input.activeSensitiveSurfaces.size > 0) return false;
  if (input.pathname.startsWith('/miniapp')) return false;
  const page = input.hash.replace(/^#/, '');
  return !SENSITIVE_PAGES.has(page);
}

/** Página do produto atual a partir do hash (mesma convenção do ProductApp). */
export function pageIdFromHash(hash: string): string {
  return hash.slice(1);
}
