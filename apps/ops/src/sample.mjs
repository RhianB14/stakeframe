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
  const directory = join('/work', `sample-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { version: 1, at: new Date().toISOString(), sources: {} };
  try {
    for (const [id, env] of sources) {
      try {
        const invoke = resticAt(env, signal, { execute });
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
      } catch {
        report.sources[id] = { ok: false, at: new Date().toISOString() };
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return report;
}
