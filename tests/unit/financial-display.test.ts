import { describe, expect, it } from 'vitest';
import { betFinancialDisplay } from '../../apps/web/src/product/financial-display.js';

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
