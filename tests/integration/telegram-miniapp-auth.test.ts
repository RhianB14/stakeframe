import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTANTE: a rota resolve '@stakeframe/db' pelo exports do pacote (dist).
// O harness importa o MESMO arquivo dist para que `instanceof FinanceError`
// se comporte como em produção (src × dist são classes diferentes).
import {
  createDatabase,
  createFinanceService,
  createImportService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
  type ImportService,
  type OrganizationContext,
} from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createApp } from '../../apps/api/src/app.js';
import type { OwnerAuth } from '../../apps/api/src/auth.js';

// STK-G0-19-R6 — autenticação REAL da rota de detalhe: sessão web OU initData
// assinado do Mini App (HMAC validado no servidor). Nada é simulado na
// validação: o app completo (Fastify) atende as requisições via inject.

const source = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(source, { statementTimeoutMs: 30_000 });
const image = readFileSync(new URL('../fixtures/ai/synthetic-ticket.png', import.meta.url));
const token = '123456:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN12';
const ownerTelegramId = '424242';
let database: Database;
let finance: FinanceService;
let imports: ImportService;
let tenantContext: OrganizationContext;
let app: ReturnType<typeof createApp>;
let name: string;
const previousEnv = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  owner: process.env.TELEGRAM_OWNER_USER_ID,
};

function sign(over: { user?: string; authDate?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    auth_date: String(over.authDate ?? now),
    query_id: 'AAF',
    user: over.user ?? JSON.stringify({ id: Number(ownerTelegramId), first_name: 'Fixture' }),
  });
  const pairs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
  return params.toString();
}

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_OWNER_USER_ID = ownerTelegramId;
});
afterAll(() => {
  if (previousEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousEnv.token;
  if (previousEnv.owner === undefined) delete process.env.TELEGRAM_OWNER_USER_ID;
  else process.env.TELEGRAM_OWNER_USER_ID = previousEnv.owner;
});
beforeEach(async () => {
  name = `stk_miniapp_auth_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_miniapp_auth_[a-f0-9]{32}$/.test(name)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  const url = new URL(source);
  url.pathname = `/${name}`;
  database = createDatabase(url.toString());
  finance = createFinanceService(database);
  await migrateLocalDatabase(database);
  await database.pool.query(
    "insert into auth.\"user\"(id,name,email) values('fixture-owner','Fixture Owner','fixture-owner@stk.test') on conflict (id) do nothing",
  );
  tenantContext = await finance.ensureContext('fixture-owner');
  imports = createImportService(database);
  const getOwner = vi.fn(async (headers: Headers) =>
    headers.get('cookie')?.includes('session=fake')
      ? { user: { id: 'fixture-owner' }, status: 'active' }
      : null,
  );
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: { origin: 'https://stakeframe.test', getOwner } as unknown as OwnerAuth,
    finance,
    imports,
  });
});
afterEach(async () => {
  await app?.close();
  await database?.close();
  if (/^stk_miniapp_auth_[a-f0-9]{32}$/.test(name))
    await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
});
afterAll(async () => admin.close());

const upload = async (context: OrganizationContext = tenantContext) =>
  (
    await imports.upload(context, randomUUID(), {
      image: image.toString('base64'),
      caption: 'Fixture\nBet365',
    })
  ).id;

describe('mini app authentication on the real import routes', () => {
  it('loads the detail with a valid signed initData and shares the context with PATCH', async () => {
    const id = await upload();
    const initData = sign();
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${id}`,
      headers: { 'x-telegram-init-data': initData },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().item.id).toBe(id);
    // PATCH e GET compartilham o mesmo contexto canônico.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/imports/${id}`,
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { version: 1, betOrigin: 'real' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ version: 2 });
    const reread = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${id}`,
      headers: { 'x-telegram-init-data': initData },
    });
    expect(reread.json()).toMatchObject({ betOrigin: 'real', item: { id } });
  });

  it('accepts production-style file-backed Telegram credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stakeframe-miniapp-auth-'));
    const tokenFile = join(directory, 'telegram_bot_token');
    const ownerFile = join(directory, 'telegram_owner_user_id');
    const previous = {
      token: process.env.TELEGRAM_BOT_TOKEN,
      owner: process.env.TELEGRAM_OWNER_USER_ID,
      tokenFile: process.env.TELEGRAM_BOT_TOKEN_FILE,
      ownerFile: process.env.TELEGRAM_OWNER_USER_ID_FILE,
    };
    try {
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      writeFileSync(ownerFile, `${ownerTelegramId}\n`, { mode: 0o600 });
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_OWNER_USER_ID;
      process.env.TELEGRAM_BOT_TOKEN_FILE = tokenFile;
      process.env.TELEGRAM_OWNER_USER_ID_FILE = ownerFile;
      const id = await upload();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/${id}`,
        headers: { 'x-telegram-init-data': sign() },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      if (previous.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previous.token;
      if (previous.owner === undefined) delete process.env.TELEGRAM_OWNER_USER_ID;
      else process.env.TELEGRAM_OWNER_USER_ID = previous.owner;
      if (previous.tokenFile === undefined) delete process.env.TELEGRAM_BOT_TOKEN_FILE;
      else process.env.TELEGRAM_BOT_TOKEN_FILE = previous.tokenFile;
      if (previous.ownerFile === undefined) delete process.env.TELEGRAM_OWNER_USER_ID_FILE;
      else process.env.TELEGRAM_OWNER_USER_ID_FILE = previous.ownerFile;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a read with no session and no initData', async () => {
    const id = await upload();
    const response = await app.inject({ method: 'GET', url: `/api/v1/imports/${id}` });
    expect(response.statusCode).toBe(401);
  });

  it('refuses invalid, expired and future initData', async () => {
    const id = await upload();
    const invalid = sign().replace(/(hash=)[0-9a-f]{64}/, '$1' + '0'.repeat(64));
    const expired = sign({ authDate: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 });
    const future = sign({ authDate: Math.floor(Date.now() / 1000) + 3600 });
    for (const initData of [invalid, expired, future]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/${id}`,
        headers: { 'x-telegram-init-data': initData },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('refuses a different Telegram user', async () => {
    const id = await upload();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${id}`,
      headers: { 'x-telegram-init-data': sign({ user: JSON.stringify({ id: 111111 }) }) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps organization isolation: another organization id is not found', async () => {
    await database.pool.query(
      "insert into auth.\"user\"(id,name,email) values('fixture-other','Other','other@stk.test') on conflict (id) do nothing",
    );
    const otherContext = await createFinanceService(database).ensureContext('fixture-other');
    const foreignId = await upload(otherContext);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${foreignId}`,
      headers: { 'x-telegram-init-data': sign() },
    });
    expect(response.statusCode).toBe(404);
  });

  it('never leaks the initData into logs or responses', async () => {
    const id = await upload();
    const initData = sign();
    const spies = (['log', 'warn', 'error', 'info'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/${id}`,
        headers: { 'x-telegram-init-data': initData },
      });
      expect(response.statusCode).toBe(200);
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => call.map(String).join(' '))
        .join('\n');
      expect(logged).not.toContain(initData);
      expect(logged).not.toContain(token);
      expect(response.body).not.toContain(initData);
      expect(response.body).not.toContain(token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
