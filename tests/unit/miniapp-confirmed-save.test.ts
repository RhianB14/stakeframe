import { describe, expect, it } from 'vitest';
import {
  partialFailureMessage,
  planConfirmedSave,
  refusalMessage,
  type ConfirmedSaveInput,
} from '../../apps/web/src/product/confirmed-save.js';

// STK-G0-23-R1 — a revisão do Codex apontou que o formulário completo do Mini
// App mandava TUDO pelo PATCH do rascunho, de modo que campos que JÁ têm
// comando canônico (casa, tipster, origem/crédito e data) acabavam recusados
// pelo fail-closed. Estes testes provam o planejamento campo→comando antes de
// qualquer escrita.

const baseline = {
  origin: 'real' as const,
  credit: '',
  bookmaker: '20000000-0000-4000-8000-000000000001',
  tipster: '30000000-0000-4000-8000-000000000001',
  eventAt: null,
  stake: '100.00',
  odds: '2.00',
  sport: 'Futebol',
  tournament: 'Fixture',
  country: 'Brasil',
  ticketKind: 'simple' as const,
  selections: [{ event: 'A x B', market: 'Resultado', selection: 'A' }],
};

const input: ConfirmedSaveInput = {
  version: 4,
  completionState: 'complete',
  selectionIds: ['40000000-0000-4000-8000-000000000001'],
  baseline,
  current: { ...baseline },
};

describe('STK-G0-23-R1 planejamento da edição de aposta confirmada', () => {
  it('encaminha casa, tipster, origem/crédito e data para os comandos canônicos', () => {
    const plan = planConfirmedSave({
      ...input,
      current: {
        ...baseline,
        origin: 'freebet',
        credit: '50000000-0000-4000-8000-000000000009',
        bookmaker: '20000000-0000-4000-8000-000000000002',
        tipster: '30000000-0000-4000-8000-000000000002',
        eventAt: '2026-09-30T18:00:00.000Z',
      },
    });

    expect(plan.blocked).toEqual([]);
    expect(plan.origin).toEqual({
      kind: 'freebet',
      freebetId: '50000000-0000-4000-8000-000000000009',
    });
    expect(plan.bookmaker).toBe('20000000-0000-4000-8000-000000000002');
    expect(plan.tipster).toBe('30000000-0000-4000-8000-000000000002');
    expect(plan.dates).toEqual([
      { selectionId: '40000000-0000-4000-8000-000000000001', eventAt: '2026-09-30T18:00:00.000Z' },
    ]);
    // O PATCH do rascunho NUNCA carrega o que foi ALTERADO: ele não é capaz de
    // atualizar o registro financeiro e o fail-closed recusaria a divergência.
    expect(plan.patch.bookmakerId).toBeUndefined();
    expect(plan.patch.tipsterId).toBeUndefined();
    expect(plan.patch.betOrigin).toBeUndefined();
    expect(plan.patch.freebetId).toBeUndefined();
    expect(plan.patch.eventAt).toBeUndefined();
    expect(plan.patch.sport).toBeUndefined();
    // ...mas continua levando o que o usuário NÃO mexeu, para o "salvar sem
    // mudança" preservar o rascunho como o contrato exige.
    expect(plan.patch.stake).toBe('100.00');
    expect(plan.patch.odds).toBe('2.00');
    expect(plan.patch.selections).toEqual(baseline.selections);
    expect(plan.patch.version).toBe(4);
    expect(plan.patch.tournament).toBe('Fixture');
    expect(plan.patch.country).toBe('Brasil');
    expect(plan.patch.ticketKind).toBe('simple');
  });

  it('mantém valor e odd bloqueados com mensagem própria (não genérica)', () => {
    const plan = planConfirmedSave({
      ...input,
      current: { ...baseline, stake: '250.00', odds: '3.50' },
    });

    expect(plan.blocked).toEqual(['stake', 'odds']);
    expect(plan.origin).toBeNull();
    expect(plan.bookmaker).toBeNull();
    expect(plan.tipster).toBeNull();
    expect(plan.dates).toEqual([]);
    expect(plan.patch.version).toBe(4);
    expect(plan.patch.tournament).toBe('Fixture');
    expect(plan.patch.stake).toBeUndefined();

    const message = refusalMessage(plan.blocked);
    expect(message).toContain('valor apostado');
    expect(message).toContain('odd total');
    expect(message).toContain('Nada foi salvo');
    expect(message).toContain('decisão de produto');
    // Precisa nomear os DOIS limites, sem declarar o formulário inteiro imutável.
    expect(message).not.toMatch(/todos os campos|nenhum campo/);
    expect(message).not.toContain('seções de casa e tipster');
  });

  it('recusa alteração de seleção ou esporte por não ter comando canônico', () => {
    const plan = planConfirmedSave({
      ...input,
      current: {
        ...baseline,
        sport: 'Basquete',
        selections: [{ event: 'A x B', market: 'Resultado', selection: 'B' }],
      },
    });

    expect(plan.blocked).toEqual(['selections', 'sport']);
    const message = refusalMessage(plan.blocked);
    expect(message).toContain('Nada foi salvo');
    expect(message).toContain('texto das seleções');
    expect(message).not.toContain('odd total');
  });

  it('recusa limpar o tipster (o comando canônico exige um tipster)', () => {
    const plan = planConfirmedSave({ ...input, current: { ...baseline, tipster: '' } });

    expect(plan.blocked).toEqual(['tipsterClear']);
    expect(plan.tipster).toBeNull();
    expect(refusalMessage(plan.blocked)).toContain('remover o tipster');
  });

  it('sem mudança nenhuma não bloqueia nem envia comando', () => {
    const plan = planConfirmedSave(input);

    expect(plan.blocked).toEqual([]);
    expect(plan.origin).toBeNull();
    expect(plan.bookmaker).toBeNull();
    expect(plan.tipster).toBeNull();
    expect(plan.dates).toEqual([]);
    expect(plan.patch.version).toBe(4);
    expect(plan.patch.tournament).toBe('Fixture');
  });

  it('aposta INCOMPLETA continua com os campos roteados pelo rascunho', () => {
    const plan = planConfirmedSave({
      ...input,
      completionState: 'incomplete',
      current: {
        ...baseline,
        stake: '250.00',
        bookmaker: '20000000-0000-4000-8000-000000000002',
      },
    });

    // Enquanto o registro não existe, é o PATCH que completa a aposta — por
    // isso valor e casa continuam graváveis neste caminho.
    expect(plan.blocked).toEqual([]);
    expect(plan.canonical).toBe(false);
    expect(plan.origin).toBeNull();
    expect(plan.bookmaker).toBeNull();
    expect(plan.dates).toEqual([]);
    expect(plan.patch.stake).toBe('250.00');
    expect(plan.patch.bookmakerId).toBe('20000000-0000-4000-8000-000000000002');
    expect(plan.patch.betOrigin).toBe('real');
    expect(plan.patch.version).toBe(4);
  });

  it('nomeia exatamente o que foi salvo e o que não foi em falha parcial', () => {
    const message = partialFailureMessage(['casa'], 'tipster', 'A aposta está liquidada.');

    expect(message).toContain('Salvo: casa.');
    expect(message).toContain('Não aplicado: tipster');
    expect(message).toContain('A aposta está liquidada.');
    expect(message).toContain('Mini App não foi fechado');
    expect(message).not.toMatch(/sucesso total|tudo foi salvo/i);
  });
});
