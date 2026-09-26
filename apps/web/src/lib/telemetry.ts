// STK-F1-10 — runtime de telemetria do cliente web (Sentry + PostHog EU).
//
// Ativado em runtime pela configuração pública do API (/api/v1/telemetry/config)
// e SEMPRE subordinado ao opt-in explícito (§6.1). Zero configuração = zero
// telemetria; a região do PostHog é fixa na UE (nenhum override é possível no
// cliente). Replay: desligado por padrão, mascarado e bloqueado em bilhetes,
// finanças, configurações e no mini-app do Telegram.

import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';
import {
  scrubTelemetry,
  telemetryPublicConfigSchema,
  type TelemetryPublicConfig,
} from '@stakeframe/shared';
import { request } from '../product/api.js';
import {
  readTelemetryConsent,
  shouldRecordReplay,
  writeTelemetryConsent,
  pageIdFromHash,
  SENSITIVE_PAGES,
  type TelemetryConsent,
} from './telemetry-policy.js';

export { SENSITIVE_PAGES, pageIdFromHash };
export type { TelemetryConsent };

const POSTHOG_EU_HOST = 'https://eu.i.posthog.com';

let publicConfig: TelemetryPublicConfig | null = null;
let posthogStarted = false;
const activeSensitiveSurfaces = new Set<string>();

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function consent(): TelemetryConsent {
  return readTelemetryConsent(storage());
}

/** Marca/desmarca uma superfície sensível (modal aberto, página sensível). */
export function setSensitiveSurface(id: string, sensitive: boolean): void {
  if (sensitive) activeSensitiveSurfaces.add(id);
  else activeSensitiveSurfaces.delete(id);
}

/**
 * Busca a configuração pública e inicializa Sentry (se configurado). Sem
 * resposta válida do API nada é inicializado (fail-closed).
 */
export async function initWebTelemetry(): Promise<void> {
  try {
    publicConfig = await request('/api/v1/telemetry/config', telemetryPublicConfigSchema);
  } catch {
    publicConfig = null;
    return;
  }
  if (publicConfig.sentry) {
    Sentry.init({
      dsn: publicConfig.sentry.dsn,
      environment: publicConfig.sentry.environment,
      release: `stakeframe-web@${publicConfig.release.version}+${publicConfig.release.commit}`,
      tracesSampleRate: 0.1,
      beforeSend: (event) => scrubTelemetry(event) as Sentry.ErrorEvent,
      // §4.6 (coleta restritiva no cliente): nada de dados pessoais, cookies,
      // corpos ou query params coletados automaticamente; o scrubber ainda
      // sanitiza tudo no beforeSend.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
      },
      integrations: (integrations) => [
        ...integrations,
        Sentry.replayIntegration({
          maskAllText: true,
          maskAllInputs: true,
          blockAllMedia: true,
          // A decisão é consultada a cada evento: o toggle de replay vale sem
          // recarregar e nenhum quadro de superfície sensível é gravado.
          beforeAddRecordingEvent: (event) =>
            shouldRecordReplay({
              pathname: window.location.pathname,
              hash: window.location.hash,
              activeSensitiveSurfaces,
              consent: consent(),
            })
              ? event
              : null,
        }),
      ],
    });
  }
  applyAnalyticsConsent();
}

/** Inicia/ajusta o PostHog conforme o consentimento atual de analytics. */
export function applyAnalyticsConsent(): void {
  if (!publicConfig?.posthog) return;
  const current = consent();
  if (current.analytics && !posthogStarted) {
    posthog.init(publicConfig.posthog.key, {
      api_host: POSTHOG_EU_HOST,
      persistence: 'localStorage',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      person_profiles: 'identified_only',
    });
    posthogStarted = true;
    return;
  }
  if (posthogStarted) {
    if (current.analytics) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  }
}

/** Atualiza a preferência (Configurações) e aplica imediatamente. */
export function updateTelemetryConsent(
  kind: 'analytics' | 'replay',
  granted: boolean,
): TelemetryConsent {
  const updated = writeTelemetryConsent(storage(), kind, granted);
  if (kind === 'analytics') applyAnalyticsConsent();
  // Replay: a preferência é lida a cada evento de gravação — sem reload.
  return updated;
}

export function readConsent(): TelemetryConsent {
  return consent();
}

/** Evento de navegação: nunca nas telas sensíveis; exige consentimento. */
export function capturePageView(page: string): void {
  if (!posthogStarted || !consent().analytics) return;
  if (SENSITIVE_PAGES.has(page)) return;
  posthog.capture('page_view', { page });
}

/** Identificação pseudônima: apenas o id interno — nunca e-mail, nome ou PII. */
export function identifyOwner(ownerId: string): void {
  if (!posthogStarted || !consent().analytics) return;
  posthog.identify(ownerId);
}

/**
 * Feature flag de ROLLOUT (PostHog): sem configuração/flags o comportamento
 * default prevalece. Nunca é fonte de verdade de planos ou permissões — esses
 * vivem no banco.
 */
export function featureFlag(key: string, fallback: boolean): boolean {
  if (!posthogStarted) return fallback;
  try {
    const value = posthog.getFeatureFlag(key);
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}
