import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createDatabase, attachmentExpiredSql } from '@stakeframe/db';
import { BUNDLE, SHA, UUID, MAX_DUMP_BYTES, MAX_METADATA_BYTES } from './config.mjs';
import { restic, snapshots, readSnapshotMetadata } from './backup.mjs';
import {
  prepareBundle,
  clearBundle,
  readJson,
  hashFile,
  validateMetadata,
  tableCounts,
  financialIntegrity,
  roles,
} from './bundle.mjs';
import { run } from './process.mjs';
import { permissions } from './permissions.mjs';

export async function restore(config, requestedSnapshot, parentSignal) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(parentSignal ? [parentSignal] : [])]);
  if (requestedSnapshot !== undefined)
    assert.ok(SHA.test(requestedSnapshot), 'OPS_SNAPSHOT_REFUSED');
  const started = performance.now();
  const command = restic(config, signal);
  const all = await snapshots(command);
  assert.ok(all.length > 0, 'OPS_BACKUP_MISSING');
  const selected = requestedSnapshot
    ? all.find((snapshot) => snapshot.id === requestedSnapshot)
    : all[0];
  assert.ok(selected, 'OPS_SNAPSHOT_REFUSED');
  // Latest tombstones also apply when intentionally restoring an older snapshot.
  const tombstones = new Set(
    (await readSnapshotMetadata(command, all[0])).filter((row) => row.expired).map((row) => row.id),
  );
  const connectionString = config.connectionString.replace(
    '@postgres:5432/',
    '@restore-postgres:5432/',
  );
  assert.notEqual(connectionString, config.connectionString);
  const database = createDatabase(connectionString, { statementTimeoutMs: 30_000 });
  const client = database.createMigrationClient();
  client.on('error', () => controller.abort());
  const abort = () => {
    controller.abort();
    void client.end().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const pgEnv = { ...config.pgEnv, PGHOST: 'restore-postgres' };
  let prepared = false;
  try {
    await client.connect();
    const schemas = (
      await client.query(`select nspname from pg_namespace
      where nspname not like 'pg_%' and nspname not in ('information_schema','public')`)
    ).rows;
    const objects = (
      await client.query(`select count(*)::text as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')`)
    ).rows[0].count;
    assert.deepEqual(schemas, [], 'OPS_RESTORE_TARGET_OCCUPIED');
    assert.equal(objects, '0', 'OPS_RESTORE_TARGET_OCCUPIED');
    const expectedRoles = await roles(client);
    await command(['check']);
    await prepareBundle();
    prepared = true;
    for (const name of [
      'manifest.json',
      'roles.json',
      'permissions.json',
      'attachments.json',
      'database.dump',
    ]) {
      await command(['dump', selected.id, `${BUNDLE}/${name}`], {
        output: join(BUNDLE, name),
        maxBytes: name === 'database.dump' ? MAX_DUMP_BYTES : MAX_METADATA_BYTES,
      });
    }
    const manifest = await readJson('manifest.json');
    assert.ok(
      manifest.version === 1 &&
        UUID.test(manifest.cycle) &&
        Number(manifest.serverVersion) >= 180000 &&
        Number(manifest.serverVersion) < 190000,
    );
    assert.ok(
      Number.isFinite(Date.parse(manifest.cutoff)) &&
        Date.parse(manifest.cutoff) <= Date.now() + 60_000,
    );
    for (const [file, key] of [
      ['database.dump', 'databaseSha256'],
      ['attachments.json', 'attachmentsSha256'],
      ['roles.json', 'rolesSha256'],
      ['permissions.json', 'permissionsSha256'],
    ])
      assert.equal(await hashFile(join(BUNDLE, file)), manifest[key], 'OPS_BACKUP_CHECKSUM_FAILED');
    assert.deepEqual(await readJson('roles.json'), expectedRoles);
    const metadata = validateMetadata(await readJson('attachments.json'));
    await run(
      'pg_restore',
      [
        '--no-password',
        '--exit-on-error',
        '--single-transaction',
        '--dbname=stakeframe',
        '--section=pre-data',
        join(BUNDLE, 'database.dump'),
      ],
      { env: pgEnv, signal },
    );
    // Preserve every metadata row and FK target before PostgreSQL restores inbox data.
    for (let offset = 0; offset < metadata.length; offset += 100) {
      await client.query(
        `insert into integration.attachment select * from
        jsonb_populate_recordset(null::integration.attachment,$1::jsonb)`,
        [JSON.stringify(metadata.slice(offset, offset + 100))],
      );
    }
    await run(
      'pg_restore',
      [
        '--no-password',
        '--exit-on-error',
        '--single-transaction',
        '--dbname=stakeframe',
        '--section=data',
        '--section=post-data',
        join(BUNDLE, 'database.dump'),
      ],
      { env: pgEnv, signal },
    );
    assert.deepEqual(await tableCounts(client), manifest.counts, 'OPS_RESTORE_COUNT_MISMATCH');
    assert.deepEqual(
      await financialIntegrity(client),
      manifest.finance,
      'OPS_RESTORE_FINANCE_MISMATCH',
    );
    assert.deepEqual(await roles(client), expectedRoles);
    assert.deepEqual(
      await permissions(client),
      await readJson('permissions.json'),
      'OPS_RESTORE_PERMISSIONS_MISMATCH',
    );
    const expired = new Set(
      (
        await client.query(`select a.id from integration.attachment a
      where a.state in ('deleting','deleted') or (${attachmentExpiredSql})`)
      ).rows.map((row) => row.id),
    );
    let restoredImages = 0;
    for (const row of metadata) {
      signal?.throwIfAborted();
      if (row.expired || expired.has(row.id) || tombstones.has(row.id)) {
        await client.query(
          "update integration.attachment set state='deleted',image=null,remote_attempted=false where id=$1",
          [row.id],
        );
        continue;
      }
      const path = join(BUNDLE, 'attachments', row.id);
      await command(['dump', selected.id, `${BUNDLE}/attachments/${row.id}`], {
        output: path,
        maxBytes: row.size,
      });
      assert.equal(await hashFile(path), row.sha256, 'OPS_ATTACHMENT_CHECKSUM_FAILED');
      const image = await readFile(path);
      assert.equal(image.length, row.size);
      await client.query(
        "update integration.attachment set state='local',image=$2,remote_attempted=false where id=$1",
        [row.id, image],
      );
      // Only one image is staged during restore, independent of total corpus size.
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
      restoredImages++;
    }
    await client.query('begin');
    await client.query(
      "insert into integration.cursor(name,next_offset) values('recovery-quarantine',1) on conflict(name) do update set next_offset=1",
    );
    await client.query(
      "update integration.inbox set state='failed',error_code='AI_OUTCOME_UNCERTAIN',updated_at=now(),version=version+1 where state in ('pending','processing')",
    );
    await client.query('delete from integration.extraction_request');
    await client.query(
      "update integration.event_search set state='failed',error_code='EVENT_OUTCOME_UNCERTAIN',completed_at=now() where state in ('pending','processing')",
    );
    await client.query('delete from auth.session');
    await client.query('delete from auth.verification');
    await client.query(
      'update auth.account set access_token=null,refresh_token=null,id_token=null,access_token_expires_at=null,refresh_token_expires_at=null',
    );
    await client.query(
      "insert into finance.audit(type,actor,entity_id,after) values('recovery.restored','system',$1,$2)",
      [
        manifest.cycle,
        JSON.stringify({
          snapshot: selected.id,
          cutoff: manifest.cutoff,
          restoredImages,
          expiredImages: metadata.length - restoredImages,
          importsPaused: true,
        }),
      ],
    );
    await client.query('commit');
    return {
      version: 1,
      snapshot: selected.id,
      cutoff: manifest.cutoff,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      restoredImages,
      expiredImages: metadata.length - restoredImages,
      countsVerified: true,
      financeVerified: true,
      rolesVerified: true,
      permissionsVerified: true,
      importsPaused: true,
      sessionsRevoked: true,
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.end().catch(() => {});
    await database.close();
    if (prepared) await clearBundle();
  }
}
