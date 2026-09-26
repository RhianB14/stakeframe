import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Commands are argument arrays, with an explicit environment and no shell. Raw
// diagnostics can contain SQL, credentials or object names and never reach
// logs: stderr is consumed, bounded and stripped of sensitive lines before a
// sanitized excerpt is attached to the thrown error for operators.
export const STDERR_CAPTURE_BYTES = 8 * 1024;

// Sanitized operator-facing excerpt: bounded, whitespace-collapsed and without
// lines that could carry credentials. Raw output is never attached verbatim.
export function sanitizeStderr(buffer) {
  return buffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => !/(password|secret|token|credential|authorization)/i.test(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ')
    .slice(0, 4096);
}

export async function run(
  binary,
  args,
  { env, cwd, signal, output, maxBytes = 4 * 1024 * 1024 } = {},
) {
  if (!['pg_dump', 'pg_restore', 'restic'].includes(binary)) throw new Error('OPS_COMMAND_REFUSED');
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  combined.throwIfAborted();
  const child = spawn(binary, args, {
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: combined,
    windowsHide: true,
  });
  let killTimer;
  const kill = () => {
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  };
  combined.addEventListener('abort', kill, { once: true });
  const exit = new Promise((resolve) => {
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(killTimer);
      combined.removeEventListener('abort', kill);
      resolve(code);
    });
  });
  // Consume stderr without buffering more than the capture bound; the stream
  // must keep flowing or the child would stall on a full pipe.
  const stderrChunks = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    if (stderrBytes >= STDERR_CAPTURE_BYTES) return;
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
  });
  let size = 0;
  const chunks = [];
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) callback(new Error('OPS_OUTPUT_LIMIT'));
      else callback(null, chunk);
    },
  });
  let failed = false;
  try {
    if (output)
      await pipeline(
        child.stdout,
        bounded,
        createWriteStream(output, { flags: 'wx', mode: 0o600 }),
        { signal: combined },
      );
    else {
      const stream = child.stdout.pipe(bounded);
      for await (const chunk of stream) chunks.push(chunk);
    }
  } catch {
    failed = true;
    local.abort();
  }
  const code = await exit;
  if (failed || combined.aborted || code !== 0) {
    const detail = sanitizeStderr(Buffer.concat(stderrChunks).subarray(0, STDERR_CAPTURE_BYTES));
    throw new Error('OPS_COMMAND_FAILED', detail ? { cause: new Error(detail) } : undefined);
  }
  return { stdout: Buffer.concat(chunks).toString('utf8'), bytes: size };
}
