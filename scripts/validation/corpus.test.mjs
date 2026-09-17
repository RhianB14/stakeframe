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
test('counts an invented sport when the evidence does not show it', () => {
  const value = fixture();
  value.cases[0].expected.selections[0].sport = null;
  value.cases[0].actual.extraction.selections[0].sport = 'Futebol';
  const report = evaluateCorpus(value);
  assert.equal(report.eligibleForOwnerReview, false);
  assert.equal(report.fieldCounts['selections.sport'].invented, 1);
  assert.equal(
    report.cases[0].issues.some(
      (issue) => issue.field === 'selections.sport' && issue.kind === 'invented',
    ),
    true,
  );
  const coherent = fixture();
  coherent.cases[0].expected.selections[0].sport = 'Futebol';
  coherent.cases[0].actual.extraction.selections[0].sport = 'Futebol';
  assert.equal(evaluateCorpus(coherent).fieldCounts['selections.sport'], undefined);
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

test('keeps the event date out of the essential comparison (R3)', () => {
  const value = fixture();
  value.cases[0].actual.extraction.selections[0].eventDateText = '31/12/2030';
  value.cases[0].expected.selections[0].eventDateText = '07/09/2026';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 0);
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

test('treats isolated confrontation separators as equivalent without touching real hyphens', () => {
  for (const actual of [
    'Fictional A — B',
    'Fictional A – B',
    'Fictional A - B',
    'Fictional A vs B',
    'Fictional A v B',
    'Fictional A x B',
  ]) {
    const value = fixture();
    value.cases[0].expected.selections[0].event = 'Fictional A x B';
    value.cases[0].actual.extraction.selections[0].event = actual;
    assert.equal(evaluateCorpus(value).essentialFieldErrors, 0, actual);
  }
  const hyphen = fixture();
  hyphen.cases[0].expected.selections[0].event = 'Jean-Luc Picard x Outro';
  hyphen.cases[0].actual.extraction.selections[0].event = 'Jean Luc Picard x Outro';
  assert.equal(evaluateCorpus(hyphen).essentialFieldErrors, 1);
  const substantive = fixture();
  substantive.cases[0].actual.extraction.selections[0].event = 'Fictional C x B';
  assert.equal(evaluateCorpus(substantive).essentialFieldErrors, 1);
});

test('treats ordinal glyphs as equivalent in markets only', () => {
  const value = fixture();
  value.cases[0].expected.selections[0].market = '2º Set - Total de Games';
  value.cases[0].actual.extraction.selections[0].market = '2° Set - Total de Games';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 0);
  const different = fixture();
  different.cases[0].expected.selections[0].market = '3º Set - Total de Games';
  different.cases[0].actual.extraction.selections[0].market = '2° Set - Total de Games';
  assert.equal(evaluateCorpus(different).essentialFieldErrors, 1);
  const selection = fixture();
  selection.cases[0].expected.selections[0].selection = 'A 2º game';
  selection.cases[0].actual.extraction.selections[0].selection = 'A 2° game';
  assert.equal(evaluateCorpus(selection).essentialFieldErrors, 1);
});

test('accepts a null or matching visual bookmaker with a user-informed house and flags real conflicts', () => {
  const value = fixture();
  value.bookmakerContext = 'user-informed';
  value.cases[0].expected.bookmaker = 'bet365';
  value.cases[0].actual.extraction.bookmaker = null;
  const report = evaluateCorpus(value);
  assert.equal(report.essentialFieldErrors, 0);
  assert.equal(report.contextDiagnostics.bookmakerAbsent, 1);
  assert.equal(report.cases[0].correct, true);
  const confirmed = fixture();
  confirmed.bookmakerContext = 'user-informed';
  confirmed.cases[0].expected.bookmaker = 'bet365';
  confirmed.cases[0].actual.extraction.bookmaker = 'Bet365';
  const confirmedReport = evaluateCorpus(confirmed);
  assert.equal(confirmedReport.essentialFieldErrors, 0);
  assert.equal(confirmedReport.contextDiagnostics.bookmakerConfirmed, 20);
  const conflict = fixture();
  conflict.bookmakerContext = 'user-informed';
  conflict.cases[0].expected.bookmaker = 'bet365';
  conflict.cases[0].actual.extraction.bookmaker = 'superbet';
  const conflictReport = evaluateCorpus(conflict);
  assert.equal(conflictReport.essentialFieldErrors, 1);
  assert.equal(conflictReport.fieldCounts.bookmaker.mismatches, 1);
  assert.equal(conflictReport.contextDiagnostics.bookmakerConflicts, 1);
  assert.equal(conflictReport.eligibleForOwnerReview, false);
});

test('separates visual layout diagnostics from the main user-informed path', () => {
  const value = fixture();
  value.bookmakerContext = 'user-informed';
  for (const item of value.cases.filter((entry) => entry.expectedLayoutId !== null))
    item.actual.layoutId = null;
  const report = evaluateCorpus(value);
  assert.equal(report.essentialFieldErrors, 0);
  assert.equal(report.eligibleForOwnerReview, true);
  assert.equal(report.visualDiagnostics.positiveUnrecognized, 20);
  assert.equal(report.visualDiagnostics.crossHouseRejected, 5);
  const falsePositive = fixture();
  falsePositive.bookmakerContext = 'user-informed';
  falsePositive.cases[24].actual.layoutId = 'bet365-fixture';
  const falsePositiveReport = evaluateCorpus(falsePositive);
  assert.equal(falsePositiveReport.eligibleForOwnerReview, false);
  assert.equal(falsePositiveReport.essentialFieldErrors, 1);
  assert.equal(falsePositiveReport.visualDiagnostics.crossHouseRecognized, 1);
  assert.equal(falsePositiveReport.fieldCounts.layout.mismatches, 1);
});

test('keeps the legacy visual-only contract closed when no context is declared', () => {
  const value = fixture();
  for (const item of value.cases.filter((entry) => entry.expectedLayoutId !== null))
    item.actual.layoutId = null;
  const report = evaluateCorpus(value);
  assert.equal(report.bookmakerContext, 'visual-only');
  assert.equal(report.essentialFieldErrors, 20);
  assert.equal(report.eligibleForOwnerReview, false);
});

test('treats stacked sides separated by a line break as a confrontation separator only when strict', () => {
  const stacked = fixture();
  stacked.cases[0].expected.selections[0].event = 'Fictional A x B';
  stacked.cases[0].actual.extraction.selections[0].event = 'Fictional A\nB';
  assert.equal(evaluateCorpus(stacked).essentialFieldErrors, 0);
  const uncertain = fixture();
  uncertain.cases[0].expected.selections[0].event = 'Fictional A x B';
  uncertain.cases[0].actual.extraction.selections[0].event = 'Fictional A B';
  assert.equal(evaluateCorpus(uncertain).essentialFieldErrors, 1);
  const multi = fixture();
  multi.cases[0].expected.selections[0].event = 'Real Madrid x Bayern de Munique';
  multi.cases[0].actual.extraction.selections[0].event = 'Real Madrid — Bayern de Munique';
  assert.equal(evaluateCorpus(multi).essentialFieldErrors, 0);
  const broken = fixture();
  broken.cases[0].expected.selections[0].event = 'Guilherme Clezar x Outro';
  broken.cases[0].actual.extraction.selections[0].event = 'Guilherme\nClezar x Outro';
  assert.equal(evaluateCorpus(broken).essentialFieldErrors, 1);
});

test('keeps potential return, prize and stake as distinct exact values', () => {
  const value = fixture();
  value.cases[0].expected.potentialReturn = '0.53';
  value.cases[0].actual.extraction.potentialReturn = '0.53';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 0);
  const swapped = fixture();
  swapped.cases[0].expected.potentialReturn = '0.53';
  swapped.cases[0].actual.extraction.potentialReturn = '1.02';
  assert.equal(evaluateCorpus(swapped).essentialFieldErrors, 1);
  const asStake = fixture();
  asStake.cases[0].expected.potentialReturn = null;
  asStake.cases[0].actual.extraction.potentialReturn = '50.00';
  assert.equal(evaluateCorpus(asStake).essentialFieldErrors, 1);
});

test('preserves visible zero returns, exact odds and absence of value', () => {
  const value = fixture();
  value.cases[0].expected.potentialReturn = '0.00';
  value.cases[0].actual.extraction.potentialReturn = '0.00';
  assert.equal(evaluateCorpus(value).essentialFieldErrors, 0);
  const omitted = fixture();
  omitted.cases[0].expected.potentialReturn = '0.00';
  omitted.cases[0].actual.extraction.potentialReturn = null;
  assert.equal(evaluateCorpus(omitted).essentialFieldErrors, 1);
  const invented = fixture();
  invented.cases[0].actual.extraction.potentialReturn = '0.00';
  assert.equal(evaluateCorpus(invented).essentialFieldErrors, 1);
  const odds = fixture();
  odds.cases[0].expected.selections[0].odds = '1.57';
  odds.cases[0].actual.extraction.selections[0].odds = '1.58';
  assert.equal(evaluateCorpus(odds).essentialFieldErrors, 1);
});

test('accepts sanitized OCR evidence on the actual result without leaking it to the report', () => {
  const value = fixture();
  value.cases[0].actual = {
    ...value.cases[0].actual,
    ocr: { provider: 'azure', fallbackUsed: false, latencyMs: 42 },
    ocrConsistent: true,
  };
  const report = evaluateCorpus(value);
  assert.equal(report.eligibleForOwnerReview, true);
  assert.equal(JSON.stringify(report).includes('azure'), false);
});

test('rejects OCR evidence outside the sanitized contract', () => {
  const extra = fixture();
  extra.cases[0].actual = {
    ...extra.cases[0].actual,
    ocr: { provider: 'azure', fallbackUsed: false, latencyMs: 42, text: 'vazamento' },
  };
  assert.throws(() => evaluateCorpus(extra), /Unrecognized key/);
  const unknownProvider = fixture();
  unknownProvider.cases[0].actual = {
    ...unknownProvider.cases[0].actual,
    ocr: { provider: 'documentai', fallbackUsed: false, latencyMs: 42 },
  };
  assert.throws(() => evaluateCorpus(unknownProvider), /Invalid option|Invalid enum value/);
});

// Negativos corretamente rejeitados (expectedLayoutId=null e layoutId=null) são
// casos de rejeição cross-house: o conteúdo pertence ao corpus da outra casa e
// não pode gerar erro essencial. Schema, vínculo de imagem/modelo e a própria
// rejeição de layout continuam sendo validados; um falso positivo de layout
// continua bloqueando a elegibilidade.
const foreignExtraction = () => ({
  bookmaker: 'outra-casa-visivel',
  reference: 'FOREIGN-REF-99',
  placedAtText: '01/01/2030 23:59',
  currency: 'BRL',
  stake: '999.99',
  odds: '99.99',
  potentialReturn: '123.45',
  freebet: false,
  selections: [
    {
      event: 'Estranho A x Estranho B',
      sport: 'Futebol',
      market: 'Mercado Estranho',
      selection: 'Selecao Estranha',
      odds: '9.99',
      eventDateText: '31/12/2030',
    },
  ],
  warnings: ['duvida estranha'],
});
const mutateNegatives = (value, mutate) => {
  for (const item of value.cases.filter((entry) => entry.expectedLayoutId === null)) mutate(item);
  return value;
};
test('does not compare content of a correctly rejected negative with foreign data', () => {
  const value = mutateNegatives(fixture(), (item) => {
    item.actual.layoutId = null;
    item.actual.extraction = foreignExtraction();
  });
  const report = evaluateCorpus(value);
  assert.equal(report.essentialFieldErrors, 0);
  assert.equal(report.eligibleForOwnerReview, true);
  assert.equal(report.correctTickets, 25);
  for (const item of report.cases.filter((entry) => entry.index >= 21)) {
    assert.deepEqual(item.issues, []);
    assert.equal(item.correct, true);
  }
});
test('keeps false positive cross-house blocking and counts only the layout error', () => {
  const value = mutateNegatives(fixture(), (item) => {
    item.actual.layoutId = 'bet365-fixture';
    item.actual.extraction = foreignExtraction();
  });
  const report = evaluateCorpus(value);
  assert.equal(report.visualDiagnostics.crossHouseRecognized, 5);
  assert.equal(report.fieldCounts.layout.mismatches, 5);
  assert.equal(report.essentialFieldErrors, 5);
  assert.equal(report.eligibleForOwnerReview, false);
});
test('keeps schema, image and model bindings blocking on rejected negatives', () => {
  const invalidSchema = mutateNegatives(fixture(), (item) => {
    item.actual.extraction.stake = 10;
  });
  assert.equal(evaluateCorpus(invalidSchema).fieldCounts.schema.mismatches, 5);
  assert.equal(evaluateCorpus(invalidSchema).eligibleForOwnerReview, false);
  const invalidImage = mutateNegatives(fixture(), (item) => {
    item.actual.imageSha256 = 'a'.repeat(64);
    item.actual.extraction = foreignExtraction();
  });
  assert.equal(evaluateCorpus(invalidImage).fieldCounts.image.mismatches, 5);
  assert.equal(evaluateCorpus(invalidImage).eligibleForOwnerReview, false);
  const invalidModel = mutateNegatives(fixture(), (item) => {
    item.actual.model = 'outro-modelo';
    item.actual.extraction = foreignExtraction();
  });
  assert.equal(evaluateCorpus(invalidModel).fieldCounts.model.mismatches, 5);
  assert.equal(evaluateCorpus(invalidModel).eligibleForOwnerReview, false);
});
test('keeps negative coverage and cross-house diagnostics counted after the content skip', () => {
  const value = mutateNegatives(fixture(), (item) => {
    item.actual.layoutId = null;
    item.actual.extraction = foreignExtraction();
  });
  const report = evaluateCorpus(value);
  assert.equal(report.coverage.negative, 5);
  assert.equal(report.coverage.positive, 20);
  assert.equal(report.visualDiagnostics.crossHouseRejected, 5);
  assert.equal(report.coveragePassed, true);
  assert.equal(report.correctTickets, 25);
});
