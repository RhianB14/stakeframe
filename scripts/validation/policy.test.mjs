import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateCorpus } from './corpus-core.mjs';
import { buildPolicyEntry, syntheticCorpus } from './corpus-fixture.mjs';
import { verifyApprovalPolicy } from './policy.mjs';

const NOW = new Date('2026-09-10T00:00:00.000Z');

function writeEvidenceDirectory(corpus) {
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
  writeFileSync(file, JSON.stringify(entries));
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
  assert.equal(result.verified[0].id, 'bet365-fixture');
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
    ['layoutSha256', 'POLICY_LAYOUT_HASH_MISMATCH'],
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

test('refuses houses and layouts without approved corpus evidence', async () => {
  const evidence = writeEvidenceDirectory(syntheticCorpus());
  const uncovered = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      id: 'superbet-fixture',
      bookmaker: 'superbet',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(uncovered, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_HOUSE_NOT_COVERED'),
    ),
  );
  const unknown = writePolicy([
    buildPolicyEntry(evidence.corpus, evidence.report, evidence.evaluationSha256, {
      id: 'kalshi-fixture',
      bookmaker: 'kalshi',
    }),
  ]);
  assert.ok(
    (await verifyApprovalPolicy(unknown, [evidence.directory], NOW)).failures.some((code) =>
      code.startsWith('POLICY_BOOKMAKER_UNKNOWN'),
    ),
  );
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
