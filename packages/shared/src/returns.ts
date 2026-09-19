// STK-G0-20 — aritmética decimal dos retornos por modalidade financeira.
// Fonte única (mensagem do Telegram, Mini App, Web e liquidação no servidor):
//   dinheiro real: valor × odd
//   freebet:       freebet × (odd − 1)   — o valor da freebet NÃO retorna
//   híbrida:       (valor real × odd) + (freebet × (odd − 1))
// Tudo em BigInt com arredondamento half-up em centavos.

export type BetOrigin = 'real' | 'freebet' | 'hibrida';

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const ODDS = /^\d{1,12}(\.\d{1,4})?$/;

const scale = (value: string, decimals: number) => {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(`${fraction}0000`.slice(0, decimals));
};

const formatScaled = (total: bigint) => {
  const whole = total / 100n;
  const fraction = (total % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
};

// stake (até 2 casas) × odds (até 4 casas) com arredondamento half-up em centavos.
export function grossReturn(stake: string, odds: string): string | null {
  if (!MONEY.test(stake) || !ODDS.test(odds)) return null;
  const cents = scale(stake, 2);
  const scaledOdds = scale(odds, 4);
  return formatScaled((cents * scaledOdds + 5000n) / 10000n);
}

// freebet: o valor apostado não retorna ao apostador — stake × (odd − 1).
export function freebetReturn(stake: string, odds: string): string | null {
  if (!MONEY.test(stake) || !ODDS.test(odds)) return null;
  const scaledOdds = scale(odds, 4) - 10_000n;
  if (scaledOdds < 0n) return null;
  return formatScaled((scale(stake, 2) * scaledOdds + 5000n) / 10000n);
}

export function addCents(left: string, right: string): string | null {
  if (!MONEY.test(left) || !MONEY.test(right)) return null;
  return formatScaled(scale(left, 2) + scale(right, 2));
}

// Metade de um valor em centavos, half-up (usada nas liquidações parciais).
export function halfCents(value: string): string | null {
  if (!MONEY.test(value)) return null;
  return formatScaled((scale(value, 2) + 1n) / 2n);
}

// Retorno potencial exibido/registrado conforme a modalidade declarada.
export function potentialReturnFor(
  origin: BetOrigin,
  stake: string,
  odds: string,
  freebetAmount: string | null,
): string | null {
  if (origin === 'real') return grossReturn(stake, odds);
  if (origin === 'freebet') return freebetReturn(stake, odds);
  if (freebetAmount === null) return null;
  const real = grossReturn(stake, odds);
  const bonus = freebetReturn(freebetAmount, odds);
  return real !== null && bonus !== null ? addCents(real, bonus) : null;
}

/**
 * Modalidade derivada do registro canônico: sem crédito ⇒ dinheiro real;
 * crédito com o MESMO valor da stake ⇒ freebet pura; crédito com valor
 * diferente ⇒ híbrida (valor real + freebet na mesma aposta).
 */
export function deriveBetOrigin(stake: string, freebetAmount: string | null): BetOrigin {
  if (freebetAmount === null) return 'real';
  return freebetAmount === stake ? 'freebet' : 'hibrida';
}

export type SettleAction = 'win' | 'loss' | 'void' | 'half_win' | 'half_loss';

/**
 * STK-G0-20 — valor de retorno calculado NO SERVIDOR para a liquidação pelo
 * teclado de status / Mini App. Convenções (registradas na devolutiva):
 * - win:      real = P×O; freebet = F×(O−1); híbrida = P×O + F×(O−1)
 * - loss:     0 em todas as modalidades
 * - void:     real = P (devolve o valor); freebet = 0; híbrida = P
 * - half_win: metade ganha + metade anulada —
 *             real = (P×O + P)/2; freebet = F×(O−1)/2; híbrida = (P×O + P + F×(O−1))/2
 * - half_loss: metade perdida + metade anulada — real = P/2; freebet = 0; híbrida = P/2
 * `principal` é o valor em aberto da aposta (remaining).
 */
export function settleReturnFor(
  action: SettleAction,
  origin: BetOrigin,
  principal: string,
  odds: string,
  freebetAmount: string | null,
): string | null {
  if (!MONEY.test(principal) || !ODDS.test(odds)) return null;
  const bonusAmount = origin === 'freebet' ? principal : freebetAmount;
  if (origin !== 'real' && bonusAmount === null) return null;
  const full =
    origin === 'real'
      ? grossReturn(principal, odds)
      : origin === 'freebet'
        ? freebetReturn(principal, odds)
        : potentialReturnFor('hibrida', principal, odds, bonusAmount);
  if (full === null) return null;
  switch (action) {
    case 'win':
      return full;
    case 'loss':
      return '0.00';
    case 'void':
      return origin === 'freebet' ? '0.00' : principal;
    case 'half_win': {
      const refund = origin === 'freebet' ? '0.00' : principal;
      const total = addCents(full, refund);
      return total === null ? null : halfCents(total);
    }
    case 'half_loss':
      return origin === 'freebet' ? '0.00' : halfCents(principal);
  }
}
