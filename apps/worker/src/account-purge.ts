import { setTimeout as delay } from 'node:timers/promises';
import { createAccountDeletionService, type Database } from '@stakeframe/db';

/**
 * STK-F1-08 purge worker: runs the irreversible account purge for every deletion whose
 * 30-day grace window has closed. The scan is infrastructure (it iterates deletions, not
 * organizations) and the purge itself is idempotent: rows already purged, cancelled or
 * still inside the window are skipped by the service. Follows the worker loop pattern
 * (attachments, monthly units) instead of a pg-boss queue — pg-boss stays reserved for
 * the probe queue; nothing here needs per-job delivery semantics.
 */
export function startAccountPurge(database: Database) {
  const deletions = createAccountDeletionService(database);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        let progressed = false;
        for (const due of await deletions.duePurges()) {
          if (controller.signal.aborted) break;
          if (await deletions.purge(due.userId)) {
            progressed = true;
            // Sanitized trail: the durable evidence lives in core.account_deletion (state
            // 'purged' + purged_at); never log ids, e-mail or row counts of private data.
            console.log('ACCOUNT_PURGED');
          }
        }
        if (progressed) continue;
      } catch {
        console.warn('ACCOUNT_PURGE_FAILED');
      }
      await delay(60_000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('ACCOUNT_PURGE_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
  };
}
