import { setTimeout as delay } from 'node:timers/promises';
import { createAttachmentStore, createR2Storage, type Database } from '@stakeframe/db';

export function startAttachments(database: Database, env: NodeJS.ProcessEnv) {
  const store = createAttachmentStore(database, createR2Storage(env));
  const controller = new AbortController();
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        const expired = await store.retainOne();
        const uploaded = await store.uploadOne();
        if (uploaded || expired) continue;
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
