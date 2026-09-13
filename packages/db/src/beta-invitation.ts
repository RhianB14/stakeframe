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
 * - No public route uses these services in this task.
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

  return { createInvitation, redeemBetaInvitation };
}

export type BetaInvitationService = ReturnType<typeof createBetaInvitation>;
