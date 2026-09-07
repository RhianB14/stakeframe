import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequest, models, probe, ProbeError } from './probe.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const [directoryArg, model, ...extra] = process.argv.slice(2);

async function main() {
  if (!isAbsolute(directoryArg ?? '') || !models.includes(model) || extra.length)
    throw new ProbeError('AI_SETUP_USAGE');
  const info = await lstat(directoryArg);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new ProbeError('AI_PRIVATE_DIRECTORY_REQUIRED');
  const directory = await realpath(directoryArg);
  const rel = relative(await realpath(workspace), directory);
  const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
    canonical(resolve(directoryArg)) !== canonical(directory)
  )
    throw new ProbeError('AI_PRIVATE_PATH_REFUSED');
  async function readPrivate(name) {
    const filename = join(directory, name);
    const stat = await lstat(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new ProbeError('AI_PRIVATE_FILE_REFUSED');
    return readFile(filename, 'utf8');
  }
  const metadata = JSON.parse(await readPrivate('metadata.json'));
  const verifiedAt = Date.parse(metadata.billingVerifiedAt);
  if (
    metadata.billingTier !== 'free' ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt > Date.now() ||
    Date.now() - verifiedAt > 86_400_000
  )
    throw new ProbeError('AI_FREE_TIER_RECHECK_REQUIRED');
  const apiKey = (await readPrivate('api_key')).trim();
  if (!/^[A-Za-z0-9_-]{30,128}$/.test(apiKey)) throw new ProbeError('AI_KEY_INVALID');
  const png = await readFile(
    new URL('../../tests/fixtures/ai/synthetic-ticket.png', import.meta.url),
  );
  createRequest(model, png);
  // One deliberate call per model and directory; an ambiguous outcome is never retried automatically.
  try {
    await writeFile(
      join(directory, `${model}.intent.json`),
      JSON.stringify({ startedAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error.code === 'EEXIST') throw new ProbeError('AI_ALREADY_ATTEMPTED');
    throw error;
  }
  const result = { completedAt: null, ...(await probe({ apiKey, model, png })) };
  result.completedAt = new Date().toISOString();
  await writeFile(join(directory, `${model}.result.json`), JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      error instanceof ProbeError
        ? { code: error.message, ...error.details }
        : { code: 'AI_SETUP_FAILED' },
    ),
  );
  process.exitCode = 1;
});
