import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDecision } from './decision-core.mjs';
import { syntheticCorpus } from './corpus-fixture.mjs';

// R3 — a decisão reproduz a ordem real do fluxo e a data do evento nunca
// participa. Fixtures sintéticas; nenhum dado privado.

const day = (index) => String((index % 27) + 1).padStart(2, '0');
const ctxPlacedAt = (index) => `2026-09-${day(index)}T10:30:00-03:00`;

const withContext = (value, overrides = () => ({})) => ({
  schemaVersion: 1,
  cases: value.cases.map((item, index) => ({
    imageSha256: item.imageSha256,
    bookmaker: value.layout.bookmaker,
    kind: 'real',
    placedAt: ctxPlacedAt(index),
    freebetCredit: 'none',
    expectedDecision: 'AUTO_IMPORT_EXPECTED',
    ...overrides(index),
  })),
});

// A extração sintética usa a casa 'Fictional'; o contexto informa 'bet365'.
// Marca visual nula é aceitável — copiar contexto para a extração nunca é.
const detachBookmaker = (value) => {
  for (const item of value.cases) {
    item.expected.bookmaker = null;
    item.actual.extraction.bookmaker = null;
  }
  return value;
};

const base = () => detachBookmaker(syntheticCorpus());

test('sem contexto nenhum caso é importável e todos os gates ficam zerados', () => {
  const report = evaluateDecision(base());
  assert.equal(report.context.provided, false);
  assert.equal(report.actual.wouldImport, 0);
  assert.equal(report.actual.review, 25);
  assert.equal(report.gates.unsafeAutoImport, 0);
  assert.equal(report.gates.wrongPersistedData, 0);
  assert.equal(report.cases[0].actualIssues.includes('CONTEXT_MISSING'), true);
});

test('com contexto completo os 20 positivos importam e as 5 negativas ficam em revisão', () => {
  const value = base();
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.context.provided, true);
  assert.equal(report.positives, 20);
  assert.equal(report.negatives, 5);
  assert.equal(report.actual.wouldImport, 20);
  assert.equal(report.actual.review, 5);
  assert.equal(report.expected.autoImportExpected, 20);
  assert.equal(report.expected.manualReviewExpected, 5);
  assert.equal(report.gates.unsafeAutoImport, 0);
  assert.equal(report.gates.wrongPersistedData, 0);
  assert.equal(report.gates.conflictAccepted, 0);
  assert.equal(report.gates.layoutOrPolicyBypass, 0);
  assert.equal(report.conservativeReview, 0);
  assert.equal(report.eventEnrichmentPending, 20);
  assert.equal(report.placedAtAvailable, 20);
  assert.equal(report.cases[24].actualClass, 'MANUAL_REVIEW');
});

test('negativa cross-house rejeitada é revisão esperada, nunca importação insegura', () => {
  const value = base();
  value.cases[24].actual.layoutId = null;
  const report = evaluateDecision(value, { context: withContext(value) });
  const item = report.cases[24];
  assert.equal(item.negative, true);
  assert.equal(item.expectedClass, 'MANUAL_REVIEW_EXPECTED');
  assert.equal(item.actualClass, 'MANUAL_REVIEW');
  assert.deepEqual(item.actualIssues, ['CROSS_HOUSE_REVIEW']);
  assert.equal(report.gates.unsafeAutoImport, 0);
});

test('positivo sem layout reconhecido permanece em revisão conservadora', () => {
  const value = base();
  value.cases[0].actual.layoutId = null;
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.deepEqual(report.cases[0].actualIssues, ['LAYOUT_UNRECOGNIZED']);
  assert.equal(report.actual.wouldImport, 19);
});

test('layout diferente ou modelo não aprovado impedem a importação', () => {
  const wrongLayout = base();
  wrongLayout.cases[0].actual.layoutId = 'other-v1';
  const reportLayout = evaluateDecision(wrongLayout, { context: withContext(wrongLayout) });
  assert.deepEqual(reportLayout.cases[0].actualIssues, ['LAYOUT_CONFLICT']);

  const wrongModel = base();
  wrongModel.cases[0].actual.model = 'fallback/model-without-homologation';
  const reportModel = evaluateDecision(wrongModel, { context: withContext(wrongModel) });
  assert.deepEqual(reportModel.cases[0].actualIssues, ['MODEL_UNAPPROVED']);
  assert.equal(reportModel.gates.layoutOrPolicyBypass, 0);
  assert.equal(reportModel.gates.unsafeAutoImport, 0);
});

test('digest de política é verificado no fluxo real e explicitado no relatório', () => {
  const value = base();
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.match(report.policyDigestSource, /fluxo real/);
  assert.equal(report.gates.layoutOrPolicyBypass, 0);
});

test('Bet365 sem data visual usa a quarta linha válida do contexto', () => {
  const value = base();
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.cases[0].placedAt !== null, true);
  assert.equal(report.cases[0].actualClass, 'WOULD_IMPORT');
});

test('Bet365 sem qualquer placedAt permanece em revisão', () => {
  const value = base();
  const report = evaluateDecision(value, {
    context: withContext(value, () => ({ placedAt: null })),
  });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('PLACED_AT_UNCERTAIN'), true);
  assert.equal(report.cases[0].expectedFeasible, false);
  assert.equal(report.cases[0].expectedIssues.includes('placedAt_missing'), true);
  assert.equal(report.gates.unsafeAutoImport, 0);
});

test('placedAt divergente entre imagem e contexto permanece em revisão', () => {
  const value = base();
  value.cases[0].actual.extraction.placedAtText = '2026-09-07T23:59:00-03:00';
  value.cases[0].expected.placedAtText = '2026-09-07T23:59:00-03:00';
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('PLACED_AT_UNCERTAIN'), true);
});

test('período ao vivo e data dentro da seleção nunca viram data do evento nem bloqueiam', () => {
  const value = base();
  value.cases[0].actual.extraction.selections[0].eventDateText = "2º Tempo • 61'";
  value.cases[0].expected.selections[0].eventDateText = '31/12/2030';
  const report = evaluateDecision(value, { context: withContext(value) });
  const item = report.cases[0];
  assert.equal(item.actualClass, 'WOULD_IMPORT');
  assert.deepEqual(item.persistedDiffs, []);
  assert.equal(report.gates.wrongPersistedData, 0);
});

test('evento, mercado, seleção ou odd incorretos bloqueiam a homologação', () => {
  for (const mutate of [
    (item) => (item.actual.extraction.selections[0].market = 'Mercado Errado'),
    (item) => (item.actual.extraction.selections[0].selection = 'Outra'),
    (item) => (item.actual.extraction.selections[0].event = 'Evento Errado'),
    (item) => (item.actual.extraction.selections[0].odds = '9.99'),
  ]) {
    const value = base();
    mutate(value.cases[0]);
    const report = evaluateDecision(value, { context: withContext(value) });
    assert.equal(report.cases[0].actualClass, 'WOULD_IMPORT');
    assert.equal(report.cases[0].persistedDiffs.length > 0, true);
    assert.equal(report.gates.wrongPersistedData, 1);
  }
});

test('stake ou odd total incorretos bloqueiam a homologação', () => {
  const value = base();
  value.cases[0].actual.extraction.stake = '10.01';
  value.cases[1].actual.extraction.odds = '2.01';
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.gates.wrongPersistedData, 2);
});

test('referência inconsistente com o OCR impede a importação; omissão é detectada', () => {
  const blocked = base();
  blocked.cases[0].actual.ocrConsistent = false;
  const reportBlocked = evaluateDecision(blocked, { context: withContext(blocked) });
  assert.equal(reportBlocked.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.deepEqual(reportBlocked.cases[0].actualIssues, ['EXTRACTION_UNCERTAIN']);

  const omitted = base();
  omitted.cases[0].actual.extraction.reference = null;
  const report = evaluateDecision(omitted, { context: withContext(omitted) });
  assert.equal(report.cases[0].actualClass, 'WOULD_IMPORT');
  assert.deepEqual(report.cases[0].persistedDiffs, ['reference']);
  assert.equal(report.gates.wrongPersistedData, 1);
});

test('freebet sem crédito único controlado permanece em revisão; com crédito controlado importa', () => {
  const uncontrolled = base();
  for (const item of uncontrolled.cases) {
    item.expected.freebet = null;
    item.actual.extraction.freebet = null;
  }
  const report = evaluateDecision(uncontrolled, {
    context: withContext(uncontrolled, () => ({ kind: 'freebet', freebetCredit: 'uncontrolled' })),
  });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('FREEBET_UNRESOLVED'), true);
  assert.equal(report.cases[0].expectedFeasible, false);

  const controlled = base();
  for (const item of controlled.cases) {
    item.expected.freebet = null;
    item.actual.extraction.freebet = null;
  }
  const reportControlled = evaluateDecision(controlled, {
    context: withContext(controlled, () => ({ kind: 'freebet', freebetCredit: 'controlled' })),
  });
  assert.equal(reportControlled.cases[0].actualClass, 'WOULD_IMPORT');
  assert.equal(reportControlled.wouldImportByKind.freebet, 20);
});

test('tipo sem declaração no contexto permanece em revisão (duas linhas)', () => {
  const value = base();
  const report = evaluateDecision(value, { context: withContext(value, () => ({ kind: null })) });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('CAPTION_UNRESOLVED'), true);
});

test('casa visual de outra casa conflita com o contexto informado', () => {
  const value = base();
  value.cases[0].actual.extraction.bookmaker = 'Superbet';
  const report = evaluateDecision(value, { context: withContext(value) });
  assert.equal(report.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(report.cases[0].actualIssues.includes('BOOKMAKER_CONFLICT'), true);
});

test('duplicidade offline por imagem repetida ou tupla persistida', () => {
  const repeated = base();
  repeated.cases[1].imageSha256 = repeated.cases[0].imageSha256;
  repeated.cases[1].actual.imageSha256 = repeated.cases[0].imageSha256;
  const reportRepeated = evaluateDecision(repeated, { context: withContext(repeated) });
  assert.equal(reportRepeated.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(reportRepeated.cases[0].actualIssues.includes('DUPLICATE_REVIEW_REQUIRED'), true);

  const tuple = base();
  tuple.cases[1].actual.extraction.stake = tuple.cases[0].actual.extraction.stake;
  tuple.cases[1].actual.extraction.odds = tuple.cases[0].actual.extraction.odds;
  const reportTuple = evaluateDecision(tuple, {
    context: withContext(tuple, (index) => (index === 1 ? { placedAt: ctxPlacedAt(0) } : {})),
  });
  assert.equal(reportTuple.cases[0].actualClass, 'MANUAL_REVIEW');
  assert.equal(reportTuple.cases[1].actualIssues.includes('DUPLICATE_REVIEW_REQUIRED'), true);
});

test('ausência de contexto em um caso específico o mantém em revisão', () => {
  const value = base();
  const context = withContext(value);
  context.cases = context.cases.slice(0, 3);
  const report = evaluateDecision(value, { context });
  assert.equal(report.context.positivesWithoutContext, 17);
  assert.equal(report.actual.wouldImport, 3);
  assert.equal(report.conservativeReview, 0);
  assert.equal(report.reasonCounts.CONTEXT_MISSING, 17);
  assert.equal(report.gates.unsafeAutoImport, 0);
});

test('o relatório preserva o bloco de qualidade quando fornecido', () => {
  const value = base();
  const report = evaluateDecision(value, {
    context: withContext(value),
    quality: {
      correctTickets: 25,
      essentialFieldErrors: 0,
      fieldCounts: {},
      coveragePassed: true,
      eligibleForOwnerReview: true,
    },
  });
  assert.equal(report.quality.correctTickets, 25);
  assert.equal(report.eventEnrichmentPending, 20);
});

test('recusa casa fora do allowlist antes de avaliar', () => {
  const value = base();
  value.layout.bookmaker = 'kalshi';
  assert.throws(
    () => evaluateDecision(value, { context: withContext(value) }),
    /DECISION_BOOKMAKER_UNKNOWN/,
  );
});

test('retorno visual divergente é somente diagnóstico de fidelidade e nunca bloqueia (R6)', () => {
  const value = base();
  // Um positivo com retorno visual divergente do cálculo stake × odd.
  // Um positivo qualquer recebe um retorno visual claramente divergente.
  const targetIndex = 0;
  const target = value.cases[targetIndex];
  const original = target.actual.extraction.potentialReturn;
  target.actual.extraction.potentialReturn = '999.99';
  const report = evaluateDecision(value, { context: withContext(value) });
  const evaluated = report.cases.find((item) => item.index === targetIndex + 1);
  // Nenhum issue de retorno: o valor visual não participa da decisão…
  assert.equal(evaluated.actualIssues.includes('RETURN_MISMATCH'), false);
  // …o caso continua importável e a divergência fica no diagnóstico separado.
  assert.equal(evaluated.actualClass, 'WOULD_IMPORT');
  assert.equal(report.returnFidelityMismatch >= 1, true);
  assert.equal(report.gates.unsafeAutoImport, 0);
  target.actual.extraction.potentialReturn = original;
});
