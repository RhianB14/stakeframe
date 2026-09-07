import { createHash } from 'node:crypto';
import {
  corpusEvaluationInputSchema,
  ticketExtractionSchema,
} from '../../packages/shared/dist/index.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = (value, field) => {
  if (typeof value !== 'string') return value;
  if (['stake', 'odds', 'potentialReturn'].includes(field))
    return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
};
export function evaluateCorpus(value) {
  const input = corpusEvaluationInputSchema.parse(value);
  if (
    input.cases.some(
      (item) => item.expectedLayoutId !== null && item.expectedLayoutId !== input.layout.id,
    )
  )
    throw new Error('CORPUS_LAYOUT_INVALID');
  const fieldCounts = {};
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
    if (item.actual.layoutId !== item.expectedLayoutId) record('layout', 'mismatches');
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
      ])
        compare(field, item.expected[field], actual.data[field]);
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
    model: input.layout.model,
    corpusSha256: hash(
      input.cases.map(({ imageSha256, expectedLayoutId, expected }) => ({
        imageSha256,
        expectedLayoutId,
        expected,
      })),
    ),
    evidenceSha256: hash(input.cases),
    sampleCount: positive.length,
    totalCases: cases.length,
    correctTickets: cases.filter((item) => item.correct).length,
    essentialFieldErrors: errors,
    fieldCounts,
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
