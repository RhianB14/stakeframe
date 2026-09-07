import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCorpus } from './corpus-core.mjs';

// This evaluator only reads saved evidence. It makes no paid requests and never activates a policy.
const [directoryArg, ...extra] = process.argv.slice(2);
try {
  if (!isAbsolute(directoryArg ?? '') || extra.length) throw new Error();
  const directory = await realpath(directoryArg);
  const workspace = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = relative(workspace, directory);
  if (
    !rel ||
    (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
    canonical(resolve(directoryArg)) !== canonical(directory)
  )
    throw new Error();
  const info = await lstat(directory);
  const file = join(directory, 'corpus.json');
  const stat = await lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 20 * 1024 * 1024 ||
    (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0))
  )
    throw new Error();
  const bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error();
  const report = evaluateCorpus(JSON.parse(bytes.toString('utf8')));
  const output =
    JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n';
  await writeFile(join(directory, 'evaluation.json'), output, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      totalCases: report.totalCases,
      correctTickets: report.correctTickets,
      essentialFieldErrors: report.essentialFieldErrors,
      coveragePassed: report.coveragePassed,
      eligibleForOwnerReview: report.eligibleForOwnerReview,
      corpusSha256: report.corpusSha256,
      evaluationSha256: createHash('sha256').update(output).digest('hex'),
    }),
  );
  if (!report.eligibleForOwnerReview) process.exitCode = 1;
} catch {
  console.error(
    'CORPUS_EVALUATION_FAILED: use a private directory outside the repository with a valid corpus.json and no existing evaluation.json',
  );
  process.exitCode = 1;
}
