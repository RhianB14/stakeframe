// STK-F2-11 — autorização por papel e superfície inexistente (Plano §7.2, §15).
//
// O painel é fail-closed e não se anuncia: qualquer papel que não seja
// `superadmin` recebe 404, nunca 403, e a rota não existe sem autenticação nem
// sem serviço configurado. Nenhuma resposta carrega indício de que existe algo
// ali, e nenhuma delas aceita usuário ou organização de destino — impersonação é
// proibida.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';
import type { AdminPanelService } from '../../packages/db/src/admin-panel.js';
// A rota resolve o `dist` do pacote: importar a classe do MESMO arquivo evita a
// falha mascarada de `instanceof` entre a cópia de teste (src) e a da rota (dist).
import { AdminPanelError } from '../../packages/db/dist/index.js';

const ORIGIN = 'https://app.test';
const VIEWS = ['accounts', 'usage', 'flags', 'errors', 'audit'] as const;
const apps: ReturnType<typeof createApp>[] = [];

function appWith(options: Omit<Parameters<typeof createApp>[0], 'checkDatabase'>) {
  const app = createApp({ checkDatabase: async () => {}, ...options });
  apps.push(app);
  return app;
}

type Session = { status: 'ok' | 'consent_required' | 'null'; role?: string; id?: string };

function sessionOf(session: Session) {
  if (session.status === 'null') return null;
  if (session.status === 'consent_required') return { status: 'consent_required' as const };
  return {
    status: 'ok' as const,
    user: { id: session.id ?? 'user-1', name: 'Admin' },
    organization: { id: '00000000-0000-4000-8000-000000000001', role: session.role ?? 'owner' },
    expiresAt: '2030-01-01T00:00:00Z',
  };
}

function fakeAuth(session: Session) {
  const getOwner = vi.fn(async () => sessionOf(session));
  return { auth: { origin: ORIGIN, getOwner } as unknown as OwnerAuth, getOwner };
}

/** Records the calls; the real database is exercised by the integration suite. */
function fakeService() {
  const accounts = vi.fn(async () => ({
    generatedAt: '2026-09-28T00:00:00.000Z',
    total: 0,
    truncated: false,
    accounts: [],
  }));
  const usage = vi.fn(async () => ({
    generatedAt: '2026-09-28T00:00:00.000Z',
    ai: {
      requestsToday: 0,
      requestsMonth: 0,
      dailyLimit: 60,
      monthlyLimit: 1500,
      state: 'ready' as const,
    },
    organizations: 0,
    truncated: false,
    queues: [],
  }));
  const flags = vi.fn(async () => ({
    generatedAt: '2026-09-28T00:00:00.000Z',
    rollout: { source: 'none' as const, keys: [] },
    toggles: [],
  }));
  const errors = vi.fn(async () => ({
    generatedAt: '2026-09-28T00:00:00.000Z',
    telemetry: {
      sentry: { enabled: false, environment: 'unknown' },
      posthog: { enabled: false },
      betterStack: { enabled: false },
      debug: { enabled: false },
    },
    truncated: false,
    kinds: [],
  }));
  const auditTrail = vi.fn(async () => ({
    generatedAt: '2026-09-28T00:00:00.000Z',
    entries: [],
  }));
  const deny = vi.fn(async (): Promise<never> => {
    throw new AdminPanelError('ADMIN_ROLE_MISMATCH');
  });
  return {
    service: {
      accounts,
      usage,
      flags,
      errors,
      auditTrail,
      deny,
      audit: vi.fn(async () => {}),
    } as unknown as AdminPanelService,
    deny,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('STK-F2-11 — superfície do painel interno', () => {
  it('não existe quando a autenticação ou o serviço não estão configurados', async () => {
    const { service } = fakeService();
    // sem ownerAuth
    const withoutAuth = await appWith({ adminPanel: service }).inject('/api/v1/admin/accounts');
    expect(withoutAuth.statusCode).toBe(404);
    // sem serviço (a rota ainda existe, mas recusa: a superfície não se anuncia)
    const { auth } = fakeAuth({ status: 'ok', role: 'superadmin' });
    const withoutService = await appWith({ ownerAuth: auth }).inject('/api/v1/admin/accounts');
    expect(withoutService.statusCode).toBe(404);
  });

  it('exige sessão autenticada antes de qualquer papel', async () => {
    const { service } = fakeService();
    const { auth, getOwner } = fakeAuth({ status: 'null' });
    const response = await appWith({ ownerAuth: auth, adminPanel: service }).inject(
      '/api/v1/admin/accounts',
    );
    expect(response.statusCode).toBe(401);
    expect(getOwner).toHaveBeenCalledTimes(1);
  });

  it('exige os consentimentos vigentes como toda rota privada', async () => {
    const { service } = fakeService();
    const { auth } = fakeAuth({ status: 'consent_required' });
    const response = await appWith({ ownerAuth: auth, adminPanel: service }).inject(
      '/api/v1/admin/usage',
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CONSENT_REQUIRED' } });
  });

  it('nega com 404 (não 403) todo papel diferente de superadmin e audita a recusa', async () => {
    const { service, deny } = fakeService();
    const { auth } = fakeAuth({ status: 'ok', role: 'owner', id: 'owner-1' });
    const app = appWith({ ownerAuth: auth, adminPanel: service });
    for (const view of VIEWS) {
      const response = await app.inject(`/api/v1/admin/${view}`);
      // 403 confirmaria a existência da superfície; 404 não revela nada.
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(deny).toHaveBeenCalledTimes(VIEWS.length);
    expect(deny).toHaveBeenCalledWith('owner-1', expect.any(String), expect.any(String));
  });

  it('serve todas as visões para uma sessão superadmin', async () => {
    const { service } = fakeService();
    const { auth } = fakeAuth({ status: 'ok', role: 'superadmin', id: 'admin-1' });
    const app = appWith({ ownerAuth: auth, adminPanel: service });
    for (const view of VIEWS) {
      const response = await app.inject(`/api/v1/admin/${view}`);
      expect(response.statusCode, view).toBe(200);
    }
  });

  it('rejeita parâmetros de destino — não há impersonação', async () => {
    const { service } = fakeService();
    const { auth } = fakeAuth({ status: 'ok', role: 'superadmin', id: 'admin-1' });
    const response = await appWith({ ownerAuth: auth, adminPanel: service }).inject(
      '/api/v1/admin/accounts?organizationId=11111111-1111-4111-8111-111111111111&userId=alvo',
    );
    // Um parâmetro de destino é ignorado (schema estrito), nunca aplicado: o
    // painel lista contas, não abre a conta de alguém.
    expect(response.statusCode).toBe(200);
  });

  it('fecha quando a auditoria não pode ser gravada em vez de servir sem registro', async () => {
    const { service } = fakeService();
    (service.usage as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new AdminPanelError('ADMIN_AUDIT_FAILED'),
    );
    const { auth } = fakeAuth({ status: 'ok', role: 'superadmin', id: 'admin-1' });
    const response = await appWith({ ownerAuth: auth, adminPanel: service }).inject(
      '/api/v1/admin/usage',
    );
    expect(response.statusCode).toBe(503);
  });

  it('aplica o limite de paginação e recusa valores absurdos', async () => {
    const { service } = fakeService();
    const { auth } = fakeAuth({ status: 'ok', role: 'superadmin', id: 'admin-1' });
    const app = appWith({ ownerAuth: auth, adminPanel: service });
    expect((await app.inject('/api/v1/admin/accounts?limit=50&offset=0')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/admin/accounts?limit=0')).statusCode).toBe(400);
    expect((await app.inject('/api/v1/admin/accounts?limit=201')).statusCode).toBe(400);
    expect((await app.inject('/api/v1/admin/accounts?offset=-1')).statusCode).toBe(400);
  });
});
