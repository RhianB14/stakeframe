import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './index.js';

export async function migrateLocalDatabase(database: Database) {
  const client = database.createMigrationClient();
  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock(782341091)');
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      migrationsSchema: 'drizzle',
    });
  } finally {
    // Destroy this dedicated connection so session settings and locks cannot leak into the pool.
    await client.end();
  }
}
