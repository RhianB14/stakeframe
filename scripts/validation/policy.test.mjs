import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateCorpus } from './corpus-core.mjs';
import { buildPolicyEntry, buildGlobalPolicy, syntheticCorpus } from './corpus-fixture.mjs';
import { verifyApprovalPolicy } from './policy.mjs';

const NOW = new Date('2026-09-10T00:00:00.000Z');

function writeEvidenceDirectory(corpus) {
  corpus.bookmakerContext = 'user-informed';
  const directory = mkdtempSync(join(tmpdir(), 'stk-policy-evidence-'));
  const corpusFile = join(directory, 'corpus.json');
  writeFileSync(corpusFile, JSON.stringify(corpus, null, 2) + '\n');
  chmodSync(corpusFile, 0o600);
  const report = evaluateCorpus(corpus);
  const output =
    JSON.stringify({ generatedAt: '2026-09-01T00:00:00.000Z', ...report }, null, 2) + '\n';
  const evaluationFile = join(directory, 'evaluation.json');
  writeFileSync(evaluationFile, output);
  chmodSync(evaluationFile, 0o600);
  return {
    directory,
    corpus,
    report,
    evaluationSha256: createHash('sha256').update(output).digest('hex'),
  };
}

function writePolicy(entries) {
  const directory = mkdtempSync(join(tmpdir(), 'stk-policy-file-'));
  const file = join(directory, 'policies.json');
  if (entries[0]?.schemaVersion === 2) {
    writeFileSync(file, JSON.stringify(entries[0]));
    chmodSync(file, 0o600);
    return file;
  }
  const evidence = entries.map((entry) => ({
    report: entry.__report,
    evaluationSha256: entry.__evaluationSha256,
  }));
  const first = entries[0];
  const overrides = {
    model: first.model,
    placedAtFormats: [...new Set(entries.map((entry) => entry.placedAtFormat))],
    allowFreebet: entries.every((entry) => entry.allowFreebet),
    potentialReturnLabels: [
      ...new Set(entries.flatMap((entry) => entry.potentialReturnLabels ?? ['Retorno Total'])),
    ],
    approvedAt: first.approvedAt,
    expiresAt: first.expiresAt,
  };
  if (first.corpusSha256 !== first.__report.corpusSha256)
    overrides.corpusSha256 = first.corpusSha256;
  if (first.evaluationSha256 !== first.__evaluationSha256)
    overrides.evaluationSha256 = first.evaluationSha256;
  if (JSON.stringify(first.coverage) !== JSON.stringify(first.__report.coverage))
    overrides.coverage = first.coverage;
  if (first.sampleCount !== first.__report.sampleCount) overrides.sampleCount = first.sampleCount;
  if (first.essentialFieldErrors !== first.__report.essentialFieldErrors)
    overrides.essentialFieldErrors = first.essentialFieldErrors;
  const policy = buildGlobalPolicy(evidence, overrides);
  writeFileSync(file, JSON.stringify(policy));
  chmodSync(file, 0o600);
  return file;
}

test('verifies a coherent approval and never prints ticket content', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const policy = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256),
  ]);
  const result = await verifyApprovalPolicy(policy, [evidence.directory], NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0].bookmaker, 'bet365');
  assert.equal(JSON.stringify(result).includes('Fictional A'), false);
});

test('refuses a tampered evaluation file', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const tampered = JSON.parse(
    JSON.stringify({ generatedAt: '2026-09-01T00:00:00.000Z', ...evidence.report }),
  );
  tampered.sampleCount = 25;
  writeFileSync(join(evidence.directory, 'evaluation.json'), JSON.stringify(tampered));
  chmodSync(join(evidence.directory, 'evaluation.json'), 0o600);
  const policy = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256),
  ]);
  const result = await verifyApprovalPolicy(policy, [evidence.directory], NOW);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((code) => code.startsWith('EVALUATION_TAMPERED')));
});

test('refuses hash divergences between policy, evaluation and corpus', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  for (const [field, code] of [
    ['evaluationSha256', 'POLICY_EVALUATION_HASH_MISMATCH'],
    ['corpusSha256', 'POLICY_CORPUS_HASH_MISMATCH'],
  ]) {
    const policy = writePolicy([
      buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
        [field]: 'f'.repeat(64),
      }),
    ]);
    const result = await verifyApprovalPolicy(policy, [evidence.directory], NOW);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((value) => value.startsWith(code)));
  }
});

test('refuses coverage and sample count divergences', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const coverage = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      coverage: { ...evidence.report.coverage, positive: 21 },
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(coverage, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_COVERAGE_MISMATCH'),
    ),
  );
  const sample = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      sampleCount: 25,
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(sample, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_SAMPLE_COUNT_MISMATCH'),
    ),
  );
});

test('refuses an ineligible evaluation declared as approved', async () => {
  const corpus = syntheticCorpus();
  corpus.cases[0].actual.extraction.stake = '99.00';
  const evidence = writeEvidenceDirectory(corpus);
  const policy = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256),
  ]);
  const result = await verifyApprovalPolicy(policy, [evidence.directory], NOW);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((code) => code.startsWith('POLICY_NOT_ELIGIBLE')));
});

test('refuses a global policy that does not match the neutral corpus', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const mismatched = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      model: 'qwen/qwen3-vl-32b-instruct',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(mismatched, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_MODEL_MISMATCH'),
    ),
  );
});

test('refuses a global policy that omits a corpus return label', async () => {
  const corpus = syntheticCorpus({ bookmakerContext: 'user-informed' });
  corpus.layout.potentialReturnLabels = ['Prêmio', 'Ganho Potencial'];
  const evidence = writeEvidenceDirectory(corpus);
  const policy = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      potentialReturnLabels: ['Prêmio'],
    }),
  ]);
  const result = await verifyApprovalPolicy(policy, [evidence.directory], NOW);
  assert.ok(result.failures.includes('POLICY_RETURN_LABELS_MISMATCH'));
});

test('refuses expired, future and inverted validity windows', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const expired = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      approvedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(expired, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_EXPIRED'),
    ),
  );
  const future = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      approvedAt: '2999-01-01T00:00:00.000Z',
      expiresAt: '2999-06-01T00:00:00.000Z',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(future, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_APPROVAL_IN_FUTURE'),
    ),
  );
  const inverted = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      approvedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(inverted, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_VALIDITY_INVALID'),
    ),
  );
});

test('refuses missing or invalid policy files and invalid corpus directories', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const missing = await verifyApprovalPolicy(
    join(evidence.directory, 'missing-policies.json'),
    [evidence.directory],
    NOW,
  );
  assert.deepEqual(missing.failures, ['POLICY_FILE_INVALID']);
  const invalidDirectory = mkdtempSync(join(tmpdir(), 'stk-policy-invalid-'));
  const invalidCorpusFile = join(invalidDirectory, 'corpus.json');
  writeFileSync(invalidCorpusFile, 'private-invalid-content');
  chmodSync(invalidCorpusFile, 0o600);
  const invalidCorpus = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256),
  ]);
  const result = await verifyApprovalPolicy(invalidCorpus, [invalidDirectory], NOW);
  assert.ok(result.failures.some((code) => code.startsWith('CORPUS_INVALID')));
});

test('covers two houses with two corpus directories in one policy file', async () => {
  const first = writeEvidenceDirectory(syntheticCorpus());
  const second = writeEvidenceDirectory(
    syntheticCorpus({ id: 'superbet-fixture', bookmaker: 'superbet' }),
  );
  const policy = writePolicy([
    buildPolicyEntry(first.corpus, first.report, first.evaluationSha256),
    buildPolicyEntry(second.corpus, second.report, second.evaluationSha256),
  ]);
  const result = await verifyApprovalPolicy(policy, [first.directory, second.directory], NOW);
  assert.equal(result.ok, true);
  assert.equal(result.verified.length, 2);
  assert.equal(result.unusedCorpora, 0);
  rmSync(first.directory, { recursive: true, force: true });
  rmSync(second.directory, { recursive: true, force: true });
});
