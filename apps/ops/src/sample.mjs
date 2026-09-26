import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { run } from './process.mjs';
import { BUNDLE, MAX_METADATA_BYTES } from './config.mjs';
import { snapshots } from './backup.mjs';
import { hashFile, validateMetadata } from './bundle.mjs';
import { resticAt, secondProviderEnv } from './replicate.mjs';

// STK-F1-11 §12.4: periodic restore evidence without touching production — a
// bounded sample (manifest, attachment metadata and one attachment) is dumped
// from the latest complete snapshot of EACH destination and verified against
// the bundle checksums. Run manually; nothing is written outside /work and the
// caller-owned status file.
export const SAMPLE_TIMEOUT_MS = 30 * 60_000;
// The daemon cycle (backup + copy + retention) holds the repository lock for
// minutes: retry the lock well past a normal cycle instead of failing on
// contention. Sample runs still belong outside the cycle window (runbook §3).
export const SAMPLE_RETRY_LOCK = '15m';

// Reports carry a code, never provider output or paths: anything that is not a
// known OPS_* code is collapsed into a generic marker for the operator.
export function sampleReason(error) {
  if (error?.code === 'ERR_ASSERTION') return 'OPS_SAMPLE_VALIDATION_FAILED';
  const message = error instanceof Error ? error.message : '';
  return /^OPS_[A-Z_]{3,40}$/.test(message) ? message : 'OPS_SAMPLE_FAILED';
}

// Operator-facing detail for our own OPS_* failures only: the cause carries the
// sanitized provider excerpt (process.mjs), bounded again here. Raw messages
// from unknown errors are never echoed.
export function sampleDetail(error) {
  const message = error instanceof Error ? error.message : '';
  if (!/^OPS_[A-Z_]{3,40}$/.test(message)) return null;
  const cause = error?.cause instanceof Error ? error.cause.message : '';
  return cause ? cause.slice(0, 80) : null;
}

// Reports carry a code, never provider output or paths: anything that is not a
// known OPS_* code is collapsed into a generic marker for the operator.
export function sampleReason(error) {
  if (error?.code === 'ERR_ASSERTION') return 'OPS_SAMPLE_VALIDATION_FAILED';
  const message = error instanceof Error ? error.message : '';
  return /^OPS_[A-Z_]{3,40}$/.test(message) ? message : 'OPS_SAMPLE_FAILED';
}

export async function sample(config, parentSignal, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(SAMPLE_TIMEOUT_MS),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  const sources = [['r2', config.resticEnv]];
  if (config.b2) sources.push(['b2', secondProviderEnv(config)]);
  const directory = join(dependencies.workdir ?? '/work', `sample-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { version: 1, at: new Date().toISOString(), sources: {} };
  try {
    for (const [id, env] of sources) {
      try {
        const invoke = resticAt(env, signal, { execute, retryLock: SAMPLE_RETRY_LOCK });
        const all = await snapshots(invoke, { complete: true });
        assert.ok(all.length > 0, 'OPS_BACKUP_MISSING');
        const snapshot = all[0];
        const manifest = JSON.parse(
          (
            await invoke(['dump', snapshot.id, `${BUNDLE}/manifest.json`], {
              maxBytes: MAX_METADATA_BYTES,
            })
          ).stdout,
        );
        assert.equal(manifest.version, 1);
        const metadata = validateMetadata(
          JSON.parse(
            (
              await invoke(['dump', snapshot.id, `${BUNDLE}/attachments.json`], {
                maxBytes: MAX_METADATA_BYTES,
              })
            ).stdout,
          ),
        );
        let files = 2;
        let bytes = 0;
        const row = metadata.find((entry) => !entry.expired);
        if (row) {
          const path = join(directory, row.id);
          await invoke(['dump', snapshot.id, `${BUNDLE}/attachments/${row.id}`], {
            output: path,
            maxBytes: row.size,
          });
          assert.equal(await hashFile(path), row.sha256, 'OPS_SAMPLE_CHECKSUM_FAILED');
          files += 1;
          bytes = row.size;
        }
        report.sources[id] = {
          ok: true,
          snapshot: snapshot.id,
          cutoff: manifest.cutoff,
          files,
          bytes,
          at: new Date().toISOString(),
        };
      } catch (error) {
        const detail = sampleDetail(error);
        report.sources[id] = {
          ok: false,
          at: new Date().toISOString(),
          reason: sampleReason(error),
          ...(detail ? { detail } : {}),
        };
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return report;
}
