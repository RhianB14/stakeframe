import { describe, expect, it } from 'vitest';
import type { Bet } from '../../packages/shared/src/index.js';
import {
  betStatusLabel,
  betStatusNeedsReview,
  betStatusTone,
} from '../../apps/web/src/product/bet-status.js';

/**
 * STK-F3-02 — a cor do status na tabela de apostas.
 *
 * O que estes testes impedem, e por que cada caso existe:
 *
 * A regra que mais importa aqui NÃO é "qual cor é bonita". É que
 * `unknown != zero` também vale para COR: uma aposta cujo resultado
 * ninguém sabe não pode ser pintada como se soubesse. O caso `settled`
 * sem `latestOutcome` é o que fixa isso, e é o primeiro teste abaixo de
 * propósito — ele é a razão de o módulo existir separado do CSS.
 */

const bet = (overrides: Partial<Pick<Bet, 'state' | 'latestOutcome'>> = {}) =>
  ({
    state: 'open',
    latestOutcome: null,
    ...overrides,
  }) as Pick<Bet, 'state' | 'latestOutcome'>;

describe('status da aposta (STK-F3-02)', () => {
  it('R2: liquidada sem resultado registrado é desconhecido, não anulada', () => {
    /* O caso que justifica o módulo. `state: 'settled'` sem
       `latestOutcome` significa que o dinheiro foi movimentado e ninguém
       registrou por quê. A tabela mostra "Liquidada" e a cor `warn`.

       Se isto fosse `void`, a linha diria que o bilhete não valia mais —
       que é uma afirmação que NINGUÉM fez. E se fosse `pos` ou `neg`,
       inventaria resultado. `warn` é a única cor que não afirma. */
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: null }))).toBe('warn');
    expect(betStatusNeedsReview(bet({ state: 'settled', latestOutcome: null }))).toBe(true);
  });

  it('uma aposta ganha é `pos` e uma perdida é `neg` — o state não decide', () => {
    /* As duas são `state: 'settled'`. Se a cor viesse do `state`, as duas
       cairiam na mesma classe e a linha mais importante da tabela — o
       resultado — seria visualmente idêntica. */
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: 'win' }))).toBe('pos');
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: 'loss' }))).toBe('neg');
    expect(betStatusTone(bet({ state: 'open', latestOutcome: 'win' }))).toBe('pos');
    expect(betStatusTone(bet({ state: 'open', latestOutcome: 'loss' }))).toBe('neg');
  });

  it('meio-ganha e meio-perdida herdam a família do resultado cheio', () => {
    /* `half_win` não é uma aposta ganha: é uma aposta em que sobrou
       dinheiro. A pessoa que leu "Meio-Ganha" e a que leu "Ganha" precisam
       da mesma resposta à pergunta "o dinheiro voltou?" — sim. Separate-as
       em uma quinta cor e a tabela ganha uma cor que ninguém sabe ler. */
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: 'half_win' }))).toBe('pos');
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: 'half_loss' }))).toBe('neg');
  });

  it('anulada, cancelada e reembolso são `void` — ausência, não sinal', () => {
    /* Um reembolso é a ausência de resultado, e a cor precisa dizer
       isso: `neg` diria que o dinheiro foi perdido, que é falso — ele foi
       devolvido. As três são a mesma família, e a diferença entre elas é
       textual (o rótulo canônico diz qual das três aconteceu). */
    expect(betStatusTone(bet({ state: 'settled', latestOutcome: 'void' }))).toBe('void');
    expect(betStatusTone(bet({ state: 'cancelled', latestOutcome: null }))).toBe('void');
  });

  it('cancelar NÃO é perder: as duas cores precisam ser diferentes', () => {
    /* Perda e cancelamento têm consequências contábeis opostas, e é a
       cor que a pessoa lê de relance na tabela. Pintar os dois de vermelho
       faria uma aposta anulada parecer dinheiro perdido. */
    expect(betStatusTone(bet({ state: 'cancelled', latestOutcome: null }))).not.toBe(
      betStatusTone(bet({ state: 'settled', latestOutcome: 'loss' })),
    );
  });

  it('em aberto é `warn` — é o estado que pede ação', () => {
    /* A aposta em curso é a única que ainda pode virar qualquer coisa, e
       é a única que pede decisão. Cinza esconderia isso, que é o
       contrário do que a cor deve fazer. */
    expect(betStatusTone(bet({ state: 'open', latestOutcome: null }))).toBe('warn');
  });

  it('cashout é `pos` mesmo com a aposta ainda em aberto', () => {
    /* Cashout devolveu dinheiro. A aposta continua `open` — o qualifier
       "Ainda em aberto" continua visível ao lado — e mesmo assim houve
       realização, que é o que a cor precisa dizer. `warn` aqui diria que
       nada aconteceu, e a cor é o que a pessoa lê antes de clicar. */
    expect(betStatusTone(bet({ state: 'open', latestOutcome: 'cashout' }))).toBe('pos');
    expect(betStatusTone(bet({ state: 'open', latestOutcome: 'partial_cashout' }))).toBe('pos');
  });

  it('o rótulo é sempre o canônico, e nunca some', () => {
    /* A cor é apresentação; o texto é o contrato. Toda combinação
       produz um rótulo não vazio, e nenhum estado vira célula em branco. */
    for (const sample of [
      bet({ state: 'open', latestOutcome: null }),
      bet({ state: 'settled', latestOutcome: null }),
      bet({ state: 'cancelled', latestOutcome: null }),
      bet({ state: 'settled', latestOutcome: 'win' }),
      bet({ state: 'settled', latestOutcome: 'loss' }),
      bet({ state: 'settled', latestOutcome: 'void' }),
      bet({ state: 'open', latestOutcome: 'partial_cashout' }),
    ]) {
      expect(betStatusLabel(sample)).not.toBe('');
      expect(betStatusLabel(sample)).not.toBe('—');
    }
  });

  it('só a liquidada sem resultado pede revisão', () => {
    expect(betStatusNeedsReview(bet({ state: 'settled', latestOutcome: null }))).toBe(true);
    for (const sample of [
      bet({ state: 'open', latestOutcome: null }),
      bet({ state: 'open', latestOutcome: 'partial_cashout' }),
      bet({ state: 'cancelled', latestOutcome: null }),
      bet({ state: 'settled', latestOutcome: 'win' }),
      bet({ state: 'settled', latestOutcome: 'void' }),
    ]) {
      expect(betStatusNeedsReview(sample)).toBe(false);
    }
  });

  it('toda combinação de state e outcome cai numa das quatro famílias', () => {
    /* Fecha o espaço: nenhuma combinação pode ficar sem cor, porque uma
       tag sem cor é uma linha sem status — que é o defeito que a tela
       precisa não ter. A lista é o domínio inteiro de `latestOutcome`. */
    const outcomes: NonNullable<Bet['latestOutcome']>[] = [
      'win',
      'loss',
      'void',
      'half_win',
      'half_loss',
      'cashout',
      'partial_cashout',
    ];
    const states: Bet['state'][] = ['open', 'settled', 'cancelled'];
    for (const state of states) {
      for (const latestOutcome of [...outcomes, null]) {
        expect(['pos', 'neg', 'warn', 'void']).toContain(
          betStatusTone(bet({ state, latestOutcome })),
        );
      }
    }
  });
});
