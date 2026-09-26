import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { run } from './process.mjs';
import { BACKUP_HOST, BACKUP_TAG, readDualStatus } from './config.mjs';

// STK-F1-11 (Plano Master §12.4): the primary Cloudflare R2 repository is
// mirrored to the Backblaze B2 repository through `restic copy`, which carries
// only blobs missing on the destination and preserves deduplication. Both
// destinations converge on the same retention after every sync.
export const RETENTION_DAILY = '14';
export const RETENTION_WEEKLY = '8';
export const RETENTION_MONTHLY = '12';
export const INCOMPLETE_RETENTION = '48h';
export const CHECK_INTERVAL_MS = 7 * 86400_000;
export const CHECK_RETRY_MS = 6 * 3600_000;
export const REPLICATION_TIMEOUT_MS = 60 * 60_000;
export const CHECK_TIMEOUT_MS = 2 * 60 * 60_000;
export const CHECK_SUBSET = '10%';

// Restic command bound to an explicit environment: the primary repository uses
// the service credentials, the second provider adds its own key pair. The
// read-only guard mirrors the primary wrapper so recovery-only runs can never
// mutate either repository.
export function resticAt(env, signal, { execute = run, readOnly = false } = {}) {
  return (args, options = {}) => {
    if (readOnly && !['snapshots', 'dump', 'check'].includes(args[0]))
      throw new Error('OPS_READ_ONLY_REPOSITORY');
    return execute(
      'restic',
      ['--no-cache', ...(readOnly ? ['--no-lock'] : ['--retry-lock', '30s']), ...args],
      { env, signal, ...options },
    );
  };
}

export function secondProviderEnv(config) {
  assert.ok(config.b2, 'OPS_SECOND_PROVIDER_REFUSED');
  return { ...config.resticEnv, ...config.b2.env, RESTIC_REPOSITORY: config.b2.repository };
}

export function retentionForgetArgs(complete) {
  return [
    'forget',
    '--host',
    BACKUP_HOST,
    '--tag',
    `${BACKUP_TAG},${complete ? 'complete' : 'incomplete'}`,
    '--group-by',
    'host,paths',
    ...(complete
      ? [
          '--keep-daily',
          RETENTION_DAILY,
          '--keep-weekly',
          RETENTION_WEEKLY,
          '--keep-monthly',
          RETENTION_MONTHLY,
          '--prune',
        ]
      : ['--keep-within', INCOMPLETE_RETENTION]),
  ];
}

export async function saveDualStatus(status) {
  const temporary = `/status/backup-dual-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(status) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, '/status/backup-dual.json');
}

// Integrity evidence: a full `restic check` with a bounded data subset runs at
// most once per week, at least six hours apart while failing, against both
// destinations. A failure never aborts the sync — it is reported as its own
// condition so the monitor can alert on it independently.
export function integrityDue(previous, nowMs) {
  const lastSuccess = Date.parse(previous?.integrity?.at ?? '');
  const lastAttempt = Date.parse(previous?.integrity?.attemptAt ?? '');
  const due = !Number.isFinite(lastSuccess) || nowMs - lastSuccess >= CHECK_INTERVAL_MS;
  const retryReady = !Number.isFinite(lastAttempt) || nowMs - lastAttempt >= CHECK_RETRY_MS;
  return due && retryReady;
}

export async function runIntegrityCheck(invokes, previous, nowMs) {
  const timestamp = new Date(nowMs).toISOString();
  if (!integrityDue(previous, nowMs)) return previous?.integrity ?? null;
  try {
    for (const invoke of invokes) await invoke(['check', '--read-data-subset', CHECK_SUBSET]);
    return { state: 'ready', at: timestamp, attemptAt: timestamp };
  } catch {
    return { state: 'failed', at: previous?.integrity?.at ?? null, attemptAt: timestamp };
  }
}

export async function replicate(config, parentSignal, dependencies = {}) {
  if (config.rehearsal || config.readOnly || !config.b2) return null;
  const execute = dependencies.run ?? run;
  const readStatus = dependencies.readStatus ?? readDualStatus;
  const saveStatus = dependencies.saveStatus ?? saveDualStatus;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(REPLICATION_TIMEOUT_MS),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  const previous = (await readStatus()) ?? {};
  const primary = config.resticEnv;
  const secondary = secondProviderEnv(config);
  const invoke = (env, args, options = {}) => resticAt(env, signal, { execute })(args, options);
  const timestamp = () => new Date().toISOString();
  let ratio;
  try {
    await invoke(
      {
        ...secondary,
        RESTIC_FROM_REPOSITORY: primary.RESTIC_REPOSITORY,
        RESTIC_FROM_PASSWORD: primary.RESTIC_PASSWORD,
      },
      ['copy'],
    );
    for (const env of [secondary, primary]) {
      await invoke(env, retentionForgetArgs(false));
      await invoke(env, retentionForgetArgs(true));
    }
    const raw = JSON.parse(
      (await invoke(primary, ['stats', '--json', '--mode', 'raw-data'])).stdout,
    );
    const restore = JSON.parse(
      (await invoke(primary, ['stats', '--json', '--mode', 'restore-size'])).stdout,
    );
    assert.ok(Number.isFinite(raw.total_size) && raw.total_size >= 0);
    assert.ok(Number.isFinite(restore.total_size) && restore.total_size >= 0);
    ratio =
      raw.total_size > 0 ? Math.round((restore.total_size / raw.total_size) * 100) / 100 : null;
  } catch (cause) {
    await saveStatus({ ...previous, version: 1, sync: { state: 'failed', at: timestamp() } });
    throw new Error('OPS_REPLICATION_FAILED', { cause });
  }
  const checkSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
  const integrity = await runIntegrityCheck(
    [secondary, primary].map((env) => resticAt(env, checkSignal, { execute })),
    previous,
    Date.now(),
  );
  const status = {
    version: 1,
    sync: { state: 'ready', at: timestamp() },
    integrity,
    ...(ratio === null ? {} : { dedup: { ratio, at: timestamp() } }),
  };
  await saveStatus(status);
  return status;
}
