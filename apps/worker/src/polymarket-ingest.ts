import { setTimeout as delay } from 'node:timers/promises';
import {
  createEntitlementService,
  createPolymarketStore,
  type Database,
  type PolymarketStore,
} from '@stakeframe/db';
import {
  LEADERBOARD_CATEGORY,
  LEADERBOARD_MAX_PAGES,
  LEADERBOARD_PAGE_LIMIT,
  POLYMARKET_BACKFILL_DAYS,
  backfillAnchor,
  backfillSucceeded,
  backoffMs,
  paidCallDecision,
  type BackfillResult,
  type BackfillStatus,
  type IngestedPage,
  type LeaderboardOrderBy,
  type LeaderboardTimePeriod,
} from '@stakeframe/shared';
import { createPolymarketLeaderboardClient, type LeaderboardClient } from './polymarket-client.js';
import { IntegrationError } from './http.js';

/**
 * STK-F2-14 — o job de ingestao do leaderboard Polymarket.
 *
 * O job tem cinco responsabilidades e uma proibicao. A proibicao e a
 * importante: o job NAO pode terminar como SUCESSO se alguma fatia
 * relevante falhou. Isso nao e uma convencao do chamador — e uma funcao pura
 * (`backfillSucceeded`), testada, que nenhum caminho de codigo consegue
 * contornar.
 *
 *  1) PORTA ANTES DE QUALQUER CHAMADA. O gate da F2-13 (entitlements +
 *     breakers + teto de gasto) e consultado ANTES da primeira requisicao
 *     externa. Com qualquer breaker aberto ou teto atingido, o job nao faz
 *     UMA chamada e devolve o desfecho recusado. Nenhuma pagina e gravada
 *     nesse caminho: uma serie gravada como `truncated` por um gate fechado
 *     seria um truncamento que nao veio da origem.
 *
 *  2) BACKOFF COM `Retry-After`. Um 429 com `Retry-After: 7` espera 7
 *     segundos; sem o cabecalho, o backoff exponencial com jitter decide. O
 *     teto de tentativas e POR PAGINA, e um `POLYMARKET_UNCERTAIN` (timeout,
 *     conexao) NAO e repetido: repetir uma chamada de resultado incerto pode
 *     duplicar dado, e o card pede dedup deterministica, nao forca bruta.
 *
 *  3) DEDUP PELA CHAVE DE ORIGEM. Cada linha observada vira um INSERT com
 *     `ON CONFLICT DO NOTHING` sobre a chave nao nula. Reexecutar o job nao
 *     cria linha nova.
 *
 *  4) COMPLETUDE DECLARADA, NUNCA INFERIDA. A serie fecha com `complete`
 *     apenas quando uma pagina CURTA foi observada; se o job parou no teto
 *     de paginas, e `truncated`; se alguma pagina falhou, e `partial`.
 *
 *  5) JANELA DE 180 DIAS, COM ANCORA GRAVADA. O `backfill_from` e a data de
 *     180 dias atras e entra no banco: e ela que torna a serie datavel.
 *
 * O que este job NAO faz, e o escopo excluido do card (§9.1): nenhuma ordem,
 * nenhuma aposta, nenhum trade individual, nenhum indice on-chain, nenhum
 * Kalshi. A unica coisa que ele le e o LEADERBOARD.
 */

/** Tentativas por pagina, incluindo a primeira. */
const MAX_ATTEMPTS_PER_PAGE = 3;

/**
 * O desfecho do job, e o motivo de ele carregar `refused`.
 *
 * Uma recusa da porta da F2-13 e um backfill que rodaram sao situacoes
 * diferentes: a primeira nao tentou nada, e por isso tem um campo proprio
 * para dizer isso, em vez de parecer um backfill vazio que deu certo.
 */
export type PolymarketIngestResult = BackfillResult & {
  /** O gate recusou antes de qualquer chamada? Nenhuma pagina foi tentada. */
  refused: boolean;
  /** O codigo do gate, quando recusou ('quota' | 'breaker' | 'spend'). */
  refusalReason: string | null;
};

type Options = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /** Injetavel para o teste nao esperar de verdade. */
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

type Window = {
  category: typeof LEADERBOARD_CATEGORY;
  timePeriod: LeaderboardTimePeriod;
  orderBy: LeaderboardOrderBy;
};

export function createPolymarketIngestJob(database: Database, options: Options = {}) {
  const store: PolymarketStore = createPolymarketStore(database);
  const entitlements = createEntitlementService(database);
  const client: LeaderboardClient = createPolymarketLeaderboardClient({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const sleep = options.sleep ?? ((ms: number) => delay(ms).then(() => undefined));
  const now = options.now ?? (() => new Date());

  /**
   * O gate da F2-13, consultado ANTES da primeira chamada externa.
   *
   * A decisão NÃO é recalculada aqui: quem decide é `paidCallDecision`, a
   * função pura da F2-13, que já aplica a ordem de verificação dela própria
   * (breaker global, breaker por usuário, breaker diário, gasto, quota
   * diária, quota mensal). Este job só pergunta e obedece — se ele
   * reimplementasse a ordem, um novo breaker da F2-13 passaria despercebido
   * aqui, e o portão da ingestão ficaria aberto sem ninguém perceber.
   */
  async function gateIsOpen(): Promise<{ open: boolean; reason: string | null }> {
    const decision = paidCallDecision(await entitlements.gate(null));
    return decision.allowed
      ? { open: true, reason: null }
      : { open: false, reason: decision.reason };
  }

  /** Executa UMA janela, com paginacao, backoff e desfecho explicito. */
  async function runOnce(window: Window): Promise<PolymarketIngestResult> {
    const empty = (refused: boolean, refusalReason: string | null): PolymarketIngestResult => ({
      status: refused ? 'unknown' : 'unknown',
      succeeded: false,
      refused,
      refusalReason,
      pages: [],
      failedPages: 0,
      accepted: 0,
      rejected: 0,
      errors: [],
    });

    // (1) A PORTA. Fecha, nao ha uma unica chamada externa.
    const gate = await gateIsOpen();
    if (!gate.open) return empty(true, gate.reason);

    const instant = now();
    const seriesId = await store.upsertSeries({
      window,
      windowFrom: new Date(instant.getTime() - POLYMARKET_BACKFILL_DAYS * 86_400_000),
      windowTo: instant,
      backfillFrom: backfillAnchor(instant),
    });

    const pages: IngestedPage[] = [];
    const errors: string[] = [];
    let accepted = 0;
    const rejected = 0;
    let failedPages = 0;
    let cursor: number | null = null;
    let observedEnd = false;

    for (let index = 0; index < LEADERBOARD_MAX_PAGES; index += 1) {
      const offset = index * LEADERBOARD_PAGE_LIMIT;
      let attempt = 0;
      let stored = false;

      // (2) Tentativas da pagina, com backoff. Um resultado INCERTO nao e
      // repetido: pode ter gravado, e o card pede dedup, nao insistencia.
      while (attempt < MAX_ATTEMPTS_PER_PAGE) {
        attempt += 1;
        try {
          const page = await client.fetchPage({ window, offset });
          const inserted = await store.recordPage({
            seriesId,
            page: {
              offset,
              received: page.entries.length,
              accepted: page.entries.length,
              complete: !page.observedEnd,
              errorCode: null,
              retryAfterSeconds: null,
            },
            entries: page.entries,
            window,
          });
          accepted += inserted;
          // Uma pagina inteira que volta vazia e um resultado VALIDO: a
          // origem pode legitimately ter menos trader que o limite nesse
          // offset, e isso e o sinal de fim observado.
          cursor = offset;
          pages.push({
            offset,
            received: page.entries.length,
            accepted: inserted,
            complete: !page.observedEnd,
            errorCode: null,
            retryAfterSeconds: null,
          });
          observedEnd = observedEnd || page.observedEnd;
          stored = true;
          break;
        } catch (error) {
          const code = error instanceof IntegrationError ? error.code : 'POLYMARKET_UNCERTAIN';
          // Incerto nao se repete: a resposta pode ter sido processada pela
          // origem e repeticao seria duplicar por ignorancia.
          if (code === 'POLYMARKET_UNCERTAIN' || attempt >= MAX_ATTEMPTS_PER_PAGE) {
            failedPages += 1;
            const retryAfter =
              error instanceof IntegrationError
                ? ((error.safeMetadata.retryAfter as number | undefined) ?? null)
                : null;
            pages.push({
              offset,
              received: 0,
              accepted: 0,
              complete: false,
              errorCode: code,
              retryAfterSeconds: retryAfter,
            });
            if (!errors.includes(code)) errors.push(code);
            break;
          }
          // Falha CONFIRMADA (429, 5xx): repetir com espera. O `Retry-After`
          // manda no tempo; sem ele, expoencial com jitter.
          const retryAfter =
            error instanceof IntegrationError
              ? ((error.safeMetadata.retryAfter as number | undefined) ?? null)
              : null;
          await sleep(backoffMs(attempt, retryAfter, 0.5));
        }
      }

      if (!stored) {
        // Esta fatia falhou e a pagina nao esta consumida: o job nao pode
        // seguir adiante fingindo que a serie esta inteira. A serie fecha
        // como `partial` e o desfecho e explicitamente NAO-sucesso.
        break;
      }
      // Uma pagina CURTA e o unico sinal de fim observado.
      if (observedEnd) break;
    }

    // (4) A COMPLETUDE. Derivada do que foi OBSERVADO, nunca da ausencia de
    // linhas: falha de pagina => partial; teto de paginas sem fim
    // observado => truncated; fim observado => complete.
    const status: BackfillStatus =
      failedPages > 0 ? 'partial' : observedEnd ? 'complete' : 'truncated';

    await store.closeSeries({
      seriesId,
      window,
      status,
      cursor,
      quantity: accepted,
      pages: pages.length,
      failedPages,
      errors,
    });

    const result: PolymarketIngestResult = {
      status,
      // (PROIBICAO) Sucesso exige zero paginas falhas E cobertura completa.
      // `backfillSucceeded` e pura e testada; nao ha como este objeto dizer
      // `succeeded: true` carregando `failedPages > 0` nem `status:
      // 'truncated'`. Uma serie truncada e o resultado HONESTO de um
      // backfill que a origem nunca diz ter terminado — e por isso nao e
      // sucesso, ainda que tenha gravado milhares de linhas.
      succeeded: backfillSucceeded({
        status,
        succeeded: true,
        pages,
        failedPages,
        accepted,
        rejected,
        errors,
      }),
      refused: false,
      refusalReason: null,
      pages,
      failedPages,
      accepted,
      rejected,
      errors,
    };
    return result;
  }

  /** As janelas que o job ingere: as duas ordenacoes da janela pedida. */
  function windowsOf(timePeriod: LeaderboardTimePeriod): Window[] {
    return (['PNL', 'VOL'] as const).map((orderBy) => ({
      category: LEADERBOARD_CATEGORY,
      timePeriod,
      orderBy,
    }));
  }

  /** Um passe: todas as janelas, e o resumo com a regra de sucesso. */
  async function tick(
    timePeriod: LeaderboardTimePeriod = 'ALL',
  ): Promise<PolymarketIngestResult[]> {
    const results: PolymarketIngestResult[] = [];
    for (const window of windowsOf(timePeriod)) {
      results.push(await runOnce(window));
    }
    return results;
  }

  return { runOnce, tick, windowsOf, store, entitlements, client };
}

export type PolymarketIngestJob = ReturnType<typeof createPolymarketIngestJob>;
