import { createHash } from 'node:crypto';
import { OPENROUTER_MODEL } from '../../packages/shared/dist/index.js';

// Synthetic, deterministic fixtures for evaluator and policy tests only. They
// never contain real tickets, images, hashes or personal data.
export function syntheticExtraction() {
  return {
    bookmaker: 'Fictional',
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

export function syntheticCorpus({ id = 'bet365-fixture', bookmaker = 'bet365' } = {}) {
  const extraction = syntheticExtraction();
  return {
    schemaVersion: 1,
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
  return {
    id: corpus.layout.id,
    bookmaker: corpus.layout.bookmaker,
    bookmakerId: corpus.layout.bookmakerId,
    model: corpus.layout.model,
    description: corpus.layout.description,
    placedAtFormat: corpus.layout.placedAtFormat,
    allowFreebet: corpus.layout.allowFreebet,
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
}
