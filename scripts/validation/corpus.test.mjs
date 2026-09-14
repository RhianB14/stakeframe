import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCorpus } from './corpus-core.mjs';
import { syntheticCorpus } from './corpus-fixture.mjs';

const fixture = syntheticCorpus;
test('evaluates distinct positive/negative cases, multiple bets and missing fields without treating missing cost as zero', () => {
  const report = evaluateCorpus(fixture());
  assert.equal(report.eligibleForOwnerReview, true);
  assert.equal(report.bookmaker, 'bet365');
  assert.equal(report.correctTickets, 25);
  assert.equal(report.sampleCount, 20);
  assert.equal(report.requestCount, 25);
  assert.equal(report.costUsd, null);
  assert.equal(report.latency.p95Ms, 123);
  assert.equal(JSON.stringify(report).includes('Fictional A'), false);
  assert.equal('approvedBy' in report, false);
});
test('rejects a corpus from an unknown house before any other evaluation', () => {
  const unknown = fixture();
  unknown.layout.bookmaker = 'kalshi';
  assert.throws(() => evaluateCorpus(unknown), /CORPUS_BOOKMAKER_UNKNOWN/);
});
test('reports invented values, omissions, selection count and wrong layouts as essential errors', () => {
  const value = fixture();
  value.cases[0].actual.extraction.potentialReturn = '20.00';
  value.cases[1].actual.extraction.reference = null;
  value.cases[2].actual.extraction.selections.pop();
  value.cases[24].actual.layoutId = 'bet365-fixture';
  const report = evaluateCorpus(value);
  assert.equal(report.eligibleForOwnerReview, false);
  assert.equal(report.essentialFieldErrors, 4);
  assert.equal(report.fieldCounts.potentialReturn.invented, 1);
  assert.equal(report.fieldCounts.reference.omitted, 1);
  assert.equal(report.fieldCounts['selections.length'].mismatches, 1);
  assert.equal(report.fieldCounts.layout.mismatches, 1);
});
test('binds each result to its image and model, rejects invalid schemas and missed warnings', () => {
  const value = fixture();
  value.cases[0].actual.imageSha256 = 'a'.repeat(64);
  value.cases[1].actual.model = 'different-model';
  value.cases[2].actual.extraction.stake = 10;
  value.cases[3].expected.warnings = ['Fictional uncertainty'];
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 4);
});
test('requires representative coverage and distinct images and does not infer promotional validation', () => {
  const short = fixture();
  short.cases.pop();
  assert.equal(evaluateCorpus(short).coveragePassed, false);
  assert.equal(evaluateCorpus(short).latency.medianMs, 111.5);
  const repeated = fixture();
  repeated.cases[1].imageSha256 = repeated.cases[0].imageSha256;
  assert.equal(evaluateCorpus(repeated).coveragePassed, false);
  const promo = fixture();
  promo.layout.allowFreebet = true;
  assert.equal(evaluateCorpus(promo).coveragePassed, false);
});
test('compares decimal spelling exactly by value while preserving text and event distinctions', () => {
  const value = fixture();
  value.cases[0].actual.extraction.stake = '10';
  value.cases[0].actual.extraction.odds = '2.0000';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 0);
  value.cases[0].actual.extraction.stake = '10.01';
  value.cases[0].actual.extraction.selections[0].event = 'Different event';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 2);
});

test('does not use missing fields from negative images to qualify the approved layout', () => {
  const value = fixture();
  for (const item of value.cases.filter((item) => item.expectedLayoutId !== null)) {
    item.expected.placedAtText = '2026-09-07T10:00:00-03:00';
    item.expected.potentialReturn = '20.00';
    for (const selection of item.expected.selections) selection.eventDateText = '07/09/2026';
    item.actual.extraction = structuredClone(item.expected);
  }
  const report = evaluateCorpus(value);
  assert.equal(report.essentialFieldErrors, 0);
  assert.equal(report.coverage.negative, 5);
  assert.equal(report.coverage.missingFields, 0);
  assert.equal(report.coveragePassed, false);
  assert.equal(report.eligibleForOwnerReview, false);
});
