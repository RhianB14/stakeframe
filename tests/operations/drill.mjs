import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import {
  createDatabase,
  createFinanceService,
  createImportService,
  createAttachmentStore,
} from '@stakeframe/db';
import { migrateLocalDatabase } from './node_modules/@stakeframe/db/dist/migrate.js';
import { backup, restic, snapshots } from './src/backup.mjs';
import { restore } from './src/restore.mjs';
import { readOpsConfig, readStatus, BUNDLE } from './src/config.mjs';

const sharp = createRequire(import.meta.resolve('@stakeframe/db'))('sharp');
const config = readOpsConfig(process.env);
assert.equal(config.rehearsal, true);
const signal = AbortSignal.timeout(300000);
const command = restic(config, signal);
const database = createDatabase(config.connectionString, { statementTimeoutMs: 30000 });
const report = { version: 1, checks: [], status: 'running' };
const checked = (name) => {
  report.checks.push(name);
  console.info(`OPERATIONS_CHECK_PASSED ${name}`);
};
try {
  await migrateLocalDatabase(database);
  const finance = createFinanceService(database);
  const imports = createImportService(database);
  const execute = async (input) =>
    finance.command('fixture-owner', randomUUID(), {
      ...input,
      expectedVersion: (await finance.workspace()).version,
    });
  const house = (await finance.workspace()).catalog.find((row) => row.name === 'Bet365').id;
  await execute({
    type: 'bankroll.initialize',
    reserve: '500.00',
    balances: [{ bookmakerId: house, amount: '500.00' }],
    unitPercent: '1.00',
  });
  const bet = {
    bookmakerId: house,
    tipsterId: null,
    stake: '100.00',
    odds: '2.00',
    placedAt: new Date().toISOString(),
    freebetId: null,
    reference: 'fictional-recovery',
    allowMissingUnit: false,
    selections: [
      {
        event: 'Time A x Time B',
        sport: 'Futebol',
        market: 'Resultado',
        selection: 'A',
        odds: null,
        eventDate: null,
        eventAt: null,
        dateStatus: 'pending',
      },
    ],
  };
  await execute({ type: 'bet.create', ...bet });
  const second = await execute({
    type: 'bet.create',
    ...bet,
    reference: 'fictional-recovery-second',
    stake: '75.00',
    odds: '2.10',
  });
  await execute({
    type: 'bet.settle',
    id: second.id,
    outcome: 'win',
    closedPrincipal: '75.00',
    returnAmount: '157.50',
    settledAt: new Date().toISOString(),
    reason: 'Conferido no ensaio fictício',
  });
  const images = [];
  for (const color of ['#ff0000', '#00ff00', '#0000ff'])
    images.push(
      await sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
        .png()
        .toBuffer(),
    );
  const inbox = [];
  for (const image of images)
    inbox.push(
      (
        await imports.upload('fixture-owner', randomUUID(), {
          caption: 'Tipster fictício\nBet365',
          image: image.toString('base64'),
        })
      ).id,
    );
  const rows = (
    await database.pool.query(
      'select i.id,i.attachment_id,a.object_key from integration.inbox i join integration.attachment a on a.id=i.attachment_id order by i.created_at',
    )
  ).rows;
  const remote = new Map();
  const storage = {
    put: async (key, bytes) => {
      remote.set(key, Buffer.from(bytes));
    },
    get: async (key) => {
      assert.ok(remote.has(key));
      return remote.get(key);
    },
    delete: async (key) => {
      remote.delete(key);
    },
  };
  const attachments = createAttachmentStore(database, storage);
  await attachments.uploadOne();
  assert.equal(remote.size, 1);
  await execute({
    type: 'import.discard',
    importId: inbox[2],
    expectedInboxVersion: 1,
    reason: 'Anexo fictício descartado',
  });
  await database.pool.query(
    "insert into integration.cursor(name,next_offset) values('telegram',123)",
  );
  await command(['init', '--repository-version', '2']);
  const first = await backup(config, process.env, signal, { storage });
  assert.equal(first.imageCount, 3);
  assert.equal(first.retention, true);
  checked('consistent-encrypted-dump-local-and-remote-images');
  const guard = database.createMigrationClient();
  await guard.connect();
  try {
    await guard.query('select pg_advisory_lock(782341097)');
    assert.deepEqual(await backup(config, process.env, signal, { storage }), { skipped: true });
  } finally {
    await guard.end();
  }
  assert.equal((await readStatus()).snapshot, first.snapshot);
  checked('overlapping-backup-does-not-replace-valid-status');
  await assert.rejects(
    backup(config, process.env, signal, {
      storage: {
        get: async () => {
          throw new Error('Fictional storage outage');
        },
      },
    }),
  );
  assert.equal((await snapshots(command)).length, 1);
  assert.equal((await readStatus()).cutoff, first.cutoff);
  checked('missing-image-refuses-publish-and-preserves-last-recoverable-cutoff');
  await database.pool.query(
    "update integration.inbox set updated_at=now()-interval '31 days' where id=$1",
    [inbox[2]],
  );
  const secondBackup = await backup(config, process.env, signal, { storage });
  assert.equal(secondBackup.imageCount, 2);
  const remaining = await snapshots(command);
  assert.equal(remaining.length, 2);
  assert.equal((await readStatus()).snapshot, secondBackup.snapshot);
  assert.ok(remaining.some((snapshot) => snapshot.id === secondBackup.snapshot));
  const expiredId = rows.find((row) => row.id === inbox[2]).attachment_id;
  for (const snapshot of remaining)
    await assert.rejects(command(['dump', snapshot.id, `${BUNDLE}/attachments/${expiredId}`]));
  await command(['check', '--read-data']);
  checked('expired-payload-purged-from-current-and-historical-snapshots');
  const targetConfig = readOpsConfig({
    ...process.env,
    DB_PASSWORD_FILE: '/run/secrets/target_db_password',
    BACKUP_READ_ONLY: 'true',
  });
  const wrongKey = {
    ...targetConfig,
    resticEnv: { ...targetConfig.resticEnv, RESTIC_PASSWORD: 'b'.repeat(64) },
  };
  await assert.rejects(restore(wrongKey, undefined, signal));
  checked('wrong-recovery-key-refused');
  const restored = await restore(targetConfig, remaining.at(-1).id, signal);
  assert.equal(restored.restoredImages, 2);
  assert.equal(restored.expiredImages, 1);
  assert.equal(restored.importsPaused, true);
  report.restore = restored;
  const target = createDatabase(
    targetConfig.connectionString.replace('@postgres:', '@restore-postgres:'),
  );
  try {
    const restoredStore = createAttachmentStore(target);
    for (let index = 0; index < 2; index++)
      assert.deepEqual(
        (await restoredStore.read(rows.find((row) => row.id === inbox[index]).attachment_id)).image,
        images[index],
      );
    await assert.rejects(restoredStore.read(expiredId));
    assert.equal(
      (
        await target.pool.query(
          "select next_offset::text from integration.cursor where name='recovery-quarantine'",
        )
      ).rows[0].next_offset,
      '1',
    );
    assert.equal(
      (
        await target.pool.query(
          "select count(*)::text as count from integration.inbox where state in ('pending','processing')",
        )
      ).rows[0].count,
      '0',
    );
    const before = (await target.pool.query('select count(*)::text as count from finance.bet'))
      .rows[0].count;
    await assert.rejects(restore(targetConfig, undefined, signal), /OPS_RESTORE_TARGET_OCCUPIED/);
    assert.equal(
      (await target.pool.query('select count(*)::text as count from finance.bet')).rows[0].count,
      before,
    );
  } finally {
    await target.close();
  }
  checked('historical-restore-respects-latest-expiry-and-preserves-financial-data');
  checked('occupied-target-refused-and-imports-quarantined');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failureType = error.code ?? error.name;
  report.failureCode = /^[A-Z_]+$/.test(error.message ?? '') ? error.message : undefined;
  report.failureLine = error.stack?.match(/drill.mjs:(\d+):/)?.[1];
  report.failureCause = error.cause
    ? {
        type: error.cause.code ?? error.cause.name,
        code: /^[A-Z_]+$/.test(error.cause.message ?? '') ? error.cause.message : undefined,
        source: error.cause.stack?.match(/(?:backup|bundle|process|config)\.mjs:\d+:\d+/)?.[0],
      }
    : undefined;
  // Fixtures are synthetic; only the fixed error code/name is emitted.
  console.error('OPERATIONS_REHEARSAL_FAILED', report.failureType);
  process.exitCode = 1;
} finally {
  await database.close();
  await writeFile('/status/rehearsal.json', JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
