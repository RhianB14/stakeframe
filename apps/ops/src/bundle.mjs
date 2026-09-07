import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
  readFile,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentExpiredSql } from '@stakeframe/db';
import { BUNDLE, UUID, SHA, MAX_METADATA_BYTES } from './config.mjs';

const files = ['database.dump', 'attachments.json', 'manifest.json', 'roles.json'];
export async function clearBundle() {
  let info;
  try {
    info = await lstat(BUNDLE);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(BUNDLE), BUNDLE);
  const entries = await readdir(BUNDLE, { withFileTypes: true });
  assert.ok(
    entries.every((entry) =>
      entry.name === 'attachments'
        ? entry.isDirectory()
        : files.includes(entry.name) && entry.isFile(),
    ),
  );
  if (entries.some((entry) => entry.name === 'attachments')) {
    const attachments = join(BUNDLE, 'attachments');
    assert.equal(await realpath(attachments), attachments);
    const images = await readdir(attachments, { withFileTypes: true });
    assert.ok(images.every((entry) => UUID.test(entry.name) && entry.isFile()));
    for (const entry of images) await unlink(join(attachments, entry.name));
    await rmdir(attachments);
  }
  for (const entry of entries)
    if (entry.name !== 'attachments') await unlink(join(BUNDLE, entry.name));
  await rmdir(BUNDLE);
}

export async function prepareBundle() {
  await clearBundle();
  await mkdir(BUNDLE, { mode: 0o700 });
  await mkdir(join(BUNDLE, 'attachments'), { mode: 0o700 });
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function writeJson(name, value) {
  assert.ok(files.includes(name));
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_METADATA_BYTES) throw new Error('OPS_METADATA_LIMIT');
  await writeFile(join(BUNDLE, name), bytes, { flag: 'wx', mode: 0o600 });
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readJson(name) {
  assert.ok(files.includes(name));
  const path = join(BUNDLE, name);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_METADATA_BYTES);
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeImage(id, image, sha, createdAt) {
  assert.ok(UUID.test(id) && SHA.test(sha));
  assert.ok(image.length > 0 && image.length <= 8388608);
  assert.equal(createHash('sha256').update(image).digest('hex'), sha);
  const path = join(BUNDLE, 'attachments', id);
  await writeFile(path, image, { flag: 'wx', mode: 0o600 });
  // Immutable metadata gives restic stable paths and timestamps across cycles.
  const time = new Date(createdAt);
  await utimes(path, time, time);
}

export async function tableCounts(client) {
  const tables = (
    await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname) as name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p') and n.nspname not like 'pg_%' and n.nspname<>'information_schema'
    order by 1`)
  ).rows;
  assert.ok(tables.length > 0 && tables.length <= 1000);
  const result = {};
  for (const { name } of tables)
    result[name] = (
      await client.query(`select count(*)::text as count from ${name}`)
    ).rows[0].count;
  return result;
}

export async function financialIntegrity(client) {
  const bad = (
    await client.query(`select count(*)::text as count from
    (select j.id from finance.journal j left join finance.posting p on p.journal_id=j.id
     group by j.id having count(p.account_id)<2 or coalesce(sum(p.amount),0)<>0) unbalanced`)
  ).rows[0].count;
  assert.equal(bad, '0', 'OPS_LEDGER_UNBALANCED');
  const exposure = (
    await client.query(`select coalesce(sum(p.amount),0)::numeric(16,2)::text as amount
    from finance.posting p join finance.account a on a.id=p.account_id where a.kind='exposure'`)
  ).rows[0].amount;
  const remaining = (
    await client.query(`select coalesce(sum(remaining),0)::numeric(16,2)::text as amount
    from finance.bet where freebet_id is null and state='open'`)
  ).rows[0].amount;
  assert.equal(exposure, remaining, 'OPS_EXPOSURE_MISMATCH');
  const accounts = (
    await client.query(`select a.id,coalesce(sum(p.amount),0)::numeric(16,2)::text as amount
    from finance.account a left join finance.posting p on p.account_id=a.id group by a.id order by a.id`)
  ).rows;
  return { exposure, accounts };
}

export async function roles(client) {
  const role = (
    await client.query(`select rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin
    from pg_roles where rolname='stakeframe_app'`)
  ).rows[0];
  assert.deepEqual(role, {
    rolname: 'stakeframe_app',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
  });
  const membership = (
    await client.query(`select count(*)::text as count from pg_auth_members m
    join pg_roles r on r.oid=m.member where r.rolname='stakeframe_app'`)
  ).rows[0].count;
  assert.equal(membership, '0');
  const owner = (
    await client.query(
      `select pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()`,
    )
  ).rows[0].owner;
  assert.equal(owner, 'stakeframe_app');
  return { version: 1, databaseOwner: owner, application: role, memberships: [] };
}

export async function attachmentMetadata(client) {
  const columns = [
    'id',
    'sha256',
    'mime',
    'size',
    'width',
    'height',
    'state',
    'object_key',
    'remote_attempted',
    'created_at',
    'updated_at',
  ];
  const actual = (
    await client.query(`select attname from pg_attribute where attrelid='integration.attachment'::regclass
    and attnum>0 and not attisdropped order by attname`)
  ).rows.map((row) => row.attname);
  assert.deepEqual(actual, [...columns, 'image'].sort(), 'OPS_ATTACHMENT_SCHEMA_CHANGED');
  const metadataFields = columns.map((column) => `'${column}',a.${column}`).join(',');
  const result = [];
  let last = null;
  let bytes = 2;
  while (true) {
    const rows = (
      await client.query(
        `select jsonb_build_object(${metadataFields}) as metadata,
      (a.state in ('deleting','deleted') or (${attachmentExpiredSql})) as expired
      from integration.attachment a where ($1::uuid is null or a.id>$1::uuid) order by a.id limit 500`,
        [last],
      )
    ).rows;
    for (const { metadata, expired } of rows) {
      const row = { ...metadata, expired };
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > MAX_METADATA_BYTES || result.length >= 250_000)
        throw new Error('OPS_METADATA_LIMIT');
      result.push(row);
      last = row.id;
    }
    if (rows.length < 500) return result;
  }
}

export function validateMetadata(rows) {
  assert.ok(Array.isArray(rows) && rows.length <= 250_000);
  const ids = new Set();
  for (const row of rows) {
    assert.ok(UUID.test(row.id) && SHA.test(row.sha256) && !ids.has(row.id));
    ids.add(row.id);
    assert.ok(Number.isInteger(row.size) && row.size > 0 && row.size <= 8388608);
    assert.ok(['local', 'remote', 'deleting', 'deleted'].includes(row.state));
    assert.ok(['image/png', 'image/jpeg'].includes(row.mime));
    assert.equal(row.object_key, `tickets/${row.id}`);
    assert.equal(typeof row.expired, 'boolean');
    assert.ok(
      Number.isFinite(Date.parse(row.created_at)) && Number.isFinite(Date.parse(row.updated_at)),
    );
    assert.equal(row.image, undefined);
  }
  return rows;
}
