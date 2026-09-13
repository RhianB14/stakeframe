import { describe, expect, it } from 'vitest';
import {
  createTenantContext,
  TenantContextError,
  type Database,
} from '../../packages/db/src/index.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function unusedDatabase(counter: { connects: number; selects: number }) {
  return {
    orm: {
      select: () => {
        counter.selects += 1;
        throw new Error('query must not run');
      },
    },
    pool: {
      connect: () => {
        counter.connects += 1;
        throw new Error('connection must not be acquired');
      },
    },
  } as unknown as Database;
}

describe('tenant context pre-flight validation (no database required)', () => {
  it.each([[''], [undefined], [null], [42]])(
    'rejects a missing authenticated user (%s) before any query',
    async (userId) => {
      const counter = { connects: 0, selects: 0 };
      const tenant = createTenantContext(unusedDatabase(counter));
      await expect(
        tenant.resolveOrganizationContext(userId as unknown as string),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(counter.selects).toBe(0);
      expect(counter.connects).toBe(0);
    },
  );

  it('rejects an invalid organization id before touching the pool', async () => {
    const counter = { connects: 0, selects: 0 };
    const tenant = createTenantContext(unusedDatabase(counter));
    await expect(
      tenant.withOrganizationTransaction(
        { organizationId: 'not-a-uuid', role: 'owner', userId: 'user-1' },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ORGANIZATION_ID' });
    expect(counter.connects).toBe(0);
  });

  it('rejects an invalid expected organization id before touching the pool', async () => {
    const counter = { connects: 0, selects: 0 };
    const tenant = createTenantContext(unusedDatabase(counter));
    await expect(
      tenant.withOrganizationTransaction(
        { organizationId: ORG_A, role: 'owner', userId: 'user-1' },
        async () => undefined,
        { expectedOrganizationId: 'still-not-a-uuid' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ORGANIZATION_ID' });
    expect(counter.connects).toBe(0);
  });

  it('refuses an organization that diverges from the expected one', async () => {
    const counter = { connects: 0, selects: 0 };
    const tenant = createTenantContext(unusedDatabase(counter));
    await expect(
      tenant.withOrganizationTransaction(
        { organizationId: ORG_A, role: 'owner', userId: 'user-1' },
        async () => undefined,
        { expectedOrganizationId: ORG_B },
      ),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_MISMATCH' });
    expect(counter.connects).toBe(0);
  });

  it('keeps every error stable and sanitized', async () => {
    const counter = { connects: 0, selects: 0 };
    const tenant = createTenantContext(unusedDatabase(counter));
    const error = await tenant.resolveOrganizationContext('').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TenantContextError);
    const failure = error as TenantContextError;
    expect(failure.name).toBe('TenantContextError');
    expect(failure.message).toBe('UNAUTHENTICATED');
    expect(failure.code).toBe('UNAUTHENTICATED');
    expect(String(failure)).toBe('TenantContextError: UNAUTHENTICATED');
    expect(String(failure)).not.toMatch(/@|token|cookie|secret/i);
  });

  it('rolls back and releases the connection when set_config fails', async () => {
    const queries: string[] = [];
    let releases = 0;
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.startsWith('SELECT set_config'))
          throw new Error('RAW_FAILURE 10.0.0.9 core.membership');
        return { rows: [] };
      },
      release: () => {
        releases += 1;
      },
    };
    const database = {
      orm: {
        select: () => {
          throw new Error('query must not run');
        },
      },
      pool: { connect: async () => client },
    } as unknown as Database;
    const tenant = createTenantContext(database);
    let callbackRan = false;
    let failure: unknown = null;
    try {
      await tenant.withOrganizationTransaction(
        { organizationId: ORG_A, role: 'owner', userId: 'user-1' },
        async () => {
          callbackRan = true;
          return 'never';
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'TenantContextError', code: 'CONTEXT_SETUP_FAILED' });
    expect((failure as Error).message).toBe('CONTEXT_SETUP_FAILED');
    expect(String(failure)).not.toMatch(/10\.0\.0\.9|core\.membership|RAW_FAILURE/);
    expect(callbackRan).toBe(false);
    expect(releases).toBe(1);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]!.startsWith('SELECT set_config')).toBe(true);
    expect(queries[2]).toBe('ROLLBACK');
  });

  it('sanitizes membership lookup failures without exposing driver details', async () => {
    const database = {
      orm: {
        select: () => {
          throw new Error(
            'connection to server at "10.0.0.9", port 5432 failed for user "stakeframe_local"',
          );
        },
      },
      pool: {
        connect: () => {
          throw new Error('connection must not be acquired');
        },
      },
    } as unknown as Database;
    const tenant = createTenantContext(database);
    let failure: unknown = null;
    try {
      await tenant.resolveOrganizationContext('user-1');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'TenantContextError',
      code: 'MEMBERSHIP_LOOKUP_FAILED',
    });
    expect((failure as Error).message).toBe('MEMBERSHIP_LOOKUP_FAILED');
    expect(String(failure)).toBe('TenantContextError: MEMBERSHIP_LOOKUP_FAILED');
    expect(String(failure)).not.toMatch(/10\.0\.0\.9|5432|stakeframe_local/);
  });
});
