import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { createMemoryEmailSender } from '../../apps/api/src/email.js';
import { createApp } from '../../apps/api/src/app.js';
import type { EnabledAuthConfig } from '../../apps/api/src/auth-config.js';
import {
  apiErrorSchema,
  consentAcceptedSchema,
  consentHistorySchema,
  consentStatusSchema,
} from '../../packages/shared/src/index.js';
import { acceptRequiredConsents, REQUIRED_CONSENT_TYPES } from '../fixtures/consents.js';

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
const databaseName = `stk_consent_test_${randomUUID().replaceAll('-', '')}`;
let database: Database;
let created = false;
let app: ReturnType<typeof createApp>;
let transport: ReturnType<typeof createMemoryEmailSender>;
let clientNumber = 0;

const SEED_DOCUMENTS = [
  { type: 'terms_of_use', file: 'docs/legal/TERMS-OF-USE-DRAFT-v1.md' },
  { type: 'privacy_policy', file: 'docs/legal/PRIVACY-POLICY-DRAFT-v1.md' },
  { type: 'minimum_age', file: 'docs/legal/MINIMUM-AGE-DRAFT-v1.md' },
] as const;

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
async function dropTestDatabase() {
  if (!/^stk_consent_test_[a-f0-9]{32}$/.test(databaseName))
    throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`DROP DATABASE "${databaseName}"`);
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
    { name: 'Consent Fixture', email, password: 'fixture-password-1' },
    invite.token,
  );
  expect(signUpResponse.statusCode).toBe(200);
  const verified = await verifyFromTransport();
  expect(verified.statusCode).toBe(302);
  const signedIn = await signIn(email, 'fixture-password-1');
  expect(signedIn.statusCode).toBe(200);
  return { cookie: cookieJar(signedIn.headers['set-cookie']), invite };
}
async function countConsentRecords() {
  return Number(
    (await database.pool.query<{ count: string }>('SELECT count(*) FROM core.consent_record'))
      .rows[0]?.count,
  );
}
async function readConsentRows() {
  return (
    await database.pool.query<{
      user_id: string;
      doc_type: string;
      document_version: string;
      document_hash: string;
      accepted_at: Date;
    }>('SELECT * FROM core.consent_record ORDER BY doc_type, accepted_at')
  ).rows;
}
/** Publishes a new current version for a document, superseding the previous one. */
async function publishVersion(
  type: string,
  version: string,
  options: { effectiveAt?: Date; contentOverride?: string } = {},
) {
  await database.pool.query(
    `UPDATE core.legal_document SET status = 'superseded' WHERE doc_type = $1 AND status = 'current'`,
    [type],
  );
  const previous = (
    await database.pool.query<{ content_md: string; content_hash: string }>(
      'SELECT content_md, content_hash FROM core.legal_document WHERE doc_type = $1 ORDER BY version DESC LIMIT 1',
      [type],
    )
  ).rows[0]!;
  const content = options.contentOverride ?? previous.content_md;
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  await database.pool.query(
    `INSERT INTO core.legal_document (doc_type, version, title, summary, content_md, content_hash, text_url, required, status, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'current', $8)`,
    [
      type,
      version,
      'Documento atualizado (provisório)',
      'Versão atualizada usada pelos testes de re-aceite.',
      content,
      hash,
      `/api/v1/legal/documents/${type}/${version}`,
      options.effectiveAt ?? new Date(),
    ],
  );
}
/** Restores the catalog to the migration seed state between tests. */
async function resetLegalCatalog() {
  await database.pool.query('DELETE FROM core.consent_record');
  await database.pool.query('DELETE FROM core.legal_document');
  for (const seed of SEED_DOCUMENTS) {
    const content = readFileSync(seed.file, 'utf8');
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    await database.pool.query(
      `INSERT INTO core.legal_document (doc_type, version, title, summary, content_md, content_hash, text_url, required, status, effective_at)
       VALUES ($1, '1.0.0-draft', $2, $3, $4, $5, $6, true, 'current', '2026-09-14T03:00:00Z')`,
      [
        seed.type,
        `${seed.type} (provisório)`,
        'Documento provisório restaurado pelo teste.',
        content,
        hash,
        `/api/v1/legal/documents/${seed.type}/1.0.0-draft`,
      ],
    );
  }
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
  app = createApp({
    checkDatabase: database.check,
    ownerAuth: createOwnerAuth(config, database, {
      emailService: createEmailService({ sender: transport.sender, origin: config.origin }),
    }),
  });
});
afterEach(async () => {
  await app?.close();
  await resetLegalCatalog();
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

describe('versioned consent catalog and the access gate', () => {
  it('lists the effective required documents and blocks private access until the full acceptance', async () => {
    const { cookie } = await admittedSession('consent.gate@example.test');
    // The private app is blocked before any organization is provisioned or exposed.
    const blocked = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(apiCode(blocked)).toBe('CONSENT_REQUIRED');
    expect(blocked.body).not.toMatch(/organization|membership|postgres|driver|select/i);
    const protectedRoute = await app.inject({ url: '/api/v1/bets', headers: { cookie } });
    expect(protectedRoute.statusCode).toBe(403);
    expect(apiCode(protectedRoute)).toBe('CONSENT_REQUIRED');
    expect(
      Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM core.organization'))
          .rows[0]?.count,
      ),
    ).toBe(0);
    // Status shows the three current documents as pending, with version and validity.
    const status = await app.inject({ url: '/api/v1/consents/status', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    const parsed = consentStatusSchema.parse(status.json());
    expect(parsed.status).toBe('pending');
    expect(parsed.documents.map((document) => document.type).sort()).toEqual(
      [...REQUIRED_CONSENT_TYPES].sort(),
    );
    for (const document of parsed.documents) {
      expect(document.version).toBe('1.0.0-draft');
      expect(document.accepted).toBe(false);
      expect(document.stale).toBe(false);
      expect(document.integrity).toBe('ok');
      expect(document.acceptedAt).toBeNull();
      expect(new Date(document.effectiveAt).getTime()).toBeLessThanOrEqual(Date.now());
      expect(document.textUrl).toBe(`/api/v1/legal/documents/${document.type}/1.0.0-draft`);
    }
    expect(parsed.pendingTypes).toHaveLength(3);
    // Full acceptance: recorded in one call, with a server-side timestamp.
    const before = Date.now();
    const accepted = await acceptRequiredConsents(app, cookie, { origin: config.origin });
    expect(accepted.statusCode).toBe(200);
    const acceptedBody = consentAcceptedSchema.parse(accepted.json());
    expect(acceptedBody.accepted).toHaveLength(3);
    for (const record of acceptedBody.accepted) {
      const timestamp = new Date(record.acceptedAt).getTime();
      expect(timestamp).toBeGreaterThanOrEqual(before - 1_000);
      expect(timestamp).toBeLessThanOrEqual(Date.now() + 1_000);
    }
    // The private app now works and provisions the isolated organization.
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(
      Number(
        (await database.pool.query<{ count: string }>('SELECT count(*) FROM core.organization'))
          .rows[0]?.count,
      ),
    ).toBe(1);
    // The status flips to accepted and stays idempotent.
    const after = consentStatusSchema.parse(
      (await app.inject({ url: '/api/v1/consents/status', headers: { cookie } })).json(),
    );
    expect(after.status).toBe('accepted');
    expect(after.pendingTypes).toHaveLength(0);
    const again = await acceptRequiredConsents(app, cookie, { origin: config.origin });
    expect(again.statusCode).toBe(200);
    expect(consentAcceptedSchema.parse(again.json()).accepted).toHaveLength(3);
    expect(await countConsentRecords()).toBe(3);
  });
  it('refuses partial, unknown and mismatched acceptances without recording anything', async () => {
    const { cookie } = await admittedSession('consent.partial@example.test');
    const partial = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: { documents: [{ type: 'terms_of_use' }, { type: 'privacy_policy' }] },
    });
    expect(partial.statusCode).toBe(400);
    expect(apiCode(partial)).toBe('CONSENT_INVALID');
    expect(partial.body).not.toMatch(/postgres|driver|select|legal_document/i);
    // A version echo that does not match the effective version is refused.
    const wrongVersion = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: {
        documents: REQUIRED_CONSENT_TYPES.map((type) => ({ type, version: '0.9.0-old' })),
      },
    });
    expect(wrongVersion.statusCode).toBe(400);
    expect(apiCode(wrongVersion)).toBe('CONSENT_INVALID');
    // An unknown document type never reaches the service.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: {
        documents: [...REQUIRED_CONSENT_TYPES.map((type) => ({ type })), { type: 'marketing' }],
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(apiCode(unknown)).toBe('INVALID_REQUEST');
    expect(await countConsentRecords()).toBe(0);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(403);
  });
  it('rejects versions that are old or not yet effective and keeps the current acceptance', async () => {
    const { cookie } = await admittedSession('consent.versions@example.test');
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    // Publish v2 for the terms; v1 is superseded and no longer acceptable.
    await publishVersion('terms_of_use', '2.0.0');
    const oldVersion = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: {
        documents: [
          { type: 'terms_of_use', version: '1.0.0-draft' },
          { type: 'privacy_policy' },
          { type: 'minimum_age' },
        ],
      },
    });
    expect(oldVersion.statusCode).toBe(400);
    expect(apiCode(oldVersion)).toBe('CONSENT_INVALID');
    // A future version is not part of the effective catalog either (the current one stays).
    await database.pool.query(
      `INSERT INTO core.legal_document (doc_type, version, title, summary, content_md, content_hash, text_url, required, status, effective_at)
       SELECT 'privacy_policy', '9.9.9', 'Versão futura', 'Versão com vigência futura usada pelos testes.', content_md, content_hash, text_url, true, 'current', now() + interval '1 day'
       FROM core.legal_document WHERE doc_type = 'privacy_policy' AND version = '1.0.0-draft'`,
    );
    const futureVersion = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: {
        documents: [
          { type: 'terms_of_use', version: '2.0.0' },
          { type: 'privacy_policy', version: '9.9.9' },
          { type: 'minimum_age' },
        ],
      },
    });
    expect(futureVersion.statusCode).toBe(400);
    expect(apiCode(futureVersion)).toBe('CONSENT_INVALID');
    // Status reflects the drift: v2 pending, privacy still v1 accepted.
    const status = consentStatusSchema.parse(
      (await app.inject({ url: '/api/v1/consents/status', headers: { cookie } })).json(),
    );
    expect(status.status).toBe('pending');
    expect(status.documents.find((document) => document.type === 'terms_of_use')?.version).toBe(
      '2.0.0',
    );
    expect(status.documents.find((document) => document.type === 'terms_of_use')?.stale).toBe(true);
    expect(status.documents.find((document) => document.type === 'privacy_policy')?.version).toBe(
      '1.0.0-draft',
    );
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(403);
  });
  it('requires re-acceptance after a new version while keeping the old history intact', async () => {
    const { cookie } = await admittedSession('consent.reaccept@example.test');
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
    // A new terms version is published: access is blocked again until acceptance.
    await publishVersion('terms_of_use', '2.0.0');
    const blocked = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(apiCode(blocked)).toBe('CONSENT_REQUIRED');
    const historyAfterUpgrade = consentHistorySchema.parse(
      (await app.inject({ url: '/api/v1/consents/history', headers: { cookie } })).json(),
    );
    expect(
      historyAfterUpgrade.history.filter((record) => record.type === 'terms_of_use'),
    ).toHaveLength(1);
    // Re-accepting adds new rows and unlocks the app again.
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
    const history = consentHistorySchema.parse(
      (await app.inject({ url: '/api/v1/consents/history', headers: { cookie } })).json(),
    );
    const terms = history.history.filter((record) => record.type === 'terms_of_use');
    expect(terms.map((record) => record.version).sort()).toEqual(['1.0.0-draft', '2.0.0']);
    // Deterministic order: newest first.
    for (let index = 1; index < history.history.length; index++) {
      expect(new Date(history.history[index - 1]!.acceptedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(history.history[index]!.acceptedAt).getTime(),
      );
    }
    expect(await countConsentRecords()).toBe(4);
  });
  it('blocks acceptance and re-acceptance when the stored content drifts from its hash', async () => {
    const { cookie } = await admittedSession('consent.drift@example.test');
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    // Silent change of the same version: the stored hash no longer matches the content.
    await database.pool.query(
      `UPDATE core.legal_document SET content_md = content_md || E'\nconteudo alterado sem nova versao' WHERE doc_type = 'terms_of_use'`,
    );
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(403);
    expect(apiCode(me)).toBe('CONSENT_REQUIRED');
    const status = consentStatusSchema.parse(
      (await app.inject({ url: '/api/v1/consents/status', headers: { cookie } })).json(),
    );
    const terms = status.documents.find((document) => document.type === 'terms_of_use')!;
    expect(terms.integrity).toBe('changed');
    expect(terms.accepted).toBe(false);
    // Accepting the drifted document is refused (fail-closed), nothing new is recorded.
    const attempt = await acceptRequiredConsents(app, cookie, { origin: config.origin });
    expect(attempt.statusCode).toBe(400);
    expect(apiCode(attempt)).toBe('CONSENT_INVALID');
    expect(await countConsentRecords()).toBe(3);
  });
  it('refuses a batch that omits a tampered required document (fail-closed, no partial record)', async () => {
    const { cookie } = await admittedSession('consent.tamper@example.test');
    // Silent change of one required document: the stored content no longer matches its hash.
    await database.pool.query(
      `UPDATE core.legal_document SET content_md = content_md || E'\nconteudo adulterado pelo teste' WHERE doc_type = 'minimum_age' AND status = 'current'`,
    );
    // Only the intact documents are provided; the tampered one is omitted on purpose.
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie, origin: config.origin },
      payload: {
        documents: [{ type: 'terms_of_use' }, { type: 'privacy_policy' }],
      },
    });
    expect(attempt.statusCode).toBe(400);
    expect(apiCode(attempt)).toBe('CONSENT_INVALID');
    expect(attempt.body).not.toMatch(
      /postgres|driver|select|legal_document|content_hash|adulterado/i,
    );
    // The whole operation was refused before any insert: no partial acceptance.
    expect(await countConsentRecords()).toBe(0);
    // The private app remains blocked pending the full acceptance.
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(403);
    expect(apiCode(me)).toBe('CONSENT_REQUIRED');
  });
  it('keeps histories isolated per user and ignores client-supplied user ids', async () => {
    const first = await admittedSession('consent.one@example.test');
    const second = await admittedSession('consent.two@example.test');
    expect(
      (await acceptRequiredConsents(app, first.cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    expect(
      (await acceptRequiredConsents(app, second.cookie, { origin: config.origin })).statusCode,
    ).toBe(200);
    // A body claiming another user id must not change whose acceptance is recorded.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/consents/accept',
      remoteAddress: nextIp(),
      headers: { cookie: first.cookie, origin: config.origin },
      payload: {
        user_id: 'attacker-controlled',
        documents: REQUIRED_CONSENT_TYPES.map((type) => ({ type })),
      },
    });
    expect(forged.statusCode).toBe(200);
    const rows = await readConsentRows();
    const firstMe = await app.inject({ url: '/api/v1/me', headers: { cookie: first.cookie } });
    const firstUserId = rows.find(
      (row) => row.doc_type === 'terms_of_use' && row.accepted_at,
    )?.user_id;
    expect(firstUserId).toBeTruthy();
    expect(firstUserId).not.toBe('attacker-controlled');
    expect(firstMe.statusCode).toBe(200);
    expect(rows.length).toBe(6);
    const firstHistory = consentHistorySchema.parse(
      (
        await app.inject({ url: '/api/v1/consents/history', headers: { cookie: first.cookie } })
      ).json(),
    );
    const secondHistory = consentHistorySchema.parse(
      (
        await app.inject({ url: '/api/v1/consents/history', headers: { cookie: second.cookie } })
      ).json(),
    );
    expect(firstHistory.history).toHaveLength(3);
    expect(secondHistory.history).toHaveLength(3);
    // Cross access is impossible: histories only ever come from the session identity.
    const anonymous = await app.inject({ url: '/api/v1/consents/history' });
    expect(anonymous.statusCode).toBe(401);
  });
  it('rolls the whole batch back when one acceptance fails mid-transaction', async () => {
    const { cookie } = await admittedSession('consent.rollback@example.test');
    await database.pool.query(`
      CREATE OR REPLACE FUNCTION stk_consent_probe_guard() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.doc_type = 'terms_of_use' THEN
          RAISE EXCEPTION 'consent probe failure';
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql`);
    await database.pool.query(
      'CREATE TRIGGER consent_probe_failure BEFORE INSERT ON core.consent_record FOR EACH ROW EXECUTE FUNCTION stk_consent_probe_guard()',
    );
    try {
      const attempt = await acceptRequiredConsents(app, cookie, { origin: config.origin });
      expect(attempt.statusCode).toBe(500);
      expect(apiCode(attempt)).toBe('INTERNAL_ERROR');
      expect(attempt.body).not.toMatch(/consent probe|postgres|trigger|driver|select/i);
    } finally {
      await database.pool.query(
        'DROP TRIGGER IF EXISTS consent_probe_failure ON core.consent_record',
      );
      await database.pool.query('DROP FUNCTION IF EXISTS stk_consent_probe_guard()');
    }
    expect(await countConsentRecords()).toBe(0);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(403);
    // A valid retry after the failure still works.
    expect((await acceptRequiredConsents(app, cookie, { origin: config.origin })).statusCode).toBe(
      200,
    );
    expect(await countConsentRecords()).toBe(3);
  });
  it('handles concurrent acceptances idempotently', async () => {
    const { cookie } = await admittedSession('consent.concurrent@example.test');
    const [first, second] = await Promise.all([
      acceptRequiredConsents(app, cookie, { origin: config.origin, remoteAddress: '192.0.2.240' }),
      acceptRequiredConsents(app, cookie, { origin: config.origin, remoteAddress: '192.0.2.241' }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await countConsentRecords()).toBe(3);
    const rows = await readConsentRows();
    expect(new Set(rows.map((row) => row.doc_type)).size).toBe(3);
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(200);
  });
  it('keeps pending-consent sessions restricted to the consent endpoints', async () => {
    const { cookie } = await admittedSession('consent.restricted@example.test');
    // Session stays usable for the consent surface, history and sign-out…
    expect(
      (await app.inject({ url: '/api/v1/consents/status', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/consents/history', headers: { cookie } })).statusCode,
    ).toBe(200);
    const signOut = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      remoteAddress: nextIp(),
      headers: { origin: config.origin, cookie },
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/consents/status', headers: { cookie } })).statusCode,
    ).toBe(401);
    // …but logout never grants private access, and an expired session is unauthenticated.
    expect((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode).toBe(401);
    const another = await admittedSession('consent.expired@example.test');
    await database.pool.query(`UPDATE auth.session SET expires_at = now() - interval '1 minute'`);
    const status = await app.inject({
      url: '/api/v1/consents/status',
      headers: { cookie: another.cookie },
    });
    expect(status.statusCode).toBe(401);
    expect(status.body).not.toMatch(/expires|driver|postgres/i);
  });
  it('serves the versioned legal text publicly without exposing user data', async () => {
    const { cookie } = await admittedSession('consent.reader@example.test');
    const anonymous = await app.inject({
      url: '/api/v1/legal/documents/terms_of_use/1.0.0-draft',
    });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers['content-type']).toContain('text/plain');
    expect(anonymous.body).toContain('Termos de Uso');
    expect(anonymous.body).not.toContain('consent.reader@example.test');
    const missing = await app.inject({
      url: '/api/v1/legal/documents/terms_of_use/4.4.4',
    });
    expect(missing.statusCode).toBe(404);
    const invalidType = await app.inject({ url: '/api/v1/legal/documents/marketing/1.0.0' });
    expect(invalidType.statusCode).toBe(400);
    // The session cookie changes nothing about the public reader.
    const withSession = await app.inject({
      url: '/api/v1/legal/documents/privacy_policy/1.0.0-draft',
      headers: { cookie },
    });
    expect(withSession.statusCode).toBe(200);
    expect(withSession.body).toContain('Política de Privacidade');
  });
  it('never writes consent or identity secrets to the logs during the flows', async () => {
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
      const { cookie } = await admittedSession('consent.logs@example.test');
      const accept = await acceptRequiredConsents(app, cookie, { origin: config.origin });
      expect(accept.statusCode).toBe(200);
      await app.inject({ url: '/api/v1/legal/documents/minimum_age/1.0.0-draft' });
      const rows = await readConsentRows();
      const all = captured.join('\n');
      for (const row of rows) {
        expect(all).not.toContain(row.document_hash);
        expect(all).not.toContain(row.user_id);
      }
      expect(all).not.toContain('fixture-password');
      expect(all).not.toContain(config.secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
