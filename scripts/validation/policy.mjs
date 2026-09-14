import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateCorpus, KNOWN_BOOKMAKERS } from './corpus-core.mjs';
import { validatedLayoutsSchema } from '../../packages/shared/dist/index.js';

// This checker only reads saved evidence (corpus.json plus evaluation.json) and
// a proposed policy file. It performs no extractions, writes nothing, activates
// nothing, and never prints ticket content or private paths. Approval must stay
// fail-closed: any mismatch between policy, evaluation and corpus is refused.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_POLICY_BYTES = 32768;
const COVERAGE_KEYS = [
  'positive',
  'negative',
  'multiples',
  'missingFields',
  'promotional',
  'uniqueImages',
];
const canonical = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

async function resolveOutsideWorkspace(workspace, path, expectDirectory) {
  if (!isAbsolute(path)) throw new Error('POLICY_PATH_INVALID');
  const resolved = await realpath(path);
  const rel = relative(workspace, resolved);
  if (
    !rel ||
    (!rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
    // Windows exposes short (8.3) temp names whose realpath expands to the long
    // form; POSIX keeps refusing any path with a symlinked component.
    (process.platform !== 'win32' && canonical(resolve(path)) !== canonical(resolved))
  )
    throw new Error('POLICY_PATH_INVALID');
  const info = await lstat(path);
  if (info.isSymbolicLink() || (expectDirectory ? !info.isDirectory() : !info.isFile()))
    throw new Error('POLICY_PATH_INVALID');
  return resolved;
}

async function readPrivateFile(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error('POLICY_PATH_INVALID');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new Error('POLICY_PATH_INVALID');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error('POLICY_PATH_INVALID');
  return bytes;
}

function savedEvaluationMatches(saved, report) {
  if (!saved || typeof saved !== 'object') return false;
  const scalarKeys = [
    'layoutId',
    'bookmaker',
    'model',
    'corpusSha256',
    'layoutSha256',
    'sampleCount',
    'totalCases',
    'correctTickets',
    'essentialFieldErrors',
    'coveragePassed',
    'eligibleForOwnerReview',
  ];
  if (scalarKeys.some((key) => JSON.stringify(saved[key]) !== JSON.stringify(report[key])))
    return false;
  return COVERAGE_KEYS.every((key) => saved.coverage?.[key] === report.coverage[key]);
}

// Verifies a proposed approval policy against saved corpus evidence. Every
// policy entry must be covered by exactly one corpus directory; hashes,
// coverage, counts, eligibility and validity must all correspond.
export async function verifyApprovalPolicy(policyPath, corpusDirs, now = new Date()) {
  const failures = [];
  const verified = [];
  const workspace = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const reports = [];
  for (const dirArg of corpusDirs) {
    try {
      const directory = await resolveOutsideWorkspace(workspace, dirArg, true);
      const corpusBytes = await readPrivateFile(join(directory, 'corpus.json'), MAX_BYTES);
      let report;
      try {
        report = evaluateCorpus(JSON.parse(corpusBytes.toString('utf8')));
      } catch {
        failures.push('CORPUS_INVALID');
        continue;
      }
      const evaluationBytes = await readPrivateFile(join(directory, 'evaluation.json'), MAX_BYTES);
      let saved = null;
      try {
        saved = JSON.parse(evaluationBytes.toString('utf8'));
      } catch {
        saved = null;
      }
      if (!savedEvaluationMatches(saved, report)) {
        failures.push(`EVALUATION_TAMPERED ${report.layoutId}`);
        continue;
      }
      reports.push({ report, evaluationSha256: sha256(evaluationBytes) });
    } catch {
      failures.push('CORPUS_DIRECTORY_INVALID');
    }
  }
  let layouts;
  try {
    const resolved = await resolveOutsideWorkspace(workspace, policyPath, false);
    const bytes = await readPrivateFile(resolved, MAX_POLICY_BYTES);
    layouts = validatedLayoutsSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return { ok: false, failures: [...failures, 'POLICY_FILE_INVALID'], verified: [] };
  }
  for (const layout of layouts) {
    const codes = [];
    if (!KNOWN_BOOKMAKERS.includes(layout.bookmaker)) codes.push('POLICY_BOOKMAKER_UNKNOWN');
    const matches = reports.filter(
      ({ report }) => report.layoutId === layout.id && report.bookmaker === layout.bookmaker,
    );
    if (!matches.length) codes.push('POLICY_HOUSE_NOT_COVERED');
    else if (matches.length > 1) codes.push('POLICY_HOUSE_AMBIGUOUS');
    else {
      const { report, evaluationSha256 } = matches[0];
      if (
        report.layout.bookmakerId !== layout.bookmakerId ||
        report.layout.model !== layout.model ||
        report.layout.description !== layout.description ||
        report.layout.placedAtFormat !== layout.placedAtFormat ||
        report.layout.allowFreebet !== layout.allowFreebet
      )
        codes.push('POLICY_LAYOUT_MISMATCH');
      if (layout.layoutSha256 !== report.layoutSha256) codes.push('POLICY_LAYOUT_HASH_MISMATCH');
      if (layout.corpusSha256 !== report.corpusSha256) codes.push('POLICY_CORPUS_HASH_MISMATCH');
      if (layout.evaluationSha256 !== evaluationSha256)
        codes.push('POLICY_EVALUATION_HASH_MISMATCH');
      if (layout.sampleCount !== report.sampleCount) codes.push('POLICY_SAMPLE_COUNT_MISMATCH');
      if (COVERAGE_KEYS.some((key) => layout.coverage[key] !== report.coverage[key]))
        codes.push('POLICY_COVERAGE_MISMATCH');
      if (
        layout.essentialFieldErrors !== 0 ||
        report.essentialFieldErrors !== 0 ||
        !report.coveragePassed ||
        !report.eligibleForOwnerReview
      )
        codes.push('POLICY_NOT_ELIGIBLE');
      const approvedAt = Date.parse(layout.approvedAt);
      const expiresAt = Date.parse(layout.expiresAt);
      if (approvedAt > now.getTime()) codes.push('POLICY_APPROVAL_IN_FUTURE');
      if (expiresAt <= now.getTime()) codes.push('POLICY_EXPIRED');
      if (expiresAt <= approvedAt) codes.push('POLICY_VALIDITY_INVALID');
      if (!codes.length)
        verified.push({
          id: layout.id,
          bookmaker: layout.bookmaker,
          sampleCount: layout.sampleCount,
          layoutSha256: layout.layoutSha256,
          corpusSha256: layout.corpusSha256,
          evaluationSha256: layout.evaluationSha256,
          expiresAt: layout.expiresAt,
        });
    }
    failures.push(...codes.map((code) => `${code} ${layout.id}`));
  }
  const coveredIds = new Set(layouts.map((layout) => layout.id));
  const unusedCorpora = reports.filter(({ report }) => !coveredIds.has(report.layoutId)).length;
  return { ok: failures.length === 0, failures, verified, unusedCorpora };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [policyArg, ...dirArgs] = process.argv.slice(2);
  if (!policyArg || !dirArgs.length) {
    console.error(
      'POLICY_VERIFICATION_FAILED: use an absolute policy file and at least one absolute private corpus directory',
    );
    process.exitCode = 1;
  } else {
    const result = await verifyApprovalPolicy(policyArg, dirArgs);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
