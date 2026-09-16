import { eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { membership, membershipRole, type MembershipRole } from './core-schema.js';
import type { Database } from './index.js';

export type TenantContextErrorCode =
  | 'UNAUTHENTICATED'
  | 'MEMBERSHIP_MISSING'
  | 'MEMBERSHIP_INCONSISTENT'
  | 'MEMBERSHIP_LOOKUP_FAILED'
  | 'USER_NOT_FOUND'
  | 'PROVISIONING_FAILED'
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
  /**
   * Transaction isolation for read flows. Kept separate from READ ONLY on purpose: a read-only
   * transaction rejects `set_config`, and the organization context must be visible to every
   * statement inside the transaction (RLS policies read it).
   */
  isolation?: 'repeatable read';
  /**
   * Run inside an already-connected client (the caller owns connect/release — used by workers
   * that hold a session advisory lock on the same connection).
   */
  client?: PoolClient;
};

/** Transaction-local PostgreSQL variable read by the RLS policies. */
export const ORGANIZATION_CONTEXT_SETTING = 'app.organization_id';

/**
 * Context used by infrastructure workers that act on behalf of the system (never on behalf of a
 * request): extraction/retention/event jobs that belong to one organization but have no session.
 */
export function systemOrganizationContext(organizationId: string): OrganizationContext {
  return { organizationId, role: 'owner', userId: 'system:worker' };
}

/**
 * Default bookmaker catalog created for every new organization (same seed migration 0002 applied
 * to the founding organization before the multi-tenant phase).
 */
const DEFAULT_BOOKMAKERS = ['Bet365', 'Superbet', 'Novibet'] as const;

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

export function createTenantContext(database: Database) {
  async function resolveOrganizationContext(userId: string): Promise<OrganizationContext> {
    if (typeof userId !== 'string' || userId.length === 0)
      throw new TenantContextError('UNAUTHENTICATED');
    let rows: { organizationId: string; role: MembershipRole }[];
    try {
      rows = await database.orm
        .select({ organizationId: membership.organizationId, role: membership.role })
        .from(membership)
        .where(eq(membership.userId, userId));
    } catch {
      throw new TenantContextError('MEMBERSHIP_LOOKUP_FAILED');
    }
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
    const ownsClient = options.client === undefined;
    if (options.client) {
      client = options.client;
    } else {
      try {
        client = await database.pool.connect();
      } catch {
        throw new TenantContextError('TRANSACTION_FAILED');
      }
    }
    try {
      try {
        await client.query(
          options.isolation === 'repeatable read'
            ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
            : 'BEGIN',
        );
      } catch {
        throw new TenantContextError('TRANSACTION_FAILED');
      }
      try {
        await client.query('SELECT set_config($1, $2, true)', [
          ORGANIZATION_CONTEXT_SETTING,
          organizationId,
        ]);
      } catch {
        await rollback(client);
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
      if (ownsClient) client.release();
    }
  }

  /**
   * Idempotent provisioning: guarantees exactly one organization and one membership for the
   * authenticated user, plus the organization's own financial space (settings row, system
   * accounts and the default bookmaker catalog) — the same seed migration 0002 applied to the
   * founding organization. Serialized per user with a transaction-scoped advisory lock, so
   * concurrent requests cannot create duplicates; existing rows are returned untouched.
   */
  async function ensureOrganizationMembership(userId: string): Promise<OrganizationContext> {
    if (typeof userId !== 'string' || userId.length === 0)
      throw new TenantContextError('UNAUTHENTICATED');
    let client: PoolClient;
    try {
      client = await database.pool.connect();
    } catch {
      throw new TenantContextError('PROVISIONING_FAILED');
    }
    try {
      try {
        await client.query('BEGIN');
      } catch {
        throw new TenantContextError('PROVISIONING_FAILED');
      }
      let result: OrganizationContext;
      try {
        try {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
            'stakeframe.organization.provision',
            userId,
          ]);
        } catch {
          throw new TenantContextError('PROVISIONING_FAILED');
        }
        const existing = await client.query<{ organization_id: string; role: string }>(
          'SELECT organization_id, role FROM core.membership WHERE user_id = $1',
          [userId],
        );
        if (existing.rows.length > 1) throw new TenantContextError('MEMBERSHIP_INCONSISTENT');
        if (existing.rows.length === 1) {
          const row = existing.rows[0]!;
          if (!VALID_ROLES.has(row.role)) throw new TenantContextError('MEMBERSHIP_INCONSISTENT');
          result = {
            organizationId: row.organization_id,
            role: row.role as MembershipRole,
            userId,
          };
        } else {
          const users = await client.query<{ name: string }>(
            'SELECT name FROM auth."user" WHERE id = $1',
            [userId],
          );
          if (users.rows.length === 0) throw new TenantContextError('USER_NOT_FOUND');
          const displayName = (users.rows[0]!.name ?? '').trim() || 'Fundação';
          const created = await client.query<{ id: string }>(
            'INSERT INTO core.organization (name) VALUES ($1) RETURNING id',
            [displayName],
          );
          const organizationId = created.rows[0]!.id;
          await client.query(
            'INSERT INTO core.membership (organization_id, user_id, role) VALUES ($1, $2, $3)',
            [organizationId, userId, 'owner'],
          );
          result = { organizationId, role: 'owner', userId };
        }
        // The financial space of the organization: RLS requires the transaction-local context.
        await client.query('SELECT set_config($1, $2, true)', [
          ORGANIZATION_CONTEXT_SETTING,
          result.organizationId,
        ]);
        const settings = await client.query(
          'SELECT 1 FROM finance.settings WHERE organization_id = $1',
          [result.organizationId],
        );
        if (!settings.rowCount) {
          await client.query('INSERT INTO finance.settings(organization_id) VALUES($1)', [
            result.organizationId,
          ]);
          await client.query(
            "INSERT INTO finance.account(organization_id,kind,name) VALUES($1,'reserve','Reserva'),($1,'exposure','Principal em aberto'),($1,'counter','Contrapartida')",
            [result.organizationId],
          );
          const inserted = await client.query<{ id: string; name: string }>(
            `INSERT INTO finance.catalog(organization_id,kind,name)
             SELECT $1,'bookmaker',name FROM unnest($2::text[]) AS name
             RETURNING id,name`,
            [result.organizationId, [...DEFAULT_BOOKMAKERS]],
          );
          await client.query(
            `INSERT INTO finance.catalog_alias(organization_id,kind,alias,label,catalog_id)
             SELECT $1,'bookmaker',lower(name),name,id FROM unnest($2::uuid[],$3::text[]) AS t(id,name)`,
            [
              result.organizationId,
              inserted.rows.map((row) => row.id),
              inserted.rows.map((row) => row.name),
            ],
          );
          await client.query(
            `INSERT INTO finance.account(organization_id,kind,name,bookmaker_id)
             SELECT $1,'bookmaker',name,id FROM unnest($2::uuid[],$3::text[]) AS t(id,name)`,
            [
              result.organizationId,
              inserted.rows.map((row) => row.id),
              inserted.rows.map((row) => row.name),
            ],
          );
        }
      } catch (error) {
        await rollback(client);
        throw error instanceof TenantContextError
          ? error
          : new TenantContextError('PROVISIONING_FAILED');
      }
      try {
        await client.query('COMMIT');
      } catch {
        await rollback(client);
        throw new TenantContextError('PROVISIONING_FAILED');
      }
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * The organization of the oldest `owner` membership — the founding organization that held the
   * single-tenant financial core before STK-F1-13. Deterministic across runs (created_at,
   * organization_id) and used by the migration backfill and by infrastructure workers that
   * predate per-organization bindings (Telegram owner). Never used for authorization decisions.
   */
  async function founderOrganizationId(): Promise<string | null> {
    const rows = await database.pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM core.membership
       WHERE role = 'owner'
       ORDER BY created_at ASC, organization_id ASC
       LIMIT 1`,
    );
    return rows.rows[0]?.organization_id ?? null;
  }

  /**
   * Every organization, for infrastructure workers that must iterate tenants (retention, event
   * search, monthly units). `core.organization` is registry data, not tenant data. The returned
   * contexts identify the system worker (never a request session).
   */
  async function listOrganizations(): Promise<OrganizationContext[]> {
    const rows = await database.pool.query<{ id: string }>(
      'SELECT id FROM core.organization ORDER BY created_at ASC, id ASC',
    );
    return rows.rows.map((row) => systemOrganizationContext(row.id));
  }

  return {
    resolveOrganizationContext,
    withOrganizationTransaction,
    ensureOrganizationMembership,
    founderOrganizationId,
    listOrganizations,
  };
}
