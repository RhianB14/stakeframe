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

/** Um lançamento de razão: uma conta sendo debitada ou creditada. */
export type JournalPosting = { accountId: string; accountName: string; amount: string };

/**
 * STK-F2-18 (Fase 4) — efeito líquido de um lançamento sobre a banca, em
 * CENTAVOS (`bigint`).
 *
 * Por que a soma, e não o primeiro posting: uma transferência de R$ 500,00
 * entre duas contas da mesma banca produz `+500,00` numa conta e `−500,00` em
 * outra. A soma é zero — que é a verdade contábil. Ler o primeiro posting
 * diria que a banca cresceu R$ 500,00, e essa é exatamente a leitura que faz
 * uma pessoa conciliar errado e concluir que o sistema mente.
 *
 * Por que `bigint`: somar dinheiro em `Number` perde precisão acima de 2^53
 * centavos. O resto do produto já trata valor em `bigint`; uma coluna que
 * quebrasse essa regra seria a única exceção.
 */
export function journalNetEffect(postings: readonly JournalPosting[]): bigint {
  let total = 0n;
  for (const posting of postings) {
    const negative = posting.amount.startsWith('-');
    const cents = BigInt(posting.amount.replace(/^-/, '').replace('.', ''));
    total += negative ? -cents : cents;
  }
  return total;
}

/** Centavos com sinal, no mesmo formato de `formatReportBRL`. */
export function centsLabel(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '−' : ''}R$ ${whole.toLocaleString('pt-BR')},${fraction}`;
}
