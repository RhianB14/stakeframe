import { randomUUID } from 'node:crypto';
import {
  LEADERBOARD_CATEGORY,
  LEADERBOARD_PAGE_LIMIT,
  leaderboardPageSchema,
  type LeaderboardPage,
  type LeaderboardOrderBy,
  type LeaderboardTimePeriod,
  type LeaderboardWindow,
} from '@stakeframe/shared';
import { IntegrationError, readBounded } from './http.js';

/**
 * STK-F2-14 — o cliente da API oficial do leaderboard Polymarket.
 *
 * O contrato deste arquivo foi VERIFICADO contra a origem, e as conclusoes
 * estao comentadas aqui e em `packages/shared/src/polymarket.ts`. O resumo do
 * que os probes viram de verdade:
 *
 *   host      data-api.polymarket.com   (gamma/clob devolvem 404 neste path)
 *   path      /v1/leaderboard
 *   resposta  ARRAY JSON direto, sem envelope
 *   limite    50 por chamada (teto duro; limit=51 devolve 50)
 *   orderBy   PNL | VOL   (VOLUME/PROFIT/RATIO => 400)
 *   category  OVERALL     (qualquer outro => 400)
 *
 * O que este cliente NAO faz, deliberadamente:
 *
 *  - NAO serializa numeros. A resposta e lida do TEXTO do corpo e cada
 *    `vol`/`pnl` e capturado como LITERAL. Um `JSON.parse` normal ja teria
 *    degradado `2666493.7190210004` para o double mais proximo, e esse
 *    double, reformatado, nao volta ao literal.
 *
 *  - NAO da `float` para o banco, em nenhuma hipotese. O que sai daqui e
 *    string decimal exata.
 *
 *  - NAO confia em pagina cheia para dizer que acabou. A origem entrega
 *    pagina cheia em `offset=5000`, entao a ultima pagina CURTA e o unico
 *    sinal de fim — e ainda assim e um sinal OBSERVADO, nao declarado.
 *
 *  - NAO repete chamada cujo resultado e incerto. Um timeout depois do envio
 *    pode ter gravado algo; repetir seria duplicar por ignorancia. O codigo
 *    `POLYMARKET_UNCERTAIN` e distinto do erro de status justamente para que
 *    o chamador decida com essa distincao a vista.
 */

// O host que RESPONDEU. Os outros dois devolvem 404 neste mesmo path.
const LEADERBOARD_ORIGIN = 'https://data-api.polymarket.com';
const LEADERBOARD_PATH = '/v1/leaderboard';

/** Teto de corpo: uma pagina de 50 linhas cabe folgadamente em 1 MiB. */
const MAX_BODY_BYTES = 1_048_576;

/** Timeout por chamada. A doc oficial sugere 30s; usamos 20s. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Token numerico aceito como decimal exato: ate 18 inteiros e 18 decimais. */
const EXACT_DECIMAL = /^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

/** Forma de um numero JSON, incluindo notacao cientifica (que recusamos). */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

export type LeaderboardClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  signal?: AbortSignal;
};

/** Uma pagina lida da origem, com os decimais ainda em texto. */
export type FetchedPage = {
  offset: number;
  entries: LeaderboardPage;
  /** A pagina veio com menos registros que o teto? So entao observamos fim. */
  observedEnd: boolean;
};

export type LeaderboardClient = {
  fetchPage(params: {
    window: LeaderboardWindow;
    offset: number;
    limit?: number;
  }): Promise<FetchedPage>;
  window(
    category: typeof LEADERBOARD_CATEGORY,
    timePeriod: LeaderboardTimePeriod,
    orderBy: LeaderboardOrderBy,
  ): LeaderboardWindow;
};

/**
 * Reescreve o corpo para que um `JSON.parse` devolva os numeros como TEXTO.
 *
 * O problema que isto resolve: `JSON.parse` converte todo numero em double e
 * o round-trip ja perdeu digitos. A resposta real traz
 * `2666493.7190210004`; `JSON.parse` seguido de `String(...)` devolveria
 * `2666493.719021`. O card proibe exatamente essa perda, entao o corpo nunca
 * passa por `Number`.
 *
 * A estrategia e um SCANNER de caracteres, nao um regex global sobre o texto:
 * o scanner sabe quando esta dentro de uma string e so troca numeros que sao
 * VALORES do JSON. Um numero escrito dentro de uma string (o sufixo de um
 * `userName`, por exemplo) nunca e tocado, o que torna o round-trip fiel por
 * construcao.
 *
 * Cada numero valido e trocado por um sentinela ALEATORIO entre aspas, e o
 * sentinela e restaurado para o literal original logo apos o parse. O
 * sentinela e aleatorio de proposito: um sentinela fixo poderia colidir com
 * o conteudo real de um `userName` e corromper dado da origem.
 */
export function withLiteralDecimals(body: string): unknown {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const pattern = new RegExp(`__pm${nonce}l([0-9]+)__`, 'g');
  const literals: string[] = [];

  let out = '';
  let cursor = 0;
  let inString = false;
  let escaped = false;
  while (cursor < body.length) {
    const char = body[cursor]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      cursor += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      cursor += 1;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const rest = body.slice(cursor);
      const token = JSON_NUMBER.exec(rest)?.[0];
      if (token && EXACT_DECIMAL.test(token)) {
        literals.push(token);
        out += `"__pm${nonce}l${literals.length - 1}__"`;
        cursor += token.length;
        continue;
      }
      // Token fora do formato (notacao cientifica, gigante demais): fica
      // como numero e o schema vai recusar a linha, que e o comportamento
      // correto quando a origem sai do contrato.
      out += token ?? char;
      cursor += token ? token.length : 1;
      continue;
    }
    out += char;
    cursor += 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out) as unknown;
  } catch {
    throw new IntegrationError('INVALID_JSON_RESPONSE');
  }
  const restore = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(pattern, (_all, slot: string) => literals[Number(slot)] ?? '');
    }
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, restore(item)]),
      );
    }
    return value;
  };
  return restore(parsed);
}

/**
 * Le o valor do cabecalho `Retry-After`, em segundos.
 *
 * A forma observada nesta origem e o numero de segundos. A forma HTTP-date
 * tambem e valida por especificacao, mas nao e usada aqui: em vez de supor,
 * o leitor devolve `null` para a data e o chamador cai no backoff padrao —
 * que e a decisao segura quando nao ha prazo confiavel.
 */
export function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}

export function createPolymarketLeaderboardClient(
  options: LeaderboardClientOptions = {},
): LeaderboardClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  const window = (
    category: typeof LEADERBOARD_CATEGORY,
    timePeriod: LeaderboardTimePeriod,
    orderBy: LeaderboardOrderBy,
  ): LeaderboardWindow => ({ category, timePeriod, orderBy });

  async function fetchPage(params: {
    window: LeaderboardWindow;
    offset: number;
    limit?: number;
  }): Promise<FetchedPage> {
    const { window: win, offset } = params;
    // O teto e nosso e 50: pedimos 50 e, se a origem devolver MAIS do que
    // pedimos, isso e violacao de contrato e a pagina e recusada pelo
    // schema — nunca truncada em silencio.
    const limit = Math.min(params.limit ?? LEADERBOARD_PAGE_LIMIT, LEADERBOARD_PAGE_LIMIT);
    const url = new URL(LEADERBOARD_PATH, LEADERBOARD_ORIGIN);
    url.searchParams.set('category', win.category);
    url.searchParams.set('timePeriod', win.timePeriod);
    url.searchParams.set('orderBy', win.orderBy);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      // Timeout, abort ou conexao recusada. O codigo e deliberadamente
      // distinto do erro de status: a resposta pode nao ter sido
      // processada, e quem decide se repete e o chamador.
      throw new IntegrationError('POLYMARKET_UNCERTAIN', { offset });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) {
      // O corpo de erro NAO entra na excecao: so status e Retry-After.
      await response.body?.cancel().catch(() => undefined);
      const wait = retryAfterSeconds(response);
      throw new IntegrationError(
        response.status === 429 ? 'POLYMARKET_RATE_LIMITED' : 'POLYMARKET_STATUS_ERROR',
        { status: response.status, offset, ...(wait !== null ? { retryAfter: wait } : {}) },
      );
    }

    // Limite de corpo: uma resposta maior que o teto e recusada ANTES de
    // virar string, para que um corpo gigante nao vire alocacao.
    const body = (await readBounded(response, maxBodyBytes)).toString('utf8');

    // So aqui os numeros viram LITERAL. O `readBounded` ja garantiu o teto.
    const result = leaderboardPageSchema.safeParse(withLiteralDecimals(body));
    if (!result.success) {
      throw new IntegrationError('POLYMARKET_CONTRACT_VIOLATION', {
        offset,
        // O motivo e o codigo do PRIMEIRO issue do schema: nunca a
        // mensagem do Zod, que carregaria o valor recebido.
        reason: result.error.issues[0]?.code ?? 'INVALID_PAGE',
      });
    }

    const entries = result.data;
    return {
      offset,
      entries,
      // So uma pagina MENOR que o limite observado sugere fim. Uma pagina
      // cheia nunca prova que acabou: a origem entrega pagina cheia em
      // offset arbitrario.
      observedEnd: entries.length < limit,
    };
  }

  return { fetchPage, window };
}
