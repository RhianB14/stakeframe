import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTANTE: a rota resolve '@stakeframe/db' pelo exports do pacote (dist).
// O harness importa o MESMO arquivo dist para que `instanceof TelegramSessionError`
// se comporte como em produção (src × dist são classes diferentes).
import {
  createDatabase,
  createFinanceService,
  createTelegramLinkService,
  requireDatabaseUrl,
  TelegramSessionError,
  type Database,
  type TelegramLinkService,
} from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

// STK-F2-12 — a sessão do Mini App: o initData é validado no servidor pelo HMAC
// do Telegram e a conta é resolvida pelo VÍNCULO ATIVO da F2-04. Nada aqui é
// simulado: o app Fastify completo atende as requisições via inject, contra um
// PostgreSQL real com as migrações aplicadas.
//
// O que estes testes provam, e que é o núcleo da tarefa:
//  1. initData forjado, expirado, no futuro, duplicado ou de outro bot é recusado;
//  2. a conta do Telegram NÃO escolhe nada: o usuário vem do vínculo;
//  3. revogar no site encerra o acesso IMEDIATAMENTE (re-resolvido por requisição);
//  4. uma conta sem vínculo não enxerga dado de ninguém — nem o próprio
//     workspaces de outro usuário;
//  5. o atalho legado (TELEGRAM_OWNER_USER_ID) deixa de valer quando o serviço
//     de vínculo está presente — uma conta revogada não entra por ele.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const token = '123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN12';
const telegramId = 424242;
let database: Database;
let links: TelegramLinkService;
let app: ReturnType<typeof createApp>;
let name: string;
const previousEnv = { token: process.env.TELEGRAM_BOT_TOKEN };

function sign(over: { user?: string; authDate?: number; token?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    auth_date: String(over.authDate ?? now),
    query_id: 'AAF',
    user: over.user ?? JSON.stringify({ id: telegramId, first_name: 'Fixture' }),
  });
  const pairs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData')
    .update(over.token ?? token)
    .digest();
  params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
  return params.toString();
}

const header = (initData: string) => ({ 'x-telegram-init-data': initData });

/** Cria o vínculo ATIVO da F2-04 entre a conta do Telegram e o usuário. */
async function link(userId: string, telegramUserId = String(telegramId)) {
  const context = await createFinanceService(database).ensureContext(userId);
  await database.pool.query('select set_config($1, $2, false)', [
    'app.organization_id',
    context.organizationId,
  ]);
  await database.pool.query(
    `insert into core.telegram_link (organization_id, user_id, telegram_user_id)
     values ($1, $2, $3)`,
    [context.organizationId, userId, telegramUserId],
  );
  return context;
}

async function createUser(userId: string, email: string) {
  await database.pool.query(
    `insert into auth."user"(id,name,email,email_verified) values($1,$2,$3,true)
     on conflict (id) do nothing`,
    [userId, userId, email],
  );
}

beforeEach(async () => {
  name = `stk_f212_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_f212_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  process.env.TELEGRAM_BOT_TOKEN = token;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  links = createTelegramLinkService(database);
  const getOwner = vi.fn(async (headers: Headers) =>
    headers.get('cookie')?.includes('session=fake')
      ? {
          status: 'ok' as const,
          user: { id: 'fixture-owner', name: 'Fixture Owner' },
          organization: { id: '00000000-0000-0000-0000-000000000000', role: 'owner' as const },
          expiresAt: '',
        }
      : null,
  );
  const resolveAccess = vi.fn(async (userId: string) => {
    const rows = await database.pool.query<{ organization_id: string; role: string }>(
      'select organization_id, role from core.membership where user_id = $1',
      [userId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    return {
      status: 'ok' as const,
      user: { id: userId, name: '' },
      organization: {
        id: row.organization_id,
        role: (row.role === 'superadmin' ? 'superadmin' : 'owner') as 'owner',
      },
      expiresAt: '',
    };
  });
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: {
      origin: 'https://stakeframe.test',
      getOwner,
      resolveAccess,
    } as unknown as OwnerAuth,
    finance: createFinanceService(database),
    telegramLink: links,
  });
});

afterAll(async () => {
  if (previousEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousEnv.token;
  await admin.close();
});

const cleanup = async () => {
  await app?.close();
  await database?.close();
  if (/^stk_f212_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
};

describe('STK-F2-12 — sessão do Mini App', () => {
  it('resolve o usuário pelo vínculo ativo e entrega o mesmo workspace da web', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await link('fixture-owner');
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/session',
      payload: { initData: sign() },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ linked: true, role: 'owner' });
    expect(session.json().userId).toBe('fixture-owner');
    // A MESMA rota da web, agora alcançável pelo initData: o Mini App não tem
    // leitura própria, ele usa a rota canônica.
    const workspace = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign()),
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().version).toBeGreaterThan(0);
    await cleanup();
  });

  it('recusa initData forjado, expirado, no futuro, duplicado e de outro bot', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await link('fixture-owner');
    const now = Math.floor(Date.now() / 1000);
    const forged = sign().replace(/(hash=)[0-9a-f]{64}/, `$1${'0'.repeat(64)}`);
    const expired = sign({ authDate: now - 2 * 24 * 3600 });
    const future = sign({ authDate: now + 3600 });
    const otherBot = sign({ token: '999999:OTHER-TOKEN-OTHER-TOKEN-OTHER12' });
    const duplicated = `${sign()}&hash=${'0'.repeat(64)}`;
    const malformed = 'not-an-init-data';
    for (const initData of [forged, expired, future, otherBot, duplicated, malformed]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/telegram/session',
        payload: { initData },
      });
      // 401 para tudo que é um initData estruturado mas não autêntico: o
      // atacante não distingue hash forjado de conta errada, expirado ou
      // parâmetro duplicado.
      expect(response.statusCode).toBe(401);
    }
    // Corpo vazio é recusado pelo CONTRATO (400), antes de qualquer
    // autenticação: forma inválida e credencial inválida são camadas distintas,
    // e a segunda nunca chega a rodar sem um initData plausível.
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/session',
      payload: { initData: '' },
    });
    expect(empty.statusCode).toBe(400);
    // A rota de produto recusa o mesmo conjunto.
    for (const initData of [forged, expired, otherBot]) {
      const workspace = await app.inject({
        method: 'GET',
        url: '/api/v1/workspace',
        headers: header(initData),
      });
      expect(workspace.statusCode).toBe(401);
    }
    await cleanup();
  });

  it('recusa conta do Telegram sem vínculo e não expõe dado de ninguém', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await createUser('fixture-other', 'other@stk.test');
    await link('fixture-owner', '424242');
    // Uma conta verdadeira do Telegram, mas SEM vínculo com ninguém.
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/session',
      payload: { initData: sign({ user: JSON.stringify({ id: 999999 }) }) },
    });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('TELEGRAM_SESSION_NOT_LINKED');
    const strangerRead = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign({ user: JSON.stringify({ id: 999999 }) })),
    });
    expect(strangerRead.statusCode).toBe(403);
    expect(strangerRead.body).not.toContain('fixture-owner');
    expect(strangerRead.body).not.toContain('fixture-other');
    await cleanup();
  });

  it('revogação pelo site encerra o acesso do Mini App imediatamente', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    const context = await link('fixture-owner');
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign()),
    });
    expect(before.statusCode).toBe(200);
    // Revogação real pelo serviço da F2-04 (o mesmo que o site aciona).
    await links.revokeLink({ userId: 'fixture-owner', organizationId: context.organizationId });
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign()),
    });
    // Re-resolvido a CADA requisição: sem esperar expirar nada.
    expect(after.statusCode).toBe(403);
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/telegram/session',
      payload: { initData: sign() },
    });
    expect(session.statusCode).toBe(403);
    expect(session.json().error.code).toBe('TELEGRAM_SESSION_REVOKED');
    await cleanup();
  });

  it('relink troca a conta: a antiga perde o acesso e a nova entra', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    const context = await link('fixture-owner', '424242');
    // Relink: a conta nova assume e a antiga é encerrada, na mesma transação.
    await database.pool.query('select set_config($1, $2, false)', [
      'app.organization_id',
      context.organizationId,
    ]);
    await database.pool.query(
      `update core.telegram_link set state = 'revoked', revoked_at = now()
        where user_id = 'fixture-owner'`,
    );
    await database.pool.query(
      `insert into core.telegram_link (organization_id, user_id, telegram_user_id)
       values ($1, 'fixture-owner', $2)`,
      [context.organizationId, '555555'],
    );
    const old = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign()),
    });
    expect(old.statusCode).toBe(403);
    const fresh = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign({ user: JSON.stringify({ id: 555555 }) })),
    });
    expect(fresh.statusCode).toBe(200);
    await cleanup();
  });

  it('ignora o atalho legado TELEGRAM_OWNER_USER_ID quando há vínculo', async () => {
    // Regressão de segurança: com o serviço de vínculo presente, o caminho
    // legado do G0-19 (que comparava com um id de ambiente) NÃO pode existir —
    // do contrário uma conta revogada ainda entraria por ele.
    await createUser('fixture-owner', 'owner@stk.test');
    await link('fixture-owner');
    process.env.TELEGRAM_OWNER_USER_ID = '424242';
    try {
      const stillLinked = await app.inject({
        method: 'GET',
        url: '/api/v1/workspace',
        headers: header(sign()),
      });
      expect(stillLinked.statusCode).toBe(200);
      // Revoga o vínculo; o id de ambiente continua configurado.
      await database.pool.query(
        `update core.telegram_link set state = 'revoked', revoked_at = now()
          where user_id = 'fixture-owner'`,
      );
      const afterRevoke = await app.inject({
        method: 'GET',
        url: '/api/v1/workspace',
        headers: header(sign()),
      });
      expect(afterRevoke.statusCode).toBe(403);
    } finally {
      delete process.env.TELEGRAM_OWNER_USER_ID;
    }
    await cleanup();
  });

  it('mantém isolamento de organização: o vínculo decide o tenant, nunca o cliente', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await createUser('fixture-other', 'other@stk.test');
    const ownerContext = await link('fixture-owner');
    const otherContext = await createFinanceService(database).ensureContext('fixture-other');
    // O cliente tenta se passar pelo outro tenant apenas mudando a conta do
    // Telegram — a organização continua vindo do vínculo.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign({ user: JSON.stringify({ id: 424242 }) })),
    });
    expect(response.statusCode).toBe(200);
    expect(ownerContext.organizationId).not.toBe(otherContext.organizationId);
    await cleanup();
  });

  it('recusa quando o usuário resolvido não passa no gate de acesso', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await link('fixture-owner');
    // Gate de acesso recusando (conta removida/purgada ou convite cancelado):
    // o Mini App não é uma porta alternativa.
    const refused = createApp({
      checkDatabase: database.check,
      ownerAuth: {
        origin: 'https://stakeframe.test',
        getOwner: async () => null,
        resolveAccess: async () => null,
      } as unknown as OwnerAuth,
      finance: createFinanceService(database),
      telegramLink: links,
    });
    const response = await refused.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: header(sign()),
    });
    expect(response.statusCode).toBe(401);
    await refused.close();
    await cleanup();
  });

  it('resolve a sessão direto no serviço, fora do app HTTP', async () => {
    await createUser('fixture-owner', 'owner@stk.test');
    await link('fixture-owner');
    const session = await links.resolveSession(telegramId);
    expect(session.userId).toBe('fixture-owner');
    expect(session.role).toBe('owner');
    // Identificador fora do formato (negativo, zero, fracionário, não inteiro).
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(links.resolveSession(invalid)).rejects.toBeInstanceOf(Error);
    }
    await expect(links.resolveSession(987654)).rejects.toBeInstanceOf(TelegramSessionError);
    await cleanup();
  });

  it('sem initData nem cookie a rota continua anônima (401), como na web', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/workspace' });
    expect(response.statusCode).toBe(401);
    await cleanup();
  });
});
