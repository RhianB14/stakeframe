import { z } from 'zod';
import {
  LEADERBOARD_ORDER_BY,
  LEADERBOARD_TIME_PERIODS,
  backfillStatusSchema,
  decimalTokenSchema,
  type LeaderboardOrderBy,
  type LeaderboardTimePeriod,
} from './polymarket.js';

/**
 * STK-F2-15 — o CONTRATO da interface de ranking Polymarket.
 *
 * Este arquivo é a TRADUÇÃO do que a interface pode mostrar, e ele é puro:
 * sem banco, sem rede, sem relógio. Três decisões o sustentam, e cada uma é
 * uma FUNÇÃO testada, não um comentário.
 *
 *  1) O ENUM É OFICIAL E FOI VERIFICADO. A tarefa exige os enums oficiais da
 *     API Polymarket conferidos contra o contrato da F2-14 — e a verificação
 *     encontrou uma divergência que precisa ser dita, não escondida: a
 *     F2-14 afirma que `category` aceita APENAS `OVERALL` e o CHECK do banco
 *     (`polymarket_series_category_check`) só aceita `OVERALL` também. A
 *     documentação oficial de `/v1/leaderboard` declara ONZE opções, e os
 *     onze foram sondados um a um: todos respondem `200`, e rótulos fora da
 *     lista (`SCIENCE`, `WORLD`, `BUSINESS`, `OVERALL_TIME`) respondem `400
 *     {"error":"invalid category parameter"}`. Cada categoria aceita devolve um
 *     conjunto DISTINTO de traders (interseção com `OVERALL` = 0 para dez
 *     delas; `POLITICS` tem 1 trader em comum no top 10), então o filtro
 *     filtra de verdade e não é um rótulo decorativo.
 *
 *     Consequência honesta, e ela é a mais importante deste arquivo: as dez
 *     categorias além de `OVERALL` NÃO são ingested pela F2-14, porque o job
 *     dela ingere `LEADERBOARD_CATEGORY` (uma única categoria) e o CHECK do
 *     banco rejeitaria as outras. Portanto a interface NÃO pode oferecer
 *     "Políticas" ou "Esportes" como um ranking populado: o que ela oferece é
 *     o filtro pelo enum oficial, e a resposta para uma janela ainda não
 *     ingerida é `unknown` com a explicação, nunca uma lista vazia apresentada
 *     como "não existe trader nesta categoria".
 *
 *  2) A COMPLETUDE VEM DO STATUS GRAVADO, NUNCA DA CONTAGEM. `truncated` é o
 *     estado real e normal deste backfill: a origem entrega página cheia em
 *     `offset=5000` e nunca declara que acabou. Um top 100 com 100 linhas
 *     NÃO prova que a série é completa, e um top 100 com 40 linhas NÃO prova
 *     que a série truncou. A única fonte da verdade é
 *     `integration.polymarket_series.status`, gravada pela F2-14.
 *
 *  3) MÉTRICA QUE DEPENDE DA SÉRIE COMPLETA É BLOQUEADA. O que responde "o
 *     top 100 representa quanto do tabuleiro?" — o total do tabuleiro e a
 *     participação de cada trader nele — depende de a série ser `complete`.
 *     Enquanto não for, o número não é exibido nem estimado: a função
 *     `rankingAggregatePolicy` devolve recusa com o motivo, e a interface
 *     escreve que a métrica está bloqueada. Nenhuma simulação substitui dado
 *     ausente.
 *
 * O que este arquivo NÃO contém, por decisão do card (§9.3 e escopo
 * excluído): Composite Score, badge, recomendação, leitura, comparação ou
 * qualquer trade. Isso não é uma omissão — é uma INVARIANTE verificada pelo
 * teste §15, que varre este arquivo, o da interface e o render e exige a
 * AUSÊNCIA do termo. Os schemas são `strictObject`: um campo a mais seria
 * recusado pelo parse, então um score não entraria em silêncio.
 */

// ---------------------------------------------------------------------------
// Enums oficiais (verificados por probe contra a origem)
// ---------------------------------------------------------------------------

/**
 * As onze categorias ACEITAS por `category` na origem, na grafia exata que a
 * API exige (maiúsculas, sem acento em `CULTURE`).
 *
 * A lista é a DOCUMENTAÇÃO oficial cruzada com o comportamento observado: os
 * onze valores respondem `200` e qualquer rótulo fora dela responde `400`.
 * Nenhum valor aqui foi inventado e nenhum foi ampliado por conveniência — se
 * a origem passar a aceitar um décimo segundo rótulo, isso exige um probe e
 * uma revisão deste arquivo, não uma edição silenciosa.
 */
export const POLYMARKET_RANKING_CATEGORIES = [
  'OVERALL',
  'POLITICS',
  'SPORTS',
  'ESPORTS',
  'CRYPTO',
  'CULTURE',
  'MENTIONS',
  'WEATHER',
  'ECONOMICS',
  'TECH',
  'FINANCE',
] as const;
export const polymarketRankingCategorySchema = z.enum(POLYMARKET_RANKING_CATEGORIES);
export type PolymarketRankingCategory = z.infer<typeof polymarketRankingCategorySchema>;

/**
 * O rótulo em português de cada categoria oficial. A grafia oficial continua
 * no valor (é o que vai para a query e para a chave de dedup da F2-14); o
 * rótulo é só apresentação.
 */
export const POLYMARKET_CATEGORY_LABELS = {
  OVERALL: 'Geral',
  POLITICS: 'Política',
  SPORTS: 'Esportes',
  ESPORTS: 'Esports',
  CRYPTO: 'Cripto',
  CULTURE: 'Cultura',
  MENTIONS: 'Menções',
  WEATHER: 'Clima',
  ECONOMICS: 'Economia',
  TECH: 'Tecnologia',
  FINANCE: 'Finanças',
} as const satisfies Record<PolymarketRankingCategory, string>;

/**
 * Os períodos oficiais, reaproveitados da F2-14 em vez de redefinidos: são os
 * mesmos quatro valores que a origem aceitou nos probes, e o rótulo diz em
 * português o que cada um significa.
 *
 * `MONTH` é o período do ranking PADRÃO do card ("PnL oficial 30d"), e ele é
 * `MONTH` porque é o nome que a origem usa. Não existe "30d" no enum da API:
 * escrever `30d` no filtro seria inventar um parâmetro que a origem não tem.
 */
export const POLYMARKET_PERIOD_LABELS = {
  DAY: 'Hoje (24h)',
  WEEK: '7 dias',
  MONTH: '30 dias',
  ALL: 'Todo o período',
} as const satisfies Record<LeaderboardTimePeriod, string>;

/** As ordenações oficiais, reaproveitadas da F2-14 (`PNL` e `VOL`). */
export const POLYMARKET_ORDER_LABELS = {
  PNL: 'P&L',
  VOL: 'Volume',
} as const satisfies Record<LeaderboardOrderBy, string>;

/** A janela PADRÃO do ranking: PnL oficial de 30 dias, categoria geral. */
export const POLYMARKET_DEFAULT_WINDOW = {
  category: 'OVERALL',
  timePeriod: 'MONTH',
  orderBy: 'PNL',
} as const satisfies {
  category: PolymarketRankingCategory;
  timePeriod: LeaderboardTimePeriod;
  orderBy: LeaderboardOrderBy;
};

/** O TOP 100 do card. O teto é o próprio número do card, não um padrão. */
export const POLYMARKET_RANKING_LIMIT = 100;

// ---------------------------------------------------------------------------
// A consulta (filtros)
// ---------------------------------------------------------------------------

/**
 * Os filtros da tela. `strictObject` de propósito: um parâmetro a mais na
 * query string é RECUSADO (400) em vez de ignorado em silêncio — um filtro
 * digitado que não aplica é pior do que um filtro recusado.
 *
 * O `default` é a janela padrão do card, o que faz `GET /ranking` sem query
 * devolver exatamente o PnL oficial de 30 dias.
 */
export const polymarketRankingQuerySchema = z.strictObject({
  timePeriod: z.enum(LEADERBOARD_TIME_PERIODS).default(POLYMARKET_DEFAULT_WINDOW.timePeriod),
  category: polymarketRankingCategorySchema.default(POLYMARKET_DEFAULT_WINDOW.category),
  orderBy: z.enum(LEADERBOARD_ORDER_BY).default(POLYMARKET_DEFAULT_WINDOW.orderBy),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(POLYMARKET_RANKING_LIMIT)
    .default(POLYMARKET_RANKING_LIMIT),
});
export type PolymarketRankingQuery = z.infer<typeof polymarketRankingQuerySchema>;

// ---------------------------------------------------------------------------
// A resposta
// ---------------------------------------------------------------------------

/**
 * Uma linha do ranking, e só o que a origem publica.
 *
 * `pnl` e `vol` são o LITERAL decimal, como TEXTO, pelo mesmo motivo da
 * F2-14: `3654334.788786006` não sobrevive a um `number` do JavaScript. A
 * coluna é `numeric(38, 18)` e o Postgres devolve `numeric` como texto.
 *
 * Não existe campo de score, de badge, de recomendação, de leitura nem de
 * contrato nesta linha. `strictObject` transforma essa ausência em
 * invariante: um campo a mais faria o parse FALHAR em vez de passar em
 * silêncio, que é exatamente o que o card proíbe.
 */
export const polymarketRankingRowSchema = z.strictObject({
  /** Posição declarada pela origem, como TEXTO (a F2-14 prova que vem string). */
  rank: z.string().regex(/^\d{1,9}$/, 'INVALID_RANK'),
  /** Identidade pública do trader na origem. */
  proxyWallet: z.string().regex(/^0x[0-9a-f]{40}$/, 'INVALID_PROXY_WALLET'),
  userName: z.string().max(200),
  /** Valor exato do P&L da origem. */
  pnl: decimalTokenSchema,
  /** Valor exato do volume da origem. */
  vol: decimalTokenSchema,
});
export type PolymarketRankingRow = z.infer<typeof polymarketRankingRowSchema>;

/**
 * O ESTADO DA SÉRIE, lido de `integration.polymarket_series` e nunca
 * deduzido da contagem de linhas.
 *
 * `available` responde "esta janela já foi ingerida alguma vez?", e é ele que
 * separa "a série existe e está truncada" de "a série não existe": as duas
 * situações apareceriam como lista vazia, e elas significam coisas opostas.
 * `ingested` é a quantidade que a ingestão gravou — o que DEVERIA existir para
 * o top 100 ser o top 100, e é o que torna a diferença visível quando a lista
 * vem curta.
 */
export const polymarketRankingSeriesSchema = z.strictObject({
  /** A completude gravada pela F2-14. É o único campo que fala de completude. */
  status: backfillStatusSchema,
  /** A série existe no banco para esta janela? */
  available: z.boolean(),
  /** Registros aceitos pela ingestão nesta série. */
  ingested: z.number().int().nonnegative(),
  /** A data mais antiga que o backfill tentou cobrir. */
  backfillFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'INVALID_BACKFILL_DATE'),
  /** Páginas consumidas e páginas que falharam. */
  pages: z.number().int().nonnegative(),
  failedPages: z.number().int().nonnegative(),
});
export type PolymarketRankingSeries = z.infer<typeof polymarketRankingSeriesSchema>;

/**
 * A amostra, com a MESMA regra de limiar que o resto do produto usa
 * (F2-02/F2-03, `DASHBOARD_MIN_SAMPLE`, padrão 30).
 *
 * A regra do produto para amostra é uma só e ela já existe no repositório: com
 * `N` abaixo do limiar, a tela mostra números crus e nenhum texto de leitura.
 * Este card não cria uma segunda regra — reaproveita a mesma, e é por isso
 * que `lowSample` é calculado aqui e não na interface.
 */
export const polymarketRankingSampleSchema = z.strictObject({
  /** N: quantos registros a tela está exibindo. */
  n: z.number().int().nonnegative(),
  minSample: z.number().int().positive(),
  lowSample: z.boolean(),
});
export type PolymarketRankingSample = z.infer<typeof polymarketRankingSampleSchema>;

/**
 * A aggregate that depends on a COMPLETE series, declared as blocked or
 * allowed — never estimated.
 *
 * The "board total" (the P&L and volume of ALL traders) and each trader's
 * participation in it are the two responses that a truncated series would
 * make up. They live here as an explicit state, not as an absent number: the
 * interface renders the refusal with its reason, and a reader can see that
 * the metric was evaluated and refused — not that it was forgotten.
 */
export const polymarketRankingAggregateSchema = z.strictObject({
  blocked: z.boolean(),
  /** The refusal, or `null` when the series is complete and the metric is legitimate. */
  reason: z.string().min(1).nullable(),
});
export type PolymarketRankingAggregate = z.infer<typeof polymarketRankingAggregateSchema>;

/**
 * The complete payload. `strictObject`: no extra field survives the parse.
 */
export const polymarketRankingSchema = z.strictObject({
  window: z.strictObject({
    category: polymarketRankingCategorySchema,
    timePeriod: z.enum(LEADERBOARD_TIME_PERIODS),
    orderBy: z.enum(LEADERBOARD_ORDER_BY),
  }),
  /** The completeness, already translated into a label and detail for the screen. */
  series: polymarketRankingSeriesSchema,
  /** The label and the text the interface writes about the completeness. */
  completeness: z.strictObject({
    /** The series TRUNCATED? Becomes the visible warning on screen. */
    truncated: z.boolean(),
    label: z.string().min(1),
    detail: z.string().min(1),
  }),
  sample: polymarketRankingSampleSchema,
  /** The board aggregate: blocked with a reason while the series is not complete. */
  aggregate: polymarketRankingAggregateSchema,
  /** How many records the top 100 asked for and how many came back. */
  requested: z.number().int().positive(),
  returned: z.number().int().nonnegative(),
  rows: z.array(polymarketRankingRowSchema),
});
export type PolymarketRanking = z.infer<typeof polymarketRankingSchema>;

// ---------------------------------------------------------------------------
// A completude: a função que decide, e ela é pura
// ---------------------------------------------------------------------------

/**
 * Traduz a completude GRAVADA em rótulo e detalhe, e diz se a série está
 * truncada.
 *
 * Quatro casos, e a distinção entre eles é o trabalho inteiro desta função:
 *
 *  - `available: false` — a janela NUNCA foi ingerida. A resposta NÃO é "0
 *    traders": é "esta janela ainda não foi coletada". Uma lista vazia
 *    apresentada como ausência de trader é a mentira que o card proíbe.
 *
 *  - `status: 'complete'` — a única situação em que a série pode ser tratada
 *    como cobertura total, e ainda assim apenas porque foi OBSERVADA uma
 *    página curta pela F2-14, nunca porque a origem declarou o fim.
 *
 *  - `status: 'truncated'` — o estado real e normal deste backfill. A origem
 *    nunca diz que acabou, então o backfill para no teto de páginas e a
 *    série é truncada. O top 100 é real; o que ele não pode sustentar é uma
 *    afirmação sobre o tabuleiro inteiro.
 *
 *  - `status: 'partial'` — alguma página falhou. É truncamento COM um motivo a
 *    mais, e por isso continua truncada: apresentar uma série com página
 *    falha como completa seria o mesmo erro com aparência de bom senso.
 *
 * A função é pura e não usa relógio: dado o mesmo estado gravado, ela escreve
 * a mesma frase, o que a torna testável sem banco e estável na tela.
 */
export function rankingCompleteness(input: {
  series: Pick<
    PolymarketRankingSeries,
    'status' | 'available' | 'ingested' | 'pages' | 'failedPages'
  >;
}): { truncated: boolean; label: string; detail: string } {
  const { status, available, ingested, pages, failedPages } = input.series;
  if (!available) {
    return {
      truncated: true,
      label: 'Janela ainda não coletada',
      detail:
        'A Polymarket ainda não publicizou esta combinação de período, categoria e ordenação ' +
        'na nossa coleta. Nenhuma conclusão pode ser lida a partir de uma janela ausente, ' +
        'e por isso a lista aparece vazia com esta marca — não como ausência de traders.',
    };
  }
  const where = `nesta janela (${ingested} registros ingeridos em ${pages} ${
    pages === 1 ? 'página' : 'páginas'
  }).`;
  if (status === 'complete')
    return {
      truncated: false,
      label: 'Cobertura completa',
      detail:
        'A coleta observou o fim da paginação desta janela. Os números abaixo são os que a ' +
        `origem publicou, sem estimativa. ${where}`,
    };
  if (status === 'partial')
    return {
      truncated: true,
      label: 'Série truncada com falha de coleta',
      detail:
        `Esta janela está INCOMPLETA: ${failedPages} ${
          failedPages === 1 ? 'página falhou' : 'páginas falharam'
        } na coleta. Os traders listados são reais e os valores são exatos, mas a lista ` +
        `não representa o ranking inteiro. ${where}`,
    };
  if (status === 'unknown')
    return {
      truncated: true,
      label: 'Completude desconhecida',
      detail:
        'A coleta desta janela foi aberta e não foi concluída, então não há como afirmar que ' +
        'a lista representa o ranking inteiro. Os traders listados são reais e os valores são ' +
        `exatos. ${where}`,
    };
  // `truncated`: o estado real e normal deste backfill, porque a origem nunca
  // declara o fim da paginação.
  return {
    truncated: true,
    label: 'Série truncada',
    detail:
      'A Polymarket não declara quando o leaderboard termina, então a coleta para no limite ' +
      'de páginas e a série fica marcada como TRUNCADA. Os traders listados são reais e os ' +
      `valores são exatos, mas a lista NÃO representa o ranking inteiro. ${where}`,
  };
}

/**
 * A política do agregado do tabuleiro: o total de P&L e de volume de TODOS os
 * traders, e a participação de cada um deles nele.
 *
 *Essas duas respostas dependem da série ser `complete`, e só `complete` as
 * autoriza. Enquanto a série estiver `truncated`, `partial` ou `unknown`, a
 * função RECUSA com o motivo — e a recusa é o comportamento correto, não uma
 * falta: exibido sobre uma série incompleta, o "total" seria a soma do que a
 * coleta conseguiu ver, rotulada como se fosse o todo.
 *
 * Não há caminho de código que devolva o número com a série incompleta, e o
 * teste §15 cobre exatamente essa tentativa.
 */
export function rankingAggregatePolicy(
  series: Pick<PolymarketRankingSeries, 'status' | 'available'>,
): { allowed: true; reason: null } | { allowed: false; reason: string } {
  if (!series.available)
    return {
      allowed: false,
      reason:
        'Total e participação do tabuleiro estão bloqueados: esta janela ainda não foi coletada.',
    };
  if (series.status !== 'complete')
    return {
      allowed: false,
      reason:
        'Total e participação do tabuleiro estão bloqueados: a série deste ranking está ' +
        `${rankingStatusLabel(series.status)}, e um total sobre cobertura parcial seria ` +
        'apresentado como o todo.',
    };
  return { allowed: true, reason: null };
}

/** O nome curto de cada estado de completude, para frases. */
export function rankingStatusLabel(
  status: 'complete' | 'truncated' | 'partial' | 'unknown',
): string {
  if (status === 'complete') return 'completa';
  if (status === 'partial') return 'parcial';
  if (status === 'unknown') return 'de completude desconhecida';
  return 'truncada';
}

// ---------------------------------------------------------------------------
// A amostra, pela regra que o produto já usa
// ---------------------------------------------------------------------------

/**
 * A amostra (`N`) com a regra de limiar já existente no produto.
 *
 * `n` é o número de registros EXIBIDOS — é este o `N` honesto, porque é o
 * que o usuário pode conferir na tela. `minSample` chega do servidor (a
 * mesma `DASHBOARD_MIN_SAMPLE` do dashboard analítico) e nunca é presumido
 * aqui, para que a tela do ranking e a tela de análises não discordem sobre o
 * que é amostra pequena.
 */
export function rankingSample(input: { n: number; minSample: number }): PolymarketRankingSample {
  const n = Math.max(0, Math.trunc(input.n));
  const minSample = input.minSample;
  if (!Number.isInteger(minSample) || minSample < 1) throw new Error('INVALID_RANKING_MIN_SAMPLE');
  return { n, minSample, lowSample: n < minSample };
}

// ---------------------------------------------------------------------------
// O decimal exato, para exibição
// ---------------------------------------------------------------------------

/**
 * Formata um decimal da origem para exibição SEM ARREDONDAR.
 *
 * A regra é uma só e ela é verificável: remover os separadores da saída
 * devolve, caractere a caractere, o literal que a origem publicou. Isso é o
 * que permite escrever "valor exato" na tela e dizer a verdade — um
 * arredondamento para exibição seria uma segunda medida, e a segunda medida
 * é a que o card proíbe.
 *
 * O agrupamento é o pt-BR (milhar com ponto, decimal com vírgula) e a moeda é
 * US$, porque é a moeda em que a Polymarket publica. Não há conversão para BRL
 * em lugar nenhum: cotação não é dado de origem, e converter publicaria um
 * número que ninguém mediu.
 */
export function formatExactDecimal(token: string, currency: '' | 'US$' = 'US$'): string {
  if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(token))
    throw new Error('INVALID_DECIMAL_TOKEN');
  const negative = token.startsWith('-');
  const [whole = '0', fraction] = token.replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimal = fraction === undefined ? '' : `,${fraction}`;
  return `${negative ? '−' : ''}${currency} ${grouped}${decimal}`;
}

/** O rótulo de `N` no mesmo formato do resto do produto. */
export const rankingSampleLabel = (n: number) => `N = ${n} ${n === 1 ? 'trader' : 'traders'}`;
