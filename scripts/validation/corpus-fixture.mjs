import { createHash } from 'node:crypto';
import { OPENROUTER_MODEL } from '../../packages/shared/dist/index.js';

// Synthetic, deterministic fixtures for evaluator and policy tests only. They
// never contain real tickets, images, hashes or personal data.
export function syntheticExtraction() {
  return {
    reference: 'fixture',
    placedAtText: null,
    currency: 'BRL',
    stake: '10.00',
    odds: '2.00',
    potentialReturn: null,
    freebet: false,
    selections: [
      {
        event: 'Fictional A × B',
        sport: null,
        market: 'Result',
        selection: 'A',
        odds: null,
        eventDateText: null,
      },
    ],
    warnings: [],
  };
}

export function syntheticCorpus({
  id = 'bet365-fixture',
  bookmaker = 'bet365',
  bookmakerContext = 'visual-only',
} = {}) {
  const extraction = syntheticExtraction();
  return {
    schemaVersion: 1,
    bookmakerContext,
    layout: {
      id,
      bookmaker,
      bookmakerId: '10000000-0000-4000-8000-000000000001',
      model: OPENROUTER_MODEL,
      description: 'Fictional evidence for evaluator tests only.',
      placedAtFormat: 'iso-offset',
      allowFreebet: false,
    },
    cases: Array.from({ length: 25 }, (_, index) => {
      const imageSha256 = createHash('sha256').update(`fictional-image-${index}`).digest('hex');
      const layoutId = index < 20 ? id : null;
      const expected = structuredClone(extraction);
      if (index < 3)
        expected.selections.push({ ...expected.selections[0], event: 'Another fictional event' });
      return {
        imageSha256,
        expectedLayoutId: layoutId,
        expected,
        actual: {
          imageSha256,
          model: OPENROUTER_MODEL,
          layoutId,
          extraction: structuredClone(expected),
          latencyMs: 100 + index,
          requestCount: 1,
          costUsd: null,
        },
      };
    }),
  };
}

export function buildPolicyEntry(corpus, report, evaluationSha256, overrides = {}) {
  const entry = {
    id: corpus.layout.id,
    bookmaker: corpus.layout.bookmaker,
    bookmakerId: corpus.layout.bookmakerId,
    model: corpus.layout.model,
    description: corpus.layout.description,
    placedAtFormat: corpus.layout.placedAtFormat,
    allowFreebet: corpus.layout.allowFreebet,
    potentialReturnLabels: corpus.layout.potentialReturnLabels ?? ['Retorno Total'],
    layoutSha256: report.layoutSha256,
    coverage: report.coverage,
    corpusSha256: report.corpusSha256,
    evaluationSha256,
    sampleCount: report.sampleCount,
    essentialFieldErrors: 0,
    approvedBy: 'owner',
    approvedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  };
  Object.defineProperties(entry, {
    __report: { value: report, enumerable: false },
    __evaluationSha256: { value: evaluationSha256, enumerable: false },
  });
  return entry;
}

export function buildGlobalPolicy(evidence, overrides = {}) {
  const reports = evidence.map((item) => item.report);
  const evaluationHashes = evidence.map((item) => item.evaluationSha256).sort();
  const corpusHashes = reports.map((report) => report.corpusSha256).sort();
  const coverage = Object.fromEntries(
    ['positive', 'negative', 'multiples', 'missingFields', 'promotional', 'uniqueImages'].map(
      (key) => [key, reports.reduce((total, report) => total + report.coverage[key], 0)],
    ),
  );
  const bookmakers = {
    approved: [...new Set(reports.map((report) => report.bookmaker))],
    pending: [],
    ...(overrides.bookmakers ?? {}),
  };
  const rest = { ...overrides };
  delete rest.bookmakers;
  return {
    schemaVersion: 3,
    requiresUserBookmaker: true,
    aiBookmakerClassification: 'disabled',
    bookmakerScope: 'explicit',
    bookmakers,
    model: reports[0].model,
    placedAtFormats: [...new Set(reports.map((report) => report.layout.placedAtFormat))],
    allowFreebet: reports.every((report) => report.layout.allowFreebet ?? false),
    potentialReturnLabels: [
      ...new Set(
        reports.flatMap((report) => report.layout.potentialReturnLabels ?? ['Retorno Total']),
      ),
    ],
    corpusSha256: createHash('sha256').update(JSON.stringify(corpusHashes)).digest('hex'),
    evaluationSha256: createHash('sha256').update(JSON.stringify(evaluationHashes)).digest('hex'),
    coverage,
    sampleCount: reports.reduce((total, report) => total + report.sampleCount, 0),
    // An approval declaration claims zero; the checker compares this claim
    // with the recomputed reports and rejects any non-zero evidence.
    essentialFieldErrors: 0,
    approvedBy: 'owner',
    approvedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...rest,
  };
}
