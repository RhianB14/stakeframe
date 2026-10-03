/**
 * STK-F3-03 — a escala do eixo Y do gráfico de resultado realizado.
 *
 * O padrão reproduzido (o `AreaChart` do SharkTrack) começa o eixo em R$ 0
 * porque a série que ele desenha é um ACÚMULO DE SALDO: sempre positiva, e
 * subir do zero é o que dá sentido à distância entre a linha e o chão.
 *
 * Aqui a série é o resultado realizado do período, e resultado realizado
 * PODE SER NEGATIVO. Aplicar a mesma escala aqui produz o pior tipo de
 * mentira num gráfico: com o mínimo automático, uma série que vai de
 * -R$ 40 a -R$ 10 é desenhada como se estivesse SUBINDO, e o leitor lê
 * ganho onde houve prejuízo. A área preenchida agrava isso, porque a altura
 * do preenchimento deixa de ter qualquer relação com o sinal.
 *
 * Por isso a regra é: se houver valor negativo, o domínio inclui o zero
 * SEMPRE; se não houver, começa no zero como o padrão faz. Não é
 * preferência — é o que impede o gráfico de mentir sobre o sinal.
 */

/** Domínio do eixo Y para uma série de valores em reais (já fracionários). */
export function resultDomain(values: number[]): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [0, 1];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  // Série negativa (ou que toca o zero): o zero é uma referência de sinal,
  // então ele precisa estar dentro da janela, não nas bordas.
  if (min < 0) {
    /* `max` pode ser menor que zero (série toda negativa), e nesse caso a
       janela precisa SUBIR até o zero — não basta incluir o zero como
       extremo, ele tem de ser VISÍVEL. Sem este `if`, uma série de -40 a
       -10 sai com domínio [-40, -10] e volta a mentir sobre o sinal,
       que é o defeito que esta função existe para impedir. */
    return [min, Math.max(max, 0)];
  }
  // Sem valor negativo: começa em zero, como o padrão do SharkTrack.
  const headroom = max * 0.1;
  return [0, max + (headroom > 0 ? headroom : 1)];
}

/** Uma cota do eixo Y arredondada a um número "redondo", para o rótulo ler bem. */
export function axisTick(value: number): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** O gráfico só deve ser desenhado a partir deste número de dias observados. */
export const MIN_CHART_SAMPLE = 4;

/** A amostra é suficiente para o desenho do gráfico? */
export function chartHasSample(observedDays: number): boolean {
  return observedDays >= MIN_CHART_SAMPLE;
}

/**
 * A mensagem do piso de amostra.
 *
 * Este texto é uma REGRA DO PRODUTO, não um placeholder: abaixo do piso o
 * produto se recusa a desenhar o gráfico e diz por quê. A biblioteca
 * desen happily 1 ponto — e um gráfico com 1 ponto é uma forma desenhada a
 * partir de nenhuma observação, que é pior do que não ter gráfico.
 */
export function lowChartSampleMessage(observedDays: number): string {
  return `Apenas ${observedDays} ${
    observedDays === 1 ? 'dia com apostas' : 'dias com apostas'
  } no mês — abaixo de ${MIN_CHART_SAMPLE}, o gráfico seria uma forma inventada. Os números acima são o resultado.`;
}
