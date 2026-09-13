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
});
