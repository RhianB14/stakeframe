import {
  corpusEvaluationInputSchema,
  parseAutomaticPlacedAt,
  suggestedReturn,
  ticketExtractionSchema,
} from '../../packages/shared/dist/index.js';
import { KNOWN_BOOKMAKERS } from './corpus-core.mjs';

// Avaliação offline ORIENTADA À DECISÃO (STK-G0-19-R2): simula, sem banco e
// sem escrita financeira, a decisão real de importação por caso — o lado
// esperado vem do ground truth (modelo perfeito) e o lado observado da
// extração preservada. Os gates de segurança exigem zero importação
// automática insegura e zero valor financeiro incorreto em caso autoaprovado.
// A qualidade de transcrição continua reportada separadamente (bloco quality).

const normalized = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

const decimalEq = (left, right) => {
  const fix = (value) =>
    String(value)
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1');
  return fix(left) === fix(right);
};

const AUTO = 'AUTO_IMPORT_EXPECTED';
const AUTO_CREDIT = 'AUTO_IMPORT_EXPECTED_WITH_CREDIT';
const MANUAL = 'MANUAL_REVIEW_EXPECTED';
const WOULD = 'WOULD_IMPORT';
const REVIEW = 'MANUAL_REVIEW';

function expectedSide(item, layout, kind) {
  const issues = [];
  if (item.expectedLayoutId === null) {
    // Caso cross-house: um bilhete de outra casa NUNCA pode ser autoimportado
    // pelo fluxo desta casa.
    issues.push('negative');
    return { expectedClass: MANUAL, expectedIssues: issues };
  }
  const expected = item.expected;
  if (expected.warnings.length) issues.push('warnings');
  if (expected.currency !== 'BRL') issues.push('currency');
  if (!expected.stake) issues.push('stake');
  if (!expected.odds) issues.push('odds');
  if (expected.placedAtText === null) issues.push('placedAt_missing');
  else if (parseAutomaticPlacedAt(expected.placedAtText, layout.placedAtFormat) === null)
    issues.push('placedAt_unparseable');
  if (expected.bookmaker !== null && normalized(expected.bookmaker) !== layout.bookmaker)
    issues.push('bookmaker');
  if (kind === 'real' && expected.freebet === true) issues.push('freebet_conflict');
  if (kind === 'freebet' && expected.freebet === false) issues.push('freebet_conflict');
  if (issues.length) return { expectedClass: MANUAL, expectedIssues: issues };
  return { expectedClass: kind === 'freebet' ? AUTO_CREDIT : AUTO, expectedIssues: [] };
}

function actualSide(item, layout, kind) {
  const parsed = ticketExtractionSchema.safeParse(item.actual.extraction);
  if (!parsed.success) return { actualClass: REVIEW, actualIssues: ['EXTRACTION_UNCERTAIN'] };
  const value = parsed.data;
  const issues = [];
  // O fluxo real recusa qualquer caso com OCR inconsistente (EXTRACTION_UNCERTAIN).
  if (item.actual.ocrConsistent === false) issues.push('EXTRACTION_UNCERTAIN');
  if (value.warnings.length) issues.push('EXTRACTION_UNCERTAIN');
  if (value.currency !== 'BRL') issues.push('EXTRACTION_UNCERTAIN');
  if (!value.stake || !value.odds) issues.push('EXTRACTION_UNCERTAIN');
  if (value.bookmaker !== null) {
    const visual = normalized(value.bookmaker);
    // Casa informada é a fonte de verdade: marca ausente é aceitável; outra
    // casa conhecida ou texto não resolvido bloqueiam (fail-closed).
    if (visual !== layout.bookmaker) issues.push('BOOKMAKER_CONFLICT');
  }
  if (value.placedAtText === null) issues.push('PLACED_AT_UNCERTAIN');
  else if (parseAutomaticPlacedAt(value.placedAtText, layout.placedAtFormat) === null)
    issues.push('PLACED_AT_UNCERTAIN');
  if (kind === 'real' && value.freebet === true) issues.push('FREEBET_CONFLICT');
  if (kind === 'freebet' && value.freebet === false) issues.push('FREEBET_CONFLICT');
  if (value.potentialReturn !== null) {
    try {
      const suggested = suggestedReturn(value.stake, value.odds, 'win', kind === 'freebet', false);
      if (!decimalEq(value.potentialReturn, suggested)) issues.push('RETURN_MISMATCH');
    } catch {
      issues.push('RETURN_MISMATCH');
    }
  }
  if (!issues.length && kind === 'freebet') issues.push('REVIEW_CREDIT_OFFLINE');
  return { actualClass: issues.length ? REVIEW : WOULD, actualIssues: issues };
}

function valueMatchesExpected(item, layout, kind) {
  const parsed = ticketExtractionSchema.safeParse(item.actual.extraction);
  const expected = item.expected;
  if (!parsed.success) return false;
  const value = parsed.data;
  if (!decimalEq(value.stake ?? '0', expected.stake ?? '0')) return false;
  if (!decimalEq(value.odds ?? '0', expected.odds ?? '0')) return false;
  if ((value.currency ?? null) !== (expected.currency ?? null)) return false;
  if (kind === 'freebet' && value.freebet !== expected.freebet) return false;
  return true;
}

// Fidelidade do retorno potencial: métrica de transcrição/qualidade — nunca um
// valor financeiro errado (o principal gravado continua stake/odds corretos).
function returnFidelityDiffers(item) {
  const parsed = ticketExtractionSchema.safeParse(item.actual.extraction);
  if (!parsed.success) return false;
  const value = parsed.data;
  const expected = item.expected;
  if (expected.potentialReturn === null) return value.potentialReturn !== null;
  return (
    value.potentialReturn === null || !decimalEq(value.potentialReturn, expected.potentialReturn)
  );
}

export function evaluateDecision(value, options = {}) {
  const input = corpusEvaluationInputSchema.parse(value);
  if (!KNOWN_BOOKMAKERS.includes(input.layout.bookmaker))
    throw new Error('DECISION_BOOKMAKER_UNKNOWN');
  const layout = input.layout;
  const cases = input.cases.map((item, index) => {
    const kind =
      item.expectedLayoutId !== null && item.expected.freebet === true ? 'freebet' : 'real';
    const expected = expectedSide(item, layout, kind);
    const actual = actualSide(item, layout, kind);
    return {
      index: index + 1,
      kind,
      expectedClass: expected.expectedClass,
      actualClass: actual.actualClass,
      expectedIssues: expected.expectedIssues,
      actualIssues: actual.actualIssues,
      valueMatchesExpected:
        actual.actualClass === WOULD ? valueMatchesExpected(item, layout, kind) : null,
      returnFidelity: actual.actualClass === WOULD ? returnFidelityDiffers(item) : null,
    };
  });
  const positives = cases.filter((item) => !item.expectedIssues.includes('negative'));
  const negatives = cases.filter((item) => item.expectedIssues.includes('negative'));
  const unsafeAuto = cases.filter(
    (item) => item.actualClass === WOULD && item.expectedClass === MANUAL,
  );
  const wrongValue = cases.filter(
    (item) => item.actualClass === WOULD && item.valueMatchesExpected === false,
  );
  const returnFidelity = cases.filter((item) => item.returnFidelity === true);
  const conflictAccepted = cases.filter(
    (item) =>
      item.actualClass === WOULD &&
      item.actualIssues.some(
        (issue) => issue === 'BOOKMAKER_CONFLICT' || issue === 'FREEBET_CONFLICT',
      ),
  );
  const autoImportableReal = cases.filter(
    (item) => item.expectedClass === AUTO && item.actualClass === WOULD && item.kind === 'real',
  );
  return {
    schemaVersion: 1,
    layoutId: layout.id,
    bookmaker: layout.bookmaker,
    bookmakerContext: input.bookmakerContext ?? 'visual-only',
    model: layout.model,
    totalCases: cases.length,
    positives: positives.length,
    negatives: negatives.length,
    expected: {
      autoImportExpected: cases.filter((item) => item.expectedClass === AUTO).length,
      autoImportExpectedWithCredit: cases.filter((item) => item.expectedClass === AUTO_CREDIT)
        .length,
      manualReviewExpected: cases.filter((item) => item.expectedClass === MANUAL).length,
    },
    actual: {
      wouldImport: cases.filter((item) => item.actualClass === WOULD).length,
      review: cases.filter((item) => item.actualClass === REVIEW).length,
    },
    // Positivos realmente autoimportáveis (contexto real, sem crédito a
    // resolver offline). Freebets ficam separados por dependerem de crédito
    // (avaliado apenas no fluxo real).
    autoImportableReal: autoImportableReal.length,
    autoImportableWithCredit: cases.filter(
      (item) => item.expectedClass === AUTO_CREDIT && item.actualClass === WOULD,
    ).length,
    gates: {
      unsafeAutoImport: unsafeAuto.length,
      wrongFinancialValue: wrongValue.length,
      conflictAccepted: conflictAccepted.length,
      crossTenantLeak: 'coberto por tests/integration/finance-tenant-isolation.test.ts',
    },
    // Qualidade de transcrição do retorno potencial entre os autoaprovados
    // (métrica separada; não é valor financeiro incorreto).
    returnFidelityMismatch: returnFidelity.length,
    // Qualidade de transcrição não é apagada: bloco separado, derivado da
    // avaliação de corpus salva quando disponível.
    quality: options.quality ?? null,
    cases,
  };
}
