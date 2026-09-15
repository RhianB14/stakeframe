import { createHash } from 'node:crypto';
import {
  corpusEvaluationInputSchema,
  ticketExtractionSchema,
} from '../../packages/shared/dist/index.js';

// The beta gate only accepts the three planned houses; anything else is refused
// before any other check so a corpus can never be approved under an unknown name.
export const KNOWN_BOOKMAKERS = ['bet365', 'superbet', 'novibet'];

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalizeName = (value) => value.normalize('NFC').trim().replace(/\s+/g, ' ');
// Separadores isolados de confronto (x, v, vs, -, –, —) são equivalentes. O
// hífen legítimo dentro de nomes permanece significativo porque a troca exige
// espaço dos dois lados; nada mais do texto é tocado.
const EVENT_SEPARATOR = /\s+(?:vs|x|v|-|–|—)\s+/gi;
const normalizeEvent = (value) => normalizeName(value).replace(EVENT_SEPARATOR, ' § ');
// Glifos ordinais º/° são equivalentes somente em mercados; o restante do
// texto (nomes, valores, datas, acentos) continua exato.
const normalizeMarket = (value) => normalizeName(value).replace(/[\u00b0\u00ba]/g, '\u00ba');
const normalizeBookmaker = (value) => normalizeName(value).toLocaleLowerCase('pt-BR');
const normalize = (value, field) => {
  if (typeof value !== 'string') return value;
  if (['stake', 'odds', 'potentialReturn'].includes(field))
    return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (field === 'event') return normalizeEvent(value);
  if (field === 'market') return normalizeMarket(value);
  return normalizeName(value);
};
export function evaluateCorpus(value) {
  const input = corpusEvaluationInputSchema.parse(value);
  if (!KNOWN_BOOKMAKERS.includes(input.layout.bookmaker))
    throw new Error('CORPUS_BOOKMAKER_UNKNOWN');
  if (
    input.cases.some(
      (item) => item.expectedLayoutId !== null && item.expectedLayoutId !== input.layout.id,
    )
  )
    throw new Error('CORPUS_LAYOUT_INVALID');
  const fieldCounts = {};
  const visualDiagnostics = {
    positiveRecognized: 0,
    positiveUnrecognized: 0,
    crossHouseRejected: 0,
    crossHouseRecognized: 0,
  };
  const contextDiagnostics = { bookmakerConfirmed: 0, bookmakerAbsent: 0, bookmakerConflicts: 0 };
  // 'visual-only' preserva o contrato legado; 'user-informed' reflete a decisão
  // de produto em que a casa vem do contexto e a IA não é fonte de verdade.
  const context = input.bookmakerContext ?? 'visual-only';
  const cases = input.cases.map((item, index) => {
    const issues = [];
    const record = (field, kind) => {
      issues.push({ field, kind });
      fieldCounts[field] ??= { mismatches: 0, omitted: 0, invented: 0 };
      fieldCounts[field][kind]++;
    };
    const actual = ticketExtractionSchema.safeParse(item.actual.extraction);
    if (!actual.success) record('schema', 'mismatches');
    if (item.actual.imageSha256 !== item.imageSha256) record('image', 'mismatches');
    if (item.actual.model !== input.layout.model) record('model', 'mismatches');
    const isPositive = item.expectedLayoutId !== null;
    if (isPositive) {
      if (item.actual.layoutId === item.expectedLayoutId) visualDiagnostics.positiveRecognized += 1;
      else {
        visualDiagnostics.positiveUnrecognized += 1;
        // No modo com casa informada o layout visual não é classificação
        // obrigatória: bilhete válido não se perde por ausência de marca.
        if (context !== 'user-informed') record('layout', 'mismatches');
      }
    } else if (item.actual.layoutId === null) {
      visualDiagnostics.crossHouseRejected += 1;
    } else {
      visualDiagnostics.crossHouseRecognized += 1;
      record('layout', 'mismatches');
    }
    if (actual.success) {
      const compare = (field, expected, observed, key = field) => {
        if (normalize(expected, key) !== normalize(observed, key))
          record(
            field,
            expected === null ? 'invented' : observed === null ? 'omitted' : 'mismatches',
          );
      };
      for (const field of [
        'bookmaker',
        'reference',
        'placedAtText',
        'currency',
        'stake',
        'odds',
        'potentialReturn',
        'freebet',
      ]) {
        if (field === 'bookmaker' && context === 'user-informed' && isPositive) {
          // A casa positiva vem do contexto: null (marca ausente na tela) é
          // aceitável; a evidência visual só pesa como conflito quando aponta
          // para outra casa.
          const observed = actual.data.bookmaker;
          if (observed === null) contextDiagnostics.bookmakerAbsent += 1;
          else if (
            normalizeBookmaker(observed) === normalizeBookmaker(item.expected.bookmaker ?? '')
          )
            contextDiagnostics.bookmakerConfirmed += 1;
          else {
            contextDiagnostics.bookmakerConflicts += 1;
            record('bookmaker', 'mismatches');
          }
        } else compare(field, item.expected[field], actual.data[field]);
      }
      compare('selections.length', item.expected.selections.length, actual.data.selections.length);
      for (let i = 0; i < item.expected.selections.length; i++) {
        const expected = item.expected.selections[i];
        const observed = actual.data.selections[i];
        if (!observed) continue;
        for (const field of ['event', 'sport', 'market', 'selection', 'odds', 'eventDateText'])
          compare(`selections.${field}`, expected[field], observed[field], field);
      }
      compare(
        'warnings.present',
        item.expected.warnings.length > 0,
        actual.data.warnings.length > 0,
      );
    }
    return { index: index + 1, correct: issues.length === 0, issues };
  });
  const positive = input.cases.filter((item) => item.expectedLayoutId === input.layout.id);
  const negative = input.cases.filter((item) => item.expectedLayoutId === null);
  const uniqueImages = new Set(input.cases.map((item) => item.imageSha256)).size;
  const coverage = {
    positive: positive.length,
    negative: negative.length,
    uniqueImages,
    multiples: positive.filter((item) => item.expected.selections.length > 1).length,
    promotional: positive.filter((item) => item.expected.freebet === true).length,
    missingFields: positive.filter((item) =>
      [
        item.expected.placedAtText,
        item.expected.potentialReturn,
        ...item.expected.selections.map((selection) => selection.eventDateText),
      ].some((field) => field === null),
    ).length,
  };
  const errors = cases.reduce((total, item) => total + item.issues.length, 0);
  const coveragePassed =
    coverage.positive >= 20 &&
    coverage.negative >= 5 &&
    coverage.multiples >= 3 &&
    coverage.missingFields >= 3 &&
    (!input.layout.allowFreebet || coverage.promotional >= 3) &&
    uniqueImages === input.cases.length;
  const latency = input.cases.map((item) => item.actual.latencyMs).sort((a, b) => a - b);
  return {
    schemaVersion: 1,
    layout: input.layout,
    layoutSha256: hash(input.layout),
    layoutId: input.layout.id,
    bookmaker: input.layout.bookmaker,
    bookmakerContext: context,
    model: input.layout.model,
    corpusSha256: hash({
      bookmaker: input.layout.bookmaker,
      layoutId: input.layout.id,
      cases: input.cases.map(({ imageSha256, expectedLayoutId, expected }) => ({
        imageSha256,
        expectedLayoutId,
        expected,
      })),
    }),
    evidenceSha256: hash(input.cases),
    sampleCount: positive.length,
    totalCases: cases.length,
    correctTickets: cases.filter((item) => item.correct).length,
    essentialFieldErrors: errors,
    fieldCounts,
    visualDiagnostics,
    contextDiagnostics,
    coverage,
    coveragePassed,
    eligibleForOwnerReview: errors === 0 && coveragePassed,
    latency: {
      medianMs:
        (latency[Math.floor((latency.length - 1) / 2)] + latency[Math.floor(latency.length / 2)]) /
        2,
      p95Ms: latency[Math.ceil(latency.length * 0.95) - 1],
    },
    requestCount: input.cases.reduce((total, item) => total + item.actual.requestCount, 0),
    costUsd: input.cases.every((item) => item.actual.costUsd !== null)
      ? input.cases.reduce((total, item) => total + item.actual.costUsd, 0)
      : null,
    cases,
  };
}
