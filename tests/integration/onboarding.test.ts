import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBetaInvitation,
  createDatabase,
  createFinanceService,
  requireDatabaseUrl,
  type Database,
  type FinanceService,
} from '../../packages/db/src/index.js';
// A rota resolve `@stakeframe/db` para o dist do pacote: o serviço do teste precisa vir do
// MESMO arquivo, senão o `instanceof OnboardingError` falha entre cópias (src × dist).
import { createOnboardingService } from '../../packages/db/dist/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';
import { BETA_INVITE_COOKIE, createOwnerAuth } from '../../apps/api/src/auth.js';
import { createEmailService } from '../../apps/api/src/email-service.js';
import { createMemoryEmailSender } from '../../apps/api/src/email.js';
import { createApp } from '../../apps/api/src/app.js';
import type { EnabledAuthConfig } from '../../apps/api/src/auth-config.js';
import {
  apiErrorSchema,
  onboardingStatusSchema,
  type FinanceCommand,
  type SelectionInput,
} from '../../packages/shared/src/index.js';
import { acceptRequiredConsents } from '../fixtures/consents.js';

const config: EnabledAuthConfig = {
  enabled: true,
  origin: 'http://127.0.0.1:8088',
  secret: createHash('sha256').update('onboarding-tests').digest('hex'),
  googleClientId: 'fixture.apps.googleusercontent.com',
  googleClientSecret: 'test-only-placeholder',
  ownerEmail: 'owner@example.test',
  ownerSubject: '111111111111111111111',
};
const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
let databaseName = '';
let database: Database;
let service: FinanceService;
let onboardingService: ReturnType<typeof createOnboardingService>;
let app: ReturnType<typeof createApp>;
let transport: ReturnType<typeof createMemoryEmailSender>;
let created = false;
let clientNumber = 0;

function nextIp() {
  clientNumber++;
  return `192.0.2.${(clientNumber % 250) + 1}`;
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
async function openInvite(token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/beta-invite/open',
    remoteAddress: nextIp(),
    headers: { origin: config.origin },
    payload: { token },
  });
}
async function signUp(payload: { name: string; email: string; password: string }, token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    remoteAddress: nextIp(),
    headers: {
      origin: config.origin,
      cookie: `${BETA_INVITE_COOKIE}=${encodeURIComponent(token)}`,
    },
    payload,
  });
}
async function signIn(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: nextIp(),
    headers: { origin: config.origin },
    payload: { email, password },
  });
}
async function verifyFromTransport() {
  const message = transport.takeAll('verification').at(-1);
  expect(message).toBeTruthy();
  const url = new URL(message!.meta.url!);
  return app.inject({ url: `${url.pathname}${url.search}`, remoteAddress: nextIp() });
}
async function admittedSession(email: string) {
  const invite = await createBetaInvitation(database).createInvitation(
    email,
    new Date(Date.now() + 30 * 60_000),
  );
  await openInvite(invite.token);
  const signUpResponse = await signUp(
    { name: 'Pessoa do Onboarding', email, password: 'fixture-password-1' },
    invite.token,
  );
  expect(signUpResponse.statusCode).toBe(200);
  const verified = await verifyFromTransport();
  expect(verified.statusCode).toBe(302);
  const signedIn = await signIn(email, 'fixture-password-1');
  expect(signedIn.statusCode).toBe(200);
  return { cookie: cookieJar(signedIn.headers['set-cookie']) };
}
/** Admitted session with consents accepted and the organization provisioned (the /me flow). */
async function onboardingSession(email: string) {
  const { cookie } = await admittedSession(email);
  const accepted = await acceptRequiredConsents(app, cookie, { origin: config.origin });
  expect(accepted.statusCode).toBe(200);
  const me = await app.inject({ url: '/api/v1/me', remoteAddress: nextIp(), headers: { cookie } });
  expect(me.statusCode).toBe(200);
  const session = me.json() as { user: { id: string } };
  return { cookie, userId: session.user.id };
}
async function readStatus(cookie: string) {
  const response = await app.inject({
    url: '/api/v1/onboarding',
    remoteAddress: nextIp(),
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return onboardingStatusSchema.parse(response.json());
}
async function updateProfile(cookie: string, payload: { displayName: string; timezone: string }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/onboarding',
    remoteAddress: nextIp(),
    headers: { cookie, origin: config.origin },
    payload: { step: 'profile', ...payload },
  });
}
async function finishOnboarding(cookie: string, firstBet: 'registered' | 'deferred' = 'deferred') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/onboarding',
    remoteAddress: nextIp(),
    headers: { cookie, origin: config.origin },
    payload: { step: 'finish', firstBet },
  });
}
const selection: SelectionInput = {
  event: 'Time A x Time B',
  sport: 'Futebol',
  market: 'Gols',
  selection: 'Mais de 2,5',
  odds: null,
  eventDate: null,
  eventAt: null,
  dateStatus: 'pending',
};
type CommandInput = FinanceCommand extends infer C
  ? C extends FinanceCommand
    ? Omit<C, 'expectedVersion'>
    : never
  : never;
async function command(actor: string, input: CommandInput) {
  const context = await service.ensureContext(actor);
  return service.command(context, randomUUID(), {
    ...input,
    expectedVersion: (await service.workspace(context)).version,
  } as FinanceCommand);
}
async function initializeBankroll(actor: string) {
  const workspace = await service.workspace(await service.ensureContext(actor));
  const bookmaker = workspace.catalog.find((item) => item.name === 'Bet365')!;
  await command(actor, {
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId: bookmaker.id, amount: '500.00' }],
    unitPercent: '1.00',
  });
  return bookmaker.id;
}
async function publishVersion(type: string, version: string) {
  await database.pool.query(
    `UPDATE core.legal_document SET status = 'superseded' WHERE doc_type = $1 AND status = 'current'`,
    [type],
  );
  const previous = (
    await database.pool.query<{ content_md: string }>(
      'SELECT content_md FROM core.legal_document WHERE doc_type = $1 ORDER BY version DESC LIMIT 1',
      [type],
    )
  ).rows[0]!;
  const hash = createHash('sha256').update(previous.content_md, 'utf8').digest('hex');
  await database.pool.query(
    `INSERT INTO core.legal_document (doc_type, version, title, summary, content_md, content_hash, text_url, required, status, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'current', now())`,
    [
      type,
      version,
      'Documento atualizado (provisório)',
      'Versão atualizada usada pelos testes de re-aceite.',
      previous.content_md,
      hash,
      `/api/v1/legal/documents/${type}/${version}`,
    ],
  );
}

beforeEach(async () => {
  databaseName = `stk_onboarding_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^stk_onboarding_test_[a-f0-9]{32}$/.test(databaseName))
    throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  service = createFinanceService(database);
  transport = createMemoryEmailSender();
  onboardingService = createOnboardingService(database);
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: createOwnerAuth(config, database, {
      emailService: createEmailService({ sender: transport.sender, origin: config.origin }),
    }),
    finance: service,
    onboarding: onboardingService,
  });
});
afterEach(async () => {
  await app?.close();
  await database?.close();
  if (created && /^stk_onboarding_test_[a-f0-9]{32}$/.test(databaseName))
    await admin.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  created = false;
});
afterAll(async () => admin.close());

describe('onboarding with PostgreSQL', () => {
  it('reports a fresh, fully pending onboarding and writes nothing on reads', async () => {
    const { cookie } = await onboardingSession('fresh@example.test');
    const status = await readStatus(cookie);
    expect(status.displayName).toBe('Pessoa do Onboarding');
    expect(status.timezone).toBeNull();
    expect(status.steps.profile.completed).toBe(false);
    expect(status.steps.bankroll.completed).toBe(false);
    expect(status.steps.firstBet.completed).toBe(false);
    expect(status.completedAt).toBeNull();
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state',
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it('rejects an invalid time zone before writing and saves a valid profile', async () => {
    const { cookie, userId } = await onboardingSession('profile@example.test');
    const invalid = await updateProfile(cookie, {
      displayName: 'Nome Válido',
      timezone: 'Invalid/Zone',
    });
    expect(invalid.statusCode).toBe(400);
    expect(apiCode(invalid)).toBe('INVALID_REQUEST');
    const untouched = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state',
    );
    expect(Number(untouched.rows[0]?.count)).toBe(0);

    const saved = await updateProfile(cookie, {
      displayName: 'Rhian Teste',
      timezone: 'America/Sao_Paulo',
    });
    expect(saved.statusCode).toBe(200);
    const status = onboardingStatusSchema.parse(saved.json());
    expect(status.steps.profile.completed).toBe(true);
    expect(status.timezone).toBe('America/Sao_Paulo');
    expect(status.displayName).toBe('Rhian Teste');
    const user = await database.pool.query<{ name: string }>(
      'SELECT name FROM auth."user" WHERE id = $1',
      [userId],
    );
    expect(user.rows[0]?.name).toBe('Rhian Teste');
    const reread = await readStatus(cookie);
    expect(reread.displayName).toBe('Rhian Teste');
    expect(reread.steps.profile.completed).toBe(true);
  });

  it('keeps profile and completion idempotent under repetition and concurrency', async () => {
    const { cookie, userId } = await onboardingSession('repeat@example.test');
    const [first, second] = await Promise.all([
      updateProfile(cookie, { displayName: 'Repetida', timezone: 'America/Sao_Paulo' }),
      updateProfile(cookie, { displayName: 'Repetida', timezone: 'America/Sao_Paulo' }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state',
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
    const profile = await readStatus(cookie);
    const firstCompletedAt = profile.steps.profile.completedAt;
    expect(firstCompletedAt).not.toBeNull();

    const again = await updateProfile(cookie, {
      displayName: 'Repetida',
      timezone: 'America/Sao_Paulo',
    });
    expect(again.statusCode).toBe(200);
    const stable = await readStatus(cookie);
    expect(stable.steps.profile.completedAt).toBe(firstCompletedAt);

    // The explicit conclusion requires the configured bankroll and the first-bet decision.
    await initializeBankroll(userId);
    const [doneA, doneB] = await Promise.all([
      finishOnboarding(cookie, 'deferred'),
      finishOnboarding(cookie, 'deferred'),
    ]);
    expect(doneA.statusCode).toBe(200);
    expect(doneB.statusCode).toBe(200);
    const finished = await readStatus(cookie);
    expect(finished.completedAt).not.toBeNull();
    const repeated = await finishOnboarding(cookie, 'deferred');
    expect(onboardingStatusSchema.parse(repeated.json()).completedAt).toBe(finished.completedAt);
  });

  it('isolates onboarding state between organizations', async () => {
    const alpha = await onboardingSession('alpha@example.test');
    await updateProfile(alpha.cookie, { displayName: 'Alfa', timezone: 'Europe/Lisbon' });
    const beta = await onboardingSession('beta@example.test');

    const betaStatus = await readStatus(beta.cookie);
    expect(betaStatus.displayName).toBe('Pessoa do Onboarding');
    expect(betaStatus.timezone).toBeNull();
    expect(betaStatus.steps.profile.completed).toBe(false);

    const alphaStatus = await readStatus(alpha.cookie);
    expect(alphaStatus.displayName).toBe('Alfa');
    expect(alphaStatus.timezone).toBe('Europe/Lisbon');

    const rows = await database.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM core.onboarding_state',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.organization_id).not.toBeUndefined();
    const betaRows = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state WHERE user_id = $1',
      [beta.userId],
    );
    expect(Number(betaRows.rows[0]?.count)).toBe(0);
  });

  it('requires an effective consent and re-blocks after a version upgrade', async () => {
    const { cookie } = await admittedSession('consent-gate@example.test');
    const blocked = await app.inject({
      url: '/api/v1/onboarding',
      remoteAddress: nextIp(),
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(403);
    expect(apiCode(blocked)).toBe('CONSENT_REQUIRED');
    const blockedWrite = await updateProfile(cookie, {
      displayName: 'Sem Aceite',
      timezone: 'UTC',
    });
    expect(blockedWrite.statusCode).toBe(403);
    expect(apiCode(blockedWrite)).toBe('CONSENT_REQUIRED');

    await acceptRequiredConsents(app, cookie, { origin: config.origin });
    const unlocked = await readStatus(cookie);

    await publishVersion('terms_of_use', '1.0.1-draft');
    const reblocked = await app.inject({
      url: '/api/v1/onboarding',
      remoteAddress: nextIp(),
      headers: { cookie },
    });
    expect(reblocked.statusCode).toBe(403);
    expect(apiCode(reblocked)).toBe('CONSENT_REQUIRED');
    await acceptRequiredConsents(app, cookie, { origin: config.origin });
    expect((await readStatus(cookie)).steps.profile.completed).toBe(
      unlocked.steps.profile.completed,
    );
  });

  it('reflects the existing bankroll command and never registers the opening twice', async () => {
    const { cookie, userId } = await onboardingSession('bankroll@example.test');
    const before = await readStatus(cookie);
    expect(before.steps.bankroll.completed).toBe(false);

    const bookmakerId = await initializeBankroll(userId);
    expect(bookmakerId).toBeTruthy();
    const after = await readStatus(cookie);
    expect(after.steps.bankroll.completed).toBe(true);

    // A repeated confirmation is refused by the existing financial core; nothing duplicates.
    let duplicateError: unknown;
    try {
      await command(userId, {
        type: 'bankroll.initialize',
        reserve: '500.00',
        balances: [{ bookmakerId, amount: '500.00' }],
        unitPercent: '1.00',
      });
    } catch (error) {
      duplicateError = error;
    }
    expect((duplicateError as { code?: string })?.code).toBe('INVALID_FINANCIAL_OPERATION');
    const openings = await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM finance.journal WHERE kind = 'opening'",
    );
    expect(Number(openings.rows[0]?.count)).toBe(1);
    expect((await readStatus(cookie)).steps.bankroll.completed).toBe(true);
  });

  it('marks the first-bet step from registered bets and finishes explicitly', async () => {
    const { cookie, userId } = await onboardingSession('first-bet@example.test');
    await updateProfile(cookie, { displayName: 'Primeira aposta', timezone: 'America/Sao_Paulo' });
    const bookmakerId = await initializeBankroll(userId);
    expect((await readStatus(cookie)).steps.firstBet.completed).toBe(false);

    await command(userId, {
      type: 'bet.create',
      bookmakerId,
      tipsterId: null,
      stake: '100.00',
      odds: '1.85',
      placedAt: new Date().toISOString(),
      freebetId: null,
      reference: '',
      selections: [selection],
      allowMissingUnit: false,
    });
    const withBet = await readStatus(cookie);
    expect(withBet.steps.firstBet).toEqual({ completed: true, resolution: 'registered' });

    const finished = await finishOnboarding(cookie, 'registered');
    expect(finished.statusCode).toBe(200);
    const status = onboardingStatusSchema.parse(finished.json());
    expect(status.completedAt).not.toBeNull();
    expect((await readStatus(cookie)).completedAt).toBe(status.completedAt);
  });

  it('gates the explicit conclusion on the server: profile, bankroll and the first-bet decision', async () => {
    const { cookie, userId } = await onboardingSession('prerequisite@example.test');

    // Before the profile: refused and nothing recorded.
    const beforeProfile = await finishOnboarding(cookie, 'deferred');
    expect(beforeProfile.statusCode).toBe(409);
    expect(apiCode(beforeProfile)).toBe('ONBOARDING_PREREQUISITE');
    const rows = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state',
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);

    // Profile complete but no bankroll for the anchored organization: still refused.
    await updateProfile(cookie, { displayName: 'Prerequisito', timezone: 'America/Sao_Paulo' });
    const beforeBankroll = await finishOnboarding(cookie, 'deferred');
    expect(beforeBankroll.statusCode).toBe(409);
    expect(apiCode(beforeBankroll)).toBe('ONBOARDING_PREREQUISITE');

    // Bankroll configured: the payload field is required, and "registered" without a bet is refused.
    await initializeBankroll(userId);
    const withoutChoice = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: { step: 'finish' },
    });
    expect(withoutChoice.statusCode).toBe(400);
    expect(apiCode(withoutChoice)).toBe('INVALID_REQUEST');
    const claimedWithoutBet = await finishOnboarding(cookie, 'registered');
    expect(claimedWithoutBet.statusCode).toBe(409);
    expect(apiCode(claimedWithoutBet)).toBe('ONBOARDING_PREREQUISITE');

    // The explicit deferral is the valid path and is recorded as the step's resolution.
    const finished = await finishOnboarding(cookie, 'deferred');
    expect(finished.statusCode).toBe(200);
    const status = onboardingStatusSchema.parse(finished.json());
    expect(status.completedAt).not.toBeNull();
    expect(status.steps.firstBet).toEqual({ completed: true, resolution: 'deferred' });
    expect((await readStatus(cookie)).steps.firstBet.resolution).toBe('deferred');
  });

  it('never exposes the anchored financial state to another organization', async () => {
    // The anchored organization configures the single-tenant financial core…
    const anchored = await onboardingSession('anchor@example.test');
    await updateProfile(anchored.cookie, {
      displayName: 'Âncora',
      timezone: 'America/Sao_Paulo',
    });
    const bookmakerId = await initializeBankroll(anchored.userId);
    await command(anchored.userId, {
      type: 'bet.create',
      bookmakerId,
      tipsterId: null,
      stake: '100.00',
      odds: '1.85',
      placedAt: new Date().toISOString(),
      freebetId: null,
      reference: '',
      selections: [selection],
      allowMissingUnit: false,
    });
    const anchoredStatus = await readStatus(anchored.cookie);
    expect(anchoredStatus.steps.bankroll.completed).toBe(true);
    expect(anchoredStatus.steps.firstBet.resolution).toBe('registered');
    const anchoredFinished = await finishOnboarding(anchored.cookie, 'registered');
    expect(anchoredFinished.statusCode).toBe(200);

    // …and a different organization never sees those flags: its own bankroll does not exist
    // yet (the multi-tenant financial core is STK-F1-13) and its conclusion is refused.
    const other = await onboardingSession('other@example.test');
    await updateProfile(other.cookie, { displayName: 'Outra', timezone: 'America/Sao_Paulo' });
    const otherStatus = await readStatus(other.cookie);
    expect(otherStatus.steps.profile.completed).toBe(true);
    expect(otherStatus.steps.bankroll.completed).toBe(false);
    expect(otherStatus.steps.firstBet).toEqual({ completed: false, resolution: null });

    // The refused attempt writes nothing financial: journals (the bankroll opening + the
    // anchored first bet) and bets are unchanged by the 409.
    const journeyCount = async () =>
      Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM finance.journal'))
          .rows[0]?.count,
      );
    const betCount = async () =>
      Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM finance.bet')).rows[0]
          ?.count,
      );
    const journalsBefore = await journeyCount();
    const betsBefore = await betCount();
    const refused = await finishOnboarding(other.cookie, 'deferred');
    expect(refused.statusCode).toBe(409);
    expect(apiCode(refused)).toBe('ONBOARDING_PREREQUISITE');
    expect(await journeyCount()).toBe(journalsBefore);
    expect(await betCount()).toBe(betsBefore);
    expect(journalsBefore).toBe(2);
    expect(betsBefore).toBe(1);
    const anchoredAfter = await readStatus(anchored.cookie);
    expect(anchoredAfter.completedAt).toBe(
      onboardingStatusSchema.parse(anchoredFinished.json()).completedAt,
    );
    const otherRows = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM core.onboarding_state WHERE user_id = $1',
      [other.userId],
    );
    expect(Number(otherRows.rows[0]?.count)).toBe(1);
  });

  it('refuses unauthenticated reads and cross-origin writes', async () => {
    const anonymous = await app.inject({
      url: '/api/v1/onboarding',
      remoteAddress: nextIp(),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(apiCode(anonymous)).toBe('UNAUTHENTICATED');

    const { cookie } = await onboardingSession('origin@example.test');
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/onboarding',
      remoteAddress: nextIp(),
      headers: { cookie, origin: 'https://outra-origem.example' },
      payload: { step: 'finish', firstBet: 'deferred' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(apiCode(crossOrigin)).toBe('ORIGIN_NOT_ALLOWED');
  });
});
