import { readFile } from 'node:fs/promises';
import { readSecret, readDatabaseConfig } from '@stakeframe/db';

export const BACKUP_HOST = 'stakeframe-production';
export const BACKUP_TAG = 'stakeframe-bundle-v1';
export const BUNDLE = '/work/bundle';
export const MAX_BUNDLE_BYTES = 4 * 1024 ** 3;
export const MAX_DUMP_BYTES = 512 * 1024 ** 2;
export const MAX_METADATA_BYTES = 64 * 1024 ** 2;
export const CYCLE_TIMEOUT_MS = 25 * 60 * 1000;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SHA = /^[a-f0-9]{64}$/;

export function readOpsConfig(env) {
  if (env.NODE_ENV !== 'production' || env.STAKEFRAME_RUNTIME !== 'production')
    throw new Error('OPS_RUNTIME_REFUSED');
  const rehearsal = env.OPS_REHEARSAL === 'true';
  if (![undefined, 'true', 'false'].includes(env.BACKUP_READ_ONLY))
    throw new Error('OPS_RUNTIME_REFUSED');
  const dbPassword = readSecret(env, 'DB_PASSWORD');
  const connectionString = readDatabaseConfig(env);
  const repositoryPassword = readSecret(env, 'RESTIC_PASSWORD');
  if (!repositoryPassword || !SHA.test(repositoryPassword)) throw new Error('OPS_SECRET_REFUSED');
  let repository;
  let credentials = {};
  let b2 = null;
  if (rehearsal) {
    if (env.RESTIC_REPOSITORY !== '/repository' || env.R2_BACKUP_ACCOUNT_ID || env.R2_BACKUP_BUCKET)
      throw new Error('OPS_REHEARSAL_REPOSITORY_REFUSED');
    repository = '/repository';
  } else {
    if (env.OPS_REHEARSAL !== undefined && env.OPS_REHEARSAL !== 'false')
      throw new Error('OPS_RUNTIME_REFUSED');
    if (env.RESTIC_REPOSITORY !== undefined) throw new Error('OPS_REPOSITORY_OVERRIDE_REFUSED');
    const account = env.R2_BACKUP_ACCOUNT_ID;
    const bucket = env.R2_BACKUP_BUCKET;
    if (
      !/^[a-f0-9]{32}$/.test(account ?? '') ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
      bucket === env.R2_ATTACHMENTS_BUCKET
    )
      throw new Error('OPS_REPOSITORY_REFUSED');
    const access = readSecret(env, 'R2_BACKUP_ACCESS_KEY_ID');
    const secret = readSecret(env, 'R2_BACKUP_SECRET_ACCESS_KEY');
    if (!/^[a-f0-9]{32}$/.test(access ?? '') || !SHA.test(secret ?? ''))
      throw new Error('OPS_SECRET_REFUSED');
    repository = `s3:https://${account}.r2.cloudflarestorage.com/${bucket}/stakeframe-v1`;
    credentials = { AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret };
    // STK-F1-11 §12.4: the second provider (Backblaze B2) mirrors the primary
    // repository. Keys arrive as files under SECRET_DIRECTORY; values never
    // live in the repository, logs or status files.
    const b2Bucket = env.B2_BACKUP_BUCKET;
    const b2Account = readSecret(env, 'B2_BACKUP_ACCOUNT_ID');
    const b2Key = readSecret(env, 'B2_BACKUP_APPLICATION_KEY');
    if (
      !/^[A-Za-z0-9]{20,64}$/.test(b2Account ?? '') ||
      !/^[A-Za-z0-9]{20,64}$/.test(b2Key ?? '') ||
      !/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(b2Bucket ?? '')
    )
      throw new Error('OPS_SECOND_PROVIDER_REFUSED');
    b2 = {
      repository: `b2:${b2Bucket}:stakeframe-v1`,
      env: { B2_ACCOUNT_ID: b2Account, B2_ACCOUNT_KEY: b2Key },
    };
  }
  const restoreSource = env.RESTORE_SOURCE ?? 'r2';
  if (!['r2', 'b2'].includes(restoreSource)) throw new Error('OPS_RUNTIME_REFUSED');
  if (restoreSource === 'b2' && !b2) throw new Error('OPS_SECOND_PROVIDER_REFUSED');
  return {
    rehearsal,
    readOnly: env.BACKUP_READ_ONLY === 'true',
    restoreSource,
    b2,
    connectionString,
    pgEnv: {
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGDATABASE: 'stakeframe',
      PGUSER: 'stakeframe_app',
      PGPASSWORD: dbPassword,
      PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c statement_timeout=1200000 -c lock_timeout=5000',
    },
    resticEnv: {
      RESTIC_REPOSITORY: repository,
      RESTIC_PASSWORD: repositoryPassword,
      ...credentials,
      AWS_DEFAULT_REGION: 'auto',
      AWS_EC2_METADATA_DISABLED: 'true',
      GOMAXPROCS: '2',
    },
  };
}

export async function readStatus() {
  try {
    const source = await readFile('/status/backup.json', 'utf8');
    if (source.length > 4096) throw new Error();
    const status = JSON.parse(source);
    if (status.version !== 1 || !['ready', 'failed', 'running'].includes(status.state))
      throw new Error();
    return status;
  } catch {
    return { version: 1, state: 'failed', cutoff: null, completedAt: null, retention: false };
  }
}

export function nextBackupAt(now) {
  return (Math.floor(now / 1_800_000) + 1) * 1_800_000;
}

export function restoreTestHealth(status, now = Date.now()) {
  const completed = Date.parse(status?.completedAt ?? '');
  if (
    status?.version !== 1 ||
    status.status !== 'passed' ||
    status.cleanup !== 'passed' ||
    !Number.isFinite(completed) ||
    completed > now + 60_000 ||
    now - completed >= 35 * 86400_000
  )
    return 'failed';
  return now - completed >= 32 * 86400_000 ? 'warning' : 'ready';
}

export async function readRestoreTestHealth() {
  try {
    const source = await readFile('/status/restore-latest.json', 'utf8');
    if (source.length > 8192) throw new Error();
    return restoreTestHealth(JSON.parse(source));
  } catch {
    return 'failed';
  }
}

export function backupHealth(status, now = Date.now()) {
  const cutoff = Date.parse(status.cutoff ?? '');
  return {
    backup:
      Number.isFinite(cutoff) && cutoff <= now + 60_000 && now - cutoff < 3_600_000
        ? 'ready'
        : 'overdue',
    retention: status.retention === true ? 'ready' : 'failed',
    lastRun: status.state,
  };
}

// STK-F1-11 §12.4: deduplication below this ratio means the mirror stopped
// sharing data between cycles — surface a warning instead of alerting blind.
export const DEDUP_MIN_RATIO = 1.05;

export async function readDualStatus() {
  try {
    const source = await readFile('/status/backup-dual.json', 'utf8');
    if (source.length > 2048) throw new Error();
    const status = JSON.parse(source);
    if (status.version !== 1) throw new Error();
    return status;
  } catch {
    return null;
  }
}

export function syncHealth(dual, now = Date.now()) {
  const at = Date.parse(dual?.sync?.at ?? '');
  if (
    dual?.sync?.state !== 'ready' ||
    !Number.isFinite(at) ||
    at > now + 60_000 ||
    now - at >= 7_200_000
  )
    return 'failed';
  if (now - at >= 3_600_000) return 'warning';
  return Number.isFinite(dual?.dedup?.ratio) && dual.dedup.ratio < DEDUP_MIN_RATIO
    ? 'warning'
    : 'ready';
}

export function integrityHealth(dual, now = Date.now()) {
  const at = Date.parse(dual?.integrity?.at ?? '');
  if (
    dual?.integrity?.state !== 'ready' ||
    !Number.isFinite(at) ||
    at > now + 60_000 ||
    now - at >= 14 * 86400_000
  )
    return 'failed';
  return now - at >= 8 * 86400_000 ? 'warning' : 'ready';
}
