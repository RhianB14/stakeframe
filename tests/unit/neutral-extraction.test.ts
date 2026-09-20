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

// STK-G0-22-F5-R1: caminho real do runExtraction — enriquecimento determinístico
// do retorno pelo OCR (nunca cálculo), aviso falso de recorte removido e
// fail-closed da referência ambígua.
describe('real extraction path — OCR enrichment and fail-closed review (STK-G0-22-F5-R1)', () => {
  const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
  const ocrWith = (text: string) => ({
    text,
    pages: [
      {
        width: 10,
        height: 10,
        unit: 'pixels' as const,
        qualityScore: 1,
        blocks: [{ text: 'Bilhete ficticio', confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
        lines: [{ text, confidence: 1, boundingPoly: [{ x: 0, y: 0 }] }],
      },
    ],
    averageConfidence: 1,
    averageQualityScore: 1,
  });
  const modelResponse = (content: unknown) =>
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'c1',
        model: OPENROUTER_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      }),
    );
  it('enriches a null potentialReturn from the OCR when the label and value are visible', async () => {
    const fetchImpl = modelResponse({ ...neutral, potentialReturn: null });
    const result = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('Bilhete ficticio\nRetorno Total R$ 200,00\nValor apostado R$ 100,00'),
      fetchImpl,
    });
    expect(result.extraction.potentialReturn).toBe('200.00');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('never calculates the return from stake and odds', async () => {
    const fetchImpl = modelResponse({
      ...neutral,
      potentialReturn: null,
      stake: '100.00',
      odds: '2.00',
    });
    const result = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('Valor apostado R$ 100,00\nOdd 2.00'),
      fetchImpl,
    });
    expect(result.extraction.potentialReturn).toBeNull();
    const labelOnly = modelResponse({
      ...neutral,
      potentialReturn: null,
      stake: '100.00',
      odds: '2.00',
    });
    const withoutValue = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('Retorno Total'),
      fetchImpl: labelOnly,
    });
    expect(withoutValue.extraction.potentialReturn).toBeNull();
  });
  it('drops a false crop warning when the OCR shows the return block and keeps other warnings', async () => {
    const fetchImpl = modelResponse({
      ...neutral,
      potentialReturn: null,
      warnings: ['Recorte inferior: bloco de retorno potencial não visível.'],
    });
    const result = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('Prêmio R$ 26,50'),
      fetchImpl,
    });
    expect(result.extraction.potentialReturn).toBe('26.50');
    expect(result.extraction.warnings).toEqual([]);
    const other = modelResponse({
      ...neutral,
      potentialReturn: null,
      warnings: ['Cupom não confirmado; imagem escura.'],
    });
    const kept = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('Ganho Potencial 0,53'),
      fetchImpl: other,
    });
    expect(kept.extraction.potentialReturn).toBe('0.53');
    expect(kept.extraction.warnings).toEqual(['Cupom não confirmado; imagem escura.']);
  });
  it('keeps an ambiguous reference null with a warning and review on the real path', async () => {
    const first = JSON.stringify({ ...neutral, reference: '898C-7R4JIY' });
    const fetchImpl = vi
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
    const result = await extractTicket({
      apiKey: 'fictional-key',
      image,
      ocr: ocrWith('898C-7R4UIY'),
      fetchImpl,
    });
    expect(result.extraction.reference).toBeNull();
    expect(result.extraction.warnings.length).toBeGreaterThan(0);
    expect(result.requiresReview).toBe(true);
  });
  it('still rejects bookmaker and layout produced by the model on the real path', async () => {
    for (const extra of [{ bookmaker: 'Bet365' }, { layoutId: 'bet365-v1' }]) {
      const fetchImpl = modelResponse({ ...neutral, ...extra });
      await expect(extractTicket({ apiKey: 'fictional-key', image, fetchImpl })).rejects.toThrow(
        'AI_EXTRACTION_INVALID',
      );
    }
  });
});
