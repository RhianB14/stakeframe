import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BetaInvitationError,
  createBetaInvitation,
  createDatabase,
  hashInvitationToken,
  requireDatabaseUrl,
  type BetaInvitationService,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const NAME_PATTERN = /^stk_invite_test_[a-f0-9]{32}$/;
const PROBE_RENAME = 'beta_invitation_probe_failure';

let database: Database;
let databaseName = '';
let created = false;

async function createFreshDatabase(): Promise<BetaInvitationService> {
  databaseName = `stk_invite_test_${randomUUID().replaceAll('-', '')}`;
  if (!NAME_PATTERN.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  return createBetaInvitation(database);
}

async function dropCurrentDatabase() {
  await database?.close();
  if (created && NAME_PATTERN.test(databaseName)) {
    await admin.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  created = false;
}

type InvitationRow = {
  id: string;
  email: string;
  token_hash: string;
  status: string;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

async function readInvitation(id: string): Promise<InvitationRow | undefined> {
  const rows = (
    await database.pool.query<InvitationRow>('SELECT * FROM core.beta_invitation WHERE id = $1', [
      id,
    ])
  ).rows;
  return rows[0];
}

async function countInvitations(): Promise<number> {
  const rows = (
    await database.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM core.beta_invitation',
    )
  ).rows;
  return Number(rows[0]!.count);
}

function futureDate(minutes = 30): Date {
  return new Date(Date.now() + minutes * 60_000);
}

async function expectFailure(promise: Promise<unknown>, code: string) {
  let failure: unknown = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BetaInvitationError);
  expect((failure as BetaInvitationError).code).toBe(code);
  expect((failure as Error).message).toBe(code);
  return failure;
}

afterEach(dropCurrentDatabase);
afterAll(async () => admin.close());

describe('beta invitation foundation with a real PostgreSQL', () => {
  it('applies the migration and creates a pending invitation with a normalized e-mail', async () => {
    const service = await createFreshDatabase();
    const table = (
      await database.pool.query<{ name: string | null }>(
        "SELECT to_regclass('core.beta_invitation')::text AS name",
      )
    ).rows[0]!.name;
    expect(table).toBe('core.beta_invitation');

    const created = await service.createInvitation('  Beta.Invite@Example.TEST ', futureDate());
    expect(created.email).toBe('beta.invite@example.test');
    const row = (await readInvitation(created.invitationId))!;
    expect(row.email).toBe('beta.invite@example.test');
    expect(row.status).toBe('pending');
    expect(row.accepted_at).toBeNull();
    expect(row.accepted_user_id).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('rejects an invalid e-mail without persisting anything', async () => {
    const service = await createFreshDatabase();
    await expectFailure(
      service.createInvitation('  not an email  ', futureDate()),
      'INVITATION_EMAIL_INVALID',
    );
    expect(await countInvitations()).toBe(0);
  });

  it('persists only the hash of the token and never the raw token', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    const row = (await readInvitation(created.invitationId))!;
    const expectedHash = createHash('sha256').update(created.token, 'utf8').digest('hex');
    expect(row.token_hash).toBe(expectedHash);
    expect(hashInvitationToken(created.token)).toBe(expectedHash);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toBe(created.token);
    // The raw token must not exist anywhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  it('redeems a valid token exactly once and returns only minimal data', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    const redeemed = await service.redeemBetaInvitation(created.token);
    expect(redeemed).toEqual({
      invitationId: created.invitationId,
      email: 'beta.invite@example.test',
    });
    expect(Object.keys(redeemed).sort()).toEqual(['email', 'invitationId']);
    expect(JSON.stringify(redeemed)).not.toContain(created.token);
    const row = (await readInvitation(created.invitationId))!;
    expect(row.status).toBe('accepted');
    expect(row.accepted_at).toBeInstanceOf(Date);
    await expectFailure(service.redeemBetaInvitation(created.token), 'INVITATION_ALREADY_ACCEPTED');
  });

  it('refuses an unknown token as sanitized INVITATION_INVALID', async () => {
    const service = await createFreshDatabase();
    await service.createInvitation('beta.invite@example.test', futureDate());
    const failure = await expectFailure(
      service.redeemBetaInvitation('unknown-token-value'),
      'INVITATION_INVALID',
    );
    expect(String(failure)).not.toMatch(/relation|select|token_hash|core\./i);
  });

  it('refuses an expired invitation and keeps it pending', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation(
      'beta.invite@example.test',
      new Date(Date.now() - 60_000),
    );
    await expectFailure(service.redeemBetaInvitation(created.token), 'INVITATION_EXPIRED');
    const row = (await readInvitation(created.invitationId))!;
    expect(row.status).toBe('pending');
    expect(row.accepted_at).toBeNull();
  });

  it('refuses a revoked invitation', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    await database.pool.query("UPDATE core.beta_invitation SET status = 'revoked' WHERE id = $1", [
      created.invitationId,
    ]);
    await expectFailure(service.redeemBetaInvitation(created.token), 'INVITATION_REVOKED');
  });

  it('refuses a second pending invitation for the same e-mail with a stable error', async () => {
    const service = await createFreshDatabase();
    await service.createInvitation('beta.invite@example.test', futureDate());
    await expectFailure(
      service.createInvitation('  BETA.INVITE@example.TEST ', futureDate()),
      'INVITATION_CONFLICT',
    );
    expect(await countInvitations()).toBe(1);
    // After the first invitation is accepted (no longer pending), a new one is allowed.
    const first = (
      await database.pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM core.beta_invitation',
      )
    ).rows[0]!;
    expect(first.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows a new invitation for the same e-mail once the pending one is accepted', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    await service.redeemBetaInvitation(created.token);
    const second = await service.createInvitation('beta.invite@example.test', futureDate());
    expect(second.invitationId).not.toBe(created.invitationId);
    expect(await countInvitations()).toBe(2);
  });

  it('accepts only once under two concurrent redemption attempts', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    const results = await Promise.allSettled([
      service.redeemBetaInvitation(created.token),
      service.redeemBetaInvitation(created.token),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = (rejected[0] as PromiseRejectedResult).reason as BetaInvitationError;
    expect(failure).toBeInstanceOf(BetaInvitationError);
    expect(failure.code).toBe('INVITATION_ALREADY_ACCEPTED');
    const row = (await readInvitation(created.invitationId))!;
    expect(row.status).toBe('accepted');
    const accepted = (
      await database.pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM core.beta_invitation WHERE status = 'accepted'",
      )
    ).rows;
    expect(Number(accepted[0]!.count)).toBe(1);
  });

  it('sanitizes storage failures for creation and redemption', async () => {
    const service = await createFreshDatabase();
    const created = await service.createInvitation('beta.invite@example.test', futureDate());
    await database.pool.query(`ALTER TABLE core.beta_invitation RENAME TO ${PROBE_RENAME}`);
    try {
      const createFailure = await expectFailure(
        service.createInvitation('other.invite@example.test', futureDate()),
        'INVITATION_STORAGE_FAILED',
      );
      const redeemFailure = await expectFailure(
        service.redeemBetaInvitation(created.token),
        'INVITATION_STORAGE_FAILED',
      );
      for (const failure of [createFailure, redeemFailure]) {
        expect(String(failure)).not.toMatch(/relation|does not exist|core\.|postgres|pg_/i);
      }
    } finally {
      await database.pool.query(`ALTER TABLE core.${PROBE_RENAME} RENAME TO beta_invitation`);
    }
    // After restoring the table, the still-pending invitation can be redeemed.
    const redeemed = await service.redeemBetaInvitation(created.token);
    expect(redeemed.invitationId).toBe(created.invitationId);
  });
});
