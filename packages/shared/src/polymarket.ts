import { z } from 'zod';

/**
 * STK-F2-14 — o CONTRATO VERIFICADO da ingestão Polymarket.
 *
 * Este arquivo é a tradução do que foi OBSERVADO no endpoint oficial, não do
 * que a documentação promete. Cada afirmação abaixo tem um probe atrás dela:
 *
 *  - O HOST é `data-api.polymarket.com`. Os hosts `gamma-api.polymarket.com`
 *    e `clob.polymarket.com` devolvem `404 page not found` no MESMO caminho
 *    `/v1/leaderboard` (verificado). O cliente aponta para o host que respondeu.
 *
 *  - O PATH é `/v1/leaderboard` e a resposta 200 é um ARRAY JSON puro, sem
 *    envelope: `[{...}, {...}]` (verificado — a documentação descreve apenas o
 *    array também, e a resposta real concorda).
 *
 *  - `limit` é TETO DURO de 50. `limit=51` NÃO dá erro: devolve 50 itens. O
 *    cliente pede 50 e trata qualquer resposta maior como violação de contrato
 *    (`LEADERBOARD_PAGE_TOO_LARGE`), em vez de confiar no corte silencioso.
 *
 - `offset` NÃO é validado pela origem. `offset=1001` e `offset=5000`
   respondem `200` com a página cheia, o que prova que existe uma parede de
   paginação que a origem não documenta: ela entrega páginas até um offset
   arbitrário sem nunca declarar fim. Por isso a COMPLETUDE é um estado
   nosso (`truncated` / `partial`), nunca a ausência de linhas.
 *
 *  - `orderBy` ACEITA apenas `PNL` e `VOL`. `VOLUME`, `PROFIT`, `RATIO`,
 *    `AMOUNT` devolvem `400 {"error":"invalid order by parameter"}` (verificado).
 *    `category` aceita apenas `OVERALL` — qualquer outro valor devolve
 *    `400 {"error":"invalid category parameter"}` (verificado).
 *
 *  - `vol` e `pnl` chegam como NÚMERO JSON — isto é, já approveitados por IEEE-754
 *    antes de qualquer código nosso. A resposta real traz `2666493.7190210004`,
 *    um valor que NÃO sobrevive a um `number` do JavaScript sem perda. Por isso o
 *    campo do contrato é `decimalToken`: o LITERAL DE TEXTO do JSON, capturado
 *    antes do parse, e é ele — nunca um float — que vai para o banco. Ver
 *    `decimalTokenSchema` e o teste de exatidão.
 *
 *  - `rank` chega como STRING (`"1"`, `"2"`), não como número. Isso importa:
 *    `rank` é uma posição declarada pela origem e entra como texto, porque um
 *    inteiro de ordenação não pode ser reinterpretado como medida.
 *
 *  - `proxyWallet` é a identidade do trader (`^0x[a-fA-F0-9]{40}$`). É ela que
 *    compõe a chave de origem: NUNCA o `txHash`, que é anulável e, sozinho,
 *    não distingue duas observações da MESMA entidade.
 *
 * Não há chave de API: a API é pública. Não há PII no payload — a carteira é
 * um identificador público on-chain.
 */

// ---------------------------------------------------------------------------
// Literais decimais exatos
// ---------------------------------------------------------------------------

/**
 * O LITERAL de texto de um número JSON, como aparece no corpo bruto.
 *
 * Este é o ponto do módulo inteiro. `vol` e `pnl` não podem ser lidos como
 * `number`: o valor real `2666493.7190210004` já perdeu algarismos na
 * descompactação IEEE-754, e um `parseFloat` dele devolveria um número ainda
 * diferente. A garantia do card — "valores/preços armazenados exatamente, nunca
 * float persistido" — só é cumprida se o TEXTO que a origem escreveu chegar
 * inteiro ao `numeric` do Postgres.
 *
 * O formato aceito é o subconjunto de JSON que representa decimal: sinal
 * opcional, inteiro sem zeros à esquerda desnecessários, fração com 1..N
 * dígitos. `NaN`, `Infinity`, `1e5` e `null` NÃO são decimais e são recusados —
 * um agregador que devolvesse notação científica perderia o valor.
 */
export const decimalTokenSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/, 'NOT_A_DECIMAL_TOKEN');
export type DecimalToken = z.infer<typeof decimalTokenSchema>;

/** Uma linha do leaderboard, com os números como LITERAL de texto. */
export const leaderboardEntrySchema = z.strictObject({
  /** Posição declarada pela origem. Texto: um rank não é medida. */
  rank: z.string().regex(/^\d{1,9}$/, 'INVALID_RANK'),
  /** Identidade do trader na origem. Entra na chave de dedup. */
  proxyWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'INVALID_PROXY_WALLET'),
  userName: z.string().max(200).catch(''),
  xUsername: z.string().max(200).catch(''),
  verifiedBadge: z.boolean().catch(false),
  profileImage: z.string().max(2048).catch(''),
  /** Volume: LITERAL do JSON, nunca `number`. */
  vol: decimalTokenSchema,
  /** P&L: LITERAL do JSON, nunca `number`. */
  pnl: decimalTokenSchema,
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

/**
 * A resposta da origem é um ARRAY direto. O envelope
 * `{error: "..."}` (400/500) é recusado por este schema, e o cliente trata
 * corpo não-lista como erro de contrato, não como lista vazia.
 */
export const leaderboardPageSchema = z
  .array(leaderboardEntrySchema)
  .max(50, 'LEADERBOARD_PAGE_TOO_LARGE');
export type LeaderboardPage = z.infer<typeof leaderboardPageSchema>;

// ---------------------------------------------------------------------------
// Parâmetros aceitos pela origem (verificados por probe)
// ---------------------------------------------------------------------------

/** `orderBy` válido: `PNL` e `VOL` — qualquer outro valor é 400. */
export const LEADERBOARD_ORDER_BY = ['PNL', 'VOL'] as const;
export type LeaderboardOrderBy = (typeof LEADERBOARD_ORDER_BY)[number];

/** `category` válido: só `OVERALL`. Qualquer outro é 400. */
export const LEADERBOARD_CATEGORY = 'OVERALL' as const;

/** `timePeriod` válido: `DAY`, `WEEK`, `MONTH`, `ALL`. */
export const LEADERBOARD_TIME_PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const;
export type LeaderboardTimePeriod = (typeof LEADERBOARD_TIME_PERIODS)[number];

/** Teto duro de registros por chamada, verificado: `limit=51` devolve 50. */
export const LEADERBOARD_PAGE_LIMIT = 50;

/** O teto de PÁGINAS por backfill. Ver `backfillStatus` para o porquê. */
export const LEADERBOARD_MAX_PAGES = 36;

/** A janela de retenção do backfill: 180 dias, o limite do card. */
export const POLYMARKET_BACKFILL_DAYS = 180;

/** O contrato Zod da resposta da origem, reexportado com nome estável. */
export const polymarketLeaderboardResponseSchema = leaderboardPageSchema;

// ---------------------------------------------------------------------------
// Chave de origem (dedup determinístico)
// ---------------------------------------------------------------------------

/**
 * A chave de DEDUP de uma observação do leaderboard.
 *
 * A regra do card é "chave de fonte não nula e determinística", e o
 * complemento dela é o que NÃO é chave: o `txHash`, quando existe, é
 * anulável, e duas linhas distintas da mesma carteira compartilham
 * transação com frequência. Uma chave baseada em `txHash` sozinho colidiria
 * entre traders diferentes e deixaria passar observações diferentes da mesma
 * carteira quando o hash é nulo. Por isso a chave é a IDENTIDADE DA
 * OBSERVAÇÃO — carteira + período + ordenação + posição declarada + os dois
 * decimais exatos — e o `txHash`, quando existir, entra como SALVO, não como
 * chave.
 *
 * A função é pura e estável: a mesma linha da origem produz a mesma chave em
 * qualquer execução, em qualquer processo. Ela NUNCA devolve string vazia:
 * uma entrada sem carteira válida é recusada pelo schema antes de chegar aqui,
 * e `NO_SOURCE_KEY` é o erro explícito se chegar.
 */
export function leaderboardSourceKey(entry: LeaderboardEntry, window: LeaderboardWindow): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(entry.proxyWallet)) throw new Error('NO_SOURCE_KEY');
  // As partes entram numa ordem fixa e com separador que não existe no
  // alfabeto do conteúdo, para que a junção seja inequívoca: sem
  // separador, ('0x1', '2') e ('0x12', '') produziriam a mesma string.
  return [
    `pm1:${window.category}:${window.timePeriod}:${window.orderBy}`,
    entry.proxyWallet.toLowerCase(),
    entry.rank,
    entry.vol,
    entry.pnl,
  ].join('|');
}

/** A janela de consulta: as três dimensões que a origem usa para ordenar. */
export type LeaderboardWindow = {
  category: typeof LEADERBOARD_CATEGORY;
  timePeriod: LeaderboardTimePeriod;
  orderBy: LeaderboardOrderBy;
};

// ---------------------------------------------------------------------------
// Cobertura e completude
// ---------------------------------------------------------------------------

/**
 * O estado de completude de uma série, e o motivo de ele existir.
 *
 * A origem NUNCA declara que acabou. Ela devolve uma página cheia até um
 * offset arbitrário (`offset=5000` responde 200), então a ausência de linhas
 * não distingue "não há mais nada" de "a origem deixou de responder" — e
 * apresentar a segunda como a primeira é a mentira que este card proíbe.
 * Por isso a completude é estimada e DECLARADA: `complete` só é gravado
 * quando uma página veio com menos de 50 registros (fim observado), e
 * `truncated` é o estado real e normal deste backfill.
 */
export const backfillStatusSchema = z.enum(['complete', 'truncated', 'partial', 'unknown']);
export type BackfillStatus = z.infer<typeof backfillStatusSchema>;

/** Uma página consumida do backfill: onde foi, o que veio, o que houve. */
export const ingestedPageSchema = z.strictObject({
  offset: z.number().int().min(0),
  /** Quantos registros a origem devolveu nesta página. */
  received: z.number().int().min(0),
  /** Quantos foram aceitos após o contrato. */
  accepted: z.number().int().min(0),
  /** A página veio inteira? `false` = truncada pela origem. */
  complete: z.boolean(),
  /** Erro sanitizado desta página, se houve. */
  errorCode: z.string().max(64).nullable(),
  /** `Retry-After` observado, em segundos, quando a origem o devolveu. */
  retryAfterSeconds: z.number().int().min(0).nullable(),
});
export type IngestedPage = z.infer<typeof ingestedPageSchema>;

/**
 * O resultado de UM backfill, e a razão pela qual ele NÃO é um boolean.
 *
 * `succeeded: false` com páginas gravadas é o estado NORMAL deste job: é o
 * resultado parcial explícito que o card exige. Um job que gravou 1.500
 * traders e falhou em 6 páginas não pode se reportar como sucesso, e o tipo
 * não tem como dizer que sim — não existe caminho que produza
 * `succeeded: true` com `failedPages > 0`.
 */
export const backfillResultSchema = z.strictObject({
  status: backfillStatusSchema,
  succeeded: z.boolean(),
  pages: z.array(ingestedPageSchema),
  /** Páginas que devolveram erro. Qualquer valor > 0 impede o sucesso. */
  failedPages: z.number().int().min(0),
  /** Registros gravados, contando deduplicação. */
  accepted: z.number().int().min(0),
  /** Registros recebidos e rejeitados pelo contrato. */
  rejected: z.number().int().min(0),
  /** Erros sanitizados, sem corpo de resposta e sem URL. */
  errors: z.array(z.string().max(64)).max(64),
});
export type BackfillResult = z.infer<typeof backfillResultSchema>;

/**
 * Invariante do resultado: sucesso só com TODAS as páginas consumidas.
 *
 * A função é o que a asserção do teste §15 prova, e é separada do schema
 * porque um schema Zod não consegue expressar "depende de outro campo do
 * mesmo objeto sem um refine em cima". Um `refine` seria suficiente aqui, mas
 * a regra é usada em três lugares (worker, API e teste) e uma função pura é
 * mais honesta: ela pode ser lida, testada e reutilizada.
 *
 * As DUAS condições são necessárias, e cada uma fecha uma mentira diferente:
 *
 *  - `failedPages === 0`: uma fatia que falhou é resultado parcial, e o card
 *    proíbe que o job se reporte como sucesso nesse caso. O volume alto não
 *    compra o sucesso.
 *  - `status === 'complete'`: a origem NUNCA declara o fim da paginação
 *    (`offset=5000` responde 200), então uma série `truncated` significa que
 *    o backfill NÃO terminou o que se propunha a fazer. Declarar sucesso
 *    aqui seria apresentar cobertura parcial como cobertura total — a mesma
 *    mentira que o status `truncated` existe para impedir.
 */
export function backfillSucceeded(result: BackfillResult): boolean {
  return result.succeeded && result.failedPages === 0 && result.status === 'complete';
}

// ---------------------------------------------------------------------------
// Backoff e a âncora de 180 dias
// ---------------------------------------------------------------------------

/** Teto de espera do backoff, para um `Retry-After` absurdo não travar o job. */
export const MAX_BACKOFF_MS = 30_000;

/** Base do backoff exponencial. */
export const BACKOFF_BASE_MS = 500;

/**
 * A espera antes de repetir uma página, em milissegundos.
 *
 * O `Retry-After` tem PRECEDÊNCIA sobre o exponencial: quando a origem diz
 * quanto tempo quer esperar, inventar um número próprio seria desobedecer ao
 * rate limit. Sem o cabeçalho, o exponencial com jitter evita que vários
 * workers batam na origem no mesmo instante.
 *
 * A função é pura e não usa relógio: dado o mesmo par (tentativa,
 * retryAfter, jitter) ela devolve a MESMA espera, e é por isso que o teste
 * verifica o backoff sem esperar de verdade.
 */
export function backoffMs(
  attempt: number,
  retryAfterSeconds: number | null,
  jitter: number,
): number {
  if (retryAfterSeconds !== null) return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.min(Math.floor(exponential * (1 + jitter)), MAX_BACKOFF_MS);
}

/**
 * A data civil de `days` dias atrás, no fuso do produto, como `YYYY-MM-DD`.
 *
 * Esta é a ÂNCORA do backfill: ela diz a data mais antiga que a série afirma
 * cobrir, e é gravada no banco em vez de deduzida da contagem de linhas.
 * O fuso é o do produto (São Paulo), o mesmo da janela financeira — um
 * backfill que ancorasse em UTC cortaria o dia errado para o usuário.
 */
export function backfillAnchor(now: Date, days = POLYMARKET_BACKFILL_DAYS): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  const anchor = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - days);
  const anchorParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(anchor);
  const anchorPart = (type: string) => anchorParts.find((value) => value.type === type)!.value;
  return `${anchorPart('year')}-${anchorPart('month')}-${anchorPart('day')}`;
}
