import { createDatabase, requireDatabaseUrl } from './index.js';
import { migrateLocalDatabase } from './migrate.js';

async function main() {
  if (process.env.STAKEFRAME_RUNTIME !== 'local') throw new Error('LOCAL_RUNTIME_REQUIRED');
  const database = createDatabase(requireDatabaseUrl(process.env.DATABASE_URL));
  try {
    await migrateLocalDatabase(database);
    console.info('LOCAL_MIGRATIONS_COMPLETE');
  } finally {
    await database.close();
  }
}
void main().catch(() => {
  console.error('LOCAL_MIGRATION_FAILED');
  process.exitCode = 1;
});
