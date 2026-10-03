import { z } from 'zod';
import {
  POLYMARKET_RANKING_CATEGORIES,
  type PolymarketRankingCategory,
} from './polymarket-ranking.js';

/**
 * STK-F3-04 — o CONTRATO da tela Global do Polymarket em CARDS.
 *
 * Este arquivo é a tradução do que a tela Global mostra, e ele tem três
 * decisões que sustentam tudo o mais. Nenhuma delas é comentário: são
 * invariantes verificadas por teste.
 *
 *  1) AS CATEGORIAS SÃO AS OFICIAIS, FILTRADAS — E NÃO UM ENUM NOVO.
 *     A tela Global só mostra esportes e e-sports, porque foi essa a decisão
 *     do proprietário. A lista NÃO inventa rótulo: ela parte das ONZE
 *     categorias que a F2-15 verificou contra a origem
 *     (`POLYMARKET_RANKING_CATEGORIES`) e guarda só `SPORTS` e `ESPORTS`, com
 *     a grafia EXATA que a API exige em maiúsculas. Um filtro lateral que
 *     filtra de verdade vale mais que um rótulo inventado que a origem nunca
 *     aceitou — e o teste prova que as duas categorias da tela estão na
 *     lista oficial, e que nenhuma outra entra.
 *
 *  2) `N` É CAMPO OBRIGATÓRIO E O RótULO É SEMPRE ESCRITO. A R1 do produto
 *     ("N visível em toda métrica derivada") é estrutural aqui: o schema
 *     declara `n` como inteiro POSITIVO e a apresentação escreve o rótulo ao
 *     lado de toda métrica derivada. Não existe caminho de código que produza
 *     uma métrica derivada sem `N` — o par é um objeto só
 *     (`derivedMetric`), não dois campos independentes, porque dois campos
 *     independentes é o que deixa um deles ser esquecido.
 *
 *  3) DESCONHIDO É `null`, E `null` RENDERA "Sem base" — NUNCA 0.
 *     `pnl`, `roi`, `hitRate`, `averageOdds`, `followers`, `wins`, `losses`,
 *     `openBets` e `monthlyUnits` são `string().nullable()`. O texto exato
 *     `"Sem base"` (R1/R2) é o que a tela escreve quando o valor é `null`, e
 *     nenhum formatter deste arquivo transforma `null` em `0`, em `0,00` ou
 *     em célula vazia. `0` e `null` são valores DIFERENTES e o schema os
 *     separa: `'0'` e `null` passam em linhas distintas e produzem saídas
 *     distintas.
 *
 * O QUE ESTE ARQUIVO NÃO CONTÉM, por decisão de produto (R8): Composite Score,
 * badge, selo, avaliação, leitura, recomendação, conselho de aposta e
 * qualquer métrica que vire opinião. Não há campo para isso, e os schemas
 * são `strictObject`: um campo a mais faria o parse FALHAR em vez de
 * aparecer em silêncio.
 *
 * SOBRE A INTEGRAÇÃO: esta tela ainda NÃO está ligada a um endpoint — o gate
 * F2-18 não foi autorizado. Os dados locais vivem em
 * `apps/web/src/product/polymarket-global-data.ts` e são COERENTES com o
 * formato deste schema, não uma lista inventada no componente. A integração
 * pendente está registrada no relatório da tarefa.
 */

/**
 * As DUAS categorias que a tela Global oferece.
 *
 * A derivação é de propósito: se a lista oficial mudar, o filtro acompanha, e
 * o teste falha se `SPORTS`/`ESPORTS` saírem de lá — que é o aviso de que a
 * tela Global precisa ser revista junto com a origem.
 */
export const POLYMARKET_GLOBAL_CATEGORIES = POLYMARKET_RANKING_CATEGORIES.filter(
  (category): category is Extract<PolymarketRankingCategory, 'SPORTS' | 'ESPORTS'> =>
    category === 'SPORTS' || category === 'ESPORTS',
);

export const polymarketGlobalCategorySchema = z.enum(
  POLYMARKET_GLOBAL_CATEGORIES as unknown as [
    Extract<PolymarketRankingCategory, 'SPORTS' | 'ESPORTS'>,
    Extract<PolymarketRankingCategory, 'SPORTS' | 'ESPORTS'>,
  ],
);
export type PolymarketGlobalCategory = z.infer<typeof polymarketGlobalCategorySchema>;

/** O rótulo em português. O VALOR continua sendo o enum oficial da origem. */
export const POLYMARKET_GLOBAL_CATEGORY_LABELS = {
  SPORTS: 'Esportes',
  ESPORTS: 'E-sports',
} as const satisfies Record<PolymarketGlobalCategory, string>;

/**
 * A classificação que o CARD exibe, e ela é mais larga que o filtro.
 *
 * O dono pediu "Sport/E-sport/Ambos" no card. `BOTH` não é uma terceira
 * categoria da origem — é um tipster que aparece nas DUAS listas oficiais.
 * Ele continua sendo uma verdade sobre a origem, e o filtro trata
 * `BOTH` como presente em Esportes E em E-sports, que é o que "ambos" quer
 * dizer. A distinção é necessária porque o card do `POLYMARKET_GLOBAL`
 * precisa mostrar o que a origem de fato devolveu.
 */
export const polymarketGlobalScopeSchema = z.enum(['SPORTS', 'ESPORTS', 'BOTH']);
export type PolymarketGlobalScope = z.infer<typeof polymarketGlobalScopeSchema>;

export const POLYMARKET_GLOBAL_SCOPE_LABELS = {
  SPORTS: 'Esportes',
  ESPORTS: 'E-sports',
  BOTH: 'Ambos',
} as const satisfies Record<PolymarketGlobalScope, string>;

/**
 * Uma métrica derivada e a SUA amostra, no MESMO objeto.
 *
 * Este é o ponto do arquivo. Se `value` e `n` fossem campos separados do
 * card, a R1 ("N visível em toda métrica derivada") seria uma convenção que
 * alguém esquece no próximo card. Sendo um par, não há como renderizar a
 * métrica sem a amostra: o par é o que se renderiza.
 *
 * `value: null` é DESCONHIDO, e a apresentação escreve "Sem base" — nunca 0,
 * nunca vazio. `n` é o NÚMERO de apostas que produziu o valor, e ele é
 * sempre visível mesmo quando o valor é desconhecido: "N" continua sendo um
 * fato, e esconder a amostra junto com o valor esconderia o que sabemos.
 */
export const polymarketDerivedMetricSchema = z.strictObject({
  /** `null` = desconhecido. A string é o LITERAL decimal, como na F2-14. */
  value: z.string().nullable(),
  /** A amostra. Inteiro POSITIVO: uma métrica derivada sem amostra não existe. */
  n: z.number().int().positive(),
});
export type PolymarketDerivedMetric = z.infer<typeof polymarketDerivedMetricSchema>;

/**
 * A completude da COBERTURA do tipster, e ela é por CARD.
 *
 * `truncated: true` significa que a série gravada deste tipster é incompleta.
 * Nesse estado a métrica que depende da série completa é BLOQUEADA: a tela
 * escreve "bloqueado" com o motivo, e `roiBlocked` diz QUAL métrica é. A
 * métrica bloqueada nunca aparece estimada e nunca aparece zero — zero é uma
 * medida, e não houve medida.
 */
export const polymarketGlobalCoverageSchema = z
  .strictObject({
    truncated: z.boolean(),
    /** A razão da truncagem, quando truncada. */
    reason: z.string().min(1).nullable(),
    /** Qual campo derivado está bloqueado por esta truncagem, se algum. */
    roiBlocked: z.boolean(),
  })
  // Truncada SEM razão é um estado que a tela não sabe explicar, e o
  // proprietário pediu que o corte seja visível. Um `reason` nulo com
  // `truncated: true` produziria a etiqueta "Cobertura truncada" sem nenhuma
  // frase abaixo dela — o pior dos dois mundos: o usuário vê o aviso e não
  // sabe o que ele significa. O `superRefine` é o que garante que a razão
  // existe sempre que o aviso aparece.
  .refine((coverage) => !coverage.truncated || coverage.reason !== null, {
    message: 'TRUNCATED_WITHOUT_REASON',
  });
export type PolymarketGlobalCoverage = z.infer<typeof polymarketGlobalCoverageSchema>;

/**
 * Um card de tipster. `strictObject`: nada entra por cima disto.
 */
export const polymarketGlobalCardSchema = z.strictObject({
  /** A carteira pública: a identidade estável, e a chave da lista. */
  proxyWallet: z.string().regex(/^0x[0-9a-f]{40}$/, 'INVALID_PROXY_WALLET'),
  userName: z.string().max(200),
  /**
   * O avatar é uma INICIAL derivada, não uma URL: a tela Global é densa e
   * não há endpoint de imagem autorizado. Guardar a URL aqui abriria uma
   * janela para um `<img>` remoto numa tela que não pede rede.
   */
  avatarSeed: z.string().min(1).max(64),
  /** Em quais das DUAS listas oficiais o tipster aparece. */
  scope: polymarketGlobalScopeSchema,
  /** A posição DECLARADA pela origem, como TEXTO (rank não é medida). */
  rank: z.string().regex(/^\d{1,9}$/, 'INVALID_RANK'),
  /** P&L de 30 dias, com a amostra. */
  pnl: polymarketDerivedMetricSchema,
  /** Volume, com a amostra. */
  volume: polymarketDerivedMetricSchema,
  /** Retorno sobre a aposta, com a amostra. */
  roi: polymarketDerivedMetricSchema,
  /** Taxa de acerto, com a amostra. */
  hitRate: polymarketDerivedMetricSchema,
  /** Odd média, com a amostra. */
  averageOdds: polymarketDerivedMetricSchema,
  /** Quem segue o tipster, com a amostra. */
  followers: polymarketDerivedMetricSchema,
  wins: polymarketDerivedMetricSchema,
  losses: polymarketDerivedMetricSchema,
  openBets: polymarketDerivedMetricSchema,
  /** Unidades por mês: a métrica de R5, e ela NUNCA some. */
  monthlyUnits: polymarketDerivedMetricSchema,
  /** O mercado de maior participação do tipster. `null` = desconhecido. */
  topMarket: z.string().max(200).nullable(),
  coverage: polymarketGlobalCoverageSchema,
});
export type PolymarketGlobalCard = z.infer<typeof polymarketGlobalCardSchema>;

/** O payload da tela. */
export const polymarketGlobalResponseSchema = z.strictObject({
  cards: z.array(polymarketGlobalCardSchema),
  /** A origem desta tela: "local" enquanto a integração não existe. */
  source: z.enum(['local', 'api']),
  requested: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
});
export type PolymarketGlobalResponse = z.infer<typeof polymarketGlobalResponseSchema>;

/**
 * R1 — o texto de um valor desconhecido. Um literal, uma regra, e nenhum
 * formatter deste módulo o reconstrói: ele é declarado aqui e reusado, para
 * que "Sem base" seja sempre a MESMA palavra na tela e no teste.
 */
export const SEM_BASE = 'Sem base';

/** O texto de uma métrica bloqueada por truncagem de cobertura. */
export const METRIC_BLOCKED = 'bloqueado';

/**
 * Formata um literal decimal da origem para exibição em pt-BR, SEM
 * arredondar — a mesma regra de `formatExactDecimal` da F2-15, reaproveitada
 * em vez de reinventada. `null` vira "Sem base", nunca zero.
 */
export function formatGlobalDecimal(token: string | null): string {
  if (token === null) return SEM_BASE;
  if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(token))
    throw new Error('INVALID_DECIMAL_TOKEN');
  const negative = token.startsWith('-');
  const [whole = '0', fraction] = token.replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimal = fraction === undefined ? '' : `,${fraction}`;
  return `${negative ? '−' : ''}${grouped}${decimal}`;
}

/** Formata um percentual com uma casa, em pt-BR. `null` vira "Sem base". */
export function formatGlobalPercent(token: string | null): string {
  if (token === null) return SEM_BASE;
  if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(token))
    throw new Error('INVALID_DECIMAL_TOKEN');
  const negative = token.startsWith('-');
  const [whole = '0', fraction] = token.replace(/^-/, '').split('.');
  const first = (fraction ?? '0')[0] ?? '0';
  return `${negative ? '−' : ''}${whole},${first}%`;
}

/** O rótulo de `N` ao lado da métrica. Presente mesmo quando o valor é nulo. */
export function globalSampleLabel(n: number): string {
  return `N=${new Intl.NumberFormat('pt-BR').format(n)}`;
}

/**
 * A ORDENAÇÃO da tela Global. Três opções, e ela ordena de verdade: a
 * complaints do dono foi filtro que "não fazia nada", e um `<select>` que não
 * muda a ordem é exatamente isso.
 *
 * O critério de ordenação é EXPLÍCITO e separado: cada opção diz qual campo
 * compara, e a comparação trata `null` como ÚLTIMO — nunca como zero. Um
 * tipster sem ROI medido não pode subir para o topo por "não ter ROI", que é
 * a leitura errada que a R2 proíbe.
 */
export const POLYMARKET_GLOBAL_SORTS = ['PNL', 'ROI', 'VOLUME'] as const;
export type PolymarketGlobalSort = (typeof POLYMARKET_GLOBAL_SORTS)[number];

export const POLYMARKET_GLOBAL_SORT_LABELS = {
  PNL: 'PnL',
  ROI: 'ROI',
  VOLUME: 'Volume',
} as const satisfies Record<PolymarketGlobalSort, string>;

/** O filtro de categoria da tela, incluindo "Todos". */
export const POLYMARKET_GLOBAL_FILTERS = ['ALL', ...POLYMARKET_GLOBAL_CATEGORIES] as const;
export type PolymarketGlobalFilter = (typeof POLYMARKET_GLOBAL_FILTERS)[number];

export const POLYMARKET_GLOBAL_FILTER_LABELS = {
  ALL: 'Todos',
  SPORTS: 'Esportes',
  ESPORTS: 'E-sports',
} as const satisfies Record<PolymarketGlobalFilter, string>;

/**
 * O filtro de categoria, e ele FILTRA DE VERDADE.
 *
 * `BOTH` aparece em AMBOS os filtros: o tipster está na lista de esportes E
 * na de e-sports, e escondê-lo de um dos lados seria afirmar que ele não
 * está naquele mercado. `ALL` não filtra nada.
 */
export function globalCategoryMatches(
  card: Pick<PolymarketGlobalCard, 'scope'>,
  filter: PolymarketGlobalFilter,
): boolean {
  if (filter === 'ALL') return true;
  return card.scope === filter || card.scope === 'BOTH';
}

/**
 * Compara dois literais decimais SEM convertê-los em `number`.
 *
 * O motivo é o mesmo da F2-14: `2666493.7190210004` já perdeu algarismo
 * quando o JSON foi descompactado, e ordená-lo por `Number()` repete a
 * perda num lugar novo. A comparação é por cadeia, alinhada por casas.
 */
function compareDecimal(a: string, b: string): number {
  const negativeA = a.startsWith('-');
  const negativeB = b.startsWith('-');
  if (negativeA !== negativeB) return negativeA ? -1 : 1;
  const magnitude = compareMagnitude(a.replace(/^-/, ''), b.replace(/^-/, ''));
  return negativeA ? -magnitude : magnitude;
}

function compareMagnitude(a: string, b: string): number {
  const [wholeA = '0', fractionA = ''] = a.split('.');
  const [wholeB = '0', fractionB = ''] = b.split('.');
  if (wholeA.length !== wholeB.length) return wholeA.length - wholeB.length;
  if (wholeA !== wholeB) return wholeA < wholeB ? -1 : 1;
  const length = Math.max(fractionA.length, fractionB.length);
  const left = fractionA.padEnd(length, '0');
  const right = fractionB.padEnd(length, '0');
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * A ordenação da tela. `null` vai para o FIM, em qualquer critério, e o
 * empate é pela POSIÇÃO DECLARADA pela origem — nunca por uma métrica nossa.
 */
export function globalSortCards(
  cards: readonly PolymarketGlobalCard[],
  sort: PolymarketGlobalSort,
): PolymarketGlobalCard[] {
  // A chave é uma UNIÃO de campos, não `string`: indexar o card por `string`
  // não compila contra um `strictObject`, e afrouxar o tipo com `any`
  // resolveria o erro devolvendo a garantia de que o campo existe. O
  // `Record` abaixo é o que liga cada opção de ordenação ao campo que ela
  // realmente mede — o que impede um critério apontar para o campo errado em
  // silêncio, que era a falha que o dono viu no filtro.
  const field: Record<PolymarketGlobalSort, 'pnl' | 'roi' | 'volume'> = {
    PNL: 'pnl',
    ROI: 'roi',
    VOLUME: 'volume',
  };
  const key = field[sort];
  return [...cards].sort((left, right) => {
    const a = left[key].value;
    const b = right[key].value;
    if (a === null && b === null) return compareRank(left.rank, right.rank);
    if (a === null) return 1;
    if (b === null) return -1;
    // DESCENDENTE, e o sinal é o que faz isso. `compareDecimal` ordena do
    // menor para o maior, que é o que uma comparação de magnitude faz
    // naturalmente — mas um RANKING põe o MAIOR primeiro, e inverter o sinal
    // é o que expressa isso. A inversão já existiu como bug: a tela abria
    // com o tipster de MENOR PnL no topo, o que é o oposto de um ranking, e o
    // único teste que existia affinei o comportamento errado em vez de
    // exigi-lo.
    const byField = -compareDecimal(a, b);
    return byField !== 0 ? byField : compareRank(left.rank, right.rank);
  });
}

/**
 * A comparação de decimais exposta para teste.
 *
 * Ela é a MESMA função que a ordenação usa, e não uma cópia reescrita: um
 * teste que copiasse a comparação provaria a cópia. A exportação existe
 * porque a garantia que importa — a ordenação não passar por `Number()` — é
 * verificável diretamente sobre a comparação.
 */
export const compareDecimalForTest = compareDecimal;

function compareRank(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  return left === right ? 0 : left - right;
}

/**
 * A INICIAL do avatar, derivada do nome publicado.
 *
 * Uma inicial, nunca duas: duas letras num disco de 32px leem como um logo,
 * e o avatar aqui é um marcador de identidade, não um retrato. `null`/vazio é
 * um caso REAL da origem (o schema do leaderboard traz `userName` com
 * `.catch('')`), então a função tem resposta para ele e não devolve string
 * vazia — devolve `?`, que é o que a tela escreve como "nome não informado"
 * sem inventar um nome.
 */
export function globalAvatarInitial(userName: string): string {
  const trimmed = userName.trim();
  if (trimmed === '') return '?';
  const first = [...trimmed][0] ?? '?';
  return first.toUpperCase();
}

/**
 * O nome de exibição com a marca de TRUNCAMENTO VISÍVEL.
 *
 * A R4 do dono: nome longo tem que mostrar reticências DE PROPÓSITO, nunca
 * cortar sem sinal. A função devolve o texto e o número de caracteres
 * realmente exibidos, e o componente escreve as reticências com um
 * elemento próprio (`…`) em vez de confiar em `text-overflow` — porque
 * `text-overflow` SOME no accessibility tree e no innerText, e um leitor de
 * tela precisa ouvir que o nome continua.
 *
 * O limite é o que cabe no card, e ele é uma CONSTANTE do produto, não um
 * número solto no componente.
 */
export const GLOBAL_NAME_MAX = 22;
export const GLOBAL_MARKET_MAX = 34;

export interface TruncatedText {
  /** O que a tela mostra, já com a reticência quando cortou. */
  text: string;
  /** Cortou? Decide se o `title`/`aria-label` é preenchido. */
  truncated: boolean;
}

/** Aplica o truncamento visível a um texto qualquer. */
export function globalTruncate(value: string, max: number): TruncatedText {
  const characters = [...value];
  if (characters.length <= max) return { text: value, truncated: false };
  return { text: `${characters.slice(0, Math.max(1, max - 1)).join('')}…`, truncated: true };
}

/** O nome do tipster, truncado com reticência visível. */
export function globalNameView(userName: string): TruncatedText {
  return globalTruncate(
    userName.trim() === '' ? '(sem nome informado)' : userName.trim(),
    GLOBAL_NAME_MAX,
  );
}

/** O mercado de maior participação, truncado com reticência visível. */
export function globalMarketView(topMarket: string | null): TruncatedText {
  if (topMarket === null) return { text: SEM_BASE, truncated: false };
  return globalTruncate(topMarket, GLOBAL_MARKET_MAX);
}
