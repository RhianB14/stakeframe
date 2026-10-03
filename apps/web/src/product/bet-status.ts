import { betResultLabel, type Bet } from '@stakeframe/shared';

/**
 * STK-F3-02 — a cor do status na tabela de apostas.
 *
 * POR QUE ISTO EXISTE SEPARADO DE `pages.tsx`
 *
 * O `bet.state` tem TRÊS valores (open, settled, cancelled) e não diz o que
 * aconteceu com o dinheiro. A coluna "Resultado/status" mostra o resultado
 * canônico — Ganha, Perdida, Reembolso, Cancelada, Pendente — e são esses
 * rótulos, não os três estados, que a pessoa lê para decidir o que fazer com a
 * aposta. Colorir pelo `bet.state` pintava de cinza uma aposta ganha, que é a
 * informação mais importante da linha.
 *
 * As quatro famílias e o que cada uma significa, sem ambiguidade:
 *
 * - `pos`   Ganha / Meio-Ganha. A aposta foi ganha no todo ou em parte.
 * - `neg`   Perdida / Meio-Perdida. A aposta foi perdida no todo ou em parte.
 * - `warn`  Em aberto / Pendente. Ainda pode virar qualquer coisa: é o estado
 *           que pede ação, e cinza esconderia isso.
 * - `void`  Anulada / Reembolso / Cancelada. O bilhete não vale mais, e a
 *           distinção entre essas três rotinas é textual — quem precisa
 *           saber qual delas aconteceu lê o rótulo.
 *
 * `void` é uma família só, e não uma cor própria: ela não compete com o
 * dinheiro. Um reembolso é a ausência de resultado, não um sinal.
 *
 * R2 — unknown != zero
 *
 * `warn` é o estado de quem NÃO CONHECE o resultado ainda. É por isso que
 * aposta pendente não é `void`: "não sei" e "não vale mais" são coisas
 * diferentes, e pintá-las igual é a mesma mentira que trocar uma por zero.
 *
 * Meia-ganha e meia-perdida são subclasses, não estados novos: `half_win`
 * pertence a `pos` e `half_loss` a `neg`, porque quem leu "Meio-Ganha" e
 * quem leu "Ganha" precisam saber a mesma coisa — que sobrou dinheiro.
 */

export type BetStatusTone = 'pos' | 'neg' | 'warn' | 'void';

/** Outcomes parciais herdam a família do resultado cheio. */
const outcomeTones: Record<NonNullable<Bet['latestOutcome']>, BetStatusTone> = {
  win: 'pos',
  half_win: 'pos',
  loss: 'neg',
  half_loss: 'neg',
  cashout: 'pos',
  partial_cashout: 'pos',
  void: 'void',
};

/**
 * A família de cor de uma aposta, derivada do RESULTADO registrado.
 *
 * A ordem das decisões é a que separa "não sei" de "não vale mais":
 *
 * 1. Resultado registrado vence tudo. Cashout é `pos` porque devolveu
 *    dinheiro, mesmo com a aposta ainda em aberto — o qualifier
 *    "Ainda em aberto" continua visível ao lado.
 * 2. Sem resultado e `cancelled`: o registro foi anulado. É `void`, e não
 *    `neg`, porque perda e cancelamento têm consequências contábeis
 *    diferentes e a cor não pode dizer que foi dinheiro perdido.
 * 3. Sem resultado e `settled`: liquidou sem outcome conhecido. Fica em
 *    `warn` — desconhecido, não nulo. Um `void` afirmaria que o bilhete não
 *    valia, que é uma afirmação que ninguém fez.
 * 4. Sem resultado e `open`: `warn`. É a aposta em curso, e é a que pede
 *    ação.
 */
export function betStatusTone(bet: Pick<Bet, 'state' | 'latestOutcome'>): BetStatusTone {
  if (bet.latestOutcome) return outcomeTones[bet.latestOutcome];
  if (bet.state === 'cancelled') return 'void';
  return 'warn';
}

/** Rótulo canônico do resultado, para a tag. */
export function betStatusLabel(bet: Pick<Bet, 'state' | 'latestOutcome'>): string {
  return betResultLabel(bet);
}

/**
 * Uma aposta liquidada SEM resultado registrado é um estado que a tela de
 * apostas não pode deixar passar em silêncio: o dinheiro foi movimentado e
 * ninguém sabe por quê. A tabela mostra "Liquidada" e a cor `warn`, e esta
 * função diz à interface que há algo a conferir.
 */
export function betStatusNeedsReview(bet: Pick<Bet, 'state' | 'latestOutcome'>): boolean {
  return bet.state === 'settled' && !bet.latestOutcome;
}
