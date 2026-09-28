// STK-F2-11 — painel interno do superadmin contra o banco real (Plano §7.2, §15).
//
// Cobre os três pontos de risco da unidade:
//  1. autorização por papel: só `superadmin` abre, `owner` recebe 404;
//  2. auditoria: toda tentativa (permitida e recusada) vira linha, e a trilha é
//     somente-adição (UPDATE/DELETE recusados pelo trigger);
//  3. restrição de dados: o painel devolve metadados e NUNCA conteúdo — o teste
//     semeia aposta, journal, saldo e comprovante de uma organização e exige que
//     nenhum valor, texto ou identificador deles apareça em qualquer payload, nem
//     de outra organização.
//
// O isolamento é testado com duas organizações: a fila e os erros de uma não
// podem vazar para a linha da outra.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdminPanelService,
  createDatabase,
  requireDatabaseUrl,
  type AdminPanelService,
  type Database,
  type PoolClient,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const NAME_PATTERN = /^stk_admin_test_[a-f0-9]{32}$/;

let database: Database;
let databaseName = '';
let service: AdminPanelService;

async function insertUser(id: string) {
  // Name and e-mail are deliberately distinctive: the panel must never show
  // either, and the test proves it by searching the serialized payloads.
  await database.pool.query(
    'insert into auth."user"(id,name,email) values($1,$2,$3) on conflict (id) do nothing',
    [id, `NOME PRIVADO ${id}`, `email-privado-${id}@stk.test`],
  );
}

/** One organization with a member, exercising the real tenant context. */
async function seedOrganization(suffix: string, role: 'owner' | 'superadmin') {
  const userId = `admin-fixture-${suffix}`;
  await insertUser(userId);
  const organization = (
    await database.pool.query<{ id: string }>(
      'insert into core.organization(name) values($1) returning id',
      [`Organização ${suffix}`],
    )
  ).rows[0]!;
  await database.pool.query(
    'insert into core.membership(organization_id,user_id,role) values($1,$2,$3)',
    [organization.id, userId, role],
  );
  return { userId, organizationId: organization.id };
}

/** Runs `action` inside a transaction carrying the organization context (F1-13). */
async function withOrganization<T>(
  organizationId: string,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1,$2,true)', ['app.organization_id', organizationId]);
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A financial fact plus a private artifact: none of it may ever be shown. */
async function seedPrivateContent(organizationId: string) {
  await withOrganization(organizationId, async (client) => {
    await client.query(
      "insert into finance.catalog(organization_id,kind,name) values($1,'bookmaker','Casa Privada')",
      [organizationId],
    );
    const reserve = (
      await client.query<{ id: string }>(
        "insert into finance.account(organization_id,kind,name) values($1,'reserve','Reserva') returning id",
        [organizationId],
      )
    ).rows[0]!;
    const exposure = (
      await client.query<{ id: string }>(
        "insert into finance.account(organization_id,kind,name) values($1,'exposure','Principal em aberto') returning id",
        [organizationId],
      )
    ).rows[0]!;
    const journal = (
      await client.query<{ id: string }>(
        'insert into finance.journal(organization_id,kind,effective_at,actor,reason) values($1,$2,now(),$3,$4) returning id',
        [organizationId, 'bet.stake', 'admin-fixture', 'segredo-journal'],
      )
    ).rows[0]!;
    // Par equilibrado entre DUAS contas distintas: a PK do posting é
    // (journal_id, account_id, organization_id) e um mesmo account não repete.
    for (const [accountId, amount] of [
      [exposure.id, '-50000'],
      [reserve.id, '50000'],
    ] as const)
      await client.query(
        'insert into finance.posting(organization_id,journal_id,account_id,amount) values($1,$2,$3,$4)',
        [organizationId, journal.id, accountId, amount],
      );
    // Private import artifact: caption, hash and a failed state. The inbox id has
    // no default, so the fixture supplies it.
    await client.query(
      `insert into integration.inbox(id,organization_id,source_key,sha256,caption,metadata,state,error_code)
       values($1,$2,$3,$4,$5,$6::jsonb,'failed',$7)`,
      [
        randomUUID(),
        organizationId,
        `src-${organizationId}`,
        'a'.repeat(64),
        'CAPTION PRIVADA',
        '{"ticket":"conteudo privado"}',
        'EXTRACTION_FAILED',
      ],
    );
  });
}

beforeEach(async () => {
  databaseName = `stk_admin_test_${randomUUID().replaceAll('-', '')}`;
  if (!NAME_PATTERN.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString(), { statementTimeoutMs: 30_000 });
  await migrateLocalDatabase(database);
  service = createAdminPanelService(database, {
    telemetry: {
      sentry: { enabled: true, environment: 'production' },
      posthog: { enabled: false },
      betterStack: { enabled: false },
      debug: { enabled: false },
    },
  });
});

afterEach(async () => {
  await database?.close();
  if (NAME_PATTERN.test(databaseName))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

describe('STK-F2-11 — auditoria de acesso ao painel', () => {
  it('registra a tentativa permitida antes de devolver a visão', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const accounts = await service.accounts(superadmin.userId, 'req-1', { limit: 50, offset: 0 });
    expect(accounts.total).toBe(1);
    const trail = await service.auditTrail(superadmin.userId, 'req-2', 50);
    const entry = trail.entries.find((row) => row.view === 'accounts')!;
    expect(entry).toMatchObject({
      actorUserId: superadmin.userId,
      view: 'accounts',
      outcome: 'allowed',
      requestId: 'req-1',
    });
  });

  it('registra a recusa de um papel insuficiente e não abre nenhuma visão', async () => {
    const owner = await seedOrganization('owner', 'owner');
    // O serviço não confia no chamador: `deny` é a única porta de recusa, e a
    // rota a usa quando o membership da sessão não é `superadmin`.
    await expect(service.deny(owner.userId, 'accounts', 'req-deny')).rejects.toMatchObject({
      code: 'ADMIN_ROLE_MISMATCH',
    });
    // A recusa grava só a linha 'denied' — nenhuma visão foi servida.
    const rows = (
      await database.pool.query<{ view: string; outcome: string }>(
        'select view, outcome from core.admin_panel_access where actor_user_id = $1',
        [owner.userId],
      )
    ).rows;
    expect(rows).toEqual([{ view: 'accounts', outcome: 'denied' }]);
  });

  it('mantém a trilha somente-adição: reescrever ou apagar é recusado', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    await service.flags(superadmin.userId, 'req-3');
    await expect(
      database.pool.query('update core.admin_panel_access set outcome = $1', ['allowed']),
    ).rejects.toThrow(/ADMIN_AUDIT_IMMUTABLE/);
    await expect(database.pool.query('delete from core.admin_panel_access')).rejects.toThrow(
      /ADMIN_AUDIT_IMMUTABLE/,
    );
  });
});

describe('STK-F2-11 — restrição de dados e isolamento', () => {
  it('nunca devolve conteúdo financeiro, legenda ou identificador privado', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const tenant = await seedOrganization('tenant', 'owner');
    await seedPrivateContent(tenant.organizationId);

    const [accounts, usage, errors, flags, audit] = await Promise.all([
      service.accounts(superadmin.userId, null, { limit: 50, offset: 0 }),
      service.usage(superadmin.userId, null),
      service.errors(superadmin.userId, null),
      service.flags(superadmin.userId, null),
      service.auditTrail(superadmin.userId, null, 50),
    ]);
    const payload = JSON.stringify({ accounts, usage, errors, flags, audit });
    // Conteúdo que existe no banco e NÃO pode aparecer no painel.
    for (const secret of [
      'CAPTION PRIVADA',
      'conteudo privado',
      'segredo-journal',
      'Casa Privada',
      '50000',
      '500.00',
      // Identidade do usuário: nome e e-mail são proibidos — o id interno do
      // usuário NÃO é (é o mesmo pseudônimo que /api/v1/me já devolve ao dono).
      `NOME PRIVADO ${tenant.userId}`,
      `email-privado-${tenant.userId}@stk.test`,
    ])
      expect(payload, secret).not.toContain(secret);
    // Nem o material do comprovante (hash SHA-256) nem qualquer segredo de config.
    expect(payload).not.toContain('a'.repeat(64));
    // O que DEVE aparecer: metadados das duas contas, papel e rótulo da organização.
    expect(accounts.total).toBe(2);
    expect(accounts.accounts.map((row) => row.role).sort()).toEqual(['owner', 'superadmin']);
    expect(accounts.accounts.map((row) => row.userId).sort()).toEqual(
      [superadmin.userId, tenant.userId].sort(),
    );
    expect(payload).toContain('Organização tenant');
  });

  it('soma a cota de IA entre as organizações em vez de escopar por tenant', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const first = await seedOrganization('one', 'owner');
    const second = await seedOrganization('two', 'owner');
    const day = new Date().toISOString().slice(0, 10);
    await database.pool.query(
      'insert into integration.ai_usage_day(day,requests) values($1,$2) on conflict (day) do update set requests = integration.ai_usage_day.requests + $2',
      [day, 30],
    );
    await database.pool.query(
      'insert into integration.ai_usage_day(day,requests) values($1,$2) on conflict (day) do update set requests = integration.ai_usage_day.requests + $2',
      [day, 20],
    );
    const usage = await service.usage(superadmin.userId, null);
    // 30 + 20 = 50 somadas globalmente: escopar por organização devolveria 30.
    expect(usage.ai.requestsToday).toBe(50);
    expect(usage.ai.dailyLimit).toBe(60);
    expect(usage.ai.state).toBe('warning');
    expect(usage.organizations).toBe(3);
    expect(usage.queues.map((row) => row.organizationId).sort()).toEqual(
      [superadmin.organizationId, first.organizationId, second.organizationId].sort(),
    );
  });

  it('conta a fila e os erros de cada organização sem somar entre tenants', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const first = await seedOrganization('one', 'owner');
    const second = await seedOrganization('two', 'owner');
    await seedPrivateContent(first.organizationId);

    const usage = await service.usage(superadmin.userId, null);
    const row = usage.queues.find((item) => item.organizationId === first.organizationId)!;
    const empty = usage.queues.find((item) => item.organizationId === second.organizationId)!;
    expect(row.importFailed).toBe(1);
    expect(row.importPending).toBe(0);
    // A segunda organização não pode enxergar a fila da primeira.
    expect(empty.importFailed).toBe(0);
    expect(empty.importReview).toBe(0);

    const errors = await service.errors(superadmin.userId, null);
    // O código de falha aparece; a legenda e a origem do comprovante, nunca.
    expect(errors.kinds).toContainEqual(
      expect.objectContaining({ source: 'import', code: 'EXTRACTION_FAILED', occurrences: 1 }),
    );
    expect(JSON.stringify(errors)).not.toContain('CAPTION PRIVADA');
  });

  it('publica o estado da telemetria sem nenhum segredo', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const errors = await service.errors(superadmin.userId, null);
    const flags = await service.flags(superadmin.userId, null);
    expect(errors.telemetry.sentry).toEqual({ enabled: true, environment: 'production' });
    const payload = JSON.stringify({ errors, flags });
    expect(payload).not.toMatch(/ingest\.sentry\.io|https:\/\/|dsn/i);
    // As chaves de rollout são as realmente consultadas: hoje, nenhuma.
    expect(flags.rollout).toEqual({ source: 'none', keys: [] });
  });
});

describe('STK-F2-11 — a rota não se anuncia a outro papel', () => {
  it('responde 404 para owner e 200 para superadmin, com auditoria nos dois casos', async () => {
    const superadmin = await seedOrganization('admin', 'superadmin');
    const owner = await seedOrganization('owner', 'owner');
    const app = createApp({
      checkDatabase: async () => {},
      adminPanel: service,
      ownerAuth: {
        origin: 'https://app.test',
        getOwner: async () => ({
          status: 'ok',
          user: { id: superadmin.userId, name: 'Admin' },
          organization: { id: superadmin.organizationId, role: 'superadmin' },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      } as unknown as OwnerAuth,
    });
    const allowed = await app.inject('/api/v1/admin/accounts');
    expect(allowed.statusCode).toBe(200);
    await app.close();

    const refused = createApp({
      checkDatabase: async () => {},
      adminPanel: service,
      ownerAuth: {
        origin: 'https://app.test',
        getOwner: async () => ({
          status: 'ok',
          user: { id: owner.userId, name: 'Titular' },
          organization: { id: owner.organizationId, role: 'owner' },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      } as unknown as OwnerAuth,
    });
    const denied = await refused.inject('/api/v1/admin/accounts');
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await refused.close();

    const trail = await service.auditTrail(superadmin.userId, null, 50);
    expect(
      trail.entries.some(
        (row) => row.actorUserId === superadmin.userId && row.outcome === 'allowed',
      ),
    ).toBe(true);
    expect(
      trail.entries.some((row) => row.actorUserId === owner.userId && row.outcome === 'denied'),
    ).toBe(true);
  });
});
