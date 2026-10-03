import { describe, it, expect } from 'vitest';
import {
  cents,
  formatBRL,
  formatBRLWhenPresent,
  money,
  normalizeDecimalInput,
  positiveMoneySchema,
} from '../../packages/shared/src/index.js';

// STK-UX-DADOS — os dois defeitos de DADO da auditoria de UX.
//
// 1) Vírgula decimal: a entrada do produto é pt-BR (teclado BR) e o registro
//    canônico é en-US. A normalização acontece ANTES de validar, então nenhum
//    regex do servidor precisou ser afrouxado.
// 2) unknown ≠ zero (R2): dado ausente é "Sem base", nunca R$ 0,00.
describe('entrada decimal pt-BR normaliza para o canônico', () => {
  it('trata as formas de escrever o MESMO valor como o mesmo número', () => {
    // O card pede que "200,50", "200.50" e "R$ 200,50" (com o símbolo) sejam
    // equivalentes na entrada e produzam o mesmo valor interno. "200" e
    // "1.000,00" são OUTROS valores e aparecem nos seus próprios casos abaixo
    // — todos eles válidos na entrada.
    const expected = cents('200.50');
    for (const written of ['200,50', '200.50', 'R$ 200,50', 'R$200,50', '200,5', ' 200,50 ']) {
      const decimal = normalizeDecimalInput(written);
      expect(decimal, `entrada: ${written}`).not.toBeNull();
      expect(cents(decimal!), `entrada: ${written}`).toBe(expected);
    }
  });

  it('aceita o inteiro e o milhar pt-BR como os valores que são', () => {
    // "200" é R$ 200,00 e "1.000,00" é R$ 1.000,00: entradas distintas, valores
    // distintos — normalizadas, nunca recusadas por serem inteiras/milhares.
    expect(normalizeDecimalInput('200')).toBe('200');
    expect(cents(normalizeDecimalInput('200')!)).toBe(20000n);
    expect(normalizeDecimalInput('1.000,00')).toBe('1000.00');
    expect(cents(normalizeDecimalInput('1.000,00')!)).toBe(100000n);
  });

  it('formata o valor canônico de volta para exibição', () => {
    expect(money(cents(normalizeDecimalInput('R$ 1.000,50')!))).toBe('1000.50');
    expect(formatBRL(normalizeDecimalInput('1.000,50')!)).toBe('R$ 1.000,50');
  });

  it('aceita o valor canônico que o produto já enviava (en-US)', () => {
    // Regressão: a normalização nova não pode quebrar o caminho que já
    // funcionava no web (decimalInput sobre "25.50").
    expect(normalizeDecimalInput('25.50')).toBe('25.50');
    expect(normalizeDecimalInput('0.00')).toBe('0.00');
  });

  it('recusa o que é ambíguo em vez de adivinhar (fail-closed, R3)', () => {
    // "1.000" sem vírgula é ambíguo entre R$ 1,00 e R$ 1.000,00 — em um
    // registro financeiro o pior erro é o silencioso.
    expect(normalizeDecimalInput('1.000')).toBeNull();
    expect(normalizeDecimalInput('')).toBeNull();
    expect(normalizeDecimalInput('   ')).toBeNull();
    expect(normalizeDecimalInput('abc')).toBeNull();
    expect(normalizeDecimalInput('200,50,00')).toBeNull();
    expect(normalizeDecimalInput('200,555')).toBeNull();
  });

  it('preserva o limite de centavos do domínio', () => {
    // 3 casas decimais não são dinheiro: moneySchema é de 2 casas.
    expect(normalizeDecimalInput('200,555')).toBeNull();
  });

  it('usa a escala da odd (4 casas) só onde a odd permite', () => {
    expect(normalizeDecimalInput('1,80', 4)).toBe('1.80');
    expect(normalizeDecimalInput('1.8000', 4)).toBe('1.8000');
    expect(normalizeDecimalInput('1,80000', 4)).toBeNull();
  });
});

describe('a normalização não afrouxa o schema do servidor', () => {
  it('o schema continua recusando zero como valor positivo', () => {
    // closedPrincipal é positiveMoneySchema: o domínio NUNCA aceita R$ 0,00
    // como principal encerrado. É por isso que o card está certo em não
    // gravar 0.00 — e é por isso que a correção foi no formulário.
    expect(positiveMoneySchema.safeParse('0.00').success).toBe(false);
    expect(positiveMoneySchema.safeParse('0.01').success).toBe(true);
  });

  it('a string pt-BR crua continua inválida para o schema (a normalização é o filtro)', () => {
    expect(positiveMoneySchema.safeParse('200,50').success).toBe(false);
    // ...e o que a normalização entrega passa.
    expect(positiveMoneySchema.safeParse(normalizeDecimalInput('200,50')!).success).toBe(true);
  });
});

describe('R2: dado ausente é "Sem base", nunca R$ 0,00', () => {
  it('ausente não vira R$ 0,00 na exibição', () => {
    expect(formatBRLWhenPresent(null)).toBe('Sem base');
    expect(formatBRLWhenPresent(undefined)).toBe('Sem base');
    // O defeito: formatBRL(bet.stake ?? '0.00') mostrava R$ 0,00 para uma
    // aposta SEM valor registrado — o zero parecia um dado real.
    expect(formatBRL('0.00')).toBe('R$ 0,00');
  });

  it('presente continua formatado normalmente', () => {
    expect(formatBRLWhenPresent('200.50')).toBe('R$ 200,50');
    expect(formatBRLWhenPresent('0.00')).toBe('R$ 0,00');
  });

  it('aceita um rótulo próprio quando a tela pede outra palavra', () => {
    // A lista de apostas já usa "Unidade a conferir" para a unidade ausente;
    // o mesmo formato serve onde "Sem base" soaria estranho.
    expect(formatBRLWhenPresent(null, 'A conferir')).toBe('A conferir');
  });
});
