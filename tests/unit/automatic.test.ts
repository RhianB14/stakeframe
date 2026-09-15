import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  parseAutomaticPlacedAt,
  automaticEventDate,
  validatedLayoutsSchema,
  OPENROUTER_MODEL,
  OPENROUTER_MODELS,
  type ValidatedLayout,
} from '../../packages/shared/src/index.js';
import { readAutomaticLayouts } from '../../apps/worker/src/automatic-config.js';
import { extractTicket, extractTicketForEvidence } from '../../apps/worker/src/openrouter.js';
import { layoutDigest } from '../../packages/db/src/automatic-policy.js';
const layout: ValidatedLayout = {
  id: 'synthetic-layout',
  bookmaker: 'bet365',
  bookmakerId: randomUUID(),
  model: OPENROUTER_MODEL,
  description: 'Fictional deterministic layout, never a production approval.',
  placedAtFormat: 'iso-offset',
  allowFreebet: false,
  layoutSha256: '2'.repeat(64),
  coverage: {
    positive: 20,
    negative: 5,
    multiples: 3,
    missingFields: 3,
    promotional: 0,
    uniqueImages: 25,
  },
  corpusSha256: '0'.repeat(64),
  evaluationSha256: '1'.repeat(64),
  sampleCount: 20,
  essentialFieldErrors: 0,
  approvedBy: 'owner',
  approvedAt: '2020-01-01T00:00:00Z',
  expiresAt: '2999-01-01T00:00:00Z',
};
describe('automatic import policy boundaries', () => {
  it('requires an explicit offset or an approved exact São Paulo grammar', () => {
    expect(parseAutomaticPlacedAt('2026-09-07T10:30:00-03:00', 'iso-offset')).toBe(
      '2026-09-07T13:30:00.000Z',
    );
    expect(parseAutomaticPlacedAt('07/09/2026 10:30', 'br-sao-paulo')).toBe(
      '2026-09-07T13:30:00.000Z',
    );
    expect(parseAutomaticPlacedAt('15/01/2018 10:30:05', 'br-sao-paulo')).toBe(
      '2018-01-15T12:30:05.000Z',
    );
    for (const value of [
      null,
      '07/09 10:30',
      '31/02/2026 10:00',
      '07/09/2026 25:00',
      '07/09/2026 10:99',
      'amanhã',
    ])
      expect(parseAutomaticPlacedAt(value, 'br-sao-paulo')).toBeNull();
    expect(parseAutomaticPlacedAt('2026-09-07T10:30:00', 'iso-offset')).toBeNull();
    // São Paulo skipped midnight at the DST start and repeated 23:00 at the end.
    expect(parseAutomaticPlacedAt('04/11/2018 00:30', 'br-sao-paulo')).toBeNull();
    expect(parseAutomaticPlacedAt('16/02/2019 23:30', 'br-sao-paulo')).toBeNull();
    expect(automaticEventDate('07/09/2026')).toBe('2026-09-07');
    expect(automaticEventDate('2026-09-07')).toBe('2026-09-07');
    for (const value of ['07/09', 'amanhã', '2026-02-30', '07/09/2026 18:00'])
      expect(automaticEventDate(value)).toBeNull();
  });
  it('defaults off and validates the private opt-in policy file without exposing paths or contents', () => {
    expect(readAutomaticLayouts({})).toEqual([]);
    expect(
      readAutomaticLayouts({
        AUTOMATIC_IMPORT_ENABLED: 'false',
        AUTOMATIC_IMPORT_POLICIES_FILE: 'missing',
      }),
    ).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), 'stk-policy-test-'));
    const file = join(directory, 'policies.json');
    const env = {
      AUTOMATIC_IMPORT_ENABLED: 'true',
      AI_ENABLED: 'true',
      AUTOMATIC_IMPORT_POLICIES_FILE: file,
    };
    try {
      writeFileSync(file, JSON.stringify([layout]));
      expect(readAutomaticLayouts(env)).toEqual([layout]);
      for (const value of [
        [],
        [{ ...layout, sampleCount: 1 }],
        [{ ...layout, essentialFieldErrors: 1 }],
        [{ ...layout, approvedAt: '9999-01-01T00:00:00Z' }],
        [{ ...layout, expiresAt: '1999-01-01T00:00:00Z' }],
        [{ ...layout, coverage: { ...layout.coverage, negative: 4 } }],
        [{ ...layout, bookmaker: 'House X' }],
        [{ ...layout, layoutSha256: 'invalid' }],
        [layout, layout],
        [{ ...layout, model: 'unknown' }],
      ]) {
        writeFileSync(file, JSON.stringify(value));
        expect(() => readAutomaticLayouts(env)).toThrow('AUTOMATIC_IMPORT_CONFIGURATION_INVALID');
      }
      writeFileSync(file, 'private-invalid-content');
      expect(() => readAutomaticLayouts(env)).toThrow('AUTOMATIC_IMPORT_CONFIGURATION_INVALID');
      expect(() => readAutomaticLayouts({ ...env, AI_ENABLED: 'false' })).toThrow(
        'AUTOMATIC_IMPORT_CONFIGURATION_INVALID',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('binds recognition to the approved description and keeps unknown model-selected layouts unapproved', async () => {
    const extraction = {
      bookmaker: 'Fictional',
      reference: 'fictional-1',
      placedAtText: null,
      currency: 'BRL',
      stake: '10.00',
      odds: '2.00',
      potentialReturn: null,
      freebet: false,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: 'Result',
          selection: 'A',
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    for (const selected of [layout.id, 'unapproved', null]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 'fictional-completion',
          model: OPENROUTER_MODEL,
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ layoutId: selected, extraction }) },
            },
          ],
        }),
      );
      const result = await extractTicket({
        apiKey: 'fictional-key',
        image,
        layouts: validatedLayoutsSchema.parse([layout]),
        fetchImpl,
      });
      expect(result.layoutId).toBe(selected === layout.id ? selected : null);
      expect(result.policyDigest).toBe(selected === layout.id ? layoutDigest(layout) : null);
      expect(result.requiresReview).toBe(true);
      const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
      expect(request.messages[0].content).toContain(layout.description);
      expect(request.response_format.json_schema.schema.required).toEqual([
        'layoutId',
        'extraction',
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('never binds a fallback response to the primary model policy', async () => {
    const extraction = {
      bookmaker: 'Fictional',
      reference: 'fictional-1',
      placedAtText: null,
      currency: 'BRL' as const,
      stake: '10.00',
      odds: '2.00',
      potentialReturn: null,
      freebet: false,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: 'Result',
          selection: 'A',
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    const fallback = OPENROUTER_MODELS[1];
    const result = await extractTicket({
      apiKey: 'fictional-key',
      image: Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]),
      layouts: validatedLayoutsSchema.parse([layout]),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 'fallback-completion',
          model: fallback,
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ layoutId: layout.id, extraction }) },
            },
          ],
        }),
      ),
    });
    expect(result.model).toBe(fallback);
    expect(result.layoutId).toBe(layout.id);
    expect(result.policyDigest).toBeNull();
    expect(result.requiresReview).toBe(true);
  });

  it('recognizes a layout before approval without computing a policy digest', async () => {
    const extraction = {
      bookmaker: 'Fictional',
      reference: 'fictional-1',
      placedAtText: null,
      currency: 'BRL',
      stake: '10.00',
      odds: '2.00',
      potentialReturn: null,
      freebet: false,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: 'Result',
          selection: 'A',
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'fictional-completion',
        model: OPENROUTER_MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ layoutId: layout.id, extraction }) },
          },
        ],
      }),
    );
    const result = await extractTicketForEvidence({
      apiKey: 'synthetic-key',
      image,
      layouts: validatedLayoutsSchema.parse([layout]),
      fetchImpl,
    });
    expect(result.layoutId).toBe(layout.id);
    expect(result.policyDigest).toBeNull();
    expect(result.requiresReview).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('instructs the extractor not to infer sport from participant names', async () => {
    const extraction = {
      bookmaker: 'Fictional',
      reference: null,
      placedAtText: null,
      currency: 'BRL',
      stake: null,
      odds: null,
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: null,
          selection: null,
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'fictional-completion',
        model: OPENROUTER_MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ layoutId: layout.id, extraction }) },
          },
        ],
      }),
    );
    await extractTicket({
      apiKey: 'synthetic-key',
      image,
      layouts: validatedLayoutsSchema.parse([layout]),
      fetchImpl,
    });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(request.messages[0].content).toContain('Não infira esporte por nomes de equipes');
    expect(request.messages[0].content).toContain(
      'Preencha bookmaker somente quando a marca estiver claramente visível',
    );
    expect(request.messages[0].content).toContain('inclusive 0.00');
    expect(request.messages[0].content).toContain(
      'Só mapeie para potentialReturn quando o rótulo significar explicitamente',
    );
    expect(request.messages[0].content).toContain(
      'sem inferir ano, completar dígitos, normalizar separadores ou corrigir grafia',
    );
  });

  it('rejects invalid provider responses without relaxing the strict extraction schema', async () => {
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const extraction = {
      bookmaker: null,
      reference: null,
      placedAtText: null,
      currency: 'BRL',
      stake: null,
      odds: null,
      potentialReturn: null,
      freebet: null,
      selections: [
        {
          event: 'A x B',
          sport: null,
          market: null,
          selection: null,
          odds: null,
          eventDateText: null,
        },
      ],
      warnings: [],
    };
    const run = (body: Record<string, unknown>) =>
      extractTicket({
        apiKey: 'fictional-key',
        image,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      });
    const envelope = (content: string, finish: string = 'stop') => ({
      id: 'fictional-completion',
      model: OPENROUTER_MODEL,
      choices: [{ finish_reason: finish, message: { content } }],
    });
    await expect(run(envelope(JSON.stringify(extraction), 'length'))).rejects.toThrow(
      'AI_RESPONSE_INVALID',
    );
    await expect(run(envelope(JSON.stringify(extraction).slice(0, 24)))).rejects.toThrow(
      'AI_EXTRACTION_INVALID',
    );
    await expect(run(envelope(JSON.stringify({ ...extraction, extra: 1 })))).rejects.toThrow(
      'AI_EXTRACTION_INVALID',
    );
    const missing: Record<string, unknown> = { ...extraction };
    delete missing.warnings;
    await expect(run(envelope(JSON.stringify(missing)))).rejects.toThrow('AI_EXTRACTION_INVALID');
    await expect(run(envelope(JSON.stringify({ ...extraction, stake: 10 })))).rejects.toThrow(
      'AI_EXTRACTION_INVALID',
    );
  });

  it('keeps the evidence-only extraction out of the worker request flow', () => {
    const sourceDir = fileURLToPath(new URL('../../apps/worker/src/', import.meta.url));
    const workerFiles = readdirSync(sourceDir).filter((name) => name.endsWith('.ts'));
    expect(workerFiles).toContain('openrouter.ts');
    for (const name of workerFiles) {
      const source = readFileSync(join(sourceDir, name), 'utf8');
      if (name === 'openrouter.ts') {
        expect(source).toContain('export function extractTicketForEvidence');
        continue;
      }
      expect(source).not.toContain('extractTicketForEvidence');
    }
    const integrations = readFileSync(join(sourceDir, 'integrations.ts'), 'utf8');
    expect(integrations).toContain('extractTicket(');
    expect(integrations).not.toContain('extractTicketForEvidence');
    const replay = readFileSync(
      fileURLToPath(new URL('../../scripts/validation/corpus-replay.mjs', import.meta.url)),
      'utf8',
    );
    expect(replay).toContain('extractTicketForEvidence');
    expect(replay).not.toContain('extractTicket(');
  });
});
