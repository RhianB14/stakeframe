import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';

export type EnqueueExtraction = (client: PoolClient, id: string) => Promise<void>;
export type InboxInput = { sourceKey: string; caption: string; metadata: object };

export function createInboxStore(database: Database, enqueue: EnqueueExtraction) {
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
      const existing = await database.pool.query<{ id: string }>(
        'select id from integration.inbox where source_key=$1',
        [input.sourceKey],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const bytes = await download();
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('INVALID_INBOX_IMAGE');
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        // Admission control is shared by all producers; the network call happened before BEGIN.
        await client.query('select pg_advisory_xact_lock(782341092)');
        const capacity = await client.query<{ count: string; bytes: string }>(
          'select count(*) as count, coalesce(sum(octet_length(image)),0) as bytes from integration.inbox',
        );
        if (
          Number(capacity.rows[0]?.count) >= 2000 ||
          Number(capacity.rows[0]?.bytes) + bytes.length > 1024 * 1024 * 1024
        )
          throw new Error('INBOX_CAPACITY_REACHED');
        const id = randomUUID();
        const inserted = await client.query<{ id: string }>(
          'insert into integration.inbox(id,source_key,image,sha256,caption,metadata) values($1,$2,$3,$4,$5,$6) on conflict(source_key) do nothing returning id',
          [
            id,
            input.sourceKey,
            bytes,
            createHash('sha256').update(bytes).digest('hex'),
            input.caption,
            JSON.stringify(input.metadata),
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
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(782341093)');
        const item = await client.query<{ image: Buffer }>(
          "select image from integration.inbox where id=$1 and state='pending' for update",
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
        await client.query(
          "update integration.inbox set state='processing',attempts=attempts+1,version=version+1,updated_at=now() where id=$1",
          [id],
        );
        await client.query('commit');
        return item.rows[0].image;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async complete(id: string, result: object) {
      await database.pool.query(
        "update integration.inbox set state='review',extraction=$2,error_code=null,version=version+1,updated_at=now() where id=$1 and state='processing'",
        [id, JSON.stringify(result)],
      );
    },
    async fail(id: string, code: string) {
      if (!/^[A-Z_]{3,80}$/.test(code)) throw new Error('INVALID_ERROR_CODE');
      await database.pool.query(
        "update integration.inbox set state='failed',error_code=$2,version=version+1,updated_at=now() where id=$1 and state='processing'",
        [id, code],
      );
    },
    async recoverInterrupted() {
      await database.pool.query(
        "update integration.inbox set state='failed',error_code='AI_OUTCOME_UNCERTAIN',version=version+1,updated_at=now() where state='processing' and updated_at < now()-interval '3 minutes'",
      );
    },
  };
}
