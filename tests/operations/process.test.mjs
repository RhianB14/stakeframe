import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, sanitizeStderr, STDERR_CAPTURE_BYTES } from '../../apps/ops/src/process.mjs';

// STK-F1-11 BUG 6: lock contention between the daemon cycle and manual reads
// was invisible because stderr was discarded. The run() wrapper now keeps a
// bounded, sanitized excerpt and attaches it to OPS_COMMAND_FAILED.

test('sanitizeStderr() drops sensitive lines and bounds the excerpt', () => {
  const raw = Buffer.from(
    [
      'Fatal: unable to create lock in backend: repository is already locked',
      'password=super-secret-value',
      'Authorization: Bearer abc.def.ghi',
      '',
      '  lock was created at 2026-09-26 12:00  ',
    ].join('\n'),
  );
  const sanitized = sanitizeStderr(raw);
  assert.match(sanitized, /unable to create lock/);
  assert.match(sanitized, /lock was created at 2026-09-26 12:00/);
  assert.doesNotMatch(sanitized, /super-secret-value|Bearer|password/i);
  const bounded = sanitizeStderr(Buffer.alloc(STDERR_CAPTURE_BYTES * 2, 'x'));
  assert.ok(bounded.length <= 4096);
});

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shim' : false };

async function withShim(script, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'stk-process-'));
  try {
    const shim = join(directory, 'restic');
    await writeFile(shim, script);
    await chmod(shim, 0o755);
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('run() attaches the sanitized stderr to OPS_COMMAND_FAILED', posixOnly, async () => {
  await withShim(
    '#!/bin/sh\nprintf "Fatal: unable to create lock in backend: repository is already locked\\npassword=leak-me\\n" >&2\nexit 1\n',
    async (directory) => {
      await assert.rejects(run('restic', ['snapshots'], { env: { PATH: directory } }), (error) => {
        assert.equal(error.message, 'OPS_COMMAND_FAILED');
        assert.match(error.cause?.message ?? '', /unable to create lock/);
        assert.doesNotMatch(error.cause?.message ?? '', /leak-me/);
        return true;
      });
    },
  );
});

test('run() keeps the stdout path and byte limit unchanged', posixOnly, async () => {
  await withShim('#!/bin/sh\nprintf "hello"\nexit 0\n', async (directory) => {
    const result = await run('restic', ['version'], { env: { PATH: directory } });
    assert.equal(result.stdout, 'hello');
    assert.equal(result.bytes, 5);
  });
  await withShim(
    '#!/bin/sh\ni=0\nwhile [ $i -lt 5000 ]; do printf x; i=$((i+1)); done\nexit 0\n',
    async (directory) => {
      await assert.rejects(
        run('restic', ['version'], { env: { PATH: directory }, maxBytes: 4096 }),
        /OPS_COMMAND_FAILED/,
      );
    },
  );
});
