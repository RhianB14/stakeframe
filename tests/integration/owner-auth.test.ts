import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, requireDatabaseUrl, type Database } from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { createOwnerAuth } from '../../apps/api/src/auth.js';
import { createApp } from '../../apps/api/src/app.js';
import type { EnabledAuthConfig } from '../../apps/api/src/auth-config.js';
import {
  apiErrorSchema,
  googleSignInSchema,
  ownerSessionSchema,
  signOutSchema,
} from '../../packages/shared/src/index.js';

const config: EnabledAuthConfig = {
  enabled: true,
  origin: 'http://127.0.0.1:8088',
  secret: randomBytes(32).toString('hex'),
  googleClientId: 'fixture.apps.googleusercontent.com',
  googleClientSecret: 'test-only-placeholder',
  ownerEmail: 'owner@example.test',
  ownerSubject: '111111111111111111111',
};
const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl);
const databaseName = `stk_auth_test_${randomUUID().replaceAll('-', '')}`;
let database: Database;
let created = false;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let tokenRequests = 0;
let challenge: string | null = null;
let clientNumber = 0;
let invalidSignature = false;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function signedToken() {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), privateKey);
  if (invalidSignature) signature[0] = signature[0]! ^ 1;
  return `${data}.${signature.toString('base64url')}`;
}
function cookieJar(header: string | string[] | undefined, previous = '') {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((cookie) => {
        const split = cookie.indexOf('=');
        return [cookie.slice(0, split), cookie.slice(split + 1)];
      }),
  );
  for (const cookie of typeof header === 'string' ? [header] : (header ?? [])) {
    const pair = cookie.split(';')[0]!;
    const split = pair.indexOf('=');
    jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return [...jar]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
async function startLogin(extraHeaders: Record<string, string> = {}, origin = config.origin) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/google',
    remoteAddress: `192.0.2.${clientNumber}`,
    headers: { origin, ...extraHeaders },
    payload: { callbackURL: 'https://untrusted.example.test', provider: 'github' },
  });
  expect(response.statusCode).toBe(200);
  const url = new URL(googleSignInSchema.parse(response.json()).url);
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  challenge = url.searchParams.get('code_challenge');
  const nonce = url.searchParams.get('nonce');
  if (nonce) claims.nonce = nonce;
  return {
    cookie: cookieJar(response.headers['set-cookie']),
    callback: `/api/auth/callback/google?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=fixture-code`,
  };
}
async function login(origin = config.origin) {
  const start = await startLogin({}, origin);
  const response = await app.inject({ url: start.callback, headers: { cookie: start.cookie } });
  return { response, start, cookie: cookieJar(response.headers['set-cookie'], start.cookie) };
}
async function count(table: 'user' | 'session' | 'account') {
  return Number(
    (await database.pool.query<{ count: string }>(`SELECT count(*) FROM auth."${table}"`)).rows[0]
      ?.count,
  );
}
async function dropTestDatabase() {
  if (!/^stk_auth_test_[a-f0-9]{32}$/.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`DROP DATABASE "${databaseName}"`);
}
beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
});
beforeEach(async () => {
  clientNumber++;
  claims = {
    iss: 'https://accounts.google.com',
    aud: config.googleClientId,
    sub: config.ownerSubject,
    email: config.ownerEmail,
    email_verified: true,
    name: 'Fixture Owner',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  tokenRequests = 0;
  challenge = null;
  invalidSignature = false;
  // Only Google's network boundary is replaced. Better Auth verifies the signed JWT,
  // state cookie, PKCE, database hooks and session cookie through the real HTTP adapter.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('code')).toBe('fixture-code');
      expect(
        createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url'),
      ).toBe(challenge);
      return Response.json({
        access_token: 'test-only-access',
        refresh_token: 'test-only-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: signedToken(),
      });
    }
    throw new Error('UNEXPECTED_NETWORK_REQUEST');
  });
  app = createApp({ checkDatabase: database.check, ownerAuth: createOwnerAuth(config, database) });
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  if (database)
    await database.pool.query(
      'TRUNCATE auth."user", auth.account, auth.session, auth.verification CASCADE',
    );
});
afterAll(async () => {
  try {
    await database?.close();
    if (created) await dropTestDatabase();
  } finally {
    await admin.close();
  }
});

describe('Google owner authentication with a real PostgreSQL database', () => {
  it('sets a Secure session cookie for a configured HTTPS origin', async () => {
    await app.close();
    const origin = 'https://auth.example.test';
    app = createApp({
      checkDatabase: database.check,
      ownerAuth: createOwnerAuth({ ...config, origin }, database),
    });
    const { response, cookie } = await login(origin);
    expect(new URL(response.headers.location!, origin).href).toBe(`${origin}/`);
    const raw = response.headers['set-cookie'];
    const sessionCookie = (typeof raw === 'string' ? [raw] : (raw ?? [])).find((value) =>
      value.startsWith('__Secure-stakeframe.session_token='),
    );
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('HttpOnly');
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
  });
  it('applies the migration twice without duplicating its journal', async () => {
    await migrateLocalDatabase(database);
    expect(
      Number(
        (await database.pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0]
          .count,
      ),
    ).toBe(1);
  });
  it('refuses anonymous requests and does not expose generic auth endpoints', async () => {
    expect((await app.inject('/api/v1/me')).statusCode).toBe(401);
    expect((await app.inject('/api/auth/get-session')).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', payload: {} }))
        .statusCode,
    ).toBe(404);
  });
  it('admits only the owner, preserves secure cookie attributes and discards provider tokens', async () => {
    const { response, cookie } = await login();
    expect(response.statusCode).toBe(302);
    expect(response.body).toBe('');
    expect(new URL(response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    const setCookies = response.headers['set-cookie'];
    const sessionCookie = (typeof setCookies === 'string' ? [setCookies] : (setCookies ?? [])).find(
      (value) => value.startsWith('stakeframe.session_token='),
    );
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(ownerSessionSchema.parse(me.json())).toEqual(me.json());
    expect(me.json()).toMatchObject({ user: { name: 'Fixture Owner' } });
    expect(me.body).not.toMatch(/token|email|ipAddress|test-only/);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(await count('user')).toBe(1);
    expect(await count('session')).toBe(1);
    expect(
      (await database.pool.query('SELECT access_token, refresh_token, id_token FROM auth.account'))
        .rows[0],
    ).toEqual({ access_token: null, refresh_token: null, id_token: null });
  });
  it.each([
    { sub: '222222222222222222222' },
    { email: 'other@example.test' },
    { email_verified: false },
    { iss: 'https://attacker.example.test' },
    { aud: 'other-client' },
    { exp: 1 },
    { exp: undefined },
    { azp: 'other-client' },
  ])('rejects invalid identity/token claims %j before creating an account', async (overrides) => {
    Object.assign(claims, overrides);
    const { response } = await login();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
    expect(await count('session')).toBe(0);
  });
  it('rejects a token with a forged signature', async () => {
    invalidSignature = true;
    const { response } = await login();
    expect(response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
  });
  it('limits sign-in attempts using the server peer address, ignoring spoofed IP headers', async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/google',
        remoteAddress: `192.0.2.${clientNumber}`,
        headers: {
          origin: config.origin,
          'x-real-ip': `198.51.100.${attempt}`,
          'x-forwarded-for': `198.51.100.${attempt}`,
        },
        payload: {},
      });
      expect(response.statusCode).toBe(attempt < 5 ? 200 : 429);
      if (attempt === 5) {
        expect(apiErrorSchema.parse(response.json()).error.code).toBe('RATE_LIMITED');
        expect(Number(response.headers['x-retry-after'])).toBeGreaterThan(0);
      }
    }
  });
  it('requires the state cookie and refuses callback replay', async () => {
    const start = await startLogin();
    const missingCookie = await app.inject(start.callback);
    expect(missingCookie.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
    expect(tokenRequests).toBe(0);
    const signed = await login();
    expect(new URL(signed.response.headers.location!, config.origin).href).toBe(
      `${config.origin}/`,
    );
    const requests = tokenRequests;
    const replay = await app.inject({
      url: signed.start.callback,
      headers: { cookie: signed.start.cookie },
    });
    expect(replay.headers.location).toContain('auth=failed');
    expect(tokenRequests).toBe(requests);
    expect(await count('session')).toBe(1);
  });
  it('ignores forwarded host injection and rejects cross-origin mutations', async () => {
    await startLogin({ 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'https' });
    for (const origin of [undefined, 'https://attacker.example.test', 'null']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/google',
        headers: origin ? { origin } : {},
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    }
  });
  it('revokes the session on logout and refuses cross-site logout', async () => {
    const { cookie } = await login();
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: 'https://attacker.example.test' },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(await count('session')).toBe(1);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: config.origin },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(signOutSchema.parse(logout.json())).toEqual({ success: true });
    expect(await count('session')).toBe(0);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });
  it('accepts empty-body sign-in and anonymous sign-out without widening the identity policy', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/google',
      remoteAddress: `192.0.2.${clientNumber}`,
      headers: { origin: config.origin },
    });
    expect(start.statusCode).toBe(200);
    expect(googleSignInSchema.parse(start.json()).redirect).toBe(false);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin: config.origin },
    });
    expect(logout.statusCode).toBe(200);
    expect(signOutSchema.parse(logout.json())).toEqual({ success: true });
    expect(await count('session')).toBe(0);
  });
  it('rejects an expired session without relying on a cookie cache', async () => {
    const { cookie } = await login();
    await database.pool.query("UPDATE auth.session SET expires_at = now() - interval '1 minute'");
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });
  it('rejects a tampered session cookie', async () => {
    const { cookie } = await login();
    const altered = cookie.replace(/(session_token=[^;]+)/, '$1tampered');
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie: altered } })).statusCode).toBe(
      401,
    );
  });
  it('rechecks the Google subject on every authenticated request', async () => {
    const { cookie } = await login();
    await database.pool.query("UPDATE auth.account SET account_id = '222222222222222222222'");
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
