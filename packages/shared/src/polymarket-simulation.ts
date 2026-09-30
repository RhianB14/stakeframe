import { z } from 'zod';
import {
  LEADERBOARD_ORDER_BY,
  LEADERBOARD_PAGE_LIMIT,
  LEADERBOARD_TIME_PERIODS,
} from './polymarket.js';
import {
  POLYMARKET_RANKING_CATEGORIES,
  rankingCompleteness,
  rankingStatusLabel,
  type PolymarketRankingCategory,
  type PolymarketRankingSeries,
} from './polymarket-ranking.js';

/**
 * STK-F2-17 — o CONTRATO da simulação MERAMENTE INDICATIVA da Polymarket.
 *
 * Este arquivo é puro: sem banco, sem rede, sem relógio. Ele responde a três
 * perguntas e a nenhuma outra, e as três têm resposta OBRIGATÓRIA — inclusive
 * quando a resposta é "não, recusada".
 *
 *  1) ESTA SAÍDA É EXECUTÁVEL? **Não**, e a resposta está no TIPO, não no
 *     texto: `executable` e `executed` são `z.literal(false)`. Não existe
 *     caminho de código, nem de teste, que produza `true` sem alterar o
 *     schema — e o teste §15 tenta, e a tentativa falha. Um motor de
 *     simulação que pudesse virar execução deixaria de ser o que o card
 *     autorizou, e o risco reputacional é o ponto declarado do card (§4.9).
 *
 *  2) OS DADOS COBREM O QUE A SIMULAÇÃO AFIRMA? A resposta vem do status
 *     GRAVADO pela F2-14 (`integration.polymarket_series.status`), nunca da
 *     contagem de linhas e nunca de uma média, de um desvio padrão ou de
 *     qualquer estatística que "consertasse" a lacuna. Cobertura incompleta é
 *     RECUSA, sem exceção, sem exceção configurável e sem caminho de código
 *     que produza número sobre série não completa. `rankingCompleteness` é
 *     reaproveitado da F2-15 em vez de redefinido, para que "truncada" tenha
 *     um único significado no produto inteiro.
 *
 *  3) O QUE ESTÁ SENDO PRESUMIDO? Tudo. As premissas — atraso, taxas, spread,
 *     slippage e a taxa de dados ausentes — viajam na resposta SEMPRE, nos
 *     DOIS desfechos: na recusa e no resultado. Uma recusa sem premissas
 *     visíveis esconderia justamente o que o usuário precisa ler para entender
 *     por que a recusa aconteceu, e um resultado sem premissas visíveis
 *     apresentaria aritmética como se fosse medição.
 *
 * E O QUE ESTE ARQUIVO NÃO CONTÉM, por decisão do card (§9.5, escopo
 * excluído): execução de trade, otimização de estratégia, seleção de quem
 * entrar, recomendação e retorno prometido. A recusa de cobertura é o
 * comportamento padrão, não uma exceção — e a ausência desses campos é
 * estrutural: os schemas são `strictObject`, então um campo a mais quebraria
 * o parse em vez de passar em silêncio.
 *
 * ARITMÉTICA. Todo dinheiro é `numeric(38, 18)` no banco e LITERAL decimal no
 * transporte, pelo mesmo motivo da F2-14: o valor real que a Polymarket
 * publica (`792578.3948993701`) não sobrevive a um `number` do JavaScript. A
 * aritmética interna é `BigInt` com escala fixa e arredondamento half-up
 * EXATAMENTE no meio (away from zero) — nunca `Number`, nunca float, nunca
 * um `parseFloat` no meio do caminho. Um `Number` aqui devolveria
 * `0.0000000001` onde o valor exato é `0.0000000001`, e a soma de mil linhas
 * acumularia o erro de arredondamento do IEEE-754 até o último dígito.
 */

/**
 * Uma quantia de SAÍDA do motor, em dinheiro: até 12 inteiros e até 2 casas.
 *
 * Esta é a escala das DECISÕES: a stake que o usuário informa e todos os
 * valores que o motor produz (bruto, fricção, faixa e líquido). Duas casas é
 * a precisão que o resto do produto já usa para dinheiro (`returns.ts`,
 * `reports.ts`), e arredondar para centavo no OUTPUT é correto — o erro de
 * meio centavo por passo, acumulado em cada multiplicação, não seria.
 */
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Um valor de ORIGEM (`vol` e `pnl`), com até 18 casas decimais.
 *
 * A distinção das duas escalas é o ponto mais importante da aritmética deste
 * módulo. A Polymarket publica `792578.3948993701` e `2666493.7190210004`:
 * são DEZ casas decimais, e a coluna do banco é `numeric(38, 18)`. Reduzir
 * essas observações a centavos no momento da leitura DESCARTARIA o dígito que
 * a origem mandou, e a razão calculada sobre o valor truncado seria um número
 * que ninguém mediu. A entrada é exata em 1e18; a saída é em centavos.
 */
const OBSERVATION_VALUE = /^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;

/** Uma taxa ou fração: 0..999, com até 6 decimais. */
const RATE = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/;

/** A escala das taxas dentro do motor: 6 casas, exatas, em `BigInt`. */
const RATE_SCALE = 1_000_000n;

/** A escala do dinheiro dentro do motor: 2 casas, exatas, em `BigInt`. */
const MONEY_SCALE = 100n;

/**
 * A escala das OBSERVAÇÕES: 18 casas, a mesma do `numeric(38, 18)` da 0028.
 *
 * Ela é maior que a do dinheiro porque a origem publica mais casas do que
 * o produto exibe — exibir arredondado é uma escolha de tela; ler truncado
 * seria uma escolha de dado, e a escolha de dado é que não se faz.
 */
const OBSERVATION_SCALE = 1_000_000_000_000_000_000n;

/**
 * O schema de uma quantia de SAÍDA, exata.
 *
 * `z.string()` com `regex` e não `z.coerce.number()`: a coerção para `number`
 * é exatamente a perda que a F2-14 existe para impedir, e ela aconteceria no
 * PARSE, antes de qualquer validação de lógica.
 */
export const simulationMoneySchema = z.string().regex(MONEY, 'NOT_A_MONEY_TOKEN');

/** O schema de um valor de ORIGEM, exato em até 18 casas. */
export const simulationObservationValueSchema = z
  .string()
  .regex(OBSERVATION_VALUE, 'NOT_AN_OBSERVATION_VALUE');

/** O schema de uma taxa/fração exata (0 a 999,999999). */
export const simulationRateSchema = z.string().regex(RATE, 'NOT_A_RATE_TOKEN');

/**
 * O atraso assumido, em milissegundos, e o TETO que ele respeita.
 *
 * O teto é de um minuto porque é a partir daí que a premissa deixa de descrever
 * o mercado e passa a descrever o atraso de uma pessoa. A premissa de atraso
 * NÃO é um custo: ela é a razão pela qual o resultado não é executável. A
 * Polymarket publica o número CONSOLIDADO de uma janela (`MONTH` quer dizer
 * "os últimos 30 dias", não "o que aconteceu no minuto 0"), então qualquer
 * número derivado dele chega ao usuário com atraso estrutural e não pode ser
 * tratado como cotação. O valor é declarado, não estimado: entra na resposta,
 * e a resposta afirma que ele não vira ordem.
 */
export const SIMULATION_MAX_DELAY_MS = 60_000;

export const simulationDelaySchema = z.number().int().min(0).max(SIMULATION_MAX_DELAY_MS);

/**
 * As PREMISSAS, e a exigência de que TODAS estejam presentes.
 *
 * A chave é um enum fechado e a lista abaixo é a lista completa. Um consumidor
 * não pode escolher quais premissas exibir, e o teste §15 exige que a
 * resposta traga as sete — a ausência de uma premissa seria um número
 * publicado sem a ressalva que o limita.
 *
 * `kind` diz de ONDE a premissa vem, e essa distinção é o que separa uma
 * medição de um palpite:
 *
 *  - `configured` — o USUÁRIO escolheu (a stake e as taxas que ele supõe);
 *  - `measured`    — a COBERTURA observed na série gravada (dados ausentes);
 *  - `declared`    — a NOSSA declaração de limite (atraso, e o próprio
 *                    remember: nenhuma delas é uma medição da execute-ability).
 */
export const SIMULATION_PREMISE_KEYS = [
  'stake',
  'delayMs',
  'feeRate',
  'spreadRate',
  'slippageRate',
  'missingDataRate',
  'completeness',
] as const;
export const simulationPremiseKeySchema = z.enum(SIMULATION_PREMISE_KEYS);
export type SimulationPremiseKey = z.infer<typeof simulationPremiseKeySchema>;

/**
 * Uma premissa exibida. O texto é obrigatório e não vazio: uma premissa sem
 * frase é um número solto, e o card pede premissas EXPLÍCITAS.
 */
export const simulationPremiseSchema = z.strictObject({
  key: simulationPremiseKeySchema,
  /** O rótulo em português do que está sendo assumido. */
  label: z.string().min(1),
  /** O valor como LITERAL exato — nunca `number`, nunca formatado. */
  value: z.string().min(1),
  kind: z.enum(['configured', 'measured', 'declared']),
  /** Por que este valor existe e o que ele NÃO cobre. */
  note: z.string().min(1),
});
export type SimulationPremise = z.infer<typeof simulationPremiseSchema>;

/**
 * Os AVISOS de jogo responsável (§4.9), e a exigência de que a lista não
 * possa ser esvaziada.
 *
 * `min(1)` é a regra: uma saída de simulação SEM aviso é um schema inválido, e
 * o banco recusa gravar uma (`polymarket_simulation_disclaimers_check`). Não
 * é um campo que a interface possa decidir esconder — ele vem no payload, é
 * validado na BORDA e é gravado junto da simulação, de modo que o registro do
 * banco carrega o aviso que foi exibido. Uma tela que escondesse o aviso
 * deixaria o registro como prova de que ele existiu.
 *
 * O texto é fixo e não carrega número, nome de trader nem valor: ele descreve
 * a NATUREZA da saída, não o dado.
 */
export const simulationDisclaimerSchema = z.string().min(1).max(512);

export const SIMULATION_DISCLAIMERS: readonly string[] = [
  'Simulação indicativa: número aritmético produzido sobre dados públicos já publicados pela ' +
    'Polymarket. Não é previsão, não é cotação e não é resultado de operação.',
  'Retorno teórico não é retorno executável: nada foi apostado, nenhuma ordem foi enviada e ' +
    'nenhuma execução é possível a partir desta tela.',
  'O dado da origem é consolidado por janela e chega com atraso estrutural; o atraso ' +
    'assumido aparece entre as premissas e não pode ser zerado.',
  'Jogo responsável: apostar involve risco de perda de dinheiro. Simular não reduz esse ' +
    'risco. Proibido para menores de 18 anos (declaração de idade mínima do produto).',
  'O Stakeframe não executa apostas, não intermedia valores e não recomenda entrada, saída ' +
    'ou estratégia. A decisão é inteiramente do usuário.',
] as const;

/** A lista de avisos, já congelada e sempre a mesma. */
export function simulationDisclaimers(): string[] {
  return [...SIMULATION_DISCLAIMERS];
}

// ---------------------------------------------------------------------------
// A recusa
// ---------------------------------------------------------------------------

/**
 * Os motivos de recusa, e todos eles são RECUSA — não existe motivo que
 * produza um número parcial.
 *
 *  - `SERIES_NOT_COLLECTED` — a janela nunca foi ingerida. Sem dado, não há o
 *    que simular; a resposta NÃO é "resultado zero".
 *
 *  - `SERIES_NOT_COMPLETE` — a série existe e é `truncated`, `partial` ou
 *    `unknown`. Este é o estado REAL e normal deste backfill (a Polymarket não
 *    declara quando o leaderboard termina), e é por isso que a recusa é o
 *    comportamento normal do produto e não um erro raro. Uma simulação sobre
 *    cobertura parcial publicaria o que a coleta VIU rotulado como o que o
 *    mercado FOI — a mesma mentira que o `status` gravado existe para impedir.
 *
 *  - `SAMPLE_TOO_SMALL` — menos observações do que o limiar do produto
 *    (`DASHBOARD_MIN_SAMPLE`, a MESMA regra da F2-02/F2-03 e do ranking da
 *    F2-15). Nenhuma estatística sobre 2 linhas é uma leitura.
 *
 *  - `MISSING_DATA` — a observação existe, mas a MEIA de volume (`vol`) é zero
 *    ou ausente em alguma linha. A razão por unidade de volume é a única forma
 *    de levar a stake até o número da origem, e sem volume não há ponte: o
 *    motor recusa em vez de tratar volume ausente como volume zero, porque
 *    volume zero é um dado que diz "esse trader não operou", e volume ausente é
 *    um dado que não existe. Os dois precisam de tratamento oposto.
 *
 * Não há `NONE` como motivo: um desfecho que não recusa não tem motivo, e um
 * motivo de recusa que não recusa não é um motivo de recusa.
 */
export const SIMULATION_REFUSAL_CODES = [
  'SERIES_NOT_COLLECTED',
  'SERIES_NOT_COMPLETE',
  'SAMPLE_TOO_SMALL',
  'MISSING_DATA',
] as const;
export const simulationRefusalCodeSchema = z.enum(SIMULATION_REFUSAL_CODES);
export type SimulationRefusalCode = z.infer<typeof simulationRefusalCodeSchema>;

export const simulationRefusalSchema = z.strictObject({
  refused: z.boolean(),
  /** O código estável, ou `null` quando a simulação foi apurada. */
  code: simulationRefusalCodeSchema.nullable(),
  /** A frase que a tela mostra, ou `null` quando não houve recusa. */
  reason: z.string().min(1).nullable(),
  /** O que a tela escreve para desbloquear: sempre presente, mesmo recusando. */
  remedy: z.string().min(1).nullable(),
});
export type SimulationRefusal = z.infer<typeof simulationRefusalSchema>;

// ---------------------------------------------------------------------------
// A cobertura (o que a F2-14 gravou, nunca o que a contagem sugere)
// ---------------------------------------------------------------------------

/**
 * A cobertura, lida do estado GRAVADO e traduzida com a função da F2-15.
 *
 * `completeness` é literalmente a saída de `rankingCompleteness({ series })`:
 * o mesmo rótulo, o mesmo detalhe e o mesmo `truncated` que a tela do ranking
 * já mostra. Reutilizar a função é o que impede as duas telas divergirem
 * sobre a mesma série — e duas telas discordando sobre a completude é pior do
 * que nenhuma tela mostrar completude.
 */
export const simulationCoverageSchema = z.strictObject({
  /** O estado gravado pela ingestão ('complete' | 'truncated' | 'partial' | 'unknown'). */
  status: z.enum(['complete', 'truncated', 'partial', 'unknown']),
  /** A janela já foi ingerida alguma vez? */
  available: z.boolean(),
  /** N: quantas observações a simulação usou. */
  n: z.number().int().nonnegative(),
  /** O limiar do produto, injetado — nenhuma tela decide sozinha. */
  minSample: z.number().int().positive(),
  lowSample: z.boolean(),
  /**
   * A COMPLETUDE, traduzida. `truncated: true` com `refused: false` é
   * IMPOSSÍVEL por construção: `simulationRefusalPolicy` recusa toda série
   * truncada, e o schema abaixo torna a combinação um erro de parse.
   */
  completeness: z.strictObject({
    truncated: z.boolean(),
    label: z.string().min(1),
    detail: z.string().min(1),
  }),
  /**
   * A taxa de DADOS AUSENTES, medida sobre a série gravada.
   *
   * A DEFINIÇÃO é `1 − n / 50`, onde 50 é o teto de registros por página que
   * a F2-14 verificou por probe (`limit=51` devolve 50). Ela mede uma coisa
   * específica e verificável: quanto da PRIMEIRA página oficial do ranking
   * desta janela o nosso banco NÃO tem. Uma série `complete` tem, por
   * definição, menos de 50 linhas (foi uma página curta que encerrou a
   * paginação), então a taxa é estruturalmente maior que zero — e é isso que a
   * torna informativa em vez de decorativa.
   *
   * Ela NÃO é subtraída do resultado, e a razão é o SINAL: o dado que falta
   * pode ter sido ganho ou perda, e uma subtração com sinal presumido
   * transformaria incerteza em número. Por isso ela é exibida como
   * `missingDataBand` — a magnitude de incerteza que a lacuna representa — e
   * a premissa correspondente diz, em texto, que ela não foi aplicada.
   */
  missingDataRate: z.string().regex(RATE, 'NOT_A_RATE_TOKEN'),
});
export type SimulationCoverage = z.infer<typeof simulationCoverageSchema>;

// ---------------------------------------------------------------------------
// O resultado indicativo
// ---------------------------------------------------------------------------

/**
 * O número indicativo, ou `null` quando a simulação foi RECUSADA.
 *
 * `indicative: null` numa recusa é a invariante central deste card, e ela é do
 * TIPO: o schema é uma união discriminada por `refusal.refused`, então um
 * `indicative` preenchido com `refused: true` não é um payload válido. Um
 * chamador que ignorasse o campo de recusa teria acesso ao `null`, não ao
 * número — o número não existe para ser lido errado.
 */
export const simulationResultSchema = z.strictObject({
  /** A stake por observação, exatamente como configurada. */
  stake: simulationMoneySchema,
  /** Quantas observações entraram. */
  observations: z.number().int().positive(),

  /**
   * A RAZÃO PUBLICADA pela origem, `soma(pnl) / soma(vol)`, exata.
   *
   * É a única coisa que liga a stake ao número da Polymarket, e ela é um
   * DADO PUBLICADO, não uma estimativa nossa. Ela é published em nome próprio
   * justamente para que ninguém a leia como um coeficiente de forecast.
   */
  publishedRatio: z.string().regex(RATE, 'NOT_A_RATE_TOKEN'),
  /** As somas exatas que a produziram, para o número ser auditável. */
  publishedPnlSum: simulationObservationValueSchema,
  publishedVolSum: simulationObservationValueSchema,

  /**
   * O BRUTO, antes de qualquer premissa de fricção: `stake × n × razão`.
   *
   * Este campo é perigoso por construção, e é por isso que ele é nomeado
   * `grossBeforePremises` e não `profit`. Nenhum leitor pode receber um número
   * chamado "ganho" que não teve taxa, spread, slippage nem dado faltante
   * descontados. A ordem de leitura na tela é: bruto, depois cada premissa
   * descontada, depois o líquido — e o bruto nunca aparece sozinho.
   */
  grossBeforePremises: simulationMoneySchema,

  /** O custo de CADA premissa, em dinheiro, separadamente e visível. */
  feeCost: simulationMoneySchema,
  spreadCost: simulationMoneySchema,
  slippageCost: simulationMoneySchema,
  /** A soma das três, que é o que efetivamente sai do bruto. */
  totalFrictionCost: simulationMoneySchema,

  /**
   * A magnitude de INCERTEZA que a lacuna de dados representa, calculada sobre
   * o bruto com a taxa de dados ausentes.
   *
   * Ela NÃO é subtraída: o sinal do dado que falta é desconhecido, e
   * subtrair com sinal presumido publicaria uma precisão que não existe. A
   * tela a mostra como faixa, ao lado do líquido, para que o leitor veja que
   * o número final carrega esta incerteza.
   */
  missingDataBand: simulationMoneySchema,

  /** O LÍQUIDO após as fricções, e o ÚNICO número que a tela destaca. */
  netAfterPremises: simulationMoneySchema,
  /** Sinal do líquido, para a cor do valor. */
  negative: z.boolean(),
});
export type SimulationResult = z.infer<typeof simulationResultSchema>;

// ---------------------------------------------------------------------------
// A resposta
// ---------------------------------------------------------------------------

/**
 * A janela da simulação: as mesmas três dimensões que a F2-14 ingeriu e que a
 * F2-15 ofereceu como filtro.
 *
 * `category` é o enum OFICIAL de onze valores da F2-15 — NÃO o `LEADERBOARD_CATEGORY`
 * de um valor só da F2-14. A consequência é deliberada e é a resposta honesta à
 * divergência entre os dois: uma janela de uma das dez categorias além de
 * `OVERALL` NÃO tem série gravada, porque o CHECK do banco (0028) aceita só
 * `OVERALL`, e portanto ela é SEMPRE recusada com `SERIES_NOT_COLLECTED`. O
 * esquema aceita o rótulo oficial — é o que a interface oferece — e a recusa
 * explica por quê. Nenhuma exceção, nenhuma estimativa e nenhum número para
 * uma janela que ninguém coletou.
 */
export const simulationWindowSchema = z.strictObject({
  category: z.enum(POLYMARKET_RANKING_CATEGORIES),
  timePeriod: z.enum(LEADERBOARD_TIME_PERIODS),
  orderBy: z.enum(LEADERBOARD_ORDER_BY),
});
export type SimulationWindow = z.infer<typeof simulationWindowSchema>;

/** A categoria da janela, reexportada para quem tipa sem duplicar o enum. */
export type { PolymarketRankingCategory };

/** O que o usuário escolhe: a janela, a stake fixa e as premissas de fricção. */
export const simulationInputSchema = z.strictObject({
  window: simulationWindowSchema,
  /** A stake FIXA por observação. É o único valor monetário da entrada. */
  stake: simulationMoneySchema,
  /** Atraso assumido, em ms. Declarado, nunca estimado. */
  delayMs: simulationDelaySchema,
  feeRate: simulationRateSchema,
  spreadRate: simulationRateSchema,
  slippageRate: simulationRateSchema,
});
export type SimulationInput = z.infer<typeof simulationInputSchema>;

/**
 * A resposta completa.
 *
 * Três invariantes são do TIPO, e não do texto:
 *
 *  - `kind: 'indicative'` e `executable: false` e `executed: false` são
 *    literais. Não existe valor outro que o schema aceite.
 *  - `premises` é `array(...).min(1)` com o tamanho EXATO das sete chaves
 *    verificado pelo motor: uma premissa a menos é uma mentira por omissão.
 *  - `disclaimers` é `array(...).min(1)`, e o banco recusa gravar sem um.
 *
 * E o `refine` no fim é a REGRA CENTRAL do card, aplicada na BORDA: recusa e
 * número são mutuamente exclusivos nos DOIS sentidos. Sem ele, um payload que
 * trouxesse `refusal.refused: true` ao lado de um `indicative` preenchido
 * passaria no parse — e um chamador que ignorasse o campo de recusa leria um
 * número sobre cobertura que o próprio payload declara incompleta. O teste §15
 * monta exatamente esse payload e exige que ele seja RECUSADO.
 */
const polymarketSimulationObjectSchema = z.strictObject({
  kind: z.literal('indicative'),
  /**
   * SEMPRE `false`. `z.literal` é a decisão: enquanto este campo for um
   * literal, nenhuma rota, nenhuma tela e nenhum teste pode afirmar que a
   * saída é executável. Para mudar isso seria uma revisão do schema — que é
   * exatamente a revisão que o card exige.
   */
  executable: z.literal(false),
  /** SEMPRE `false`: nada foi executado, e o registro dirá o mesmo. */
  executed: z.literal(false),
  window: simulationWindowSchema,
  refusal: simulationRefusalSchema,
  coverage: simulationCoverageSchema,
  /** AS SETE PREMISSAS, sempre. Nos dois desfechos. */
  premises: z.array(simulationPremiseSchema).min(1),
  /** O número, ou `null` quando a simulação foi recusada. */
  indicative: simulationResultSchema.nullable(),
  /** Os avisos de jogo responsável (§4.9), sempre. */
  disclaimers: z.array(simulationDisclaimerSchema).min(1),
});

/**
 * Recusa e número são mutuamente exclusivos, e a cobertura decidindo.
 *
 * Quatro condições, e cada uma fecha uma mentira diferente:
 *
 *  - recusada ⇒ `indicative` é `null` e há código, razão e remédio. Um
 *    número atrás de uma recusa é o que o chamador sem cuidado leria.
 *  - apurada ⇒ `refusal.code`, `reason` e `remedy` são `null` e o número
 *    existe. Um desfecho que se recusa e se apura ao mesmo tempo não é
 *    interpretável.
 *  - apurada ⇒ a série é `complete` e `available`. A mesma regra do motor,
 *    verificada de novo na borda, porque a borda é onde o dado entra.
 *  - recusada por cobertura ⇒ o código é o de cobertura. Uma recusa por
 *    amostra pequena com a série não coletada esconderia o motivo real.
 */
export const polymarketSimulationSchema = polymarketSimulationObjectSchema.refine(
  (value) => {
    const { refused, code, reason, remedy } = value.refusal;
    if (refused) {
      if (value.indicative !== null) return false;
      if (code === null || reason === null || remedy === null) return false;
      if (value.coverage.status === 'complete' && value.coverage.available) return false;
      if (code === 'SERIES_NOT_COMPLETE' && value.coverage.status === 'complete') return false;
      if (code === 'SERIES_NOT_COLLECTED' && value.coverage.available) return false;
      return true;
    }
    // Apurada: número presente, recusa vazia e cobertura completa.
    if (value.indicative === null) return false;
    if (code !== null || reason !== null || remedy !== null) return false;
    if (!value.coverage.available || value.coverage.status !== 'complete') return false;
    if (value.coverage.completeness.truncated) return false;
    return true;
  },
  { message: 'REFUSAL_AND_INDICATIVE_ARE_MUTUALLY_EXCLUSIVE', path: ['refusal'] },
);
export type PolymarketSimulation = z.infer<typeof polymarketSimulationObjectSchema>;

/** A união discriminada que a API e a tela realmente recebem. */
export const simulationOutcomeSchema = z.discriminatedUnion('refused', [
  z.strictObject({
    refused: z.literal(true),
    code: simulationRefusalCodeSchema,
    reason: z.string().min(1),
    remedy: z.string().min(1),
  }),
  z.strictObject({
    refused: z.literal(false),
    code: z.null(),
    reason: z.null(),
    remedy: z.null(),
  }),
]);
export type SimulationOutcome = z.infer<typeof simulationOutcomeSchema>;

// ---------------------------------------------------------------------------
// Aritmética exata
// ---------------------------------------------------------------------------

/**
 * Converte um decimal em `BigInt` na escala pedida, e RECUSA o que não é
 * decimal — sempre, antes de qualquer aritmética.
 *
 * As casas decimais saem da própria ESCALA (uma potência de dez), e não de um
 * `if` com dois casos. A versão anterior assumia "escala 100 é dinheiro com 2
 * casas, o resto é taxa com 6", e essa suposição quebrou assim que as
 * observações passaram a entrar em 18 casas: `792578.3948993701` seria lido
 * como se tivesse 6 casas, e o valor viraria `792578394899.370100` — um
 * número com a magnitude errada e nenhum erro lançado. Derivar as casas da
 * escala é o que impede essa classe de bug de voltar.
 */
function toScaled(token: string, scale: bigint, pattern: RegExp, code: string): bigint {
  if (!pattern.test(token)) throw new Error(code);
  const negative = token.startsWith('-');
  const [whole = '0', fraction = ''] = token.replace(/^-/, '').split('.');
  // A escala é sempre uma potência de dez: as casas são o seu log exato.
  let decimals = 0;
  for (let rest = scale; rest > 1n; rest /= 10n) decimals += 1;
  const value =
    BigInt(whole) * scale + BigInt(fraction === '' ? '0' : fraction.padEnd(decimals, '0'));
  return negative ? -value : value;
}

/** O dinheiro em centavos: a stake e todos os números de saída. */
const moneyScaled = (token: string): bigint =>
  toScaled(token, MONEY_SCALE, MONEY, 'NOT_A_MONEY_TOKEN');

/** A taxa em 1e6. */
const rateScaled = (token: string): bigint => toScaled(token, RATE_SCALE, RATE, 'NOT_A_RATE_TOKEN');

/** O valor de ORIGEM em 1e18 — a mesma escala do `numeric(38, 18)`. */
const observationScaled = (token: string): bigint =>
  toScaled(token, OBSERVATION_SCALE, OBSERVATION_VALUE, 'NOT_AN_OBSERVATION_VALUE');

/**
 * Divisão com arredondamento half-up EXATO no meio, simétrico ao sinal.
 *
 * `Number` não pode fazer isto: `Math.round` arredonda meio para o infinito
 * (o que é correto para números positivos e errado para negativos, onde o
 * meio precisa cair para longe do zero) e, pior, opera sobre um float já
 * degradado. `(2·|a| + b) / 2b` em `BigInt` é o meio exato, e a negação no
 * fim devolve o mesmo arredondamento para os dois sinais.
 */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('INVALID_DENOMINATOR');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/**
 * Volta de uma escala para o literal decimal, sem notação científica.
 *
 * As casas vêm da ESCALA, pelo mesmo motivo de `toScaled`: um `if` com dois
 * casos quebraria em silêncio na terceira escala, e a saída errada aqui é um
 * número que a tela exibe como se fosse medido.
 */
function fromScaled(value: bigint, scale: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  let decimals = 0;
  for (let rest = scale; rest > 1n; rest /= 10n) decimals += 1;
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * Uma observação da origem, no que o motor precisa dela.
 *
 * `vol` e `pnl` são os LITERAIS exatos que a F2-14 gravou, com até 18 casas —
 * a mesma escala do `numeric(38, 18)`. O motor não aceita `number`, e o motivo
 * é o mesmo da F2-14: o valor real `2666493.7190210004` já perdeu algarismos
 * no IEEE-754 antes de chegar aqui, e reduzi-lo a centavos descartaria um
 * dígito que a origem mandou.
 */
export const simulationObservationSchema = z.strictObject({
  proxyWallet: z.string().regex(/^0x[0-9a-f]{40}$/, 'INVALID_PROXY_WALLET'),
  vol: simulationObservationValueSchema,
  pnl: simulationObservationValueSchema,
});
export type SimulationObservation = z.infer<typeof simulationObservationSchema>;

// ---------------------------------------------------------------------------
// A política de recusa
// ---------------------------------------------------------------------------

/**
 * A função que decide se a simulação pode ser apurada, e ela é PURA.
 *
 * Quatro recusas, avaliadas nesta ordem, e a ordem importa: a primeira
 * condição verdadeira é a que é relatada, e relatar "amostra pequena" para uma
 * janela que nunca foi coletada esconderia o motivo real — que é a ausência de
 * dado, não o tamanho dele.
 *
 * A função NÃO consulta relógio, NÃO consulta banco e NÃO conta nada que ela
 * mesma possa inventar. Dado o mesmo estado gravado e as mesmas observações,
 * ela produz a mesma decisão — que é o que a torna testável sem infraestrutura
 * e estável na tela.
 */
export function simulationRefusalPolicy(input: {
  series: Pick<PolymarketRankingSeries, 'status' | 'available'>;
  observations: readonly SimulationObservation[];
  minSample: number;
}): SimulationOutcome {
  const { series, observations, minSample } = input;
  if (!series.available)
    return {
      refused: true,
      code: 'SERIES_NOT_COLLECTED',
      reason:
        'A Polymarket ainda não publicizou esta combinação de período, categoria e ordenação na ' +
        'nossa coleta. Não existe dado para simular, e simular sobre nada produziria um número ' +
        'sem nenhum lastro.',
      remedy:
        'Escolha uma categoria e um período que a nossa coleta tenha percorrido, ou aguarde a ' +
        'coleta cobrir esta janela.',
    };
  if (series.status !== 'complete')
    return {
      refused: true,
      code: 'SERIES_NOT_COMPLETE',
      reason:
        'A cobertura desta janela está incompleta. A origem não declara quando o leaderboard ' +
        'termina, então a coleta para no limite de páginas e a série fica marcada como ' +
        `${rankingStatusLabel(series.status)}. Apurar a simulação aqui transformaria o que a ` +
        'coleta viu no que o mercado foi.',
      remedy:
        'A simulação só é apurada quando a coleta observa o fim da paginação da janela. ' +
        'Nenhuma configuração libera este caminho: a recusa é a resposta correta enquanto a ' +
        'cobertura não fechar.',
    };
  if (observations.length < minSample)
    return {
      refused: true,
      code: 'SAMPLE_TOO_SMALL',
      reason:
        `Esta janela tem ${observations.length} ${observations.length === 1 ? 'observação' : 'observações'} ` +
        `e o mínimo do produto para uma leitura é ${minSample}. Uma média sobre poucas linhas não ` +
        'descreve a janela.',
      remedy: `Amplie a janela ou o período até atingir N ≥ ${minSample} observações.`,
    };
  // `vol` é um valor de ORIGEM (18 casas), não dinheiro: o teste de volume
  // ausente compara o volume com zero na ESCALA DA OBSERVAÇÃO. Usar a escala
  // do dinheiro aqui reduziria `0.004` a `0.00` e recusaria um volume válido
  // como ausente — e a recusa errada é a que impede uma apuração legítima. A
  // distinção entre "esse trader não operou" e "o dado não existe" precisa ser
  // lida na escala em que a origem escreveu.
  if (observations.some((observation) => observationScaled(observation.vol) === 0n))
    return {
      refused: true,
      code: 'MISSING_DATA',
      reason:
        'Ao menos uma observação não tem volume publicado. A razão por unidade de volume é a ' +
        'única ponte entre a stake e o número da origem, e volume ausente não é volume zero: ' +
        'zero significa que o trader não operou, ausente significa que o dado não existe.',
      remedy:
        'A recusa vale enquanto houver observação sem volume. Tratar volume ausente como zero ' +
        'publicaria um retorno calculado sobre um dado que ninguém mediu.',
    };
  return { refused: false, code: null, reason: null, remedy: null };
}

// ---------------------------------------------------------------------------
// A cobertura medida
// ---------------------------------------------------------------------------

/**
 * A taxa de dados ausentes, medida sobre a PRIMEIRA página oficial.
 *
 * A definição é `(50 − n) / 50` com o teto de página verificado pela F2-14
 * (`LEADERBOARD_PAGE_LIMIT`), e não a fração de um total que ninguém conhece: a
 * Polymarket nunca declara quantos traders existem, então "n de 1000" seria uma
 * fração de um denominador inventado. O que o número responde é uma pergunta
 * verificável — quanto da primeira página, esta janela, o nosso banco não tem.
 *
 * Uma série `complete` tem MENOS de 50 linhas por construção (foi uma página
 * curta que encerrou a paginação), então a taxa é maior que zero mesmo no
 * melhor caso. Isso é honesto: mesmo a cobertura que a F2-14 chama de completa
 * não é a totalidade do leaderboard, e o número diz isso sem afirmar o
 * contrário.
 */
export function missingDataRate(n: number): string {
  const missing = Math.max(0, LEADERBOARD_PAGE_LIMIT - Math.max(0, n));
  // Escala 1e6: `missing / 50` com 6 casas exatas, sem `Number` no meio.
  return fromScaled(
    divHalfUp(BigInt(missing) * RATE_SCALE, BigInt(LEADERBOARD_PAGE_LIMIT)),
    RATE_SCALE,
  );
}

// ---------------------------------------------------------------------------
// O motor
// ---------------------------------------------------------------------------

/**
 * O MOTOR, e ele é uma função pura: entra o estado gravado, as observações
 * exatas e a entrada do usuário; saem a recusa (ou a sua ausência), a
 * cobertura, as sete premissas e o número indicativo.
 *
 * A ordem das operações é o card inteiro:
 *
 *  1. a recusa é decidida ANTES de qualquer aritmética, porque calcular um
 *     número para depois descartá-lo é o caminho pelo qual um número vazaria;
 *  2. a cobertura é montada a partir do status GRAVADO, e é ela que justifica
 *     a recusa;
 *  3. as premissas são montadas ANTES do resultado, para que o resultado
 *     nunca exista sem elas;
 *  4. só então o número é apurado, com a fricção descontada premissa a
 *     premissa.
 *
 * A função não aceita `null` em lugar nenhum e não tem caminho de retorno
 * parcial: ou existe `indicative` com recusa `false`, ou existe `null` com
 * recusa `true`.
 */
export function runIndicativeSimulation(input: {
  window: SimulationWindow;
  series: Pick<
    PolymarketRankingSeries,
    'status' | 'available' | 'ingested' | 'pages' | 'failedPages'
  >;
  observations: readonly SimulationObservation[];
  request: SimulationInput;
  minSample: number;
}): PolymarketSimulation {
  const { window, series, observations, request, minSample } = input;
  if (!Number.isInteger(minSample) || minSample < 1)
    throw new Error('INVALID_SIMULATION_MIN_SAMPLE');

  const outcome = simulationRefusalPolicy({ series, observations, minSample });
  const completeness = rankingCompleteness({ series });
  const rate = missingDataRate(observations.length);
  const coverage: SimulationCoverage = {
    status: series.status,
    available: series.available,
    n: observations.length,
    minSample,
    lowSample: observations.length < minSample,
    completeness: {
      truncated: completeness.truncated,
      label: completeness.label,
      detail: completeness.detail,
    },
    missingDataRate: rate,
  };

  const premises = simulationPremises({ request, coverage });

  if (outcome.refused)
    return {
      kind: 'indicative',
      executable: false,
      executed: false,
      window,
      refusal: {
        refused: true,
        code: outcome.code,
        reason: outcome.reason,
        remedy: outcome.remedy,
      },
      coverage,
      premises,
      // A recusa não tem número, e a ausência é do TIPO: `indicative` é
      // `null`, não um objeto com campos zerados. Um objeto zerado seria
      // lido como "simulação deu zero" — que é uma afirmação, e é falsa.
      indicative: null,
      disclaimers: simulationDisclaimers(),
    };

  // As somas das observações, na ESCALA DE ORIGEM (1e18). Somar em centavos
  // aqui descartaria a DÉCIMA casa que a Polymarket publicou — e a razão é a
  // divisão dessas somas, então o erro apareceria no primeiro dígito do
  // resultado, que é exatamente onde a tela promete exatidão.
  const pnlSum = observations.reduce((total, item) => total + observationScaled(item.pnl), 0n);
  const volSum = observations.reduce((total, item) => total + observationScaled(item.vol), 0n);
  // A razão publicada, em escala 1e6, half-up no meio. `volSum > 0` é
  // garantido pela política de recusa (que recusa volume zero).
  const ratio = divHalfUp(pnlSum * RATE_SCALE, volSum);

  const stake = moneyScaled(request.stake);
  const count = BigInt(observations.length);
  // Bruto: `stake × n × razão`, em centavos. O arredondamento acontece UMA
  // vez, no fim — arredondar em cada multiplicação acumularia meio centavo por
  // passo e a soma de mil linhas carregaria o erro.
  const gross = divHalfUp(stake * count * ratio, RATE_SCALE);

  const costOf = (rateToken: string) => divHalfUp(gross * rateScaled(rateToken), RATE_SCALE);
  const fee = costOf(request.feeRate);
  const spread = costOf(request.spreadRate);
  const slippage = costOf(request.slippageRate);
  const friction = fee + spread + slippage;
  const net = gross - friction;
  // A faixa de incerteza: a MAGNITUDE do que a lacuna representa, sem sinal,
  // e por isso nunca subtraída do líquido.
  const band = divHalfUp(gross * rateScaled(rate), RATE_SCALE);

  return {
    kind: 'indicative',
    executable: false,
    executed: false,
    window,
    refusal: { refused: false, code: null, reason: null, remedy: null },
    coverage,
    premises,
    indicative: {
      stake: request.stake,
      observations: observations.length,
      publishedRatio: fromScaled(ratio, RATE_SCALE),
      // As somas PUBLICA saem na escala da ORIGEM (18 casas), e não em
      // centavos: elas são o que a Polymarket publicou, e arredondá-las aqui
      // publicaria um total que difere do que a origem somou. A tela pode
      // exibi-las arredondadas; o registro guarda o valor exato.
      publishedPnlSum: fromScaled(pnlSum, OBSERVATION_SCALE),
      publishedVolSum: fromScaled(volSum, OBSERVATION_SCALE),
      grossBeforePremises: fromScaled(gross, MONEY_SCALE),
      feeCost: fromScaled(fee, MONEY_SCALE),
      spreadCost: fromScaled(spread, MONEY_SCALE),
      slippageCost: fromScaled(slippage, MONEY_SCALE),
      totalFrictionCost: fromScaled(friction, MONEY_SCALE),
      missingDataBand: fromScaled(band, MONEY_SCALE),
      netAfterPremises: fromScaled(net, MONEY_SCALE),
      negative: net < 0n,
    },
    disclaimers: simulationDisclaimers(),
  };
}

// ---------------------------------------------------------------------------
// As premissas
// ---------------------------------------------------------------------------

/**
 * AS SETE PREMISSAS, sempre as sete, na ordem da enumeração.
 *
 * A ordem é FIXA e a contagem é o que o teste §15 exige. A interface exibe a
 * lista como vier — na ordem desta função — e uma premissa a mais ou a menos
 * quebraria a correspondência entre a resposta e a tela, o que é a forma mais
 * barata de um número aparecer sem a ressalva que o limita.
 *
 * Os textos de `note` dizem, cada um, o que a premissa NÃO cobre. É a parte
 * que o card pede ("premissas explícitas") e a parte que um número sozinho
 * nunca carrega.
 */
export function simulationPremises(input: {
  request: SimulationInput;
  coverage: Pick<SimulationCoverage, 'missingDataRate' | 'status' | 'available'>;
}): SimulationPremise[] {
  const { request, coverage } = input;
  return [
    {
      key: 'stake',
      label: 'Stake fixa por observação',
      value: request.stake,
      kind: 'configured',
      note:
        'Valor fixo escolhido por você, aplicado a cada uma das observações. É a única ' +
        'quantia da entrada: a simulação não dimensiona, não divide a banca e não ' +
        'recomenda um valor.',
    },
    {
      key: 'delayMs',
      label: 'Atraso assumido',
      value: String(request.delayMs),
      kind: 'declared',
      note:
        'A Polymarket publica o consolidado da janela, não o preço de cada instante. O ' +
        'atraso entre o dado e a sua leitura é estrutural e não pode ser zerado — é por ' +
        'isso que nenhum número daqui é executável.',
    },
    {
      key: 'feeRate',
      label: 'Taxa assumida',
      value: request.feeRate,
      kind: 'configured',
      note:
        'Percentual que você supõe pagar. A Polymarket não publica uma taxa por leaderboard ' +
        'no que coletamos, então este número é seu, não medido.',
    },
    {
      key: 'spreadRate',
      label: 'Spread assumido',
      value: request.spreadRate,
      kind: 'configured',
      note:
        'Custo de atravessar o livro de ofertas. Não coletamos livro nem profundidad: esta é ' +
        'uma suposição sua, e a resposta não a apresenta como medida de mercado.',
    },
    {
      key: 'slippageRate',
      label: 'Slippage assumido',
      value: request.slippageRate,
      kind: 'configured',
      note:
        'Deslocamento entre o preço teorico e o preço de execução. Como não executamos nada, ' +
        'este valor nunca foi observado: ele é uma hipótese que você escolheu.',
    },
    {
      key: 'missingDataRate',
      label: 'Dados ausentes',
      value: coverage.missingDataRate,
      kind: 'measured',
      note:
        'Medida sobre a primeira página oficial da janela: quanto dela o nosso banco não tem. ' +
        'O sinal do dado que falta é desconhecido, então esta taxa NÃO é descontada do ' +
        'resultado — ela aparece como faixa de incerteza ao lado do líquido.',
    },
    {
      key: 'completeness',
      label: 'Cobertura da janela',
      value: `${coverage.status}${coverage.available ? '' : ' (janela não coletada)'}`,
      kind: 'measured',
      note:
        'Status gravado pela coleta, lido do banco e nunca inferido da contagem de linhas. É ' +
        'este status — e não a quantidade de observações — que decide se a simulação é ' +
        'apurada ou recusada.',
    },
  ];
}
