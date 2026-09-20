import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateCorpus, KNOWN_BOOKMAKERS } from './corpus-core.mjs';
import { automaticPolicyV3Schema } from '../../packages/shared/dist/index.js';

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

// Verifies one explicit v3 approval policy against the saved corpus evidence
// of its approved houses. Bookmaker identity is deliberately absent from the
// extractor contract: it is supplied by the user and resolved against the
// active tenant catalog at runtime. The policy names the houses that carry
// homologated evidence (approved) and the ones explicitly held back (pending);
// a pending house contributes no evidence and stays fail-closed in review.
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
  let policy;
  try {
    const resolved = await resolveOutsideWorkspace(workspace, policyPath, false);
    const bytes = await readPrivateFile(resolved, MAX_POLICY_BYTES);
    policy = automaticPolicyV3Schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return {
      ok: false,
      failures: [...failures, 'POLICY_FILE_INVALID'],
      verified: [],
      pending: [],
    };
  }
  const codes = [];
  if (!reports.length) codes.push('POLICY_NO_CORPUS');
  const approvedBookmakers = policy.bookmakers.approved;
  const undeclared = [
    ...new Set(
      reports
        .map(({ report }) => report.bookmaker)
        .filter((bookmaker) => !approvedBookmakers.includes(bookmaker)),
    ),
  ].sort();
  if (undeclared.length) codes.push(`POLICY_BOOKMAKER_UNDECLARED ${undeclared.join(',')}`);
  const missingEvidence = approvedBookmakers
    .filter((bookmaker) => !reports.some(({ report }) => report.bookmaker === bookmaker))
    .sort();
  if (missingEvidence.length)
    codes.push(`POLICY_APPROVED_EVIDENCE_MISSING ${missingEvidence.join(',')}`);
  const models = new Set(reports.map(({ report }) => report.model));
  if (models.size !== 1 || !models.has(policy.model)) codes.push('POLICY_MODEL_MISMATCH');
  if (
    reports.some(
      ({ report }) =>
        !KNOWN_BOOKMAKERS.includes(report.bookmaker) ||
        report.bookmakerContext !== 'user-informed' ||
        !policy.placedAtFormats.includes(report.layout.placedAtFormat),
    )
  )
    codes.push('POLICY_CORPUS_CONTEXT_OR_FORMAT_INVALID');
  const expectedReturnLabels = new Set(
    reports.flatMap(({ report }) => report.layout.potentialReturnLabels ?? []),
  );
  if ([...expectedReturnLabels].some((label) => !policy.potentialReturnLabels.includes(label)))
    codes.push('POLICY_RETURN_LABELS_MISMATCH');
  const aggregateCoverage = Object.fromEntries(
    COVERAGE_KEYS.map((key) => [
      key,
      reports.reduce((total, { report }) => total + report.coverage[key], 0),
    ]),
  );
  if (JSON.stringify(policy.coverage) !== JSON.stringify(aggregateCoverage))
    codes.push('POLICY_COVERAGE_MISMATCH');
  const sampleCount = reports.reduce((total, { report }) => total + report.sampleCount, 0);
  if (policy.sampleCount !== sampleCount) codes.push('POLICY_SAMPLE_COUNT_MISMATCH');
  if (
    reports.some(
      ({ report }) =>
        report.essentialFieldErrors !== 0 ||
        !report.coveragePassed ||
        !report.eligibleForOwnerReview,
    ) ||
    policy.essentialFieldErrors !== 0
  )
    codes.push('POLICY_NOT_ELIGIBLE');
  const expectedCorpusHash = sha256(
    JSON.stringify(reports.map(({ report }) => report.corpusSha256).sort()),
  );
  const expectedEvaluationHash = sha256(
    JSON.stringify(reports.map(({ evaluationSha256 }) => evaluationSha256).sort()),
  );
  if (policy.corpusSha256 !== expectedCorpusHash) codes.push('POLICY_CORPUS_HASH_MISMATCH');
  if (policy.evaluationSha256 !== expectedEvaluationHash)
    codes.push('POLICY_EVALUATION_HASH_MISMATCH');
  const approvedAt = Date.parse(policy.approvedAt);
  const expiresAt = Date.parse(policy.expiresAt);
  if (approvedAt > now.getTime()) codes.push('POLICY_APPROVAL_IN_FUTURE');
  if (expiresAt <= now.getTime()) codes.push('POLICY_EXPIRED');
  if (expiresAt <= approvedAt) codes.push('POLICY_VALIDITY_INVALID');
  if (!codes.length) {
    for (const { report } of reports) {
      verified.push({
        bookmaker: report.bookmaker,
        sampleCount: report.sampleCount,
        corpusSha256: report.corpusSha256,
      });
    }
  }
  failures.push(...codes);
  return {
    ok: failures.length === 0,
    failures,
    verified,
    pending: policy.bookmakers.pending.map((entry) => entry.bookmaker),
    unusedCorpora: 0,
  };
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
