import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  parseAutomaticPlacedAt,
  validatedLayoutsSchema,
  OPENROUTER_MODEL,
  type ValidatedLayout,
} from '../../packages/shared/src/index.js';
import { readAutomaticLayouts } from '../../apps/worker/src/automatic-config.js';
import {
  extractTicket,
  TICKET_EXTRACTION_SYSTEM_PROMPT,
} from '../../apps/worker/src/openrouter.js';
import { layoutDigest } from '../../packages/db/src/automatic-policy.js';
const layout: ValidatedLayout = {
  id: 'synthetic-layout',
  bookmaker: 'bet365',
  bookmakerId: randomUUID(),
  model: OPENROUTER_MODEL,
  description: 'Fictional deterministic layout, never a production approval.',
  placedAtFormat: 'iso-offset',
  allowFreebet: false,
  potentialReturnLabels: ['Retorno Total'],
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
  });
  it('parses the strict Superbet textual date and normalizes only the separator', () => {
    expect(parseAutomaticPlacedAt('7 DE SET. DE 2026 \u2014 14:51', 'br-textual-sao-paulo')).toBe(
      '2026-09-07T17:51:00.000Z',
    );
    expect(parseAutomaticPlacedAt('30 DE AGO. DE 2026 \u2013 09:05', 'br-textual-sao-paulo')).toBe(
      '2026-08-30T12:05:00.000Z',
    );
    expect(parseAutomaticPlacedAt('6 DE SET. DE 2026 - 10:12', 'br-textual-sao-paulo')).toBe(
      '2026-09-06T13:12:00.000Z',
    );
    for (const invalid of [
      null,
      '7 DE SET DE 2026 \u2014 14:51',
      '7 DE SETEMBRO DE 2026 \u2014 14:51',
      '7 de set. de 2026 \u2014 14:51',
      '07/09/2026 14:51',
      '7 DE SET. DE 2026 14:51',
      '7 DE SET. DE 2026 \u2014 14:5',
      '7 DE SET. DE 2026 \u2014 24:00',
      '7 DE SET. DE 2026 \u2014 14:60',
      '32 DE SET. DE 2026 \u2014 14:00',
      '7 DE SET. DE 2026 \u2014 14:51 ',
    ])
      expect(parseAutomaticPlacedAt(invalid, 'br-textual-sao-paulo')).toBeNull();
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
  it('keeps potential return out of the OCR agreement while the other fields stay essential', async () => {
    const completionFor = (potentialReturn: string | null) =>
      Response.json({
        id: 'fictional-completion',
        model: OPENROUTER_MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                layoutId: layout.id,
                extraction: {
                  bookmaker: 'Fictional',
                  reference: 'fictional-1',
                  placedAtText: null,
                  currency: 'BRL',
                  stake: '10.00',
                  odds: '2.00',
                  potentialReturn,
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
                },
              }),
            },
          },
        ],
      });
    const ocrWith = (line: string) => ({
      text: `Bilhete ficticio\nA x B\nResult\nA\nfictional-1\n10,00\n2,00\n${line}`,
      pages: [
        {
          width: 10,
          height: 10,
          unit: 'pixels' as const,
          qualityScore: 1,
          blocks: [{ text: 'Bilhete ficticio', confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
          lines: [{ text: line, confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
        },
      ],
      averageConfidence: 1,
      averageQualityScore: 1,
    });
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const run = async (
      potentialReturn: string | null,
      ocrLine: string,
      labels: string[] = ['Retorno Total'],
    ) => {
      const layouts = validatedLayoutsSchema.parse([{ ...layout, potentialReturnLabels: labels }]);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => completionFor(potentialReturn));
      const result = await extractTicket({
        apiKey: 'fictional-key',
        image,
        layouts,
        ocr: ocrWith(ocrLine),
        fetchImpl,
      });
      return { result, fetchImpl };
    };
    // Bet365: rotulo autorizado com valor consistente.
    expect((await run('20.00', 'Retorno Total 20,00')).result.ocrConsistent).toBe(true);
    // Superbet: Premio e Ganho Potencial sao os rotulos autorizados.
    expect(
      (await run('26.50', 'PREMIO 26,50 R$', ['Prêmio', 'Ganho Potencial'])).result.ocrConsistent,
    ).toBe(true);
    expect(
      (await run('0.53', 'Ganho Potencial 0,53 R$', ['Prêmio', 'Ganho Potencial'])).result
        .ocrConsistent,
    ).toBe(true);
    // R6: o retorno é diagnóstico de fidelidade — rótulo visível com omissão do
    // modelo, valor divergente do OCR ou rótulo não autorizado NÃO reprovam a
    // concordância (stake, odds, referência e seleções seguem essenciais).
    expect((await run(null, 'Retorno Total 20,00')).result.ocrConsistent).toBe(true);
    expect((await run('21.00', 'Retorno Total 20,00')).result.ocrConsistent).toBe(true);
    expect((await run('20.00', 'Retorno Liquido 20,00')).result.ocrConsistent).toBe(true);
    expect((await run('26.50', 'Retorno Obtido 26,50')).result.ocrConsistent).toBe(true);
    // Os rotulos autorizados viajam no contexto dos layouts.
    const { fetchImpl } = await run('20.00', 'Retorno Total 20,00');
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(sent.messages[0].content).toContain('"potentialReturnLabels":["Retorno Total"]');
  });
  it('keeps the event date out of the extraction order', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('[Data do evento]');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('envie sempre null');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('"eventDateText":null');
  });
});
