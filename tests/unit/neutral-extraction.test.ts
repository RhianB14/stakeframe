import { describe, expect, it } from 'vitest';
import {
  ticketExtractionJsonSchema,
  ticketExtractionSchema,
} from '../../packages/shared/src/index.js';
import { TICKET_EXTRACTION_SYSTEM_PROMPT } from '../../apps/worker/src/openrouter.js';

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
