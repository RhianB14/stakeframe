import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDecision } from './decision-core.mjs';

// Avaliação offline ORIENTADA À DECISÃO: só lê evidência salva (corpus.json e,
// quando existir, evaluation.json para o bloco de qualidade). Nenhuma chamada
// de rede, nenhuma escrita financeira, nenhuma ativação de política.
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
    (process.platform !== 'win32' && canonical(resolve(directoryArg)) !== canonical(directory))
  )
    throw new Error();
  const info = await lstat(directory);
  const argInfo = await lstat(directoryArg);
  const file = join(directory, 'corpus.json');
  const stat = await lstat(file);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    argInfo.isSymbolicLink() ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 20 * 1024 * 1024 ||
    (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0))
  )
    throw new Error();
  const bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error();
  let quality = null;
  const evaluationFile = join(directory, 'evaluation.json');
  if (existsSync(evaluationFile)) {
    const evaluation = JSON.parse(await readFile(evaluationFile, 'utf8'));
    quality = {
      correctTickets: evaluation.correctTickets,
      essentialFieldErrors: evaluation.essentialFieldErrors,
      fieldCounts: evaluation.fieldCounts,
      coveragePassed: evaluation.coveragePassed,
      eligibleForOwnerReview: evaluation.eligibleForOwnerReview,
    };
  }
  const report = evaluateDecision(JSON.parse(bytes.toString('utf8')), { quality });
  const output =
    JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n';
  await writeFile(join(directory, 'decision.json'), output, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      layoutId: report.layoutId,
      bookmaker: report.bookmaker,
      totalCases: report.totalCases,
      autoImportableReal: report.autoImportableReal,
      autoImportableWithCredit: report.autoImportableWithCredit,
      wouldImport: report.actual.wouldImport,
      review: report.actual.review,
      gates: report.gates,
      corpusSha256: createHash('sha256').update(bytes).digest('hex'),
      decisionSha256: createHash('sha256').update(output).digest('hex'),
    }),
  );
  if (
    report.gates.unsafeAutoImport > 0 ||
    report.gates.wrongFinancialValue > 0 ||
    report.gates.conflictAccepted > 0
  )
    process.exitCode = 1;
} catch {
  console.error(
    'DECISION_EVALUATION_FAILED: use a private directory outside the repository with a valid corpus.json and no existing decision.json',
  );
  process.exitCode = 1;
}
