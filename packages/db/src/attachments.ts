import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { MAX_IMAGE_BYTES } from '@stakeframe/shared';
import { readSecret, readRuntime } from './runtime-config.js';
import type { Database } from './index.js';
import { attachmentExpiredSql } from './attachment-policy.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';

let decoderTail = Promise.resolve();
let waitingDecoders = 0;
export async function validateImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('INVALID_INBOX_IMAGE');
  if (waitingDecoders >= 4) throw new Error('INBOX_BUSY');
  const previous = decoderTail;
  let release!: () => void;
  decoderTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  waitingDecoders++;
  await previous;
  try {
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
    const info = await decoder.metadata();
    if (!['png', 'jpeg'].includes(info.format ?? '') || (info.pages ?? 1) !== 1) throw new Error();
    // Metadata alone accepts truncated files. Force full pixel decoding before admission.
    await decoder.stats();
    return {
      mime: info.format === 'png' ? 'image/png' : 'image/jpeg',
      width: info.width,
      height: info.height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new Error('INVALID_INBOX_IMAGE');
  } finally {
    waitingDecoders--;
    release();
  }
}

export type ObjectStorage = {
  put(key: string, image: Buffer, mime: string, signal?: AbortSignal): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
};
export function createR2Storage(env: NodeJS.ProcessEnv): ObjectStorage | undefined {
  if (env.R2_ATTACHMENTS_ENABLED === undefined || env.R2_ATTACHMENTS_ENABLED === 'false')
    return undefined;
  if (env.R2_ATTACHMENTS_ENABLED !== 'true') throw new Error('INVALID_ATTACHMENT_STORAGE_CONFIG');
  readRuntime(env);
  const account = env.R2_ACCOUNT_ID;
  const bucket = env.R2_ATTACHMENTS_BUCKET;
  if (
    !account ||
    !/^[a-f0-9]{32}$/.test(account) ||
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  )
    throw new Error('INVALID_ATTACHMENT_STORAGE_CONFIG');
  const accessKeyId = readSecret(env, 'R2_ATTACHMENTS_ACCESS_KEY_ID');
  const secretAccessKey = readSecret(env, 'R2_ATTACHMENTS_SECRET_ACCESS_KEY');
  if (
    !accessKeyId ||
    !/^[a-f0-9]{32}$/.test(accessKeyId) ||
    !secretAccessKey ||
    !/^[a-f0-9]{64}$/.test(secretAccessKey)
  )
    throw new Error('INVALID_ATTACHMENT_STORAGE_CONFIG');
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  const signal = (extra?: AbortSignal) => ({
    abortSignal: extra
      ? AbortSignal.any([extra, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return {
    async put(Key, Body, ContentType, abort) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }),
        signal(abort),
      );
    },
    async get(Key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }), signal());
      if (!result.Body || !result.ContentLength || result.ContentLength > MAX_IMAGE_BYTES)
        throw new Error('ATTACHMENT_UNAVAILABLE');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('ATTACHMENT_UNAVAILABLE');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async delete(Key, abort) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }), signal(abort));
    },
  };
}

export function createAttachmentStore(database: Database, storage?: ObjectStorage) {
  const tenant = createTenantContext(database);
  return {
    /** Read one attachment inside the caller's organization transaction (RLS applies). */
    async read(client: Pick<PoolClient, 'query'>, id: string) {
      const row = (
        await client.query<{
          image: Buffer | null;
          mime: string;
          object_key: string;
          state: string;
          sha256: string;
        }>(
          'select image,mime,object_key,state,sha256 from integration.attachment where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
          [id],
        )
      ).rows[0];
      if (!row || ['deleting', 'deleted'].includes(row.state))
        throw new Error('ATTACHMENT_UNAVAILABLE');
      const image = row.image ?? (storage ? await storage.get(row.object_key) : null);
      if (!image || createHash('sha256').update(image).digest('hex') !== row.sha256)
        throw new Error('ATTACHMENT_UNAVAILABLE');
      return { image, mime: row.mime };
    },
    /** One organization's upload attempt; callers iterate organizations (infrastructure). */
    async uploadOne(context: OrganizationContext) {
      if (!storage) return false;
      // A session lock prevents concurrent upload/deletion across worker instances.
      const client = await database.pool.connect();
      const controller = new AbortController();
      client.on('error', () => controller.abort());
      try {
        const lock = (
          await client.query<{ locked: boolean }>(
            'select pg_try_advisory_lock(782341095) as locked',
          )
        ).rows[0]!.locked;
        if (!lock) return false;
        const claimed = await tenant.withOrganizationTransaction(
          context,
          async (connection) => {
            const row = (
              await connection.query<{
                id: string;
                image: Buffer;
                mime: string;
                object_key: string;
              }>(
                "select id,image,mime,object_key from integration.attachment where organization_id=current_setting($$app.organization_id$$, true)::uuid and state='local' and (not remote_attempted or updated_at<now()-interval '2 minutes') order by created_at limit 1",
              )
            ).rows[0];
            if (!row) return null;
            // Persist intent before PUT: an interrupted response may still have stored the object.
            await connection.query(
              'update integration.attachment set remote_attempted=true,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
              [row.id],
            );
            return row;
          },
          { client },
        );
        if (!claimed) return false;
        await storage.put(claimed.object_key, claimed.image, claimed.mime, controller.signal);
        await tenant.withOrganizationTransaction(
          context,
          async (connection) => {
            await connection.query(
              "update integration.attachment set state='remote',image=null,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and state='local'",
              [claimed.id],
            );
          },
          { client },
        );
        return true;
      } finally {
        client.release(true);
      }
    },
    /** One organization's retention attempt; callers iterate organizations (infrastructure). */
    async retainOne(context: OrganizationContext) {
      const client = await database.pool.connect();
      const controller = new AbortController();
      client.on('error', () => controller.abort());
      try {
        const lock = (
          await client.query<{ locked: boolean }>(
            'select pg_try_advisory_lock(782341095) as locked',
          )
        ).rows[0]!.locked;
        if (!lock) return false;
        const row = await tenant.withOrganizationTransaction(
          context,
          async (connection) => {
            await connection.query(
              'select id from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid for update',
            );
            await connection.query('select pg_advisory_xact_lock(782341092)');
            // Every inbox reference must be terminal and every linked bet closed for 30 days.
            // Settlement creation time also protects late backdated entries.
            const candidate = (
              await connection.query<{
                id: string;
                object_key: string;
                state: string;
                remote_attempted: boolean;
              }>(
                `
          select a.id,a.object_key,a.state,a.remote_attempted from integration.attachment a
          where a.organization_id=current_setting($$app.organization_id$$, true)::uuid
            and ($1::boolean or not a.remote_attempted)
            and (not a.remote_attempted or a.updated_at<now()-interval '2 minutes')
            and (a.state='deleting' or (a.state in ('local','remote')
            and (${attachmentExpiredSql}))) order by a.updated_at limit 1 for update of a`,
                [Boolean(storage)],
              )
            ).rows[0];
            if (!candidate) return null;
            await connection.query(
              "update integration.attachment set state='deleting',updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1",
              [candidate.id],
            );
            return candidate;
          },
          { client },
        );
        if (!row) return false;
        if (storage) await storage.delete(row.object_key, controller.signal);
        await tenant.withOrganizationTransaction(
          context,
          async (connection) => {
            await connection.query(
              "update integration.attachment set state='deleted',image=null,updated_at=now() where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1 and state='deleting'",
              [row.id],
            );
            await connection.query(
              "insert into finance.audit(type,actor,entity_id,after) values('attachment.expired','system',$1,$2)",
              [row.id, JSON.stringify({ policy: '30_days_after_all_references_closed' })],
            );
          },
          { client },
        );
        return true;
      } finally {
        client.release(true);
      }
    },
  };
}
