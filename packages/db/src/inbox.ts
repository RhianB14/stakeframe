import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { validateImage, createAttachmentStore, type ObjectStorage } from './attachments.js';

export type EnqueueExtraction = (client: PoolClient, id: string) => Promise<void>;
export type InboxInput = {
  sourceKey: string;
  caption: string;
  metadata: object;
  requestHash?: string;
};

export const enqueueExtraction: EnqueueExtraction = async (client, id) => {
  await client.query('insert into integration.extraction_request(id,inbox_id) values($1,$2)', [
    randomUUID(),
    id,
  ]);
};

export function createInboxStore(
  database: Database,
  enqueue: EnqueueExtraction = enqueueExtraction,
  storage?: ObjectStorage,
) {
  const attachments = createAttachmentStore(database, storage);
  return {
    async offset() {
      const result = await database.pool.query<{ next_offset: string }>(
        "select next_offset from integration.cursor where name = 'telegram'",
      );
      return Number(result.rows[0]?.next_offset ?? 0);
    },
    async advance(next: number) {
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('INVALID_CURSOR');
      await database.pool.query(
        "insert into integration.cursor(name,next_offset) values ('telegram',$1) on conflict(name) do update set next_offset = greatest(integration.cursor.next_offset, excluded.next_offset)",
        [next],
      );
    },
    async accept(input: InboxInput, download: () => Promise<Buffer>) {
      if (!input.sourceKey || input.sourceKey.length > 200 || input.caption.length > 1024)
        throw new Error('INVALID_INBOX_INPUT');
      const existing = await database.pool.query<{ id: string; request_hash: string | null }>(
        'select id,request_hash from integration.inbox where source_key=$1',
        [input.sourceKey],
      );
      if (existing.rows[0]) {
        if (input.requestHash && existing.rows[0].request_hash !== input.requestHash)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return existing.rows[0].id;
      }
      const bytes = await download();
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('INVALID_INBOX_IMAGE');
      const info = await validateImage(bytes);
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        // Admission control is shared by all producers; the network call happened before BEGIN.
        await client.query('select pg_advisory_xact_lock(782341092)');
        const raced = (
          await client.query<{ id: string; request_hash: string | null }>(
            'select id,request_hash from integration.inbox where source_key=$1',
            [input.sourceKey],
          )
        ).rows[0];
        if (raced) {
          if (input.requestHash && raced.request_hash !== input.requestHash)
            throw new Error('IDEMPOTENCY_CONFLICT');
          await client.query('commit');
          return raced.id;
        }
        const capacity = await client.query<{ count: string; bytes: string }>(
          "select (select count(*) from integration.inbox where state not in ('discarded','imported')) as count, coalesce(sum(octet_length(image)),0) as bytes from integration.attachment",
        );
        if (
          Number(capacity.rows[0]?.count) >= 2000 ||
          Number(capacity.rows[0]?.bytes) + bytes.length > 1024 * 1024 * 1024
        )
          throw new Error('INBOX_CAPACITY_REACHED');
        const id = randomUUID();
        const shared = (
          await client.query<{ id: string }>(
            "select id from integration.attachment where sha256=$1 and state not in ('deleting','deleted')",
            [info.sha256],
          )
        ).rows[0];
        const attachmentId = shared?.id ?? randomUUID();
        if (!shared)
          await client.query(
            'insert into integration.attachment(id,sha256,image,mime,size,width,height,object_key) values($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              attachmentId,
              info.sha256,
              bytes,
              info.mime,
              bytes.length,
              info.width,
              info.height,
              `tickets/${attachmentId}`,
            ],
          );
        const inserted = await client.query<{ id: string }>(
          'insert into integration.inbox(id,source_key,attachment_id,sha256,caption,metadata,request_hash) values($1,$2,$3,$4,$5,$6,$7) on conflict(source_key) do nothing returning id',
          [
            id,
            input.sourceKey,
            attachmentId,
            createHash('sha256').update(bytes).digest('hex'),
            input.caption,
            JSON.stringify(input.metadata),
            input.requestHash ?? null,
          ],
        );
        if (inserted.rowCount) await enqueue(client, id);
        const result = await client.query<{ id: string }>(
          'select id from integration.inbox where source_key=$1',
          [input.sourceKey],
        );
        await client.query('commit');
        return result.rows[0]!.id;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async claim(id: string) {
      const pending = (
        await database.pool.query<{ attachment_id: string }>(
          "select attachment_id from integration.inbox where id=$1 and state='pending'",
          [id],
        )
      ).rows[0];
      if (!pending) return null;
      // Private object I/O happens before the transaction and before reserving a paid attempt.
      let image: Buffer;
      try {
        image = (await attachments.read(pending.attachment_id)).image;
      } catch {
        await database.pool.query(
          "update integration.inbox set state='failed',error_code='ATTACHMENT_UNAVAILABLE',version=version+1,updated_at=now() where id=$1 and state='pending'",
          [id],
        );
        return null;
      }
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(782341093)');
        const item = await client.query(
          "select id from integration.inbox where id=$1 and state='pending' for update",
          [id],
        );
        if (!item.rows[0]) {
          await client.query('commit');
          return null;
        }
        // Counts include uncertain/failed calls. Retrying requires a new explicit request.
        const period = await client.query<{ day: string; month: string }>(
          "select to_char(now() at time zone 'UTC','YYYY-MM-DD') as day, to_char(now() at time zone 'UTC','YYYY-MM') as month",
        );
        const { day, month } = period.rows[0]!;
        const usage = await client.query<{ daily: string; monthly: string }>(
          'select coalesce(sum(requests) filter(where day=$1),0) as daily, coalesce(sum(requests),0) as monthly from integration.ai_usage_day where day >= $2 and day < $3',
          [day, `${month}-01`, `${month}-32`],
        );
        if (Number(usage.rows[0]?.daily) >= 60 || Number(usage.rows[0]?.monthly) >= 1500) {
          await client.query(
            "update integration.inbox set state='failed',error_code='AI_LOCAL_QUOTA_REACHED',version=version+1,updated_at=now() where id=$1",
            [id],
          );
          await client.query('commit');
          return null;
        }
        await client.query(
          'insert into integration.ai_usage_day(day,requests) values($1,1) on conflict(day) do update set requests=integration.ai_usage_day.requests+1',
          [day],
        );
        const claimed = await client.query<{ attempts: number }>(
          "update integration.inbox set state='processing',attempts=attempts+1,version=version+1,updated_at=now() where id=$1 returning attempts",
          [id],
        );
        await client.query('commit');
        return { image, attempt: claimed.rows[0]!.attempts };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async complete(id: string, attempt: number, result: object) {
      await database.pool.query(
        "update integration.inbox set state='review',extraction=$2,error_code=null,version=version+1,updated_at=now() where id=$1 and state='processing' and attempts=$3",
        [id, JSON.stringify(result), attempt],
      );
    },
    async fail(id: string, attempt: number, code: string) {
      if (!/^[A-Z_]{3,80}$/.test(code)) throw new Error('INVALID_ERROR_CODE');
      await database.pool.query(
        "update integration.inbox set state='failed',error_code=$2,version=version+1,updated_at=now() where id=$1 and state='processing' and attempts=$3",
        [id, code, attempt],
      );
    },
    async recoverInterrupted() {
      await database.pool.query(
        "update integration.inbox set state='failed',error_code='AI_OUTCOME_UNCERTAIN',version=version+1,updated_at=now() where state='processing' and updated_at < now()-interval '3 minutes'",
      );
    },
  };
}
