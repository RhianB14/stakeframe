import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { membership, membershipRole, type MembershipRole } from './core-schema.js';
import type { Database } from './index.js';

export type TenantContextErrorCode =
  | 'UNAUTHENTICATED'
  | 'MEMBERSHIP_MISSING'
  | 'MEMBERSHIP_INCONSISTENT'
  | 'ORGANIZATION_MISMATCH'
  | 'INVALID_ORGANIZATION_ID'
  | 'CONTEXT_SETUP_FAILED'
  | 'TRANSACTION_FAILED';

/**
 * Stable, sanitized internal error. The message is the code itself, so no user id,
 * e-mail, token, session or financial content can reach logs or callers.
 */
export class TenantContextError extends Error {
  constructor(public readonly code: TenantContextErrorCode) {
    super(code);
    this.name = 'TenantContextError';
  }
}

export type OrganizationContext = {
  organizationId: string;
  role: MembershipRole;
  userId: string;
};

export type WithOrganizationTransactionOptions = {
  /** Optional expected organization from the internal contract; divergences are refused. */
  expectedOrganizationId?: string;
};

/** Transaction-local PostgreSQL variable read by future RLS policies. */
export const ORGANIZATION_CONTEXT_SETTING = 'app.organization_id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set<string>(membershipRole.enumValues);

function assertOrganizationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value))
    throw new TenantContextError('INVALID_ORGANIZATION_ID');
  return value;
}

async function rollback(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original failure is the one worth reporting; a broken connection is simply released.
  }
}

/**
 * Reusable organization-context foundation for the multi-tenant phase.
 *
 * - The organization is always derived from the authenticated user
 *   (`auth.user` -> `core.membership` -> `organization`); callers never supply it.
 * - The transaction context uses `set_config('app.organization_id', ..., true)`, which is
 *   local to the transaction and is discarded on COMMIT/ROLLBACK, so pool connections never
 *   carry a previous request's context.
 */
export function createTenantContext(database: Database) {
  async function resolveOrganizationContext(userId: string): Promise<OrganizationContext> {
    if (typeof userId !== 'string' || userId.length === 0)
      throw new TenantContextError('UNAUTHENTICATED');
    const rows = await database.orm
      .select({ organizationId: membership.organizationId, role: membership.role })
      .from(membership)
      .where(eq(membership.userId, userId));
    if (rows.length === 0) throw new TenantContextError('MEMBERSHIP_MISSING');
    if (rows.length > 1) throw new TenantContextError('MEMBERSHIP_INCONSISTENT');
    const row = rows[0]!;
    if (!VALID_ROLES.has(row.role)) throw new TenantContextError('MEMBERSHIP_INCONSISTENT');
    return { organizationId: row.organizationId, role: row.role, userId };
  }

  async function withOrganizationTransaction<T>(
    context: OrganizationContext,
    callback: (client: PoolClient) => Promise<T>,
    options: WithOrganizationTransactionOptions = {},
  ): Promise<T> {
    const organizationId = assertOrganizationId(context?.organizationId);
    if (options.expectedOrganizationId !== undefined) {
      const expected = assertOrganizationId(options.expectedOrganizationId);
      if (expected !== organizationId) throw new TenantContextError('ORGANIZATION_MISMATCH');
    }
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch {
      throw new TenantContextError('TRANSACTION_FAILED');
    }
    try {
      try {
        await client.query('BEGIN');
      } catch {
        throw new TenantContextError('TRANSACTION_FAILED');
      }
      try {
        await client.query('SELECT set_config($1, $2, true)', [
          ORGANIZATION_CONTEXT_SETTING,
          organizationId,
        ]);
      } catch {
        throw new TenantContextError('CONTEXT_SETUP_FAILED');
      }
      let result: T;
      try {
        result = await callback(client);
      } catch (error) {
        await rollback(client);
        throw error;
      }
      try {
        await client.query('COMMIT');
      } catch {
        await rollback(client);
        throw new TenantContextError('TRANSACTION_FAILED');
      }
      return result;
    } finally {
      client.release();
    }
  }

  return { resolveOrganizationContext, withOrganizationTransaction };
}
