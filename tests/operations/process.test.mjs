import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// STK-F1-11 sample-B2: o dump do attachment passa pelo pipeline de output e o
// child pode falhar DEPOIS de escrever os bytes (o restic morre no cleanup e
// ainda deixa stderr) — o erro precisa preservar o stderr sanitizado.
test('run() captures an exit-error after the output pipeline completes', posixOnly, async () => {
  await withShim(
    '#!/bin/sh\nprintf abcdef\nprintf "Fatal: unable to open repository at b2\\n" >&2\nexit 1\n',
    async (directory) => {
      const output = join(directory, 'dump.bin');
      await assert.rejects(
        run('restic', ['dump', 'snap', '/bundle/attachments/x'], {
          env: { PATH: directory },
          output,
        }),
        (error) => {
          assert.equal(error.message, 'OPS_COMMAND_FAILED');
          assert.match(error.cause?.message ?? '', /unable to open repository at b2/);
          return true;
        },
      );
      assert.equal(await readFile(output, 'utf8'), 'abcdef');
    },
  );
});

// Quando o PRÓPRIO pipeline falha (ex.: O_EXCL num output repetido) o child é
// morto antes de escrever stderr: o cause expõe o código estável do erro para o
// operador distinguir de uma falha real do provedor (o "signal terminated" do
// sample-B2 vinha exatamente desse caminho).
test(
  'run() identifies a failed output pipeline when the child wrote no stderr',
  posixOnly,
  async () => {
    await withShim('#!/bin/sh\nprintf x\nexit 0\n', async (directory) => {
      const output = join(directory, 'occupied.bin');
      await writeFile(output, 'occupied');
      await assert.rejects(
        run('restic', ['dump', 'snap', '/bundle/attachments/x'], {
          env: { PATH: directory },
          output,
        }),
        (error) => {
          assert.equal(error.message, 'OPS_COMMAND_FAILED');
          assert.equal(error.cause?.message, 'OPS_PIPELINE_EEXIST');
          return true;
        },
      );
      assert.equal(await readFile(output, 'utf8'), 'occupied');
    });
  },
);
