import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { betaInvitation } from './core-schema.js';
import type { Database } from './index.js';

export type BetaInvitationErrorCode =
  | 'INVITATION_EMAIL_INVALID'
  | 'INVITATION_INVALID'
  | 'INVITATION_EXPIRED'
  | 'INVITATION_REVOKED'
  | 'INVITATION_ALREADY_ACCEPTED'
  | 'INVITATION_CONFLICT'
  | 'INVITATION_STORAGE_FAILED';

/**
 * Stable, sanitized error for the beta-invitation foundation. The message is the code
 * itself, so no token, e-mail, SQL, table name, host, port or connection detail can
 * reach logs or callers.
 */
export class BetaInvitationError extends Error {
  constructor(public readonly code: BetaInvitationErrorCode) {
    super(code);
    this.name = 'BetaInvitationError';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;

/**
 * Normalizes (trim + lowercase) and validates a beta-invitation e-mail.
 * Invalid input never reaches the database and the error carries no input data.
 */
export function normalizeInvitationEmail(input: string): string {
  if (typeof input !== 'string') throw new BetaInvitationError('INVITATION_EMAIL_INVALID');
  const email = input.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new BetaInvitationError('INVITATION_EMAIL_INVALID');
  }
  return email;
}

/**
 * Deterministic SHA-256 of the raw token (hex). Only the hash is persisted; the raw
 * token exists in memory only during creation. Lookup is by the unique index on the
 * hash column, so no timing-sensitive string comparison happens in application code.
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type CreatedBetaInvitation = {
  invitationId: string;
  email: string;
  expiresAt: string;
  /** Raw token — returned only to the authorized internal caller; never persisted or logged. */
  token: string;
};

export type RedeemedBetaInvitation = {
  invitationId: string;
  email: string;
};

function isPendingEmailConflict(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError), so walk the cause chain looking for
  // the pg unique-violation metadata. Never inspect messages: they can contain SQL.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (
      candidate.code === '23505' &&
      candidate.constraint === 'beta_invitation_pending_email_key'
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function rollback(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original failure is the one worth reporting; a broken connection is simply released.
  }
}

/**
 * Beta-invitation foundation (access to the closed beta).
 *
 * - This is NOT organization membership: the organization keeps being derived from the
 *   authenticated user (F1-01/F1-03). A redeemed invitation never lets the caller pick
 *   an organization.
 * - The raw token never reaches the database, logs, errors or documentation; only its
 *   SHA-256 hash is stored.
 * - Public routes (F1-05) expose only the sanitized open/consume paths; the raw token is
 *   handled at the strictly necessary boundary and discarded after validation.
 */
export function createBetaInvitation(database: Database) {
  async function createInvitation(email: string, expiresAt: Date): Promise<CreatedBetaInvitation> {
    const normalized = normalizeInvitationEmail(email);
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new TypeError('INVALID_EXPIRY');
    }
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = hashInvitationToken(token);
    let row: { id: string; email: string; expiresAt: Date } | undefined;
    try {
      const inserted = await database.orm
        .insert(betaInvitation)
        .values({ email: normalized, tokenHash, expiresAt })
        .returning({
          id: betaInvitation.id,
          email: betaInvitation.email,
          expiresAt: betaInvitation.expiresAt,
        });
      row = inserted[0];
    } catch (error) {
      if (isPendingEmailConflict(error)) throw new BetaInvitationError('INVITATION_CONFLICT');
      throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
    }
    if (!row) throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
    return {
      invitationId: row.id,
      email: row.email,
      expiresAt: row.expiresAt.toISOString(),
      token,
    };
  }

  async function redeemBetaInvitation(token: string): Promise<RedeemedBetaInvitation> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new BetaInvitationError('INVITATION_INVALID');
    }
    const tokenHash = hashInvitationToken(token);
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch {
      throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
    }
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        id: string;
        email: string;
        status: string;
        expires_at: Date;
      }>(
        'SELECT id, email, status, expires_at FROM core.beta_invitation WHERE token_hash = $1 FOR UPDATE',
        [tokenHash],
      );
      const row = found.rows[0];
      if (!row) throw new BetaInvitationError('INVITATION_INVALID');
      if (row.status === 'accepted') throw new BetaInvitationError('INVITATION_ALREADY_ACCEPTED');
      if (row.status === 'revoked') throw new BetaInvitationError('INVITATION_REVOKED');
      if (row.status !== 'pending') throw new BetaInvitationError('INVITATION_INVALID');
      if (row.expires_at.getTime() <= Date.now()) {
        throw new BetaInvitationError('INVITATION_EXPIRED');
      }
      const accepted = await client.query(
        "UPDATE core.beta_invitation SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = $1 AND status = 'pending'",
        [row.id],
      );
      if (accepted.rowCount !== 1) throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
      await client.query('COMMIT');
      return { invitationId: row.id, email: row.email };
    } catch (error) {
      await rollback(client);
      throw error instanceof BetaInvitationError
        ? error
        : new BetaInvitationError('INVITATION_STORAGE_FAILED');
    } finally {
      client.release();
    }
  }

  type InvitationRow = {
    id: string;
    email: string;
    status: string;
    expires_at: Date;
  };

  function assertUsablePendingRow(row: InvitationRow | undefined, email?: string) {
    if (!row) throw new BetaInvitationError('INVITATION_INVALID');
    if (row.status === 'accepted') throw new BetaInvitationError('INVITATION_ALREADY_ACCEPTED');
    if (row.status === 'revoked') throw new BetaInvitationError('INVITATION_REVOKED');
    if (row.status !== 'pending') throw new BetaInvitationError('INVITATION_INVALID');
    if (row.expires_at.getTime() <= Date.now()) throw new BetaInvitationError('INVITATION_EXPIRED');
    if (email !== undefined && row.email !== email) {
      throw new BetaInvitationError('INVITATION_INVALID');
    }
  }

  function assertTokenShape(token: string) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new BetaInvitationError('INVITATION_INVALID');
    }
  }

  async function loadInvitationByHash(
    tokenHash: string,
    options: { forUpdate?: boolean; client?: PoolClient } = {},
  ): Promise<InvitationRow | undefined> {
    const sqlText = `SELECT id, email, status, expires_at FROM core.beta_invitation WHERE token_hash = $1${
      options.forUpdate ? ' FOR UPDATE' : ''
    }`;
    if (options.client) {
      const found = await options.client.query<InvitationRow>(sqlText, [tokenHash]);
      return found.rows[0];
    }
    const found = await database.pool.query<InvitationRow>(sqlText, [tokenHash]);
    return found.rows[0];
  }

  /**
   * Read-only validation used when the invite link is opened: the invitation must exist,
   * be pending and be within its validity window. Never consumes; never returns the token.
   */
  async function readAcceptableInvitation(token: string): Promise<{ invitationId: string }> {
    assertTokenShape(token);
    let row: InvitationRow | undefined;
    try {
      row = await loadInvitationByHash(hashInvitationToken(token));
    } catch (error) {
      throw error instanceof BetaInvitationError
        ? error
        : new BetaInvitationError('INVITATION_STORAGE_FAILED');
    }
    assertUsablePendingRow(row);
    return { invitationId: row!.id };
  }

  /**
   * Read-only validation bound to an e-mail (used while the identity is being created):
   * the invitation must be pending, within its window and match the normalized e-mail.
   * Never consumes, so a later identity failure cannot leave a consumed invitation.
   */
  async function assertInvitationAcceptableForEmail(token: string, email: string): Promise<void> {
    assertTokenShape(token);
    const normalized = normalizeInvitationEmail(email);
    let row: InvitationRow | undefined;
    try {
      row = await loadInvitationByHash(hashInvitationToken(token));
    } catch (error) {
      throw error instanceof BetaInvitationError
        ? error
        : new BetaInvitationError('INVITATION_STORAGE_FAILED');
    }
    assertUsablePendingRow(row, normalized);
  }

  /**
   * Single-use atomic consumption of an invitation bound to an existing identity:
   * row lock, e-mail match, one accepted transition, `accepted_user_id` linked to the user.
   * Under concurrency only one attempt can transition the row; the others fail sanitized.
   */
  async function consumeInvitationForUser(
    token: string,
    input: { userId: string; email: string },
  ): Promise<RedeemedBetaInvitation> {
    assertTokenShape(token);
    if (
      typeof input?.userId !== 'string' ||
      input.userId.length === 0 ||
      input.userId.length > 255
    ) {
      throw new BetaInvitationError('INVITATION_INVALID');
    }
    const normalized = normalizeInvitationEmail(input.email);
    const tokenHash = hashInvitationToken(token);
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch {
      throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
    }
    try {
      await client.query('BEGIN');
      const row = await loadInvitationByHash(tokenHash, { forUpdate: true, client });
      assertUsablePendingRow(row, normalized);
      const accepted = await client.query(
        "UPDATE core.beta_invitation SET status = 'accepted', accepted_at = now(), accepted_user_id = $2, updated_at = now() WHERE id = $1 AND status = 'pending'",
        [row!.id, input.userId],
      );
      if (accepted.rowCount !== 1) throw new BetaInvitationError('INVITATION_STORAGE_FAILED');
      await client.query('COMMIT');
      return { invitationId: row!.id, email: row!.email };
    } catch (error) {
      await rollback(client);
      throw error instanceof BetaInvitationError
        ? error
        : new BetaInvitationError('INVITATION_STORAGE_FAILED');
    } finally {
      client.release();
    }
  }

  /**
   * Whether the identity already holds an accepted invitation (admitted beta user).
   * Fail-closed: any storage failure reports `false` so callers deny the session.
   */
  async function findAcceptedInvitationForUser(userId: string): Promise<boolean> {
    if (typeof userId !== 'string' || userId.length === 0 || userId.length > 255) return false;
    try {
      const rows = await database.pool.query(
        "SELECT 1 FROM core.beta_invitation WHERE accepted_user_id = $1 AND status = 'accepted' LIMIT 1",
        [userId],
      );
      return rows.rows.length > 0;
    } catch {
      return false;
    }
  }

  return {
    createInvitation,
    redeemBetaInvitation,
    readAcceptableInvitation,
    assertInvitationAcceptableForEmail,
    consumeInvitationForUser,
    findAcceptedInvitationForUser,
  };
}

export type BetaInvitationService = ReturnType<typeof createBetaInvitation>;
