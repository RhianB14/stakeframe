import type { Database } from './index.js';

export async function assertRecoveryReviewed(database: Database) {
  const result = await database.pool.query<{ next_offset: string }>(
    "select next_offset::text from integration.cursor where name='recovery-quarantine'",
  );
  if (result.rows[0] && result.rows[0].next_offset !== '0')
    throw new Error('INTEGRATIONS_RECOVERY_REVIEW_REQUIRED');
}
