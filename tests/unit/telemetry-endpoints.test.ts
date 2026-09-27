// STK-F1-10 — endpoints de telemetria: configuração pública e erro sintético.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { TELEMETRY_DEBUG_SYNTHETIC_ERROR } from '../../apps/api/src/debug-routes.js';
import type { TelemetryHandle } from '../../apps/api/src/telemetry.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const ORIGIN = 'https://app.test';
const apps: ReturnType<typeof createApp>[] = [];

function appWith(options: Omit<Parameters<typeof createApp>[0], 'checkDatabase'>) {
  const app = createApp({ checkDatabase: async () => {}, ...options });
  apps.push(app);
  return app;
}

function fakeTelemetry(flags: { debug?: boolean; sentry?: boolean; posthog?: boolean } = {}) {
  const captureError = vi.fn();
  const handle = {
    config: {
      sentry: {
        enabled: flags.sentry,
        // DSNs distintos: o endpoint público serve o DSN do web, nunca o do servidor.
        dsn: flags.sentry ? 'https://server-key@example.ingest.sentry.io/1' : undefined,
        publicDsn: flags.sentry ? 'https://web-key@example.ingest.sentry.io/2' : undefined,
        environment: 'local',
      },
      posthog: {
        enabled: flags.posthog ?? false,
        key: flags.posthog ? 'phc_example' : undefined,
      },
      betterStack: {
        enabled: false,
        token: undefined,
        ingestingUrl: 'https://in.logs.betterstack.com',
        infoSampleRate: 0,
      },
      debug: { enabled: flags.debug ?? false },
    },
    captureError,
    captureEvent: vi.fn(),
    featureFlag: async () => false,
    ship: vi.fn(async () => {}),
    shutdown: async () => {},
  };
  return { handle: handle as unknown as TelemetryHandle, captureError };
}

function fakeOwnerAuth(getOwner: () => Promise<unknown>) {
  return { origin: ORIGIN, getOwner } as unknown as OwnerAuth;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/v1/telemetry/config', () => {
  it('sem configuração devolve tudo desligado (zero config = zero telemetria)', async () => {
    const response = await appWith({}).inject('/api/v1/telemetry/config');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sentry: null,
      posthog: null,
      release: { version: 'unversioned', commit: 'unknown' },
    });
  });

  it('com configuração devolve apenas identificadores públicos', async () => {
    const { handle } = fakeTelemetry({ sentry: true, posthog: true });
    const response = await appWith({ telemetry: handle }).inject('/api/v1/telemetry/config');
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.sentry).toEqual({
      dsn: 'https://web-key@example.ingest.sentry.io/2',
      environment: 'local',
    });
    expect(body.posthog).toEqual({ key: 'phc_example' });
    // O token do Better Stack nunca aparece na resposta pública.
    expect(JSON.stringify(body)).not.toContain('betterstack');
  });

  it('nunca serve o DSN do servidor quando o público não está configurado', async () => {
    const { handle } = fakeTelemetry({ sentry: true });
    (handle.config.sentry as { publicDsn: string | undefined }).publicDsn = undefined;
    const response = await appWith({ telemetry: handle }).inject('/api/v1/telemetry/config');
    const body = response.json() as Record<string, unknown>;
    expect(body.sentry).toBeNull();
    expect(JSON.stringify(body)).not.toContain('server-key');
  });
});

describe('POST /api/v1/debug/telemetry-error', () => {
  it('não existe sem TELEMETRY_DEBUG_ENABLED', async () => {
    const { handle } = fakeTelemetry({ debug: false });
    const response = await appWith({ telemetry: handle }).inject({
      method: 'POST',
      url: '/api/v1/debug/telemetry-error',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(404);
  });

  it('exige autenticação mesmo com a flag ligada', async () => {
    const { handle } = fakeTelemetry({ debug: true });
    const withoutAuth = await appWith({ telemetry: handle }).inject({
      method: 'POST',
      url: '/api/v1/debug/telemetry-error',
      headers: { origin: ORIGIN },
    });
    expect(withoutAuth.statusCode).toBe(503);

    const refused = await appWith({
      telemetry: handle,
      ownerAuth: fakeOwnerAuth(async () => null),
    }).inject({
      method: 'POST',
      url: '/api/v1/debug/telemetry-error',
      headers: { origin: ORIGIN },
    });
    expect(refused.statusCode).toBe(401);

    const wrongOrigin = await appWith({
      telemetry: handle,
      ownerAuth: fakeOwnerAuth(async () => ({ status: 'ok' })),
    }).inject({
      method: 'POST',
      url: '/api/v1/debug/telemetry-error',
      headers: { origin: 'https://evil.test' },
    });
    expect(wrongOrigin.statusCode).toBe(403);
  });

  it('gera o erro sintético e alimenta a telemetria', async () => {
    const { handle, captureError } = fakeTelemetry({ debug: true });
    const response = await appWith({
      telemetry: handle,
      ownerAuth: fakeOwnerAuth(async () => ({
        status: 'ok',
        user: { id: 'user-1', name: 'Owner' },
        organization: { id: 'org-1', role: 'owner' },
        expiresAt: '2030-01-01T00:00:00Z',
      })),
    }).inject({
      method: 'POST',
      url: '/api/v1/debug/telemetry-error',
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(captureError).toHaveBeenCalledTimes(1);
    const [error, context] = captureError.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(TELEMETRY_DEBUG_SYNTHETIC_ERROR);
    expect(context.path).toBe('/api/v1/debug/telemetry-error');
  });
});
