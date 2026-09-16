import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  coreSchema,
  createDatabase,
  membershipRole,
  requireDatabaseUrl,
  type Database,
} from '../../packages/db/src/index.js';
import { migrateLocalDatabase } from '../../packages/db/src/migrate.js';

const sourceUrl = requireDatabaseUrl(process.env.TEST_DATABASE_URL);
const admin = createDatabase(sourceUrl, { statementTimeoutMs: 30_000 });
const NAME_PATTERN = /^stk_core_test_[a-f0-9]{32}$/;

let database: Database;
let databaseName = '';
let created = false;

async function createFreshDatabase() {
  databaseName = `stk_core_test_${randomUUID().replaceAll('-', '')}`;
  if (!NAME_PATTERN.test(databaseName)) throw new Error('INVALID_TEST_DATABASE');
  await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  database = createDatabase(url.toString());
  return database;
}

async function dropCurrentDatabase() {
  await database?.close();
  if (created && NAME_PATTERN.test(databaseName)) {
    await admin.pool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  created = false;
}

/**
 * Returns the database to the state before migration 0005: the core schema does not exist and
 * the recorded migrations stop at 0004, so the next migrator run must replay the 0005 chain
 * (0005 and every later core migration, e.g. 0006, 0007, 0008, 0009) for real.
 */
async function reopenCoreMigration() {
  await database.pool.query('DROP SCHEMA "core" CASCADE');
  await database.pool.query(
    `DELETE FROM drizzle.__drizzle_migrations
     WHERE created_at > (SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC OFFSET 4 LIMIT 1)`,
  );
}

async function count(query: string, params: unknown[] = []) {
  const rows = (await database.pool.query<{ count: string }>(query, params)).rows;
  return Number(rows[0]?.count);
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
  return database.pool.query(
    'INSERT INTO core.membership (organization_id, user_id, role) VALUES ($1, $2, $3)',
    [organizationId, userId, role],
  );
}

afterEach(dropCurrentDatabase);
afterAll(async () => admin.close());

describe('core tenant registry on a fresh database without users', () => {
  it('creates the core namespace, its tables and the role enum', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    const tables = (
      await database.pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' ORDER BY table_name",
      )
    ).rows.map((row) => row.table_name);
    expect(tables).toEqual([
      'beta_invitation',
      'consent_record',
      'legal_document',
      'membership',
      'onboarding_state',
      'organization',
    ]);
    const enums = await count(
      "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'core' AND t.typname = 'membership_role'",
    );
    expect(enums).toBe(1);
    expect([...membershipRole.enumValues].sort()).toEqual(['owner', 'superadmin']);
  });

  it('leaves the registry empty when there are no users to backfill', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    expect(await count('SELECT count(*) FROM core.organization')).toBe(0);
    expect(await count('SELECT count(*) FROM core.membership')).toBe(0);
  });

  it('rejects organizations without a non-empty name', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    await expect(
      database.pool.query("INSERT INTO core.organization (name) VALUES ('')"),
    ).rejects.toThrow(/organization_name_not_empty/);
    await expect(
      database.pool.query('INSERT INTO core.organization (name) VALUES (NULL)'),
    ).rejects.toThrow(/not-null/);
  });

  it('keeps one membership per user globally and rejects duplicate pairs', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    await insertUser('core-test-user-1', 'Usuário Um', 'core-user-1@example.test');
    await insertUser('core-test-user-2', 'Usuário Dois', 'core-user-2@example.test');
    const first = await insertOrganization('Organização A');
    const second = await insertOrganization('Organização B');
    await insertMembership(first, 'core-test-user-1', 'owner');
    await expect(insertMembership(second, 'core-test-user-1', 'owner')).rejects.toThrow(
      /membership_user_id_unique/,
    );
    await expect(insertMembership(first, 'core-test-user-1', 'owner')).rejects.toThrow(
      /membership_organization_id_user_id_pk|membership_user_id_unique/,
    );
    expect(await count('SELECT count(*) FROM core.membership')).toBe(1);
  });

  it('rejects invalid roles at the database level', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    await insertUser('core-test-user-3', 'Usuário Três', 'core-user-3@example.test');
    const organizationId = await insertOrganization('Organização C');
    await expect(insertMembership(organizationId, 'core-test-user-3', 'admin')).rejects.toThrow(
      /invalid input value for enum/,
    );
  });

  it('enforces foreign keys on organization and user', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    await insertUser('core-test-user-4', 'Usuário Quatro', 'core-user-4@example.test');
    const organizationId = await insertOrganization('Organização D');
    await expect(
      insertMembership('00000000-0000-4000-8000-000000000000', 'core-test-user-4', 'owner'),
    ).rejects.toThrow(/membership_organization_id_organization_id_fk/);
    await expect(
      insertMembership(organizationId, 'core-test-missing-user', 'owner'),
    ).rejects.toThrow(/membership_user_id_user_id_fk/);
  });

  it('queries core.organization and core.membership through the ORM schema registry', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    expect(await database.orm.query.organization.findMany()).toEqual([]);
    expect(await database.orm.query.membership.findMany()).toEqual([]);
    await insertUser('core-orm-user', 'Usuário ORM', 'core-orm@example.test');
    const [organization] = await database.orm
      .insert(coreSchema.organization)
      .values({ name: 'Organização ORM' })
      .returning({ id: coreSchema.organization.id, name: coreSchema.organization.name });
    expect(organization).toMatchObject({ name: 'Organização ORM' });
    await database.orm.insert(coreSchema.membership).values({
      organizationId: organization!.id,
      userId: 'core-orm-user',
      role: 'owner',
    });
    const memberships = await database.orm.query.membership.findMany();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!).toMatchObject({ userId: 'core-orm-user', role: 'owner' });
    expect(await count('SELECT count(*) FROM core.organization')).toBe(1);
    expect(await count('SELECT count(*) FROM core.membership')).toBe(1);
  });
});

describe('core tenant registry backfill with a single pre-existing user', () => {
  it('creates the founding organization and an owner membership', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    const recordedBefore = await count('SELECT count(*) FROM drizzle.__drizzle_migrations');
    await reopenCoreMigration();
    await insertUser('core-founder-user', 'Fundadora Teste', 'core-founder@example.test');
    await migrateLocalDatabase(database);

    const organizations = (
      await database.pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM core.organization',
      )
    ).rows;
    expect(organizations).toHaveLength(1);
    expect(organizations[0]!.name).toBe('Fundadora Teste');

    const memberships = (
      await database.pool.query<{ organization_id: string; user_id: string; role: string }>(
        'SELECT organization_id, user_id, role FROM core.membership',
      )
    ).rows;
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toEqual({
      organization_id: organizations[0]!.id,
      user_id: 'core-founder-user',
      role: 'owner',
    });
    expect(await count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(recordedBefore);
  });
});

describe('core tenant registry backfill with more than one pre-existing user', () => {
  it('aborts fail-closed without merging users or recording the migration', async () => {
    await createFreshDatabase();
    await migrateLocalDatabase(database);
    const recordedBefore = await count('SELECT count(*) FROM drizzle.__drizzle_migrations');
    await reopenCoreMigration();
    await insertUser('core-user-a', 'Usuário A', 'core-user-a@example.test');
    await insertUser('core-user-b', 'Usuário B', 'core-user-b@example.test');

    let failure: unknown = null;
    try {
      await migrateLocalDatabase(database);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('STK-F1-01');
    expect(message).not.toMatch(/core-user-a|core-user-b|example\.test/);
    expect(
      await count("SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'core'"),
    ).toBe(0);
    // reopenCoreMigration removed the markers of 0005 and every later core migration
    // (0006, 0007, 0008, 0009); the failed 0005 replay must not add any marker back.
    expect(await count('SELECT count(*) FROM drizzle.__drizzle_migrations')).toBe(
      recordedBefore - 5,
    );
    expect(await count('SELECT count(*) FROM auth."user"')).toBe(2);
  });
});
