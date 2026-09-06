import { createDatabase, requireDatabaseUrl, readRuntime, readDatabaseConfig } from './index.js';
import { migrateLocalDatabase } from './migrate.js';

async function main() {
  const runtime = readRuntime(process.env);
  if (runtime === 'production' && process.env.MIGRATION_CONFIRM !== 'production')
    throw new Error('EXPLICIT_MIGRATION_CONFIRMATION_REQUIRED');
  const database = createDatabase(requireDatabaseUrl(readDatabaseConfig(process.env)));
  try {
    await migrateLocalDatabase(database);
    console.info('MIGRATIONS_COMPLETE');
  } finally {
    await database.close();
  }
}
void main().catch(() => {
  console.error('MIGRATION_FAILED');
  process.exitCode = 1;
});
