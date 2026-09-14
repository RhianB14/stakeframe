import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBetaInvitation,
  createDatabase,
  requireDatabaseUrl,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { BETA_INVITE_COOKIE, createOwnerAuth } from '../../apps/api/src/auth.js';
import { createEmailService } from '../../apps/api/src/email-service.js';
import {
  EmailSendError,
  createMemoryEmailSender,
  type EmailSender,
  type MemoryEmailSender,
} from '../../apps/api/src/email.js';
import { createApp } from '../../apps/api/src/app.js';
import type { EnabledAuthConfig } from '../../apps/api/src/auth-config.js';
import { apiErrorSchema } from '../../packages/shared/src/index.js';
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
const databaseName = `stk_email_test_${randomUUID().replaceAll('-', '')}`;
let database: Database;
let created = false;
let app: ReturnType<typeof createApp>;
let transport: MemoryEmailSender;
let clientNumber = 0;

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
function apiCode(response: { json: () => unknown }) {
  return apiErrorSchema.parse(response.json()).error.code;
}
function bodyWithoutRequestId(response: { json: () => unknown }) {
  const body = response.json() as { error?: { requestId?: string } };
  if (body.error) delete body.error.requestId;
  return body;
}
async function dropTestDatabase() {
  if (!/^stk_email_test_[a-f0-9]{32}$/.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`DROP DATABASE "${databaseName}"`);
}

function buildApp(sender?: EmailSender) {
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: createOwnerAuth(config, database, {
      emailService: createEmailService({
        sender: sender ?? transport.sender,
        origin: config.origin,
      }),
    }),
  });
}
async function openInvite(token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/beta-invite/open',
    remoteAddress: nextIp(),
    headers: { origin: config.origin },
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
      origin: config.origin,
      ...(inviteToken
        ? { cookie: `${BETA_INVITE_COOKIE}=${encodeURIComponent(inviteToken)}` }
        : {}),
    },
    payload,
  });
}
async function signIn(
  email: string,
  password: string,
  options: { ip?: string; userAgent?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: options.ip ?? nextIp(),
    headers: {
      origin: config.origin,
      'user-agent': options.userAgent ?? 'stk-integration-agent',
    },
    payload: { email, password },
  });
}
async function signOut(cookie: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    remoteAddress: nextIp(),
    headers: { origin: config.origin, cookie },
    payload: {},
  });
}
async function requestReset(email: string, ip?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/request-password-reset',
    remoteAddress: ip ?? nextIp(),
    headers: { origin: config.origin },
    payload: { email },
  });
}
async function submitReset(token: string, newPassword: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/reset-password',
    remoteAddress: nextIp(),
    headers: { origin: config.origin },
    payload: { token, newPassword },
  });
}
async function resendVerification(email: string, ip?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/send-verification-email',
    remoteAddress: ip ?? nextIp(),
    headers: { origin: config.origin },
    payload: { email },
  });
}
async function count(table: 'user' | 'session' | 'account' | 'verification') {
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
  status: string;
  accepted_at: Date | null;
  accepted_user_id: string | null;
};
async function readInvitation(id: string): Promise<InvitationRow | undefined> {
  return (
    await database.pool.query<InvitationRow>('SELECT * FROM core.beta_invitation WHERE id = $1', [
      id,
    ])
  ).rows[0];
}
async function createInvite(email: string) {
  const invitations = createBetaInvitation(database);
  return invitations.createInvitation(email, new Date(Date.now() + 30 * 60_000));
}
async function verificationLink() {
  const message = transport.takeAll('verification').at(-1);
  expect(message).toBeTruthy();
  return new URL(message!.meta.url!);
}
async function verifyFromTransport() {
  const url = await verificationLink();
  return app.inject({
    url: `${url.pathname}${url.search}`,
    remoteAddress: nextIp(),
  });
}
function resetTokenFromTransport() {
  const message = transport.takeAll('password-reset').at(-1);
  expect(message).toBeTruthy();
  const url = new URL(message!.meta.url!);
  expect(url.origin).toBe(config.origin);
  return url.searchParams.get('reset')!;
}
function mintVerificationToken(email: string, expiresInSeconds: number) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      email: email.toLowerCase(),
      iat: now - 120,
      exp: now + expiresInSeconds,
    }),
  ).toString('base64url');
  const data = `${header}.${payload}`;
  const signature = createHmac('sha256', config.secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}
async function admittedUser(email: string, password = 'fixture-password-1') {
  const invite = await createInvite(email);
  await openInvite(invite.token);
  const created = await signUp({ name: 'Beta Email', email, password }, invite.token);
  expect(created.statusCode).toBe(200);
  const verified = await verifyFromTransport();
  expect(verified.statusCode).toBe(302);
  return { invite, password };
}
function failingSender(): EmailSender {
  return {
    kind: 'memory',
    send: async () => {
      throw new EmailSendError();
    },
  };
}

beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
});
beforeEach(() => {
  transport = createMemoryEmailSender();
  buildApp();
});
afterEach(async () => {
  await app?.close();
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

describe('beta e-mail lifecycle with the Resend abstraction', () => {
  it('signs up, requires verification, resends, verifies and signs in with the isolated organization', async () => {
    const invite = await createInvite('beta.lifecycle@example.test');
    const open = await openInvite(invite.token);
    expect(open.statusCode).toBe(200);
    const created = await signUp(
      {
        name: 'Beta Lifecycle',
        email: 'beta.lifecycle@example.test',
        password: 'fixture-password-1',
      },
      invite.token,
    );
    expect(created.statusCode).toBe(200);
    expect(JSON.stringify(created.json())).not.toMatch(/token|password/i);
    const verification = transport.takeAll('verification').at(-1)!;
    expect(verification.to).toBe('beta.lifecycle@example.test');
    expect(verification.subject).toBe('Confirme seu e-mail no Stakeframe');
    expect(await count('session')).toBe(0);
    // Sign-in before verification: actionable sanitized code, no session, no leak.
    const early = await signIn('beta.lifecycle@example.test', 'fixture-password-1');
    expect(early.statusCode).toBe(403);
    expect(apiCode(early)).toBe('EMAIL_NOT_VERIFIED');
    expect(early.body).not.toMatch(/jose|jwt|driver|postgres|select/i);
    expect(await count('session')).toBe(0);
    // Resend is generic and sends exactly one new verification message.
    transport.clear();
    const resent = await resendVerification('beta.lifecycle@example.test');
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toEqual({ status: true });
    expect(transport.takeAll('verification')).toHaveLength(1);
    const verified = await verifyFromTransport();
    expect(verified.statusCode).toBe(302);
    expect(new URL(verified.headers.location!, config.origin).href).toBe(`${config.origin}/`);
    expect(
      Number(
        (
          await database.pool.query<{ count: string }>(
            'SELECT count(*) FROM auth."user" WHERE email_verified = true',
          )
        ).rows[0]!.count,
      ),
    ).toBe(1);
    // The organization is provisioned only through the authenticated session, and only
    // after the versioned consent documents are accepted.
    const signedIn = await signIn('beta.lifecycle@example.test', 'fixture-password-1');
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieJar(signedIn.headers['set-cookie']);
    const gated = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(gated.statusCode).toBe(403);
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(await countCore('organization')).toBe(1);
    expect(await countCore('membership')).toBe(1);
    // First access never triggers a new-login alert.
    expect(transport.takeAll('new-login')).toHaveLength(0);
    // Sign-in failures are equivalent for existing and unknown e-mails (no enumeration).
    const wrongPassword = await signIn('beta.lifecycle@example.test', 'wrong-password-2');
    const unknown = await signIn('beta.ghost@example.test', 'wrong-password-2');
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(apiCode(wrongPassword)).toBe('AUTH_REQUEST_FAILED');
    expect(bodyWithoutRequestId(wrongPassword)).toEqual(bodyWithoutRequestId(unknown));
  });
  it('refuses expired verification tokens without verifying the account', async () => {
    await admittedUser('beta.expired.verify@example.test');
    await database.pool.query('UPDATE auth."user" SET email_verified = false WHERE email = $1', [
      'beta.expired.verify@example.test',
    ]);
    const expired = mintVerificationToken('beta.expired.verify@example.test', -60);
    const response = await app.inject({
      url: `/api/auth/verify-email?token=${encodeURIComponent(expired)}&callbackURL=%2F`,
      remoteAddress: nextIp(),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/?error=TOKEN_EXPIRED');
    expect(response.headers.location).not.toContain(expired);
    const unverified = await database.pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM auth."user" WHERE email = $1',
      ['beta.expired.verify@example.test'],
    );
    expect(unverified.rows[0]!.email_verified).toBe(false);
    // A freshly issued token still works afterwards.
    const fresh = mintVerificationToken('beta.expired.verify@example.test', 300);
    const retried = await app.inject({
      url: `/api/auth/verify-email?token=${encodeURIComponent(fresh)}&callbackURL=%2F`,
      remoteAddress: nextIp(),
    });
    expect(retried.statusCode).toBe(302);
    const verified = await database.pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM auth."user" WHERE email = $1',
      ['beta.expired.verify@example.test'],
    );
    expect(verified.rows[0]!.email_verified).toBe(true);
  });
  it('treats verification replay as idempotent: no session, no access, no extra identity', async () => {
    await admittedUser('beta.replay.verify@example.test');
    await database.pool.query('UPDATE auth."user" SET email_verified = true WHERE email = $1', [
      'beta.replay.verify@example.test',
    ]);
    const token = mintVerificationToken('beta.replay.verify@example.test', 300);
    const first = await app.inject({
      url: `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`,
      remoteAddress: nextIp(),
    });
    const replay = await app.inject({
      url: `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=%2F`,
      remoteAddress: nextIp(),
    });
    expect(first.statusCode).toBe(302);
    expect(replay.statusCode).toBe(302);
    expect(await count('session')).toBe(0);
    expect(await count('user')).toBe(1);
    expect(replay.body).not.toMatch(/token|jwt/i);
  });
  it('answers resend requests generically for unknown, verified and pending e-mails', async () => {
    const unknown = await resendVerification('beta.unknown@example.test');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ status: true });
    expect(transport.takeAll('verification')).toHaveLength(0);
    await admittedUser('beta.resent@example.test');
    transport.clear();
    const verified = await resendVerification('beta.resent@example.test');
    expect(verified.statusCode).toBe(200);
    expect(transport.takeAll('verification')).toHaveLength(0);
    await database.pool.query('UPDATE auth."user" SET email_verified = false WHERE email = $1', [
      'beta.resent@example.test',
    ]);
    const pending = await resendVerification('beta.resent@example.test');
    expect(pending.statusCode).toBe(200);
    expect(bodyWithoutRequestId(pending)).toEqual(bodyWithoutRequestId(unknown));
    expect(transport.takeAll('verification')).toHaveLength(1);
  });
});

describe('password reset', () => {
  it('resets the password with a single-use token and revokes old sessions', async () => {
    await admittedUser('beta.reset@example.test');
    const signedIn = await signIn('beta.reset@example.test', 'fixture-password-1');
    expect(signedIn.statusCode).toBe(200);
    const oldCookie = cookieJar(signedIn.headers['set-cookie']);
    expect(
      (await acceptRequiredConsents(app, oldCookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: oldCookie } })).statusCode,
    ).toBe(200);
    transport.clear();
    const requested = await requestReset('beta.reset@example.test');
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ status: true });
    const message = transport.takeAll('password-reset').at(-1)!;
    expect(message.subject).toBe('Redefina sua senha do Stakeframe');
    expect(message.html).toContain('30 minutos');
    const token = resetTokenFromTransport();
    const reset = await submitReset(token, 'fixture-password-2');
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: true });
    // The old password no longer works and the previous session was revoked.
    const oldPassword = await signIn('beta.reset@example.test', 'fixture-password-1');
    expect(oldPassword.statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: oldCookie } })).statusCode,
    ).toBe(401);
    const newPassword = await signIn('beta.reset@example.test', 'fixture-password-2');
    expect(newPassword.statusCode).toBe(200);
    const cookie = cookieJar(newPassword.headers['set-cookie']);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
  });
  it('rejects expired reset tokens and accepts a fresh request afterwards', async () => {
    await admittedUser('beta.reset.expired@example.test');
    transport.clear();
    expect((await requestReset('beta.reset.expired@example.test')).statusCode).toBe(200);
    const token = resetTokenFromTransport();
    await database.pool.query(
      `UPDATE auth.verification SET expires_at = now() - interval '1 minute' WHERE identifier = $1`,
      [`reset-password:${token}`],
    );
    const expired = await submitReset(token, 'fixture-password-2');
    expect(expired.statusCode).toBe(400);
    expect(apiCode(expired)).toBe('RESET_REJECTED');
    expect(expired.body).not.toMatch(/reset-password|postgres|driver|select|identifier/i);
    expect((await signIn('beta.reset.expired@example.test', 'fixture-password-2')).statusCode).toBe(
      401,
    );
    // A new request issues a fresh single-use token that works.
    transport.clear();
    expect((await requestReset('beta.reset.expired@example.test')).statusCode).toBe(200);
    const fresh = resetTokenFromTransport();
    expect(fresh).not.toBe(token);
    expect((await submitReset(fresh, 'fixture-password-2')).statusCode).toBe(200);
    expect((await signIn('beta.reset.expired@example.test', 'fixture-password-2')).statusCode).toBe(
      200,
    );
  });
  it('rejects replayed reset tokens', async () => {
    await admittedUser('beta.reset.replay@example.test');
    transport.clear();
    expect((await requestReset('beta.reset.replay@example.test')).statusCode).toBe(200);
    const token = resetTokenFromTransport();
    expect((await submitReset(token, 'fixture-password-2')).statusCode).toBe(200);
    const replay = await submitReset(token, 'fixture-password-3');
    expect(replay.statusCode).toBe(400);
    expect(apiCode(replay)).toBe('RESET_REJECTED');
    // The replayed attempt changed nothing: the password set by the first use holds.
    expect((await signIn('beta.reset.replay@example.test', 'fixture-password-2')).statusCode).toBe(
      200,
    );
    expect((await signIn('beta.reset.replay@example.test', 'fixture-password-3')).statusCode).toBe(
      401,
    );
  });
  it('rejects invalid tokens and answers requests identically for known and unknown e-mails', async () => {
    await admittedUser('beta.reset.enum@example.test');
    const invalid = await submitReset('not-a-real-token', 'fixture-password-2');
    expect(invalid.statusCode).toBe(400);
    expect(apiCode(invalid)).toBe('RESET_REJECTED');
    expect(invalid.body).not.toMatch(/reset-password|postgres|driver|select|identifier|jwt/i);
    transport.clear();
    const known = await requestReset('beta.reset.enum@example.test');
    const unknown = await requestReset('beta.ghost@example.test');
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(bodyWithoutRequestId(known)).toEqual(bodyWithoutRequestId(unknown));
    expect(transport.takeAll('password-reset')).toHaveLength(1);
  });
  it('rate limits reset requests per client without leaking anything', async () => {
    const ip = '192.0.2.240';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++)
      statuses.push((await requestReset('beta.ghost@example.test', ip)).statusCode);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    const limited = await requestReset('beta.ghost@example.test', ip);
    expect(apiCode(limited)).toBe('RATE_LIMITED');
    expect(limited.body).not.toMatch(/postgres|driver|select|token/i);
    // A different client is not affected.
    expect((await requestReset('beta.ghost@example.test')).statusCode).toBe(200);
  });
  it('never creates a reset path for the owner e-mail or password-less accounts', async () => {
    transport.clear();
    const owner = await requestReset(config.ownerEmail);
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({ status: true });
    expect(transport.takeAll('password-reset')).toHaveLength(0);
    expect(await count('account')).toBe(0);
    const userId = randomUUID();
    const accountId = randomUUID();
    await database.pool.query(
      'INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [userId, 'Google Only', 'beta.googleonly@example.test'],
    );
    await database.pool.query(
      'INSERT INTO auth.account (id, user_id, provider_id, account_id) VALUES ($1, $2, $3, $4)',
      [accountId, userId, 'google', 'sub-google-only'],
    );
    transport.clear();
    const googleOnly = await requestReset('beta.googleonly@example.test');
    expect(googleOnly.statusCode).toBe(200);
    expect(transport.takeAll('password-reset')).toHaveLength(0);
  });
});

describe('session lifecycle and new-login alerts', () => {
  it('signs out and invalidates the session', async () => {
    await admittedUser('beta.logout@example.test');
    const signedIn = await signIn('beta.logout@example.test', 'fixture-password-1');
    const cookie = cookieJar(signedIn.headers['set-cookie']);
    expect(await count('session')).toBe(1);
    const out = await signOut(cookie);
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ success: true });
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(401);
    expect(await count('session')).toBe(0);
  });
  it('treats expired sessions as unauthenticated', async () => {
    await admittedUser('beta.expired.session@example.test');
    const signedIn = await signIn('beta.expired.session@example.test', 'fixture-password-1');
    const cookie = cookieJar(signedIn.headers['set-cookie']);
    await database.pool.query(`UPDATE auth.session SET expires_at = now() - interval '1 minute'`);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(me.body).not.toMatch(/expires|session not found|driver|postgres/i);
  });
  it('alerts once on a new login context, without device data, and never blocks login on failure', async () => {
    await admittedUser('beta.alert@example.test');
    transport.clear();
    const ipOne = '192.0.2.201';
    const ipTwo = '192.0.2.202';
    // First access: no alert.
    expect(
      (
        await signIn('beta.alert@example.test', 'fixture-password-1', {
          ip: ipOne,
          userAgent: 'stk-agent-one',
        })
      ).statusCode,
    ).toBe(200);
    expect(transport.takeAll('new-login')).toHaveLength(0);
    // Same device context: still no alert.
    expect(
      (
        await signIn('beta.alert@example.test', 'fixture-password-1', {
          ip: ipOne,
          userAgent: 'stk-agent-one',
        })
      ).statusCode,
    ).toBe(200);
    expect(transport.takeAll('new-login')).toHaveLength(0);
    // New context (same agent, different address): exactly one alert.
    expect(
      (
        await signIn('beta.alert@example.test', 'fixture-password-1', {
          ip: ipTwo,
          userAgent: 'stk-agent-one',
        })
      ).statusCode,
    ).toBe(200);
    const alerts = transport.takeAll('new-login');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe('beta.alert@example.test');
    expect(alerts[0]!.subject).toBe('Novo login na sua conta Stakeframe');
    expect(alerts[0]!.html).not.toContain(ipTwo);
    expect(alerts[0]!.html).not.toContain('stk-agent-one');
    expect(alerts[0]!.text).not.toContain(ipTwo);
    expect(alerts[0]!.text).not.toContain('stk-agent-one');
    expect(alerts[0]!.text).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    // Sender failure: the login still succeeds and nothing partial happens.
    await app.close();
    buildApp(failingSender());
    const failingLogin = await signIn('beta.alert@example.test', 'fixture-password-1', {
      ip: '192.0.2.203',
      userAgent: 'stk-agent-two',
    });
    expect(failingLogin.statusCode).toBe(200);
    const cookie = cookieJar(failingLogin.headers['set-cookie']);
    // The consent route does not touch the e-mail sender; the gate opens for the session.
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
    expect(transport.takeAll('new-login')).toHaveLength(1);
  });
  it('keeps provider failures sanitized during signup and resend without partial acceptance', async () => {
    await app.close();
    buildApp(failingSender());
    const invite = await createInvite('beta.fail@example.test');
    await openInvite(invite.token);
    const created = await signUp(
      { name: 'Beta Fail', email: 'beta.fail@example.test', password: 'fixture-password-1' },
      invite.token,
    );
    // The library keeps the response generic even when the verification send fails.
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toMatch(/resend|EMAIL_SEND_FAILED|postgres|driver|api\./i);
    expect(transport.takeAll('verification')).toHaveLength(0);
    // The invitation holds a consistent single unit: accepted together with the identity.
    const row = (await readInvitation(invite.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_user_id).not.toBeNull();
    expect(await count('user')).toBe(1);
    expect(await count('session')).toBe(0);
    // Resend surfaces a sanitized failure (no provider detail) and sends nothing.
    const resend = await resendVerification('beta.fail@example.test');
    expect(resend.statusCode).toBe(500);
    expect(apiCode(resend)).toBe('INTERNAL_ERROR');
    expect(resend.body).not.toMatch(/resend|EMAIL_SEND_FAILED|api\.|driver|postgres/i);
    expect(transport.takeAll('verification')).toHaveLength(0);
    // Reset requests stay generic even when the sender fails.
    const requested = await requestReset('beta.fail@example.test');
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ status: true });
    expect(transport.takeAll('password-reset')).toHaveLength(0);
  });
  it('never writes secrets, passwords or tokens to the logs during the flows', async () => {
    const captured: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(
          args
            .map((arg) => {
              try {
                return typeof arg === 'string' ? arg : JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            })
            .join(' '),
        );
      }),
    );
    try {
      const passwordMarker = 'marker-password-F106';
      const invite = await createInvite('beta.logs@example.test');
      await openInvite(invite.token);
      await signUp(
        { name: 'Beta Logs', email: 'beta.logs@example.test', password: passwordMarker },
        invite.token,
      );
      const verificationUrl = await verificationLink();
      const verificationToken = verificationUrl.searchParams.get('token')!;
      await resendVerification('beta.logs@example.test');
      await requestReset('beta.logs@example.test');
      const resetToken = resetTokenFromTransport();
      await submitReset(resetToken, passwordMarker);
      const all = captured.join('\n');
      expect(all).not.toContain(passwordMarker);
      expect(all).not.toContain(verificationToken);
      expect(all).not.toContain(resetToken);
      expect(all).not.toContain(invite.token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  it('isolates organizations per admitted e-mail user', async () => {
    await admittedUser('beta.iso.one@example.test');
    await admittedUser('beta.iso.two@example.test');
    const first = await signIn('beta.iso.one@example.test', 'fixture-password-1');
    const second = await signIn('beta.iso.two@example.test', 'fixture-password-1');
    const firstCookie = cookieJar(first.headers['set-cookie']);
    const secondCookie = cookieJar(second.headers['set-cookie']);
    expect(
      (await acceptRequiredConsents(app, firstCookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    expect(
      (await acceptRequiredConsents(app, secondCookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    const firstMe = await app.inject({
      url: '/api/v1/me',
      headers: { cookie: firstCookie },
    });
    const secondMe = await app.inject({
      url: '/api/v1/me',
      headers: { cookie: secondCookie },
    });
    expect(firstMe.statusCode).toBe(200);
    expect(secondMe.statusCode).toBe(200);
    expect(firstMe.json().organization.id).not.toBe(secondMe.json().organization.id);
    expect(await count('user')).toBe(2);
    expect(await countCore('organization')).toBe(2);
    expect(await countCore('membership')).toBe(2);
  });
});
