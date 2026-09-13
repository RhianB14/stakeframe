import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createTenantContext,
  ORGANIZATION_CONTEXT_SETTING,
  requireDatabaseUrl,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const NAME_PATTERN = /^stk_tenant_test_[a-f0-9]{32}$/;

let database: Database;
let databaseName = '';
let created = false;

async function createFreshDatabase() {
  databaseName = `stk_tenant_test_${randomUUID().replaceAll('-', '')}`;
  if (!NAME_PATTERN.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  await migrateLocalDatabase(database);
  return createTenantContext(database);
}

async function dropCurrentDatabase() {
  await database?.close();
  if (created && NAME_PATTERN.test(databaseName)) {
    await admin.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  created = false;
}

async function insertUser(id: string, name: string, email: string) {
  await database.pool.query('INSERT INTO auth."user" (id, name, email) VALUES ($1, $2, $3)', [
    id,
    name,
    email,
  ]);
}

async function insertOrganization(name: string) {
  const rows = (
    await database.pool.query<{ id: string }>(
      'INSERT INTO core.organization (name) VALUES ($1) RETURNING id',
      [name],
    )
  ).rows;
  return rows[0]!.id;
}

async function insertMembership(organizationId: string, userId: string, role: string) {
  await database.pool.query(
    'INSERT INTO core.membership (organization_id, user_id, role) VALUES ($1, $2, $3)',
    [organizationId, userId, role],
  );
}

async function poolSettingValue() {
  const rows = (
    await database.pool.query(
      `SELECT current_setting('${ORGANIZATION_CONTEXT_SETTING}', true) AS value`,
    )
  ).rows;
  // A transaction-local custom GUC reverts to the empty string once the transaction ends
  // (never to a previous value); normalize it to null so "cleared" is unambiguous.
  const value = rows[0]!.value as string | null;
  return value === '' ? null : value;
}

async function seedMembership(role: string) {
  await insertUser('tenant-user-1', 'Pessoa Um', 'tenant-user-1@example.test');
  const organizationId = await insertOrganization('Organização Um');
  await insertMembership(organizationId, 'tenant-user-1', role);
  return organizationId;
}

afterEach(dropCurrentDatabase);
afterAll(async () => admin.close());

describe('organization context resolution with a real PostgreSQL', () => {
  it('resolves exactly one organization for a valid membership', async () => {
    const tenant = await createFreshDatabase();
    const organizationId = await seedMembership('owner');
    const context = await tenant.resolveOrganizationContext('tenant-user-1');
    expect(context).toEqual({
      organizationId,
      role: 'owner',
      userId: 'tenant-user-1',
    });
  });

  it('preserves the owner and superadmin roles from the membership', async () => {
    const tenant = await createFreshDatabase();
    const first = await seedMembership('owner');
    await insertUser('tenant-user-2', 'Pessoa Dois', 'tenant-user-2@example.test');
    const second = await insertOrganization('Organização Dois');
    await insertMembership(second, 'tenant-user-2', 'superadmin');
    expect(await tenant.resolveOrganizationContext('tenant-user-1')).toMatchObject({
      organizationId: first,
      role: 'owner',
    });
    expect(await tenant.resolveOrganizationContext('tenant-user-2')).toMatchObject({
      organizationId: second,
      role: 'superadmin',
    });
  });

  it('fails closed without a membership and keeps the error sanitized', async () => {
    const tenant = await createFreshDatabase();
    await insertUser('tenant-user-1', 'Pessoa Um', 'tenant-user-1@example.test');
    let failure: unknown = null;
    try {
      await tenant.resolveOrganizationContext('tenant-user-1');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'TenantContextError', code: 'MEMBERSHIP_MISSING' });
    expect((failure as Error).message).toBe('MEMBERSHIP_MISSING');
    expect(String(failure)).not.toMatch(/@|tenant-user-1|token|cookie|secret/i);
  });

  it('returns a sanitized membership lookup failure when the query itself fails', async () => {
    const tenant = await createFreshDatabase();
    await insertUser('tenant-user-1', 'Pessoa Um', 'tenant-user-1@example.test');
    await database.pool.query('DROP TABLE core.membership');
    let failure: unknown = null;
    try {
      await tenant.resolveOrganizationContext('tenant-user-1');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'TenantContextError',
      code: 'MEMBERSHIP_LOOKUP_FAILED',
    });
    expect((failure as Error).message).toBe('MEMBERSHIP_LOOKUP_FAILED');
    expect(String(failure)).not.toMatch(/relation|schema|DROP|postgres/i);
  });
});

describe('organization transaction context with a real PostgreSQL', () => {
  it('exposes the context during the transaction and clears it afterwards', async () => {
    const tenant = await createFreshDatabase();
    const organizationId = await seedMembership('owner');
    const context = await tenant.resolveOrganizationContext('tenant-user-1');
    const seen = await tenant.withOrganizationTransaction(context, async (client) => {
      const rows = (
        await client.query(
          `SELECT current_setting('${ORGANIZATION_CONTEXT_SETTING}', true) AS value`,
        )
      ).rows;
      return rows[0]!.value as string;
    });
    expect(seen).toBe(organizationId);
    expect(await poolSettingValue()).toBeNull();
  });

  it('refuses an organization that does not match the membership without running the callback', async () => {
    const tenant = await createFreshDatabase();
    await seedMembership('owner');
    const context = await tenant.resolveOrganizationContext('tenant-user-1');
    let executed = false;
    await expect(
      tenant.withOrganizationTransaction(
        context,
        async () => {
          executed = true;
          return 'never';
        },
        { expectedOrganizationId: '99999999-9999-4999-8999-999999999999' },
      ),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_MISMATCH' });
    expect(executed).toBe(false);
    expect(await poolSettingValue()).toBeNull();
  });

  it('rejects an invalid organization id before any transaction work', async () => {
    const tenant = await createFreshDatabase();
    await seedMembership('owner');
    let executed = false;
    await expect(
      tenant.withOrganizationTransaction(
        { organizationId: 'not-a-uuid', role: 'owner', userId: 'tenant-user-1' },
        async () => {
          executed = true;
          return 'never';
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ORGANIZATION_ID' });
    expect(executed).toBe(false);
    expect(await poolSettingValue()).toBeNull();
  });

  it('rolls the transaction back when the callback fails', async () => {
    const tenant = await createFreshDatabase();
    await seedMembership('owner');
    const context = await tenant.resolveOrganizationContext('tenant-user-1');
    const before = Number(
      (await database.pool.query('SELECT count(*) AS count FROM core.organization')).rows[0]!.count,
    );
    await expect(
      tenant.withOrganizationTransaction(context, async (client) => {
        await client.query(
          "INSERT INTO core.organization (name) VALUES ('Organização Temporária')",
        );
        throw new Error('FALHA_CONTROLADA');
      }),
    ).rejects.toThrow('FALHA_CONTROLADA');
    const after = Number(
      (await database.pool.query('SELECT count(*) AS count FROM core.organization')).rows[0]!.count,
    );
    expect(after).toBe(before);
    expect(await poolSettingValue()).toBeNull();
  });

  it('reuses pooled connections without leaking the previous request context', async () => {
    const tenant = await createFreshDatabase();
    const first = await seedMembership('owner');
    await insertUser('tenant-user-2', 'Pessoa Dois', 'tenant-user-2@example.test');
    const second = await insertOrganization('Organização Dois');
    await insertMembership(second, 'tenant-user-2', 'owner');
    const contextOne = await tenant.resolveOrganizationContext('tenant-user-1');
    const contextTwo = await tenant.resolveOrganizationContext('tenant-user-2');
    const seenOne = await tenant.withOrganizationTransaction(contextOne, async (client) => {
      const rows = (
        await client.query(
          `SELECT current_setting('${ORGANIZATION_CONTEXT_SETTING}', true) AS value`,
        )
      ).rows;
      return rows[0]!.value as string;
    });
    expect(seenOne).toBe(first);
    const seenTwo = await tenant.withOrganizationTransaction(contextTwo, async (client) => {
      const rows = (
        await client.query(
          `SELECT current_setting('${ORGANIZATION_CONTEXT_SETTING}', true) AS value`,
        )
      ).rows;
      return rows[0]!.value as string;
    });
    expect(seenTwo).toBe(second);
    expect(await poolSettingValue()).toBeNull();
  });

  it('keeps two concurrent transactions isolated from each other', async () => {
    const tenant = await createFreshDatabase();
    const first = await seedMembership('owner');
    await insertUser('tenant-user-2', 'Pessoa Dois', 'tenant-user-2@example.test');
    const second = await insertOrganization('Organização Dois');
    await insertMembership(second, 'tenant-user-2', 'owner');
    const contextOne = await tenant.resolveOrganizationContext('tenant-user-1');
    const contextTwo = await tenant.resolveOrganizationContext('tenant-user-2');

    let arrived = 0;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const read = async (context: typeof contextOne, organizationId: string) => {
      return tenant.withOrganizationTransaction(context, async (client) => {
        const readSetting = async () =>
          (
            await client.query(
              `SELECT current_setting('${ORGANIZATION_CONTEXT_SETTING}', true) AS value`,
            )
          ).rows[0]!.value as string;
        const beforeGate = await readSetting();
        arrived += 1;
        if (arrived === 2) releaseGate();
        await gate;
        const afterGate = await readSetting();
        expect(context.organizationId).toBe(organizationId);
        return [beforeGate, afterGate];
      });
    };
    const [observedOne, observedTwo] = await Promise.all([
      read(contextOne, first),
      read(contextTwo, second),
    ]);
    expect(observedOne).toEqual([first, first]);
    expect(observedTwo).toEqual([second, second]);
    expect(await poolSettingValue()).toBeNull();
  });
});
