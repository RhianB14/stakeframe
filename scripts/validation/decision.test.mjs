import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDecision } from './decision-core.mjs';
import { syntheticCorpus } from './corpus-fixture.mjs';

const ISO = '2026-09-07T10:00:00-03:00';
const completePositives = (value) => {
  for (const item of value.cases.filter((entry) => entry.expectedLayoutId !== null)) {
    item.expected.placedAtText = ISO;
    item.expected.bookmaker = null;
    item.actual.extraction.placedAtText = ISO;
    item.actual.extraction.bookmaker = null;
  }
  return value;
};

test('keeps the fixture baseline conservatively in review without any gate violation', () => {
  const report = evaluateDecision(syntheticCorpus());
  assert.equal(report.autoImportableReal, 0);
  assert.equal(report.actual.wouldImport, 0);
  assert.equal(report.gates.unsafeAutoImport, 0);
  assert.equal(report.gates.wrongFinancialValue, 0);
  assert.equal(report.gates.conflictAccepted, 0);
  assert.equal(report.expected.manualReviewExpected, 25);
});

test('counts truly auto-importable positives and keeps every gate at zero', () => {
  const report = evaluateDecision(completePositives(syntheticCorpus()));
  assert.equal(report.autoImportableReal, 20);
  assert.equal(report.actual.wouldImport, 20);
  assert.equal(report.actual.review, 5);
  assert.equal(report.expected.autoImportExpected, 20);
  assert.equal(report.gates.unsafeAutoImport, 0);
  assert.equal(report.gates.wrongFinancialValue, 0);
  assert.equal(report.gates.conflictAccepted, 0);
});

test('flags an unsafe automatic import when the ground truth demands review', () => {
  const value = completePositives(syntheticCorpus());
  value.cases[0].expected.warnings = ['duvida no ground truth'];
  const report = evaluateDecision(value);
  assert.equal(report.gates.unsafeAutoImport, 1);
  assert.equal(report.cases[0].expectedClass, 'MANUAL_REVIEW_EXPECTED');
  assert.equal(report.cases[0].actualClass, 'WOULD_IMPORT');
  assert.equal(report.cases[0].expectedIssues.includes('warnings'), true);
});

test('flags a wrong financial value on an auto-approved case', () => {
  const value = completePositives(syntheticCorpus());
  value.cases[1].actual.extraction.stake = '99.99';
  const report = evaluateDecision(value);
  assert.equal(report.gates.wrongFinancialValue, 1);
  assert.equal(report.cases[1].actualClass, 'WOULD_IMPORT');
  assert.equal(report.cases[1].valueMatchesExpected, false);
});

test('blocks house/freebet conflicts and keeps unresolved credits offline', () => {
  const value = completePositives(syntheticCorpus());
  value.cases[2].actual.extraction.bookmaker = 'Superbet';
  value.cases[3].expected.freebet = true;
  value.cases[3].actual.extraction.freebet = true;
  const report = evaluateDecision(value);
  assert.equal(report.cases[2].actualClass, 'MANUAL_REVIEW');
  assert.deepEqual(report.cases[2].actualIssues, ['BOOKMAKER_CONFLICT']);
  assert.equal(report.cases[3].expectedClass, 'AUTO_IMPORT_EXPECTED_WITH_CREDIT');
  assert.deepEqual(report.cases[3].actualIssues, ['REVIEW_CREDIT_OFFLINE']);
  assert.equal(report.actual.wouldImport, 18);
  assert.equal(report.gates.conflictAccepted, 0);
});

test('never counts a cross-house negative as auto-importable', () => {
  const value = completePositives(syntheticCorpus());
  const negative = value.cases.find((entry) => entry.expectedLayoutId === null);
  negative.actual.extraction.placedAtText = ISO;
  negative.actual.extraction.bookmaker = null;
  const report = evaluateDecision(value);
  assert.equal(report.cases[20].actualClass, 'WOULD_IMPORT');
  assert.equal(report.cases[20].expectedClass, 'MANUAL_REVIEW_EXPECTED');
  assert.equal(report.gates.unsafeAutoImport, 1);
});

test('keeps OCR-inconsistent evidence in review like the real flow', () => {
  const value = completePositives(syntheticCorpus());
  value.cases[0].actual.ocrConsistent = false;
  const report = evaluateDecision(value);
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('EXTRACTION_UNCERTAIN'), true);
  assert.equal(report.actual.wouldImport, 19);
});

test('reports potential-return fidelity separately from wrong financial values', () => {
  const value = completePositives(syntheticCorpus());
  value.cases[4].expected.potentialReturn = '20.00';
  value.cases[4].actual.extraction.potentialReturn = null;
  const report = evaluateDecision(value);
  assert.equal(report.cases[4].actualClass, 'WOULD_IMPORT');
  assert.equal(report.gates.wrongFinancialValue, 0);
  assert.equal(report.returnFidelityMismatch, 1);
});

test('preserves the transcription quality block when provided', () => {
  const report = evaluateDecision(syntheticCorpus(), {
    quality: {
      correctTickets: 25,
      essentialFieldErrors: 0,
      fieldCounts: {},
      coveragePassed: true,
      eligibleForOwnerReview: true,
    },
  });
  assert.equal(report.quality.correctTickets, 25);
});

test('rejects a house outside the allowlist before any evaluation', () => {
  const value = syntheticCorpus();
  value.layout.bookmaker = 'kalshi';
  assert.throws(() => evaluateDecision(value), /DECISION_BOOKMAKER_UNKNOWN/);
});
