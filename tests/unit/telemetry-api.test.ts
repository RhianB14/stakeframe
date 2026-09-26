// STK-F1-10 — configuração fail-closed, shipper e scrubbing do pipeline.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createLogShipper,
  readTelemetryConfig,
  readTelemetrySecret,
  sentryBeforeSend,
  BETTER_STACK_DEFAULT_URL,
  POSTHOG_EU_HOST,
} from '../../apps/api/src/telemetry.js';
import * as workerTelemetry from '../../apps/worker/src/telemetry.js';
import { scrubTelemetry, TELEMETRY_REDACTED } from '../../packages/shared/src/telemetry.js';

const directory = mkdtempSync(join(tmpdir(), 'stakeframe-telemetry-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('readTelemetryConfig (fail-closed)', () => {
  it('zero configuração = zero telemetria', () => {
    const config = readTelemetryConfig({});
    expect(config.sentry).toEqual({ enabled: false, dsn: undefined, environment: 'unknown' });
    expect(config.posthog).toEqual({ enabled: false, key: undefined });
    expect(config.betterStack.enabled).toBe(false);
    expect(config.debug.enabled).toBe(false);
  });

  it('ENABLED=true exige o valor correspondente (TELEMETRY_CONFIGURATION_REFUSED)', () => {
    expect(() => readTelemetryConfig({ SENTRY_ENABLED: 'true' })).toThrow(
      'TELEMETRY_CONFIGURATION_REFUSED',
    );
    expect(() => readTelemetryConfig({ POSTHOG_ENABLED: 'true' })).toThrow(
      'TELEMETRY_CONFIGURATION_REFUSED',
    );
    expect(() => readTelemetryConfig({ BETTER_STACK_ENABLED: 'true' })).toThrow(
      'TELEMETRY_CONFIGURATION_REFUSED',
    );
  });

  it('aceita configuração completa com DSN direto', () => {
    const config = readTelemetryConfig({
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
      POSTHOG_ENABLED: 'true',
      POSTHOG_KEY: 'phc_example_key',
      BETTER_STACK_ENABLED: 'true',
      BETTER_STACK_SOURCE_TOKEN: 'token_example',
    });
    expect(config.sentry.enabled).toBe(true);
    expect(config.sentry.environment).toBe('production');
    expect(config.betterStack.ingestingUrl).toBe(BETTER_STACK_DEFAULT_URL);
    expect(config.betterStack.infoSampleRate).toBe(0);
  });

  it('recusa região do PostHog fora da UE (bloqueio de override)', () => {
    expect(() =>
      readTelemetryConfig({
        POSTHOG_HOST: 'https://us.i.posthog.com',
        POSTHOG_ENABLED: 'true',
        POSTHOG_KEY: 'k',
      }),
    ).toThrow('TELEMETRY_REGION_REFUSED');
    expect(
      () =>
        readTelemetryConfig({
          POSTHOG_HOST: POSTHOG_EU_HOST,
          POSTHOG_ENABLED: 'true',
          POSTHOG_KEY: 'k',
        }).posthog.enabled,
    ).not.toThrow();
  });

  it('recusa flags e amostragem inválidas', () => {
    expect(() => readTelemetryConfig({ SENTRY_ENABLED: 'yes' })).toThrow(
      'TELEMETRY_CONFIGURATION_INVALID',
    );
    expect(() => readTelemetryConfig({ BETTER_STACK_INFO_SAMPLE_RATE: '2' })).toThrow(
      'TELEMETRY_CONFIGURATION_INVALID',
    );
    expect(() =>
      readTelemetryConfig({ BETTER_STACK_INGESTING_URL: 'http://in.logs.betterstack.com' }),
    ).toThrow('TELEMETRY_CONFIGURATION_INVALID');
  });

  it('lê valores de arquivo (_FILE) e recusa arquivo ausente/inválido', () => {
    const good = join(directory, 'sentry_dsn');
    writeFileSync(good, 'https://public@example.ingest.sentry.io/2\n');
    expect(readTelemetrySecret({ SENTRY_DSN_FILE: good }, 'SENTRY_DSN')).toBe(
      'https://public@example.ingest.sentry.io/2',
    );

    const binary = join(directory, 'bad_token');
    writeFileSync(binary, 'abc\u0000def');
    expect(() =>
      readTelemetrySecret({ BETTER_STACK_SOURCE_TOKEN_FILE: binary }, 'BETTER_STACK_SOURCE_TOKEN'),
    ).toThrow('TELEMETRY_SECRET_FILE_INVALID');

    expect(() =>
      readTelemetrySecret({ SENTRY_DSN_FILE: join(directory, 'missing') }, 'SENTRY_DSN'),
    ).toThrow('TELEMETRY_SECRET_FILE_REQUIRED');
  });

  it('o módulo do worker é gêmeo: mesma configuração resolvida', () => {
    const sample = {
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'https://public@example.ingest.sentry.io/3',
    };
    expect(workerTelemetry.readTelemetryConfig(sample)).toEqual(readTelemetryConfig(sample));
    expect(workerTelemetry.readTelemetryConfig({})).toEqual(readTelemetryConfig({}));
  });
});

describe('sentryBeforeSend (fixture de PII percorre o pipeline)', () => {
  it('remove tokens, prompts, imagens e dados financeiros do evento', () => {
    const event = sentryBeforeSend({
      type: undefined,
      event_id: 'abc123',
      message: 'falha com token sk-abc123456789012345 e e-mail rhian@example.com',
      user: { id: 'user-1', email: 'rhian@example.com' },
      extra: {
        prompt: 'classifique o bilhete',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
        stakeCents: 1234567890123,
        connection: 'postgres://stakeframe:senha123@db:5432/stake',
      },
      request: { url: 'https://app.example/api?token=abc123def' },
    });
    const serialized = JSON.stringify(event);
    for (const secret of [
      'sk-abc123456789012345',
      'rhian@example.com',
      'classifique o bilhete',
      'data:image/png;base64,iVBORw0KGgo',
      '1234567890123',
      'senha123',
      'abc123def',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(TELEMETRY_REDACTED);
  });
});

describe('createLogShipper (Better Stack)', () => {
  const enabled = {
    enabled: true,
    token: 'token_example',
    ingestingUrl: BETTER_STACK_DEFAULT_URL,
    infoSampleRate: 0,
  };

  it('não envia nada quando desligado', async () => {
    const fetchImpl = vi.fn();
    await createLogShipper({ ...enabled, enabled: false }, fetchImpl as unknown as typeof fetch)(
      'error',
      'falha',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('envia payload sanitizado com o token no header', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    await createLogShipper(enabled, fetchImpl as unknown as typeof fetch)(
      'error',
      'falha com token sk-abc123456789012345',
      {
        email: 'rhian@example.com',
        message: 'rhian@example.com',
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BETTER_STACK_DEFAULT_URL);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token_example');
    const body = String(init.body);
    expect(body).not.toContain('sk-abc123456789012345');
    expect(body).not.toContain('rhian@example.com');
    expect(body).toContain(TELEMETRY_REDACTED);
  });

  it('amostragem de info é desligada por padrão', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const ship = createLogShipper(enabled, fetchImpl as unknown as typeof fetch);
    await ship('info', 'evento de rotina');
    expect(fetchImpl).not.toHaveBeenCalled();
    await createLogShipper({ ...enabled, infoSampleRate: 1 }, fetchImpl as unknown as typeof fetch)(
      'info',
      'evento amostrado',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falha de envio é silenciosa (nunca derruba a aplicação)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      createLogShipper(enabled, fetchImpl as unknown as typeof fetch)('warn', 'aviso'),
    ).resolves.toBeUndefined();
  });
});

describe('scrubTelemetry aplicado às propriedades de eventos (PostHog)', () => {
  it('nada cru sai nas properties', () => {
    const properties = scrubTelemetry({
      distinctId: '8b2f6a1c-7e34-4d2a-9f10-2c5b8a3d6e41',
      page: 'overview',
      email: 'rhian@example.com',
      note: 'token sk-abc123456789012345',
      value: 1234567890123,
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(properties);
    expect(serialized).not.toContain('rhian@example.com');
    expect(serialized).not.toContain('sk-abc123456789012345');
    expect(serialized).not.toContain('1234567890123');
    expect(properties.page).toBe('overview');
    expect(properties.distinctId).toBe('8b2f6a1c-7e34-4d2a-9f10-2c5b8a3d6e41');
  });
});
