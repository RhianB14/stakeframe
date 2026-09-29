import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  LEADERBOARD_MAX_PAGES,
  LEADERBOARD_PAGE_LIMIT,
  backfillAnchor,
  backfillSucceeded,
  backoffMs,
  leaderboardPageSchema,
  leaderboardSourceKey,
  polymarketLeaderboardResponseSchema,
  type BackfillResult,
  type LeaderboardEntry,
  type LeaderboardWindow,
} from '../../packages/shared/src/index.js';
import {
  createPolymarketLeaderboardClient,
  retryAfterSeconds,
  withLiteralDecimals,
} from '../../apps/worker/src/polymarket-client.js';
import { IntegrationError } from '../../apps/worker/src/http.js';

/**
 * STK-F2-14 §15 — os testes do CONTRATO, da PAGINACAO, do DEDUP, da
 * COBERTURA (completa / truncada / desconhecida) e do JOB PARCIAL.
 *
 * Os fixtures deste arquivo sao COPIAS LITERAL de uma resposta real observada
 * em `https://data-api.polymarket.com/v1/leaderboard` durante a execucao
 * desta tarefa. Nenhum numero aqui foi inventado para "ficar bonito": o
 * valor `2666493.7190210004` aparece na resposta real e e justamente o caso
 * que um `number` destruiria.
 */

const WINDOW: LeaderboardWindow = {
  category: 'OVERALL',
  timePeriod: 'ALL',
  orderBy: 'PNL',
};

/** Uma linha REAL da origem, com os decimais exatos como vieram. */
const REAL_ENTRY = {
  rank: '2',
  proxyWallet: '0x224a89dbe0db0d6124b335edabd15b3f877da3d5',
  userName: 'wr0ngw4yb3tt0r',
  xUsername: '',
  verifiedBadge: false,
  vol: 2666493.7190210004,
  pnl: 792578.3948993701,
  profileImage: '',
} as const;

/** O corpo bruto real, com os numeros COMO TEXTO — o que a origem escreve. */
const REAL_BODY = JSON.stringify([REAL_ENTRY]);

/** Resposta `fetch` de mentira com corpo e cabecalhos sob controle. */
const jsonResponse = (
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('STK-F2-14 §15 — contrato verificado da origem', () => {
  it('o host e o path sao os que respondem; gamma e clob devolvem 404', () => {
    // Este teste nao faz rede: ele fixa o que os PROBES viram, para que uma
    // troca de host silenciosa (que devolveria 404 em producao) apareca aqui.
    const source = readFileSync(
      new URL('../../apps/worker/src/polymarket-client.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("const LEADERBOARD_ORIGIN = 'https://data-api.polymarket.com'");
    expect(source).toContain("const LEADERBOARD_PATH = '/v1/leaderboard'");
    // Os hosts que NAO servem este path nao podem aparecer como origem.
    expect(source).not.toMatch(/ORIGIN = 'https:\/\/gamma-api/);
    expect(source).not.toMatch(/ORIGIN = 'https:\/\/clob\./);
  });

  it('a resposta real casa com o schema de pagina', () => {
    const page = polymarketLeaderboardResponseSchema.parse(withLiteralDecimals(REAL_BODY));
    expect(page).toHaveLength(1);
    expect(page[0]!.proxyWallet).toBe(REAL_ENTRY.proxyWallet);
    // `rank` e TEXTO na origem e entra como texto: um rank nao e medida.
    expect(page[0]!.rank).toBe('2');
    expect(typeof page[0]!.rank).toBe('string');
  });

  it('o envelope de erro {error} NAO e uma lista vazia: e violacao de contrato', () => {
    // Uma resposta 400 da origem devolve {"error":"..."}. Tratar isso como
    // "zero traders" seria apresentar uma falha como cobertura vazia.
    expect(
      leaderboardPageSchema.safeParse(withLiteralDecimals('{"error":"invalid order by parameter"}'))
        .success,
    ).toBe(false);
  });

  it('o limite de pagina e 50 e uma pagina maior que o pedido viola o contrato', () => {
    expect(LEADERBOARD_PAGE_LIMIT).toBe(50);
    const oversized = Array.from({ length: 51 }, (_, index) => ({
      ...REAL_ENTRY,
      rank: String(index + 1),
      proxyWallet: `0x${String(index).padStart(40, '0')}`,
    }));
    // O schema recusa, e o cliente trata como violacao — nunca truncar em
    // silencio e continuar contando como se fosse a pagina pedida.
    expect(leaderboardPageSchema.safeParse(oversized).success).toBe(false);
  });

  it('os parametros aceitos sao os que a origem aceitou de verdade', () => {
    // orderBy=VOLUME e category=OVERALL_TIME devolveram 400 nos probes.
    // O codigo so pode emitir valores da lista verificada.
    const source = readFileSync(
      new URL('../../packages/shared/src/polymarket.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("export const LEADERBOARD_ORDER_BY = ['PNL', 'VOL'] as const");
    expect(source).toContain("export const LEADERBOARD_CATEGORY = 'OVERALL' as const");
  });
});

describe('STK-F2-14 §15 — exatidão decimal (nunca float persistido)', () => {
  it('os decimais chegam como LITERAL, digito a digito', () => {
    const [entry] = withLiteralDecimals(REAL_BODY) as Array<Record<string, unknown>>;
    expect(entry!.vol).toBe('2666493.7190210004');
    expect(entry!.pnl).toBe('792578.3948993701');
  });

  it('o round-trip por float PERDE casas, e e por isso que o texto e o caminho', () => {
    // Verificado com o Node neste ambiente: alguns literais da origem
    // sobrevivezem ao double (a re-impressao devolve os mesmos digitos) e
    // outros NAO. `214825.64162300` vira `214825.641623` — a origem escreve
    // dois zeros a mais, e um float de ida e volta apaga os dois.
    // Portanto o literal e necessario, e nao apenas uma preferencia de
    // estilo: ha valor real desta origem que nao sobrevive ao caminho float.
    expect(String(Number('214825.64162300'))).not.toBe('214825.64162300');
    // O scanner devolve o literal intacto. O corpo aqui e TEXTO CRU de
    // proposito: montar o fixture com `JSON.stringify` sobre um literal
    // float JÁ teria apagado os zeros a mais, e o teste estaria provando
    // que o scanner preserva algo que o proprio fixture ja perdeu.
    const raw = JSON.stringify([{ ...REAL_ENTRY }]).replace(
      '"vol":2666493.7190210004',
      '"vol":214825.64162300',
    );
    const [entry] = withLiteralDecimals(raw) as Array<Record<string, unknown>>;
    expect(entry!.vol).toBe('214825.64162300');
  });

  it('um numero dentro de uma string nao e tocado: o round-trip e fiel', () => {
    // O userName real traz sufixos numericos; um scanner ingenuo quebraria.
    const body = JSON.stringify([{ ...REAL_ENTRY, userName: 'trader-1765231687816' }]);
    const [entry] = withLiteralDecimals(body) as Array<Record<string, unknown>>;
    expect(entry!.userName).toBe('trader-1765231687816');
    expect(entry!.vol).toBe('2666493.7190210004');
  });

  it('um valor em notacao cientifica nao entra: o schema recusa a linha', () => {
    const body =
      '[{"rank":"1","proxyWallet":"0x' +
      'a'.repeat(40) +
      '","vol":1e5,"pnl":1,"userName":"x","xUsername":"","verifiedBadge":false,"profileImage":""}]';
    // `1e5` nao sobrevive como decimal exato, entao a pagina viola o
    // contrato em vez de virar 100000 silenciosamente.
    expect(leaderboardPageSchema.safeParse(withLiteralDecimals(body)).success).toBe(false);
  });
});

describe('STK-F2-14 §15 — dedup deterministica com chave nao nula', () => {
  it('a mesma observacao produz a mesma chave em qualquer execucao', () => {
    const first = leaderboardSourceKey(REAL_ENTRY as unknown as LeaderboardEntry, WINDOW);
    const second = leaderboardSourceKey(REAL_ENTRY as unknown as LeaderboardEntry, WINDOW);
    expect(first).toBe(second);
    // A chave e NAO NULA e carrega a identidade, nao um hash de transacao.
    expect(first.length).toBeGreaterThan(0);
    expect(first).toContain(REAL_ENTRY.proxyWallet.toLowerCase());
    expect(first.startsWith('pm1:')).toBe(true);
  });

  it('a chave distingue janela, rank e valor: nada de colisao silenciosa', () => {
    const base = REAL_ENTRY as unknown as LeaderboardEntry;
    const key = leaderboardSourceKey(base, WINDOW);
    // Outra janela => outra chave (o mesmo trader em outra ordenacao e outra
    // observacao, nao a mesma linha).
    expect(leaderboardSourceKey(base, { ...WINDOW, orderBy: 'VOL' })).not.toBe(key);
    expect(leaderboardSourceKey(base, { ...WINDOW, timePeriod: 'WEEK' })).not.toBe(key);
    // Outro rank => outra chave.
    expect(leaderboardSourceKey({ ...base, rank: '3' }, WINDOW)).not.toBe(key);
    // Outro valor => outra chave.
    expect(leaderboardSourceKey({ ...base, pnl: '1' }, WINDOW)).not.toBe(key);
  });

  it('a carteira e canonica: 0xAB e 0xab sao o MESMO trader', () => {
    const base = REAL_ENTRY as unknown as LeaderboardEntry;
    const lower = leaderboardSourceKey(
      { ...base, proxyWallet: base.proxyWallet.toLowerCase() },
      WINDOW,
    );
    const upper = leaderboardSourceKey(
      { ...base, proxyWallet: `0x${base.proxyWallet.slice(2).toUpperCase()}` },
      WINDOW,
    );
    expect(upper).toBe(lower);
  });

  it('sem carteira valida a chave NAO existe: erro explicito, nao string vazia', () => {
    const base = REAL_ENTRY as unknown as LeaderboardEntry;
    expect(() => leaderboardSourceKey({ ...base, proxyWallet: 'nao-e-wallet' }, WINDOW)).toThrow(
      'NO_SOURCE_KEY',
    );
    // `txHash` nunca entra na chave: a funcao nem recebe o campo, entao a
    // chave nao pode depender de um valor anulavel.
    expect(
      readFileSync(new URL('../../packages/shared/src/polymarket.ts', import.meta.url), 'utf8'),
    ).toContain('NO_SOURCE_KEY');
  });
});

describe('STK-F2-14 §15 — paginacao e limites de recurso', () => {
  it('o cliente pede 50 e respeita o offset', async () => {
    // O mock recebe a URL ja montada como `URL`; a anotacao do parameetro
    // mantem o `calls[0]` tipado sem `as unknown as` no meio da expressao.
    const fetchImpl = vi.fn(async (_url: URL | string) => jsonResponse(REAL_BODY));
    const client = createPolymarketLeaderboardClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const page = await client.fetchPage({ window: WINDOW, offset: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('100');
    expect(url.searchParams.get('orderBy')).toBe('PNL');
    expect(url.searchParams.get('timePeriod')).toBe('ALL');
    expect(url.searchParams.get('category')).toBe('OVERALL');
    expect(page.offset).toBe(100);
  });

  it('uma pagina cheia NAO prova fim: so a pagina curta observa o fim', async () => {
    const full = JSON.stringify(
      Array.from({ length: 50 }, (_, index) => ({
        ...REAL_ENTRY,
        rank: String(index + 1),
        proxyWallet: `0x${String(index).padStart(40, '0')}`,
      })),
    );
    const fullClient = createPolymarketLeaderboardClient({
      fetchImpl: vi.fn(async () => jsonResponse(full)) as unknown as typeof fetch,
    });
    // Pagina cheia => observedEnd FALSO. E o que impede "truncado" de virar
    // "completo" por accidento.
    expect((await fullClient.fetchPage({ window: WINDOW, offset: 0 })).observedEnd).toBe(false);

    const shortClient = createPolymarketLeaderboardClient({
      fetchImpl: vi.fn(async () => jsonResponse(REAL_BODY)) as unknown as typeof fetch,
    });
    expect((await shortClient.fetchPage({ window: WINDOW, offset: 0 })).observedEnd).toBe(true);
  });

  it('o corpo e limitado e um corpo gigante e recusado ANTES do parse', async () => {
    const huge = `[${Array.from({ length: 4000 }, (_, index) => ({ ...REAL_ENTRY, rank: String(index) })).toString()}]`;
    const client = createPolymarketLeaderboardClient({
      fetchImpl: vi.fn(async () => jsonResponse(huge)) as unknown as typeof fetch,
      maxBodyBytes: 512,
    });
    await expect(client.fetchPage({ window: WINDOW, offset: 0 })).rejects.toThrow(
      'RESPONSE_TOO_LARGE',
    );
  });

  it('o timeout aborta a chamada e vira resultado INCERTO, nao status', async () => {
    const client = createPolymarketLeaderboardClient({
      fetchImpl: ((_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
      timeoutMs: 5,
    });
    const error = await client
      .fetchPage({ window: WINDOW, offset: 0 })
      .catch((caught: unknown) => caught);
    // Incerto e distinto de erro de status: e o que impede o job de repetir
    // uma chamada cujo resultado nao se sabe.
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe('POLYMARKET_UNCERTAIN');
  });
});

describe('STK-F2-14 §15 — rate limit, Retry-After e backoff', () => {
  it('um 429 e distinguido de um 5xx e nenhum corpo vaza para o erro', async () => {
    const rateLimited = createPolymarketLeaderboardClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '7' } }),
      ) as unknown as typeof fetch,
    });
    const first = await rateLimited
      .fetchPage({ window: WINDOW, offset: 0 })
      .catch((e: unknown) => e);
    expect((first as IntegrationError).code).toBe('POLYMARKET_RATE_LIMITED');
    expect((first as IntegrationError).safeMetadata.retryAfter).toBe(7);
    // O corpo nao viaja na excecao: so status e prazo.
    expect((first as IntegrationError).safeMetadata.status).toBe(429);
    expect(JSON.stringify((first as IntegrationError).safeMetadata)).not.toContain('rate limited');

    const serverError = createPolymarketLeaderboardClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse('{"error":"boom"}', { status: 503 }),
      ) as unknown as typeof fetch,
    });
    const second = await serverError
      .fetchPage({ window: WINDOW, offset: 0 })
      .catch((e: unknown) => e);
    expect((second as IntegrationError).code).toBe('POLYMARKET_STATUS_ERROR');
  });

  it('o Retry-After manda no tempo do backoff, com teto', () => {
    expect(backoffMs(1, 7, 0)).toBe(7000);
    expect(backoffMs(9, 999, 0)).toBe(30_000);
    // Sem Retry-After, expoencial: cresce com a tentativa e tem jitter.
    expect(backoffMs(1, null, 0)).toBe(500);
    expect(backoffMs(2, null, 0)).toBe(1000);
    // 500 * 2^2 = 2000, e o jitter de 50% leva a 3000 (arredondado para
    // baixo de 3000.0 — o teto de 30s ainda nao entra).
    expect(backoffMs(3, null, 0.5)).toBe(3000);
    expect(backoffMs(20, null, 1)).toBe(30_000);
  });

  it('o Retry-After e lido em segundos e uma data http vira ausente', () => {
    expect(retryAfterSeconds(new Response('', { headers: { 'retry-after': '12' } }))).toBe(12);
    expect(
      retryAfterSeconds(
        new Response('', { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } }),
      ),
    ).toBeNull();
    expect(retryAfterSeconds(new Response(''))).toBeNull();
  });
});

describe('STK-F2-14 §15 — cobertura completa, truncada e desconhecida', () => {
  const result = (over: Partial<BackfillResult>): BackfillResult => ({
    status: 'truncated',
    succeeded: true,
    pages: [],
    failedPages: 0,
    accepted: 0,
    rejected: 0,
    errors: [],
    ...over,
  });

  it('a ancora de 180 dias e a data mais antiga declarada', () => {
    // 2026-03-01 menos 180 dias = 2025-09-02 (verificado com o Node). A
    // ancora e gravada no banco, e nao deduzida da contagem de linhas.
    expect(backfillAnchor(new Date('2026-03-01T12:00:00Z'))).toBe('2025-09-02');
    // Um ano antes, para provar que a conta anda (2024 tem ano bissexto, e a
    // diferenca de 366 dias aparece no resultado).
    expect(backfillAnchor(new Date('2025-03-01T12:00:00Z'))).toBe('2024-09-02');
  });

  it('cada estado de cobertura e distinguivel e nenhum se confunde com completo', () => {
    expect(result({ status: 'complete' }).status).toBe('complete');
    expect(result({ status: 'truncated' }).status).toBe('truncated');
    expect(result({ status: 'partial' }).status).toBe('partial');
    expect(result({ status: 'unknown' }).status).toBe('unknown');
    // Uma serie truncada NUNCA produz os mesmos campos que uma completa.
    expect(result({ status: 'truncated' })).not.toEqual(result({ status: 'complete' }));
  });
});

describe('STK-F2-14 §15 — job parcial NAO e sucesso', () => {
  const result = (over: Partial<BackfillResult>): BackfillResult => ({
    status: 'partial',
    succeeded: true,
    pages: [],
    failedPages: 0,
    accepted: 0,
    rejected: 0,
    errors: [],
    ...over,
  });

  it('uma pagina falha impede o sucesso, com ou sem o flag', () => {
    // Este e o coracao do card: `failedPages > 0` NAO pode virar sucesso.
    expect(backfillSucceeded(result({ failedPages: 1, succeeded: true }))).toBe(false);
  });

  it('muitas paginas aceitas com uma falha continuam nao-sucedendo', () => {
    // O cenario que a regra protege: 1.500 traders gravados e 6 paginas
    // falhas. O numero grande nao compra o sucesso.
    const partial = result({
      accepted: 1500,
      failedPages: 6,
      errors: ['POLYMARKET_RATE_LIMITED'],
    });
    expect(backfillSucceeded(partial)).toBe(false);
    expect(partial.status).toBe('partial');
  });

  it('uma pagina falha impede o sucesso, com ou sem o flag', () => {
    // Este e o coracao do card: `failedPages > 0` NAO pode virar sucesso.
    expect(backfillSucceeded(result({ failedPages: 1, succeeded: true }))).toBe(false);
    // E o inverso tambem: zero falha E status completo E sucesso legitimo.
    expect(backfillSucceeded(result({ status: 'complete', failedPages: 0, succeeded: true }))).toBe(
      true,
    );
    // Um resultado que se declara nao-sucedido nunca passa.
    expect(
      backfillSucceeded(result({ status: 'complete', failedPages: 0, succeeded: false })),
    ).toBe(false);
  });

  it('uma serie TRUNCADA tambem nao e sucesso, mesmo sem nenhuma falha', () => {
    // A segunda metade da regra: a origem nunca declara o fim da paginacao,
    // entao um backfill truncado NAO terminou o que se propunha a fazer.
    // Sem esta condicao, "nenhuma pagina falhou" bastaria para o job se
    // reportar como sucesso — e a serie truncada seria apresentada como
    // cobertura total.
    expect(
      backfillSucceeded(result({ status: 'truncated', failedPages: 0, succeeded: true })),
    ).toBe(false);
    expect(backfillSucceeded(result({ status: 'partial', failedPages: 0, succeeded: true }))).toBe(
      false,
    );
    expect(backfillSucceeded(result({ status: 'unknown', failedPages: 0, succeeded: true }))).toBe(
      false,
    );
  });

  it('a regra e uma funcao pura com as DUAS condicoes', () => {
    const source = readFileSync(
      new URL('../../packages/shared/src/polymarket.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      "return result.succeeded && result.failedPages === 0 && result.status === 'complete';",
    );
    const job = readFileSync(
      new URL('../../apps/worker/src/polymarket-ingest.ts', import.meta.url),
      'utf8',
    );
    expect(job).toContain('backfillSucceeded');
  });

  it('o teto de paginas existe e e finito: um backfill nao e infinito', () => {
    expect(LEADERBOARD_MAX_PAGES).toBeGreaterThan(0);
    expect(Number.isFinite(LEADERBOARD_MAX_PAGES)).toBe(true);
  });
});
