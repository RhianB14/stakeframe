import { setTimeout as delay } from 'node:timers/promises';
import {
  createAttachmentStore,
  createR2Storage,
  createTenantContext,
  type Database,
} from '@stakeframe/db';

export function startAttachments(database: Database, env: NodeJS.ProcessEnv) {
  const store = createAttachmentStore(database, createR2Storage(env));
  const tenant = createTenantContext(database);
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        // Infrastructure iterates organizations: every attempt runs inside the tenant context.
        let progressed = false;
        for (const context of await tenant.listOrganizations()) {
          if (controller.signal.aborted) break;
          const expired = await store.retainOne(context);
          const uploaded = await store.uploadOne(context);
          if (uploaded || expired) progressed = true;
        }
        if (progressed) continue;
      } catch {
        console.warn('ATTACHMENT_MAINTENANCE_FAILED');
      }
      await delay(60_000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    check() {
      if (controller.signal.aborted) throw new Error('ATTACHMENTS_STOPPED');
    },
    async stop() {
      controller.abort();
      await task;
    },
  };
}
