import { describe, expect, it } from 'vitest';
import {
  MIN_CHART_SAMPLE,
  axisTick,
  chartHasSample,
  lowChartSampleMessage,
  resultDomain,
} from '../../apps/web/src/product/chart-domain.js';

/**
 * STK-F3-03 — o eixo Y e o piso de amostra do gráfico de resultado.
 *
 * Estes testes existem por um defeito específico: o padrão de gráfico
 * reproduzido aqui começa o eixo em zero porque desenha ACÚMULO DE SALDO,
 * que nunca é negativo. Resultado realizado do período pode ser negativo, e
 * aplicar a mesma escala produz um gráfico que mente sobre o sinal — a
 * classe de defeito mais cara que um produto de contabilidade pode ter.
 */
describe('escala do eixo Y (STK-F3-03)', () => {
  it('sem valor negativo, começa em zero como o padrão', () => {
    const [min] = resultDomain([0, 100, 250]);
    expect(min).toBe(0);
    const [, max] = resultDomain([0, 100, 250]);
    expect(max).toBeGreaterThanOrEqual(250);
  });

  it('com valor negativo, o domínio INCLUI o zero — o sinal não pode mentir', () => {
    /* A regressão que este teste existe para impedir: com mínimo
       automático, esta série (-40 a -10) sairia desenhada num domínio
       [-10, -40], e o Recharts a renderizaria como uma linha que SOBE. */
    const [min, max] = resultDomain([-40, -25, -10]);
    expect(min).toBeLessThanOrEqual(-40);
    expect(max, 'o zero precisa estar dentro da janela visível').toBeGreaterThanOrEqual(0);
  });

  it('uma série que cruza o zero mantém os dois lados', () => {
    const [min, max] = resultDomain([-120, 60, 30]);
    expect(min).toBeLessThanOrEqual(-120);
    expect(max).toBeGreaterThanOrEqual(60);
  });

  it('série toda negativa não encolhe o topo abaixo de zero', () => {
    const [min, max] = resultDomain([-500, -300]);
    expect(min).toBeLessThanOrEqual(-500);
    expect(max).toBeGreaterThanOrEqual(0);
  });

  it('não quebra com série vazia, zerada ou com NaN', () => {
    for (const input of [[], [0], [Number.NaN, Number.NaN], [10, Number.NaN]]) {
      const [min, max] = resultDomain(input);
      expect(Number.isFinite(min), JSON.stringify(input)).toBe(true);
      expect(Number.isFinite(max), JSON.stringify(input)).toBe(true);
      expect(max).toBeGreaterThan(min);
    }
  });

  it('o rótulo do eixo sai em pt-BR, sem casa decimal inútil', () => {
    expect(axisTick(1000)).toBe('1.000');
    expect(axisTick(-2500)).toBe('-2.500');
    expect(axisTick(0)).toBe('0');
  });
});

describe('piso de amostra do gráfico (STK-F3-03)', () => {
  it('abaixo do piso o gráfico NÃO é desenhado', () => {
    /* A regra do produto: a biblioteca desenha 1 ponto com a mesma
       confiança com que desenha 30, e o resultado é uma forma que não
       existe. Recusar é a resposta honesta. */
    expect(MIN_CHART_SAMPLE).toBe(4);
    for (const days of [0, 1, 2, 3]) expect(chartHasSample(days), `${days} dias`).toBe(false);
    for (const days of [4, 5, 30]) expect(chartHasSample(days), `${days} dias`).toBe(true);
  });

  it('a mensagem diz o motivo e não só reporta o número', () => {
    const one = lowChartSampleMessage(1);
    expect(one).toContain('1 dia com apostas');
    expect(one).toContain(`abaixo de ${MIN_CHART_SAMPLE}`);
    // A razão é o que separa uma recusa explicada de um erro.
    expect(one).toContain('forma inventada');
    expect(lowChartSampleMessage(3)).toContain('3 dias com apostas');
  });
});
