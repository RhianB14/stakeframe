// STK-F1-10 — observabilidade (Plano Master §4.6, §6.1 e §12.1).
//
// Sentry (erros), PostHog Cloud EU (analytics e feature flags de rollout) e
// Better Stack (logs warn/error) — TODOS desligados por padrão (zero config =
// zero telemetria) e fail-closed: com ENABLED=true a configuração
// correspondente é obrigatória (TELEMETRY_CONFIGURATION_REFUSED), nunca um
// envio parcial. Nenhum token, prompt, imagem ou dado financeiro sai cru: todo
// payload passa pelo scrubber compartilhado (§4.6).
//
// O banco de dados/pool NÃO é instrumentado para telemetria: queries do PG
// ficam fora do Sentry (apenas stacktraces de erro sem parâmetros de query).

import { readFileSync } from 'node:fs';
import * as Sentry from '@sentry/node';
import { PostHog } from 'posthog-node';
import { sanitizeLogText, scrubTelemetry, type ReleaseInfo } from '@stakeframe/shared';

/** Região fixa: PostHog Cloud EU (§6.1). Override é recusado na configuração. */
export const POSTHOG_EU_HOST = 'https://eu.i.posthog.com';
export const BETTER_STACK_DEFAULT_URL = 'https://in.logs.betterstack.com';

export type TelemetryLevel = 'info' | 'warn' | 'error';

export interface TelemetryConfig {
  sentry: { enabled: boolean; dsn: string | undefined; environment: string };
  posthog: { enabled: boolean; key: string | undefined };
  betterStack: {
    enabled: boolean;
    token: string | undefined;
    ingestingUrl: string;
    infoSampleRate: number;
  };
  debug: { enabled: boolean };
}

function readFlag(environment: NodeJS.ProcessEnv, name: string): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('TELEMETRY_CONFIGURATION_INVALID');
}

/**
 * Lê um valor de telemetria: `${name}_FILE` (arquivo restrito no host de
 * produção) tem precedência sobre o valor direto. Arquivo ilegível, vazio, com
 * caracteres de controle ou acima de 4 KiB é recusado — nunca degrada para um
 * valor parcial.
 */
export function readTelemetrySecret(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const file = environment[`${name}_FILE`]?.trim();
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error('TELEMETRY_SECRET_FILE_REQUIRED');
    }
    const value = raw.replace(/\r?\n$/, '');
    if (value.length === 0 || value.length > 4096 || /\p{Cc}/u.test(value)) {
      throw new Error('TELEMETRY_SECRET_FILE_INVALID');
    }
    return value;
  }
  const direct = environment[name]?.trim();
  return direct ? direct : undefined;
}

function readInfoSampleRate(environment: NodeJS.ProcessEnv): number {
  const raw = environment.BETTER_STACK_INFO_SAMPLE_RATE?.trim();
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('TELEMETRY_CONFIGURATION_INVALID');
  }
  return value;
}

/**
 * Valida e resolve a configuração de telemetria. Desligada por padrão; quando
 * `ENABLED=true` exige o valor correspondente. A região do PostHog é fixa (EU).
 */
export function readTelemetryConfig(environment: NodeJS.ProcessEnv): TelemetryConfig {
  const runtime = environment.STAKEFRAME_RUNTIME?.trim();
  const sentry = {
    enabled: readFlag(environment, 'SENTRY_ENABLED'),
    dsn: readTelemetrySecret(environment, 'SENTRY_DSN'),
    environment: environment.SENTRY_ENVIRONMENT?.trim() || runtime || 'unknown',
  };
  if (sentry.enabled && !sentry.dsn) throw new Error('TELEMETRY_CONFIGURATION_REFUSED');

  const posthogHost = environment.POSTHOG_HOST?.trim();
  if (posthogHost && posthogHost !== POSTHOG_EU_HOST) throw new Error('TELEMETRY_REGION_REFUSED');
  const posthog = {
    enabled: readFlag(environment, 'POSTHOG_ENABLED'),
    key: readTelemetrySecret(environment, 'POSTHOG_KEY'),
  };
  if (posthog.enabled && !posthog.key) throw new Error('TELEMETRY_CONFIGURATION_REFUSED');

  const betterStack = {
    enabled: readFlag(environment, 'BETTER_STACK_ENABLED'),
    token: readTelemetrySecret(environment, 'BETTER_STACK_SOURCE_TOKEN'),
    ingestingUrl: environment.BETTER_STACK_INGESTING_URL?.trim() || BETTER_STACK_DEFAULT_URL,
    infoSampleRate: readInfoSampleRate(environment),
  };
  if (betterStack.enabled && !betterStack.token) throw new Error('TELEMETRY_CONFIGURATION_REFUSED');
  if (!betterStack.ingestingUrl.startsWith('https://')) {
    throw new Error('TELEMETRY_CONFIGURATION_INVALID');
  }

  return {
    sentry,
    posthog,
    betterStack,
    debug: { enabled: readFlag(environment, 'TELEMETRY_DEBUG_ENABLED') },
  };
}

/**
 * beforeSend do Sentry: o evento inteiro (mensagem, exceções, breadcrumbs,
 * request, contexts) passa pelo scrubber — nada cru é transmitido. Eventos
 * nunca são descartados aqui: só sanitizados.
 */
export function sentryBeforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  return scrubTelemetry(event) as Sentry.ErrorEvent;
}

export interface LogShipper {
  (level: TelemetryLevel, message: string, context?: Record<string, unknown>): Promise<void>;
}

/** Shipper do Better Stack (Telemetry HTTP): payload sanitizado, falha silenciosa. */
export function createLogShipper(
  config: TelemetryConfig['betterStack'],
  fetchImpl: typeof fetch = fetch,
): LogShipper {
  return async (level, message, context) => {
    if (!config.enabled || !config.token) return;
    if (level === 'info' && Math.random() >= config.infoSampleRate) return;
    const payload = [
      {
        dt: new Date().toISOString(),
        level,
        message: sanitizeLogText(message),
        context: scrubTelemetry(context ?? {}),
      },
    ];
    try {
      await fetchImpl(config.ingestingUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Telemetria nunca derruba a aplicação: falha de envio é silenciosa.
    }
  };
}

export interface TelemetryHandle {
  config: TelemetryConfig;
  captureError(error: unknown, context?: Record<string, unknown>): void;
  captureEvent(name: string, distinctId: string, properties?: Record<string, unknown>): void;
  featureFlag(key: string, distinctId: string, fallback: boolean): Promise<boolean>;
  ship: LogShipper;
  shutdown(): Promise<void>;
}

/**
 * Inicializa a telemetria conforme a configuração validada. Sem configuração
 * tudo permanece desligado (fail-closed); com configuração, o release é
 * identificado pelo Git SHA já carimbado no artefato (STAKEFRAME_COMMIT).
 */
export function initTelemetry(config: TelemetryConfig, release: ReleaseInfo): TelemetryHandle {
  if (config.sentry.enabled && config.sentry.dsn) {
    Sentry.init({
      dsn: config.sentry.dsn,
      environment: config.sentry.environment,
      release: `stakeframe@${release.version}+${release.commit}`,
      // §12.1: amostragem de traces baixa.
      tracesSampleRate: 0.1,
      beforeSend: sentryBeforeSend,
      // §4.6 (coleta restritiva): nenhum dado pessoal, cookie, header, corpo
      // HTTP, query param, argumento de prompt de IA ou dado de banco é
      // coletado automaticamente — e o scrubber ainda sanitiza tudo no
      // beforeSend. O banco/pool não é instrumentado (databaseQueryData: false).
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        genAI: { inputs: false, outputs: false },
        graphQL: { document: false, variables: false },
      },
    });
  }
  let posthog: PostHog | undefined;
  if (config.posthog.enabled && config.posthog.key) {
    posthog = new PostHog(config.posthog.key, {
      host: POSTHOG_EU_HOST,
      flushAt: 20,
      flushInterval: 10_000,
    });
  }
  const ship = createLogShipper(config.betterStack);
  return {
    config,
    captureError(error, context) {
      if (config.sentry.enabled) Sentry.captureException(error);
      void ship('error', error instanceof Error ? error.message : String(error), context);
    },
    captureEvent(name, distinctId, properties) {
      if (!posthog) return;
      posthog.capture({
        distinctId,
        event: name,
        properties: scrubTelemetry(properties ?? {}) as Record<string, unknown>,
      });
    },
    async featureFlag(key, distinctId, fallback) {
      // Rollout apenas: NUNCA fonte de verdade de planos/entitlements — esses
      // ficam no banco. Sem configuração o comportamento default prevalece.
      if (!posthog) return fallback;
      const value = await posthog.getFeatureFlag(key, distinctId);
      return typeof value === 'boolean' ? value : fallback;
    },
    ship,
    async shutdown() {
      await posthog?.shutdown().catch(() => undefined);
    },
  };
}
