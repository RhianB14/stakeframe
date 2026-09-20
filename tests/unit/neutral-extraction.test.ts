import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_MODEL,
  ticketExtractionJsonSchema,
  ticketExtractionSchema,
} from '../../packages/shared/src/index.js';
import {
  TICKET_EXTRACTION_SYSTEM_PROMPT,
  ambiguousReferencePair,
  extractTicket,
} from '../../apps/worker/src/openrouter.js';

// STK-G0-22-F1: contrato e prompt de extração neutros — a IA não identifica,
// infere ou sugere a casa; bookmaker/layout pertencem exclusivamente ao
// servidor e à declaração explícita do usuário.
const neutral = {
  reference: null,
  placedAtText: null,
  currency: 'BRL',
  stake: '10.00',
  odds: '2.00',
  potentialReturn: null,
  freebet: null,
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

describe('neutral extraction contract (STK-G0-22-F1)', () => {
  it.each([
    ['bookmaker', 'Bet365'],
    ['bookmakerId', 'x'],
    ['layoutId', 'x'],
    ['bookmakerName', 'Bet365'],
  ])('rejects the %s field coming from the model response', (field, value) => {
    expect(ticketExtractionSchema.safeParse({ ...neutral, [field]: value }).success).toBe(false);
  });
  it('accepts the neutral response and keeps the event date fields null', () => {
    const parsed = ticketExtractionSchema.safeParse(neutral);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('bookmaker');
    expect(ticketExtractionJsonSchema).toBeDefined();
  });
  it('rejects truncated and incomplete responses (fail-closed)', () => {
    expect(ticketExtractionSchema.safeParse('{"reference":').success).toBe(false);
    const missing: Record<string, unknown> = { ...neutral };
    delete missing.selections;
    expect(ticketExtractionSchema.safeParse(missing).success).toBe(false);
  });
  it('declares the user-informed bookmaker context and never asks for classification', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('bookmakerContext=user-informed');
    for (const forbidden of [
      'Informe layoutId',
      'Preencha bookmaker',
      'classifique',
      'identifique a casa',
      'sugira a casa',
    ])
      expect(TICKET_EXTRACTION_SYSTEM_PROMPT).not.toContain(forbidden);
  });
  it('keeps the event date out of the model order', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('[Data do evento]');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).not.toContain('extraia a data do evento');
  });
});

// STK-G0-22-F5: retorno por rótulo explícito, referência com segunda leitura e
// aviso conservador — a IA organiza o OCR e nunca calcula nem adivinha.
describe('neutral extraction finalization (STK-G0-22-F5)', () => {
  it('lists the fixed return labels and forbids any calculation', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('Retorno Total');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('Prêmio');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('Ganho Potencial');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('Nunca calcule');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).not.toContain('rótulos autorizados do layout');
  });
  it('keeps a conservative warning rule for incomplete return blocks', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('aviso conservador');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('bloco de retorno potencial');
  });
  it('requires a focused second read for ambiguous reference characters', () => {
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('U/J');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('I/1');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('O/0');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('segunda leitura');
    expect(TICKET_EXTRACTION_SYSTEM_PROMPT).toContain('Nunca adivinhe');
  });
  it('detects an ambiguous reference pair only when the OCR differs by confusable characters', () => {
    expect(ambiguousReferencePair('898C-7R4JIY', 'bilhete 898C-7R4UIY valor')).toBe(true);
    expect(ambiguousReferencePair('898C-7R4JIY', 'bilhete 898C-7R4JIY valor')).toBe(false);
    expect(ambiguousReferencePair('ABCD-EFGH', 'bilhete ABCD-EFGH valor')).toBe(false);
    expect(ambiguousReferencePair('898C-7R4JIY', 'sem referencia aqui')).toBe(false);
    expect(ambiguousReferencePair(null, '898C-7R4UIY')).toBe(false);
  });
  it('runs the second read, keeps an agreeing reference and nulls a diverging one with a warning', async () => {
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const ocr = {
      text: 'Bilhete ficticio\n898C-7R4UIY\n100,00',
      pages: [
        {
          width: 10,
          height: 10,
          unit: 'pixels' as const,
          qualityScore: 1,
          blocks: [{ text: 'Bilhete ficticio', confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
          lines: [{ text: '898C-7R4UIY', confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
        },
      ],
      averageConfidence: 1,
      averageQualityScore: 1,
    };
    const first = JSON.stringify({ ...neutral, reference: '898C-7R4JIY' });
    const agree = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 'c1',
          model: OPENROUTER_MODEL,
          choices: [{ finish_reason: 'stop', message: { content: first } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'c2',
          model: OPENROUTER_MODEL,
          choices: [{ finish_reason: 'stop', message: { content: '{"reference":"898C-7R4JIY"}' } }],
        }),
      );
    const agreed = await extractTicket({ apiKey: 'fictional-key', image, ocr, fetchImpl: agree });
    expect(agreed.extraction.reference).toBe('898C-7R4JIY');
    expect(agreed.extraction.warnings).toEqual([]);
    expect(agree).toHaveBeenCalledTimes(2);
    const diverge = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 'c1',
          model: OPENROUTER_MODEL,
          choices: [{ finish_reason: 'stop', message: { content: first } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'c2',
          model: OPENROUTER_MODEL,
          choices: [{ finish_reason: 'stop', message: { content: '{"reference":"898C-7R4UIY"}' } }],
        }),
      );
    const diverged = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr,
      fetchImpl: diverge,
    });
    expect(diverged.extraction.reference).toBeNull();
    expect(diverged.extraction.warnings.length).toBeGreaterThan(0);
    expect(diverge).toHaveBeenCalledTimes(2);
  });
  it('does not run a second read when the reference has no confusable pair', async () => {
    const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'c1',
        model: OPENROUTER_MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ ...neutral, reference: 'ABCD-EFGH' }) },
          },
        ],
      }),
    );
    const result = await extractTicket({ apiKey: 'fictional-key', image, fetchImpl });
    expect(result.extraction.reference).toBe('ABCD-EFGH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
