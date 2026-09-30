import {
  POLYMARKET_CATEGORY_LABELS,
  POLYMARKET_ORDER_LABELS,
  POLYMARKET_PERIOD_LABELS,
  formatExactDecimal,
  type PolymarketSimulation,
  type SimulationPremise,
} from '@stakeframe/shared';

/**
 * STK-F2-17 — a apresentação da simulação MERAMENTE INDICATIVA.
 *
 * Este módulo é PURO e testável sem navegador: ele devolve a VIEW MODEL
 * (rótulos e textos) que o componente renderiza, no mesmo padrão de
 * `ranking-view`. A separação existe por um motivo concreto: as três regras
 * do card — premissas sempre visíveis, recusa com dados incompletos, e
 * retorno nunca apresentado como executável — são verificáveis em testes de
 * função, sem browser.
 *
 * A ORDEM DE LEITURA da tela é decidida aqui e é a decisão mais importante do
 * módulo:
 *
 *  1. O QUE ISTO É (indicativa, não executável) — antes de qualquer número.
 *  2. A COBERTURA e, se houver, a RECUSA com o motivo e o remédio.
 *  3. AS SETE PREMISSAS — antes do número, sempre, nos dois desfechos.
 *  4. O NÚMERO — e, quando recusado, não há número.
 *  5. OS AVISOS de jogo responsável.
 *
 * A premissa vem ANTES do número porque um número lido sem a ressalva que o
 * limita é um número que já foi mal interpretado; e a natureza indicativa vem
 * ANTES da premissa porque a premissa explica um cálculo, e o cálculo só
 * importa depois de se saber que ele não vira ordem.
 *
 * O que este módulo NÃO faz, por decisão do card: não calcula, não
 * arredonda, não sugere stake, não recomenda entrada ou saída, não compara
 * estratégias e não ordena nada. Nenhum campo aqui é um derivado que o
 * servidor não mandou.
 */

/** Uma premissa pronta para exibição. */
export type SimulationPremiseView = {
  key: SimulationPremise['key'];
  label: string;
  value: string;
  /**
   * O rótulo da ORIGEM da premissa, e ele é o que impede a tela de tratar
   * hipótese como medição: `configured` é o que o usuário escolheu,
   * `measured` é o que a coleta observou, `declared` é o limite que nós
   * declaramos.
   */
  origin: string;
  note: string;
};

/** O número indicativo, já rotulado. */
export type SimulationNumberView = {
  stake: string;
  observations: string;
  ratio: string;
  gross: string;
  fee: string;
  spread: string;
  slippage: string;
  friction: string;
  band: string;
  net: string;
  negative: boolean;
  /** O que a tela escreve sobre a faixa, e por que ela não é descontada. */
  bandNote: string;
};

export type SimulationView = {
  title: string;
  /**
   * A natureza da saída, PRIMEIRA linha da tela e nunca removível. A palavra
   * "indicativa" e a frase "não é executável" são o que o card exige e o que
   * o texto de jogo responsável (§4.9) exige.
   */
  nature: string;
  /** A etiqueta que acompanha o número em qualquer contexto. */
  natureLabel: string;
  /** O rótulo da cobertura, com o detalhe da completude gravada. */
  coverageLabel: string;
  coverageDetail: string;
  /** `N`, o limiar e o estado de baixa amostra. */
  sample: string;
  /** A recusa, ou `null` quando a simulação foi apurada. */
  refusal: { label: string; reason: string; remedy: string } | null;
  /** AS SETE PREMISSAS, sempre. */
  premises: SimulationPremiseView[];
  /** O número, ou `null` quando recusada. */
  indicative: SimulationNumberView | null;
  /** OS AVISOS, sempre, e nunca vazios. */
  disclaimers: string[];
  /** O texto do estado sem número — nunca "resultado zero". */
  emptyTitle: string;
  emptyDetail: string;
  /** A frase de rodapé que afirma o que a saída NÃO é. */
  footnote: string;
};

const ORIGIN_LABEL: Record<SimulationPremise['kind'], string> = {
  configured: 'Escolhido por você',
  measured: 'Medido pela coleta',
  declared: 'Declarado pelo limite',
};

/** As premissas na ordem do motor, com a origem traduzida. */
export function simulationPremiseViews(
  premises: readonly SimulationPremise[],
): SimulationPremiseView[] {
  return premises.map((premise) => ({
    key: premise.key,
    label: premise.label,
    value: premise.value,
    origin: ORIGIN_LABEL[premise.kind],
    note: premise.note,
  }));
}

/**
 * O NÚMERO, e ele nunca aparece sozinho.
 *
 * `formatExactDecimal` é a MESMA função que a tela do ranking usa, pelo mesmo
 * motivo: o valor volta do banco como `numeric(38, 18)` e é exibido sem
 * arredondar. Arredondar aqui seria uma segunda medida — e a segunda medida
 * é a que o card proíbe.
 *
 * O líquido é o ÚNICO número que a tela destaca, e ele vem com o sinal para a
 * cor. O bruto vem nomeado `grossBeforePremises` no servidor e aparece
 * rotulado como "antes das premissas", porque um número chamado "ganho" que
 * não teve taxa, spread, slippage nem dado faltante descontados seria a
 * mentira que este card existe para evitar.
 */
export function simulationNumberView(
  simulation: PolymarketSimulation,
): SimulationNumberView | null {
  const result = simulation.indicative;
  if (!result) return null;
  return {
    stake: formatExactDecimal(result.stake),
    observations: `${result.observations}`,
    ratio: result.publishedRatio,
    gross: formatExactDecimal(result.grossBeforePremises),
    fee: formatExactDecimal(result.feeCost),
    spread: formatExactDecimal(result.spreadCost),
    slippage: formatExactDecimal(result.slippageCost),
    friction: formatExactDecimal(result.totalFrictionCost),
    band: formatExactDecimal(result.missingDataBand),
    net: formatExactDecimal(result.netAfterPremises),
    negative: result.negative,
    bandNote:
      'A faixa é a magnitude do que a lacuna de dados representa, calculada sobre o bruto. ' +
      'Ela NÃO é descontada porque o sinal do dado que falta é desconhecido: subtrair com ' +
      'sinal presumido publicaria uma precisão que não existe.',
  };
}

/**
 * A view completa, e a ordem das decisões é o card inteiro.
 *
 * Primeiro a natureza da saída, porque é ela que muda a leitura de todo o
 * resto. Depois a cobertura, que vem GRAVADA e nunca da contagem. Depois a
 * recusa, quando existe — e ela sempre traz o QUE FAZER, porque uma recusa
 * sem remédio é uma parede. Só então as premissas e o número.
 *
 * O estado SEM número nunca diz "zero": `truncated` com 40 observações não é
 * um resultado de zero, é uma ausência de apuração, e a frase diz isso.
 */
export function simulationView(simulation: PolymarketSimulation): SimulationView {
  const categoryLabel = POLYMARKET_CATEGORY_LABELS[simulation.window.category];
  const periodLabel = POLYMARKET_PERIOD_LABELS[simulation.window.timePeriod];
  const orderLabel = POLYMARKET_ORDER_LABELS[simulation.window.orderBy];
  const coverage = simulation.coverage;
  const refused = simulation.refusal.refused;

  return {
    title: `Simulação indicativa · ${categoryLabel}`,
    nature:
      'Simulação indicativa sobre dados que a Polymarket já publicou. Este número é ' +
      'aritmético, não é previsão, não é cotação e não é resultado de operação: nada foi ' +
      'apostado e nenhuma ordem pode sair daqui.',
    natureLabel: 'INDICATIVA · NÃO EXECUTÁVEL',
    coverageLabel: coverage.completeness.label,
    coverageDetail: coverage.completeness.detail,
    sample: `N = ${coverage.n} ${coverage.n === 1 ? 'observação' : 'observações'} · mínimo ${coverage.minSample}`,
    refusal: refused
      ? {
          label: 'Simulação recusada',
          reason: simulation.refusal.reason ?? 'A cobertura necessária está incompleta.',
          remedy: simulation.refusal.remedy ?? 'Aguarde a coleta fechar a cobertura desta janela.',
        }
      : null,
    premises: simulationPremiseViews(simulation.premises),
    indicative: simulationNumberView(simulation),
    disclaimers: [...simulation.disclaimers],
    emptyTitle: refused ? 'Nenhum número apurado' : 'Nada a exibir',
    emptyDetail: refused
      ? (simulation.refusal.reason ??
        'A cobertura necessária está incompleta, e a simulação não apura sobre cobertura parcial.')
      : 'A apuração não produziu número para as premissas informadas.',
    footnote:
      `Janela: ${orderLabel} de ${periodLabel.toLowerCase()}, categoria ${categoryLabel}. ` +
      'Nenhum valor desta tela é executável, nenhum retorno é prometido e nenhuma estratégia ' +
      'é sugerida. Apostar envolve risco de perda de dinheiro; simular não reduz esse risco.',
  };
}
