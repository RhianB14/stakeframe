import { describe, expect, it } from 'vitest';
import {
  betFinancialDisplay,
  journalNetEffect,
  centsLabel,
} from '../../apps/web/src/product/financial-display.js';

describe('betFinancialDisplay', () => {
  it('does not present an untouched open bet as a green profit', () => {
    expect(betFinancialDisplay({ state: 'open', returnAmount: '0.00', profit: '0.00' })).toEqual({
      returnText: '—',
      profitText: '—',
      qualifier: 'Não liquidado',
      tone: 'neutral',
    });
  });

  it('preserves positive cashout already realized while the bet remains open', () => {
    expect(betFinancialDisplay({ state: 'open', returnAmount: '65.00', profit: '25.00' })).toEqual({
      returnText: 'R$ 65,00',
      profitText: '+R$ 25,00',
      qualifier: 'Realizado parcialmente',
      tone: 'positive',
    });
  });

  it('preserves a partial loss, including after a settlement reversal reopens the bet', () => {
    expect(betFinancialDisplay({ state: 'open', returnAmount: '25.00', profit: '-15.00' })).toEqual(
      {
        returnText: 'R$ 25,00',
        profitText: '−R$ 15,00',
        qualifier: 'Realizado parcialmente',
        tone: 'negative',
      },
    );
  });

  it('keeps final wins and losses visible, with zero neutral', () => {
    expect(
      betFinancialDisplay({ state: 'settled', returnAmount: '200.00', profit: '100.00' }),
    ).toMatchObject({ qualifier: 'Realizado', tone: 'positive', profitText: '+R$ 100,00' });
    expect(
      betFinancialDisplay({ state: 'settled', returnAmount: '0.00', profit: '-100.00' }),
    ).toMatchObject({ qualifier: 'Realizado', tone: 'negative', profitText: '−R$ 100,00' });
    expect(
      betFinancialDisplay({ state: 'settled', returnAmount: '100.00', profit: '0.00' }),
    ).toMatchObject({ qualifier: 'Realizado', tone: 'neutral', profitText: 'R$ 0,00' });
  });

  it('does not color a cancelled zero as a win', () => {
    expect(
      betFinancialDisplay({ state: 'cancelled', returnAmount: '0.00', profit: '0.00' }),
    ).toMatchObject({ qualifier: 'Cancelada', tone: 'neutral' });
  });

  it('formats report values without the per-transaction money ceiling', () => {
    expect(
      betFinancialDisplay({
        state: 'settled',
        returnAmount: '1000000000000.00',
        profit: '1.00',
      }),
    ).toMatchObject({ returnText: 'R$ 1.000.000.000.000,00', profitText: '+R$ 1,00' });
  });
});

/**
 * STK-F2-18 (Fase 4) — o razão em tabela precisava de uma coluna de "efeito
 * líquido". A soma dos postings é a única leitura contábmente correta, e é
 * justamente a que um implementação ingênua erra: ler o primeiro posting de
 * uma transferência diria que a banca cresceu.
 */
describe('journalNetEffect', () => {
  const posting = (amount: string, accountName = 'conta') => ({
    accountId: '10000000-0000-4000-8000-00000000000a',
    accountName,
    amount,
  });

  it('nets a transfer between two own accounts to zero', () => {
    expect(journalNetEffect([posting('500.00', 'Betano'), posting('-500.00', 'Reserva')])).toBe(0n);
  });

  it('nets a deposit that moves money out of the reserve and into a bookmaker to zero', () => {
    // Um depósito entra no produto, mas sai da reserva: o efeito sobre a
    // BANCA é zero. A soma dos postings é o que separa "dinheiro chegou" de
    // "dinheiro apareceu", e o razão precisa mostrar a verdade contábil.
    expect(journalNetEffect([posting('2000.00', 'Betano'), posting('-2000.00', 'Reserva')])).toBe(
      0n,
    );
  });

  it('counts a balance confirmed directly on the reserve as a real increase', () => {
    expect(journalNetEffect([posting('2000.00', 'Reserva')])).toBe(200000n);
  });

  it('reads a bet stake as money leaving the bankroll', () => {
    expect(journalNetEffect([posting('-120.00', 'Betano')])).toBe(-12000n);
  });

  it('nets a settlement whose return and principal land on the same account', () => {
    // Liquidação: a casa credita o retorno e debita o principal fechado. O
    // efeito líquido é o lucro, não o retorno bruto.
    expect(journalNetEffect([posting('92.50', 'Betano'), posting('-50.00', 'Aposta')])).toBe(4250n);
  });

  it('sums exactly where float would not', () => {
    // 2^53 centavos = R$ 90.071.992,55. Acima disso `Number` perde unidade.
    const huge = journalNetEffect([posting('90071992.54'), posting('0.01')]);
    expect(huge).toBe(9007199255n);
  });

  it('treats an empty or cancelled-zero launch as no effect at all', () => {
    expect(journalNetEffect([])).toBe(0n);
    expect(journalNetEffect([posting('0.00'), posting('0.00')])).toBe(0n);
  });
});

describe('centsLabel', () => {
  it('formats with a thousands separator and two decimals, keeping the sign', () => {
    expect(centsLabel(200850n)).toBe('R$ 2.008,50');
    expect(centsLabel(-6000n)).toBe('−R$ 60,00');
    expect(centsLabel(0n)).toBe('R$ 0,00');
    expect(centsLabel(5n)).toBe('R$ 0,05');
  });
});
