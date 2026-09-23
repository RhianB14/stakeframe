import { formatReportBRL, type Bet } from '@stakeframe/shared';

type FinancialSnapshot = {
  state: Bet['state'];
  // Both individual bets and report rows use decimal strings, but report values
  // may exceed the per-transaction ceiling.
  returnAmount: string;
  profit: string;
};

export type FinancialDisplay = {
  returnText: string;
  profitText: string;
  qualifier: 'Não liquidado' | 'Realizado parcialmente' | 'Realizado' | 'Cancelada';
  tone: 'neutral' | 'positive' | 'negative';
};

/** Presentation only: the server remains the source of all monetary values. */
export function betFinancialDisplay(bet: FinancialSnapshot): FinancialDisplay {
  // An open bet can already contain a partial cashout. Never hide that realized amount.
  const hasRealization = Number(bet.returnAmount) !== 0 || Number(bet.profit) !== 0;
  if (bet.state === 'open' && !hasRealization) {
    return {
      returnText: '—',
      profitText: '—',
      qualifier: 'Não liquidado',
      tone: 'neutral',
    };
  }

  const profit = Number(bet.profit);
  const formattedProfit = formatReportBRL(bet.profit);
  return {
    returnText: formatReportBRL(bet.returnAmount),
    profitText: profit > 0 ? `+${formattedProfit}` : formattedProfit,
    qualifier:
      bet.state === 'open'
        ? 'Realizado parcialmente'
        : bet.state === 'cancelled'
          ? 'Cancelada'
          : 'Realizado',
    tone: profit === 0 ? 'neutral' : profit < 0 ? 'negative' : 'positive',
  };
}
