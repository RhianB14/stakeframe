/**
 * STK-F1-08 account deletion: 30-day grace window, immediate access block, cancellation
 * inside the window and the irreversible purge executed by the worker.
 *
 * - `request` records `pending` with `expires_at = now() + 30 days` AND deletes every
 *   session of the user in the same transaction: access stops immediately, before the
 *   purge date (the auth gate also refuses pending/purged users on any later login).
 * - `cancel` only works while the window is open; the row becomes `cancelled` and the
 *   user can sign in again (the deleted sessions simply force a fresh login).
 * - `purge` erases the organization's own data, memberships, sessions and credentials,
 *   then flips the row to `purged` — the minimal trail (user, organization id, dates)
 *   that survives the deletion. It is idempotent: a row no longer `pending`/expired is
 *   skipped, so retries after a crash converge.
 * - `duePurges` scans the whole table on purpose: it is infrastructure (the worker runs
 *   it outside any tenant), not a tenant read — the same class as the backup scans.
 *
 * Everything here is fail-closed: unknown state or a missing row never purges, and no
 * error message carries SQL, e-mail or row data.
 */
import type { PoolClient } from 'pg';
import { ORGANIZATION_CONTEXT_SETTING } from './tenant-context.js';
import type { Database } from './index.js';

/** Grace window before the purge becomes due (Plano §7.3: 30 days). */
export const ACCOUNT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Private attachments outlive the purge for this long (Plano §7.3: 90 days). */
export const ATTACHMENT_RETENTION_AFTER_PURGE_DAYS = 90;

export type AccountDeletionStateName = 'pending' | 'cancelled' | 'purged';

export type AccountDeletionStatus = {
  state: AccountDeletionStateName;
  requestedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  purgedAt: string | null;
};

export type DuePurge = { userId: string; organizationId: string };

export type AccountDeletionErrorCode =
  'DELETION_NOT_FOUND' | 'DELETION_STATE_CONFLICT' | 'DELETION_UNAVAILABLE';

export class AccountDeletionError extends Error {
  constructor(public readonly code: AccountDeletionErrorCode) {
    super(code);
    this.name = 'AccountDeletionError';
  }
}

type DeletionRow = {
  user_id: string;
  organization_id: string;
  state: AccountDeletionStateName;
  requested_at: Date;
  expires_at: Date;
  cancelled_at: Date | null;
  purged_at: Date | null;
};

function toStatus(row: DeletionRow): AccountDeletionStatus {
  return {
    state: row.state,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    purgedAt: row.purged_at ? row.purged_at.toISOString() : null,
  };
}

/**
 * Deletion order for the purge: children before parents so no composite foreign key
 * blocks the deletes. `finance.settings` is deleted before the organization row (its FK
 * has no cascade), and the organization itself cascades memberships and onboarding rows
 * that belong to other users of the same organization (single-organization product, but
 * the cascade keeps the cleanup complete either way).
 *
 * `integration.attachment` is deliberately NOT purged: Plano §7.3 keeps private attachments
 * for 90 days after the account deletion, and the attachment maintenance job expires those
 * orphans (attachmentExpiredSql, second branch) once that window closes.
 */
const ORGANIZATION_TABLES = [
  'integration.extraction_request',
  'integration.telegram_outbox',
  'integration.import_action_receipt',
  'integration.event_search',
  'integration.inbox',
  'finance.settlement_reversal',
  'finance.settlement',
  'finance.selection',
  'finance.posting',
  'finance.bet',
  'finance.freebet',
  'finance.catalog_alias',
  'finance.account',
  'finance.monthly_unit',
  'finance.journal',
  'finance.audit',
  'finance.command_receipt',
  'finance.catalog',
  'finance.settings',
  'core.onboarding_state',
  'core.membership',
] as const;

/**
 * Tables protected by finance.immutable_history() (BEFORE UPDATE OR DELETE). The purge is
 * the single sanctioned deletion path for a whole organization, so it disables exactly
 * these triggers inside its transaction and re-enables them before committing: DDL is
 * transactional in PostgreSQL, so a failed purge rolls the triggers back on.
 */
const IMMUTABLE_TABLES = [
  'finance.journal',
  'finance.posting',
  'finance.settlement',
  'finance.settlement_reversal',
  'finance.audit',
  'finance.command_receipt',
  'finance.monthly_unit',
] as const;

export function createAccountDeletionService(database: Database) {
  const context = `current_setting($$app.organization_id$$, true)::uuid`;

  async function readRow(
    connection: PoolClient,
    userId: string,
    lock = false,
  ): Promise<DeletionRow | undefined> {
    const rows = (
      await connection.query<DeletionRow>(
        `select user_id, organization_id, state, requested_at, expires_at, cancelled_at, purged_at
           from core.account_deletion where user_id = $1${lock ? ' for update' : ''}`,
        [userId],
      )
    ).rows;
    return rows[0];
  }

  async function request(userId: string, organizationId: string): Promise<AccountDeletionStatus> {
    const connection = await database.pool.connect();
    try {
      await connection.query('begin');
      let row = await readRow(connection, userId, true);
      if (row?.state === 'purged') throw new AccountDeletionError('DELETION_STATE_CONFLICT');
      if (!row) {
        await connection.query(
          `insert into core.account_deletion(user_id, organization_id, state, expires_at)
           values($1, $2, 'pending', now() + interval '30 days')
           on conflict (user_id) do nothing`,
          [userId, organizationId],
        );
        row = await readRow(connection, userId, true);
      } else if (row.state === 'cancelled') {
        await connection.query(
          `update core.account_deletion
             set state = 'pending', organization_id = $2, requested_at = now(),
                 expires_at = now() + interval '30 days', cancelled_at = null, purged_at = null,
                 updated_at = now()
           where user_id = $1`,
          [userId, organizationId],
        );
        row = await readRow(connection, userId, true);
      }
      if (!row || row.state !== 'pending') throw new AccountDeletionError('DELETION_UNAVAILABLE');
      // Immediate block: every session of this user dies with the request itself.
      await connection.query('delete from auth.session where user_id = $1', [userId]);
      await connection.query(
        "insert into finance.audit(organization_id,type,actor,entity_id,after) values($2,'account.exclusion_requested',$1,$1,jsonb_build_object('expiresAt',$3::text))",
        [userId, row.organization_id, row.expires_at.toISOString()],
      );
      await connection.query('commit');
      return toStatus(row);
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async function cancel(userId: string): Promise<AccountDeletionStatus> {
    const rows = (
      await database.pool.query<DeletionRow>(
        `update core.account_deletion
            set state = 'cancelled', cancelled_at = now(), updated_at = now()
          where user_id = $1 and state = 'pending' and expires_at > now()
          returning user_id, organization_id, state, requested_at, expires_at, cancelled_at, purged_at`,
        [userId],
      )
    ).rows;
    const row = rows[0];
    if (!row) throw new AccountDeletionError('DELETION_STATE_CONFLICT');
    await database.pool.query(
      "insert into finance.audit(organization_id,type,actor,entity_id,after) values($2,'account.exclusion_cancelled',$1,$1,'{}')",
      [userId, row.organization_id],
    );
    return toStatus(row);
  }

  async function status(userId: string): Promise<AccountDeletionStatus | null> {
    const rows = (
      await database.pool.query<DeletionRow>(
        `select user_id, organization_id, state, requested_at, expires_at, cancelled_at, purged_at
           from core.account_deletion where user_id = $1`,
        [userId],
      )
    ).rows;
    return rows[0] ? toStatus(rows[0]) : null;
  }

  /** True while access must be refused: pending (immediate) or purged (account gone). */
  async function isBlocked(userId: string): Promise<boolean> {
    try {
      const rows = (
        await database.pool.query<{ blocked: boolean }>(
          `select true as blocked from core.account_deletion
            where user_id = $1 and state in ('pending', 'purged') limit 1`,
          [userId],
        )
      ).rows;
      return rows.length === 1;
    } catch {
      // Fail-closed on infrastructure trouble: treat as blocked.
      return true;
    }
  }

  /** Infrastructure scan (worker): pending rows whose grace window has closed. */
  async function duePurges(limit = 10): Promise<DuePurge[]> {
    const rows = (
      await database.pool.query<{ user_id: string; organization_id: string }>(
        `select user_id, organization_id from core.account_deletion
          where state = 'pending' and expires_at <= now()
          order by expires_at limit $1`,
        [limit],
      )
    ).rows;
    return rows.map((row) => ({ userId: row.user_id, organizationId: row.organization_id }));
  }

  /**
   * Irreversible purge. Returns true when this call erased the account; false when the
   * row was already purged, cancelled or still inside the grace window (idempotent).
   */
  async function purge(userId: string): Promise<boolean> {
    const connection = await database.pool.connect();
    try {
      await connection.query('begin');
      const row = await readRow(connection, userId, true);
      if (!row || row.state !== 'pending' || row.expires_at > new Date()) {
        await connection.query('rollback');
        return false;
      }
      await connection.query('SELECT set_config($1, $2, true)', [
        ORGANIZATION_CONTEXT_SETTING,
        row.organization_id,
      ]);
      // The immutable-history triggers block DELETE by design; the purge disables them
      // only for its own transaction and restores them before the commit.
      for (const table of IMMUTABLE_TABLES)
        await connection.query(`alter table ${table} disable trigger user`);
      for (const table of ORGANIZATION_TABLES)
        await connection.query(`delete from ${table} where organization_id = ${context}`);
      await connection.query('delete from core.organization where id = $1', [row.organization_id]);
      for (const table of IMMUTABLE_TABLES)
        await connection.query(`alter table ${table} enable trigger user`);
      // Credentials and sessions are the user's own data; consent records stay
      // (legally required, anonymization is out of scope until professional guidance).
      await connection.query('delete from auth.session where user_id = $1', [userId]);
      await connection.query('delete from auth.account where user_id = $1', [userId]);
      await connection.query(
        `update core.account_deletion
            set state = 'purged', purged_at = now(), updated_at = now()
          where user_id = $1`,
        [userId],
      );
      await connection.query('commit');
      return true;
    } catch (error) {
      await connection.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  return { request, cancel, status, isBlocked, duePurges, purge };
}

export type AccountDeletionService = ReturnType<typeof createAccountDeletionService>;
