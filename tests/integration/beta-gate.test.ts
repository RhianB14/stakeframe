import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBetaInvitation,
  createDatabase,
  requireDatabaseUrl,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { BETA_INVITE_COOKIE, createOwnerAuth } from '../../apps/api/src/auth.js';
import { createMemoryEmailSender, type MemoryEmailSender } from '../../apps/api/src/email.js';
import { createEmailService } from '../../apps/api/src/email-service.js';
import { createApp } from '../../apps/api/src/app.js';
import type { EnabledAuthConfig } from '../../apps/api/src/auth-config.js';
import { apiErrorSchema, ownerSessionSchema } from '../../packages/shared/src/index.js';
import { acceptRequiredConsents } from '../fixtures/consents.js';

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
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const databaseName = `stk_gate_test_${randomUUID().replaceAll('-', '')}`;
let database: Database;
let created = false;
let app: ReturnType<typeof createApp>;
let transport: MemoryEmailSender;
let claims: Record<string, unknown>;
let tokenRequests = 0;
let challenge: string | null = null;
let clientNumber = 0;
let invalidSignature = false;
let activeOrigin = config.origin;
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
function nextIp() {
  clientNumber++;
  return `192.0.2.${clientNumber % 250}`;
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
function sessionCookieOf(headers: Record<string, unknown>): string | undefined {
  const raw = headers['set-cookie'];
  return (typeof raw === 'string' ? [raw] : ((raw as string[] | undefined) ?? [])).find((value) =>
    value.includes('stakeframe.session_token='),
  );
}
async function startLogin(overrides: Record<string, unknown> = {}) {
  Object.assign(claims, overrides);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/google',
    remoteAddress: nextIp(),
    headers: { origin: config.origin },
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  const url = new URL((response.json() as { url: string }).url);
  expect(url.origin).toBe('https://accounts.google.com');
  challenge = url.searchParams.get('code_challenge');
  const nonce = url.searchParams.get('nonce');
  if (nonce) claims.nonce = nonce;
  return {
    cookie: cookieJar(response.headers['set-cookie']),
    callback: `/api/auth/callback/google?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=fixture-code`,
  };
}
async function googleLogin(
  options: { invokeToken?: string; overrides?: Record<string, unknown> } = {},
) {
  const start = await startLogin(options.overrides ?? {});
  const requestCookie = options.invokeToken
    ? `${start.cookie}; ${BETA_INVITE_COOKIE}=${encodeURIComponent(options.invokeToken)}`
    : start.cookie;
  const response = await app.inject({
    url: start.callback,
    remoteAddress: nextIp(),
    headers: { cookie: requestCookie },
  });
  return { response, start, cookie: cookieJar(response.headers['set-cookie'], requestCookie) };
}
async function openInvite(token: string, origin = activeOrigin) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/beta-invite/open',
    remoteAddress: nextIp(),
    headers: { origin },
    payload: { token },
  });
}
async function signUp(
  payload: { name: string; email: string; password: string },
  inviteToken?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: nextIp(),
    headers: {
      origin: activeOrigin,
      ...(inviteToken
        ? { cookie: `${BETA_INVITE_COOKIE}=${encodeURIComponent(inviteToken)}` }
        : {}),
    },
    payload,
  });
}
async function signIn(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: nextIp(),
    headers: { origin: activeOrigin },
    payload: { email, password },
  });
}
async function userExistsById(id: string): Promise<boolean> {
  const rows = await database.pool.query('SELECT 1 FROM auth."user" WHERE id = $1 LIMIT 1', [id]);
  return rows.rows.length > 0;
}
async function count(table: 'user' | 'session' | 'account') {
  return Number(
    (await database.pool.query<{ count: string }>(`SELECT count(*) FROM auth."${table}"`)).rows[0]
      ?.count,
  );
}
async function countCore(table: 'organization' | 'membership' | 'beta_invitation') {
  return Number(
    (await database.pool.query<{ count: string }>(`SELECT count(*) FROM core.${table}`)).rows[0]
      ?.count,
  );
}
type InvitationRow = {
  id: string;
  email: string;
  status: string;
  accepted_at: Date | null;
  accepted_user_id: string | null;
  expires_at: Date;
};
async function readInvitation(id: string): Promise<InvitationRow | undefined> {
  const rows = (
    await database.pool.query<InvitationRow>('SELECT * FROM core.beta_invitation WHERE id = $1', [
      id,
    ])
  ).rows;
  return rows[0];
}
function futureDate(minutes = 30) {
  return new Date(Date.now() + minutes * 60_000);
}
async function createInvite(email: string, expiresAt = futureDate()) {
  const invitations = createBetaInvitation(database);
  return invitations.createInvitation(email, expiresAt);
}
async function verifyEmailFromTransport() {
  const message = transport.takeAll('verification').at(-1);
  expect(message).toBeTruthy();
  const url = new URL(message!.meta.url!);
  const response = await app.inject({
    url: `${url.pathname}${url.search}`,
    remoteAddress: nextIp(),
  });
  return response;
}
function apiCode(response: { json: () => unknown }) {
  return apiErrorSchema.parse(response.json()).error.code;
}
async function dropTestDatabase() {
  if (!/^stk_gate_test_[a-f0-9]{32}$/.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
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
  activeOrigin = config.origin;
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
  transport = createMemoryEmailSender();
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
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: createOwnerAuth(config, database, {
      emailService: createEmailService({ sender: transport.sender, origin: config.origin }),
    }),
  });
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  if (database)
    await database.pool.query(
      'TRUNCATE auth."user", auth.account, auth.session, auth.verification, core.membership, core.organization, core.beta_invitation CASCADE',
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

describe('beta invitation gate with Google OAuth', () => {
  it('admits an invited external user with a verified e-mail and provisions one organization', async () => {
    const invite = await createInvite('beta.one@example.test');
    const { response, cookie } = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9001', email: 'beta.one@example.test', name: 'Beta One' },
    });
    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    expect(sessionCookieOf(response.headers)).toContain('HttpOnly');
    expect(tokenRequests).toBe(1);
    // Consent gate: the private app is blocked (and nothing is provisioned) until the
    // versioned documents are accepted.
    const gated = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(gated.statusCode).toBe(403);
    expect(apiCode(gated)).toBe('CONSENT_REQUIRED');
    expect(await countCore('organization')).toBe(0);
    expect(
      (await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const session = ownerSessionSchema.parse(me.json());
    expect(session.user.name).toBe('Beta One');
    expect(session.organization.role).toBe('owner');
    expect(me.body).not.toMatch(/token|email|test-only/);
    // Invitation consumed exactly once and linked to the identity.
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_at).toBeInstanceOf(Date);
    const users = (
      await database.pool.query<{ id: string }>('SELECT id FROM auth."user" WHERE email = $1', [
        'beta.one@example.test',
      ])
    ).rows;
    expect(users).toHaveLength(1);
    expect(row.accepted_user_id).toBe(users[0]!.id);
    expect(await count('user')).toBe(1);
    expect(await countCore('organization')).toBe(1);
    expect(await countCore('membership')).toBe(1);
  });
  it('rejects a Google sign-in without any invitation (fail-closed, nothing persisted)', async () => {
    const { response } = await googleLogin({
      overrides: { sub: '9002', email: 'beta.lonely@example.test' },
    });
    expect(response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
    expect(await count('session')).toBe(0);
  });
  it('rejects invalid, expired, revoked and already-accepted invitation tokens', async () => {
    // Invalid token.
    const invalid = await googleLogin({
      invokeToken: 'not-a-real-token',
      overrides: { sub: '9003', email: 'beta.bad@example.test' },
    });
    expect(invalid.response.headers.location).toContain('auth=failed');
    // Expired.
    const expired = await createInvite('beta.expired@example.test', new Date(Date.now() - 60_000));
    expect((await openInvite(expired.token)).statusCode).toBe(403);
    const expiredLogin = await googleLogin({
      invokeToken: expired.token,
      overrides: { sub: '9004', email: 'beta.expired@example.test' },
    });
    expect(expiredLogin.response.headers.location).toContain('auth=failed');
    // Revoked.
    const revoked = await createInvite('beta.revoked@example.test');
    await database.pool.query("UPDATE core.beta_invitation SET status = 'revoked' WHERE id = $1", [
      revoked.invitationId,
    ]);
    expect((await openInvite(revoked.token)).statusCode).toBe(403);
    const revokedLogin = await googleLogin({
      invokeToken: revoked.token,
      overrides: { sub: '9005', email: 'beta.revoked@example.test' },
    });
    expect(revokedLogin.response.headers.location).toContain('auth=failed');
    // Already accepted.
    const accepted = await createInvite('beta.accepted@example.test');
    const bootstrap = await googleLogin({
      invokeToken: accepted.token,
      overrides: { sub: '9006', email: 'beta.accepted@example.test' },
    });
    expect(new URL(bootstrap.response.headers.location!, config.origin).href).toBe(
      `${config.origin}/`,
    );
    expect((await openInvite(accepted.token)).statusCode).toBe(403);
    expect(await count('user')).toBe(1);
    expect(await count('session')).toBe(1);
  });
  it('rejects an invitation whose e-mail does not match the verified Google identity', async () => {
    const invite = await createInvite('beta.match@example.test');
    const { response } = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9007', email: 'beta.other@example.test' },
    });
    expect(response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
    expect((await readInvitation(invite.invitationId))!.status).toBe('pending');
    expect((await readInvitation(invite.invitationId))!.accepted_user_id).toBeNull();
  });
  it('rejects an unverified Google e-mail even with a valid invitation', async () => {
    const invite = await createInvite('beta.unverified@example.test');
    const { response } = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9008', email: 'beta.unverified@example.test', email_verified: false },
    });
    expect(response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(0);
    expect((await readInvitation(invite.invitationId))!.status).toBe('pending');
  });
  it('lets an admitted external user sign in again without the invitation and rejects a foreign identity', async () => {
    const invite = await createInvite('beta.return@example.test');
    const first = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9009', email: 'beta.return@example.test' },
    });
    expect(new URL(first.response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    // A different Google identity reusing the same e-mail must not get access.
    const foreign = await googleLogin({
      overrides: { sub: '9010', email: 'beta.return@example.test' },
    });
    expect(foreign.response.headers.location).toContain('auth=failed');
    expect(await count('user')).toBe(1);
    // The admitted user signs in again without any invitation cookie.
    const again = await googleLogin({
      overrides: { sub: '9009', email: 'beta.return@example.test' },
    });
    expect(new URL(again.response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    expect(await count('session')).toBe(2);
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_user_id).not.toBeNull();
  });
});

describe('beta invitation gate with e-mail and password', () => {
  it('signs up, verifies the e-mail and signs in only with a valid invitation', async () => {
    const invite = await createInvite('beta.email@example.test');
    const open = await openInvite(invite.token);
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ ok: true });
    const rawCookies = open.headers['set-cookie'];
    const inviteCookie = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).find((value) =>
      (value ?? '').startsWith(`${BETA_INVITE_COOKIE}=`),
    );
    expect(inviteCookie).toContain('HttpOnly');
    expect(inviteCookie).toMatch(/SameSite=Lax/i);
    expect(inviteCookie).toContain('Max-Age=3600');
    const created = await signUp(
      { name: 'Beta Signup', email: 'beta.email@example.test', password: 'fixture-password-1' },
      invite.token,
    );
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { user: { id: string; name: string } };
    expect(createdBody.user.name).toBe('Beta Signup');
    expect(JSON.stringify(createdBody)).not.toMatch(/token|password|email/i);
    expect(sessionCookieOf(created.headers)).toBeUndefined();
    expect(await count('user')).toBe(1);
    expect(await count('session')).toBe(0);
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_user_id).toBe(createdBody.user.id);
    const users = (
      await database.pool.query<{ id: string; email_verified: boolean }>(
        'SELECT id, email_verified FROM auth."user"',
      )
    ).rows;
    expect(users).toHaveLength(1);
    expect(users[0]!.email_verified).toBe(false);
    // Sign-in before verification is refused with the actionable sanitized code and
    // creates no session.
    const early = await signIn('beta.email@example.test', 'fixture-password-1');
    expect(early.statusCode).toBe(403);
    expect(apiCode(early)).toBe('EMAIL_NOT_VERIFIED');
    expect(sessionCookieOf(early.headers)).toBeUndefined();
    expect(await count('session')).toBe(0);
    // Verification through the controlled transport.
    const verified = await verifyEmailFromTransport();
    expect(verified.statusCode).toBe(302);
    expect(
      Number(
        (
          await database.pool.query<{ count: string }>(
            'SELECT count(*) FROM auth."user" WHERE email_verified = true',
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);
    // Sign-in after verification obtains a session and the isolated organization.
    const signedIn = await signIn('beta.email@example.test', 'fixture-password-1');
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieJar(signedIn.headers['set-cookie']);
    expect(
      (await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(ownerSessionSchema.parse(me.json()).organization.role).toBe('owner');
    expect(await countCore('organization')).toBe(1);
    expect(await countCore('membership')).toBe(1);
  });
  it('refuses sign-up without an invitation and leaves the invitation untouched', async () => {
    const invite = await createInvite('beta.missing@example.test');
    const refused = await signUp({
      name: 'Beta Missing',
      email: 'beta.missing@example.test',
      password: 'fixture-password-1',
    });
    // Invitation-gated sign-up failures use the same generic response the library gives
    // for existing e-mails (anti-enumeration): no account, no session, no consumption.
    expect(refused.statusCode).toBe(200);
    const body = refused.json() as { user: { id: string } };
    expect(await userExistsById(body.user.id)).toBe(false);
    expect(await count('user')).toBe(0);
    expect(await count('session')).toBe(0);
    expect(await count('account')).toBe(0);
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('pending');
    expect(row.accepted_at).toBeNull();
    expect(row.accepted_user_id).toBeNull();
  });
  it('refuses sign-up when the invitation belongs to another e-mail', async () => {
    const invite = await createInvite('beta.invited@example.test');
    const refused = await signUp(
      { name: 'Beta Wrong', email: 'beta.wrong@example.test', password: 'fixture-password-1' },
      invite.token,
    );
    expect(refused.statusCode).toBe(200);
    const body = refused.json() as { user: { id: string } };
    expect(await userExistsById(body.user.id)).toBe(false);
    expect(await count('user')).toBe(0);
    expect((await readInvitation(invite.invitationId))!.status).toBe('pending');
  });
  it('never creates a password account for the owner e-mail', async () => {
    const invite = await createInvite(config.ownerEmail);
    const refused = await signUp(
      { name: 'Owner Impostor', email: config.ownerEmail, password: 'fixture-password-1' },
      invite.token,
    );
    expect(refused.statusCode).toBe(200);
    const body = refused.json() as { user: { id: string } };
    expect(await userExistsById(body.user.id)).toBe(false);
    expect(await count('user')).toBe(0);
    expect(await count('account')).toBe(0);
    expect((await readInvitation(invite.invitationId))!.status).toBe('pending');
    // The owner Google flow keeps working in the same environment.
    const owner = await googleLogin();
    expect(new URL(owner.response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    expect(await count('user')).toBe(1);
  });
});

describe('beta gate concurrency and sanitization', () => {
  it('accepts a concurrent consumption exactly once', async () => {
    const invite = await createInvite('beta.race@example.test');
    await database.pool.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
      'race-user-1',
      'Race One',
      'beta.race@example.test',
    ]);
    const invitations = createBetaInvitation(database);
    const consume = () =>
      database.orm.transaction((transaction) =>
        invitations.consumeInvitationForUser(transaction, invite.token, {
          userId: 'race-user-1',
          email: 'beta.race@example.test',
        }),
      );
    const results = await Promise.allSettled([consume(), consume()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVITATION_ALREADY_ACCEPTED',
    });
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_user_id).toBe('race-user-1');
  });
  it('does not consume the invitation when session persistence fails after the attempt', async () => {
    const invite = await createInvite('beta.session@example.test');
    const overrides = { sub: '9040', email: 'beta.session@example.test', name: 'Beta Session' };
    // Force a REAL failure on the session write that only fires AFTER the consumption
    // attempt: the trigger blocks the session insert while the invitation is accepted in
    // the SAME transaction. The test therefore only passes when the acceptance actually
    // happened (consumption attempted) and was rolled back with the failed session.
    await database.pool.query(`
      CREATE OR REPLACE FUNCTION stk_session_probe_guard() RETURNS trigger AS $fn$
      BEGIN
        IF (SELECT count(*) FROM core.beta_invitation WHERE status = 'accepted') > 0 THEN
          RAISE EXCEPTION 'session persistence blocked after the consumption attempt';
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql`);
    await database.pool.query(
      'CREATE TRIGGER session_probe_failure BEFORE INSERT ON auth.session FOR EACH ROW EXECUTE FUNCTION stk_session_probe_guard()',
    );
    try {
      const failed = await googleLogin({ invokeToken: invite.token, overrides });
      if (failed.response.statusCode >= 300 && failed.response.statusCode < 400) {
        expect(failed.response.headers.location).toContain('auth=failed');
      } else {
        expect(failed.response.statusCode).toBe(500);
      }
      expect(sessionCookieOf(failed.response.headers)).toBeUndefined();
      expect(failed.response.body).not.toMatch(
        /token|hash|select|insert|postgres|relation|probe|driver/i,
      );
      const location = failed.response.headers.location ?? '';
      expect(location).not.toMatch(/persistence|consumption|token|hash|postgres|relation/i);
    } finally {
      await database.pool.query('DROP TRIGGER IF EXISTS session_probe_failure ON auth.session');
      await database.pool.query('DROP FUNCTION IF EXISTS stk_session_probe_guard()');
    }
    // Nothing partial survived the failed attempt: no session and no acceptance. The
    // identity may exist as an inert, unadmitted row — never with a session or accepted
    // invitation attached.
    expect(await count('session')).toBe(0);
    const pending = (await readInvitation(invite.invitationId))!;
    expect(pending.status).toBe('pending');
    expect(pending.accepted_at).toBeNull();
    expect(pending.accepted_user_id).toBeNull();
    // A valid retry still proceeds: session and acceptance land together.
    const retry = await googleLogin({ invokeToken: invite.token, overrides });
    expect(retry.response.statusCode).toBe(302);
    expect(new URL(retry.response.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    expect(sessionCookieOf(retry.response.headers)).toContain('HttpOnly');
    expect(await count('session')).toBe(1);
    expect(await count('user')).toBe(1);
    const accepted = (await readInvitation(invite.invitationId))!;
    expect(accepted.status).toBe('accepted');
    expect(accepted.accepted_at).toBeInstanceOf(Date);
    expect(accepted.accepted_user_id).not.toBeNull();
  });
  it('keeps org provisioning fail-closed for admitted users when storage breaks', async () => {
    const invite = await createInvite('beta.org@example.test');
    const { cookie } = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9020', email: 'beta.org@example.test' },
    });
    expect(
      (await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
    await database.pool.query('ALTER TABLE core.membership RENAME TO membership_probe_failure');
    try {
      const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
      expect(me.statusCode).toBe(401);
      expect(me.body).not.toMatch(/relation|does not exist|core\.|postgres|probe_failure/i);
    } finally {
      await database.pool.query('ALTER TABLE core.membership_probe_failure RENAME TO membership');
    }
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
  });
  it('never exposes tokens, hashes, passwords or driver details in public responses', async () => {
    const invite = await createInvite('beta.clean@example.test');
    const secrets: string[] = [invite.token];
    const bodies: string[] = [];
    const openBad = await openInvite('probing-token-value');
    expect(openBad.statusCode).toBe(403);
    bodies.push(openBad.body);
    const signUpBad = await signUp(
      { name: 'Beta Clean', email: 'beta.clean@example.test', password: 'fixture-password-1' },
      'probing-token-value-2',
    );
    bodies.push(signUpBad.body);
    secrets.push('probing-token-value', 'probing-token-value-2');
    const signInBad = await signIn('beta.clean@example.test', 'fixture-password-1');
    bodies.push(signInBad.body);
    const loginBad = await googleLogin({
      invokeToken: invite.token,
      overrides: { sub: '9021', email: 'beta.wrong@example.test' },
    });
    expect(loginBad.response.headers.location).toContain('auth=failed');
    const refused = await signUp(
      { name: 'Beta Clean', email: 'beta.clean2@example.test', password: 'fixture-password-1' },
      invite.token,
    );
    bodies.push(refused.body);
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
      expect(body).not.toMatch(/[a-f0-9]{64}/);
      expect(body).not.toMatch(/password|secret|token_hash|relation|pg_|postgres|SELECT|driver/i);
    }
  });
  it('does not expose generic bypass routes for sign-up or owner password access', async () => {
    expect((await app.inject({ url: '/api/auth/get-session' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/link-social', payload: {} })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/change-password',
          payload: { newPassword: 'fixture-password-2' },
        })
      ).statusCode,
    ).toBe(404);
    const noInvite = await signUp({
      name: 'No Invite',
      email: 'beta.noinvite@example.test',
      password: 'fixture-password-1',
    });
    expect(noInvite.statusCode).toBe(200);
    const noInviteBody = noInvite.json() as { user: { id: string } };
    expect(await userExistsById(noInviteBody.user.id)).toBe(false);
    expect(await count('user')).toBe(0);
    expect(await count('session')).toBe(0);
  });
  it('keeps cookie policies on both the invite cookie and the beta session', async () => {
    await app.close();
    const origin = 'https://auth.gate.example.test';
    activeOrigin = origin;
    app = createApp({
      checkDatabase: database.check,
      ownerAuth: createOwnerAuth({ ...config, origin }, database, {
        emailService: createEmailService({ sender: transport.sender, origin }),
      }),
    });
    const invite = await createInvite('beta.secure@example.test');
    const open = await openInvite(invite.token, origin);
    expect(open.statusCode).toBe(200);
    const rawCookies = open.headers['set-cookie'];
    const inviteCookie = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).find((value) =>
      (value ?? '').startsWith(`${BETA_INVITE_COOKIE}=`),
    );
    expect(inviteCookie).toContain('Secure');
    expect(inviteCookie).toContain('HttpOnly');
    expect(inviteCookie).toMatch(/SameSite=Lax/i);
    const created = await signUp(
      { name: 'Beta Secure', email: 'beta.secure@example.test', password: 'fixture-password-1' },
      invite.token,
    );
    expect(created.statusCode).toBe(200);
    await verifyEmailFromTransport();
    const signedIn = await signIn('beta.secure@example.test', 'fixture-password-1');
    expect(signedIn.statusCode).toBe(200);
    const sessionCookie = sessionCookieOf(signedIn.headers);
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    const cookie = cookieJar(signedIn.headers['set-cookie']);
    expect((await acceptRequiredConsents(app, cookie, { origin })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
  });
  it('gives each external user an isolated organization with no sharing', async () => {
    const googleInvite = await createInvite('beta.iso.google@example.test');
    const google = await googleLogin({
      invokeToken: googleInvite.token,
      overrides: { sub: '9030', email: 'beta.iso.google@example.test', name: 'Iso Google' },
    });
    expect(new URL(google.response.headers.location!, config.origin).href).toBe(
      `${config.origin}/`,
    );
    const googleMe = await app.inject({ url: '/api/v1/me', headers: { cookie: google.cookie } });
    expect(googleMe.statusCode).toBe(403);
    expect(
      (await acceptRequiredConsents(app, google.cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    const googleSession = await app.inject({
      url: '/api/v1/me',
      headers: { cookie: google.cookie },
    });
    expect(googleSession.statusCode).toBe(200);
    const emailInvite = await createInvite('beta.iso.email@example.test');
    const created = await signUp(
      { name: 'Iso Email', email: 'beta.iso.email@example.test', password: 'fixture-password-1' },
      emailInvite.token,
    );
    expect(created.statusCode).toBe(200);
    await verifyEmailFromTransport();
    const signedIn = await signIn('beta.iso.email@example.test', 'fixture-password-1');
    const emailCookie = cookieJar(signedIn.headers['set-cookie']);
    expect(
      (await acceptRequiredConsents(app, emailCookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    const emailMe = await app.inject({ url: '/api/v1/me', headers: { cookie: emailCookie } });
    expect(emailMe.statusCode).toBe(200);
    expect(googleSession.json().organization.id).not.toBe(emailMe.json().organization.id);
    expect(await count('user')).toBe(2);
    expect(await countCore('organization')).toBe(2);
    expect(await countCore('membership')).toBe(2);
  });
});
