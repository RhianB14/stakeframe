import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  parseAutomaticPlacedAt,
  automaticEventDate,
  validatedLayoutsSchema,
  OPENROUTER_MODEL,
  type ValidatedLayout,
} from '../../packages/shared/src/index.js';
import { readAutomaticLayouts } from '../../apps/worker/src/automatic-config.js';
import { extractTicket } from '../../apps/worker/src/openrouter.js';
import { layoutDigest } from '../../packages/db/src/automatic-policy.js';
const layout: ValidatedLayout = {
  id: 'synthetic-layout',
  bookmakerId: randomUUID(),
  model: OPENROUTER_MODEL,
  description: 'Fictional deterministic layout, never a production approval.',
  placedAtFormat: 'iso-offset',
  allowFreebet: false,
  corpusSha256: '0'.repeat(64),
  evaluationSha256: '1'.repeat(64),
  sampleCount: 20,
  essentialFieldErrors: 0,
  approvedBy: 'owner',
  approvedAt: '2020-01-01T00:00:00Z',
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
});
