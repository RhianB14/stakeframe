import type { PoolClient } from 'pg';
import {
  canonicalDecimalToken,
  runIndicativeSimulation,
  type BackfillStatus,
  type PolymarketSimulation,
  type SimulationInput,
  type SimulationObservation,
  type SimulationWindow,
} from '@stakeframe/shared';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import type { Database } from './index.js';

/**
 * STK-F2-17 — a APURAÇÃO da simulação indicativa, e o seu REGISTRO.
 *
 * Esta camada faz três coisas, nesta ordem, e a ordem é o card inteiro:
 *
 *  1) LÊ O STATUS GRAVADO. `integration.polymarket_series.status` é lido e
 *     nunca deduzido da contagem de linhas. É o mesmo status que a F2-14
 *     gravou e que a F2-15 mostra; a recusa da simulação é derivada dele, e
 *     nenhuma estatística substitui a lacuna.
 *
 *  2) APURA O MOTOR PURO. O cálculo vive em `runIndicativeSimulation`, no
 *     shared, e esta camada só fornece os dados. A consequência é que o motor
 *     é testável sem banco e que a rota não tem aritmética própria — duas
 *     coisas que a F2-14 e a F2-15 já stabilizaram como padrão.
 *
 *  3) GRAVA O REGISTRO, INCLUSIVE A RECUSA. Uma tentativa recusada também é
 *     gravada, porque o registro é a evidência de que a recusa aconteceu e de
 *     qual era a cobertura no instante. Uma recusa que não deixa rastro é uma
 *     recusa que pode ser reescrita como se nunca tivesse ocorrido.
 *
 * ISOLAMENTO. Todo acesso leva o predicado explícito
 * `organization_id = current_setting('app.organization_id', true)::uuid` dentro
 * de `withOrganizationTransaction`, no mesmo padrão dos demais serviços: o
 * RLS não é a defesa (o papel de conexão é dono do banco e o ignora), o
 * predicado é.
 *
 * O que esta camada NÃO faz, por decisão do card: não chama a Polymarket (a
 * leitura é das tabelas que a F2-14 gravou, então a porta de entitlement da
 * F2-13 não é consultada), não executa ordem, não otimiza e não escreve
 * estratégia. Não existe caminho de código aqui que faça qualquer uma dessas
 * coisas, e o nome do serviço é `createPolymarketSimulationStore` — store, não
 * executor.
 */

/** Erro de apuração com código estável; a API o mapeia para 4xx/5xx. */
export class PolymarketSimulationError extends Error {
  constructor(
    public readonly code:
      'SIMULATION_WINDOW_INVALID' | 'SIMULATION_INTERNAL' = 'SIMULATION_INTERNAL',
  ) {
    super(code);
    this.name = 'PolymarketSimulationError';
  }
}

export type PolymarketSimulationStore = ReturnType<typeof createPolymarketSimulationStore>;

/** O limiar de amostra do produto, injetado: nenhuma tela decide sozinha. */
export type SimulationOptions = { minSample: number };

/**
 * O teto de observações de uma simulação: a PRIMEIRA página oficial.
 *
 * É o mesmo 50 que a F2-14 verificou por probe (`limit=51` devolve 50), e a
 * escolha é deliberada. A taxa de dados ausentes é definida como
 * `1 − n / 50` — quanto da primeira página o nosso banco não tem — e usar o
 * top 100 do ranking tornaria a taxa a medida de um conjunto diferente, que é
 * a forma mais fácil de publicar um número com o nome errado.
 */
export const FIRST_PAGE_LIMIT = 50;

/**
 * A chave de dedupe do pedido, e ela é PURA e ESTÁVEL.
 *
 * Mesma janela, mesma stake e mesmas premissas são o MESMO pedido — e o
 * `ON CONFLICT DO NOTHING` do banco faz a repetição ser um no-op declarado em
 * vez de uma segunda linha. As partes entram numa ordem fixa e com separador
 * que não existe nos valores: sem ele, ('10','0') e ('1','00') produziriam a
 * mesma chave para entradas diferentes.
 *
 * A chave NÃO inclui o resultado nem a completude, e essa é a decisão: são
 * derivado do pedido, e incluí-los transformaria "repetir a mesma pergunta
 * depois da coleta avançar" em duas linhas — quando o que o usuário fez foi
 * exatamente a mesma pergunta de novo.
 */
export function simulationDedupeKey(request: SimulationInput): string {
  return [
    'stkf217',
    request.window.category,
    request.window.timePeriod,
    request.window.orderBy,
    request.stake,
    String(request.delayMs),
    request.feeRate,
    request.spreadRate,
    request.slippageRate,
  ].join('|');
}

export function createPolymarketSimulationStore(database: Database) {
  const tenant = createTenantContext(database);

  /**
   * O estado GRAVADO da série, lido com o predicado de organización.
   *
   * `integration.polymarket_series` não tem `organization_id` — é dado público
   * de integração externa, idêntico para qualquer conta, e por isso não leva
   * RLS (a decisão da F2-14). A leitura aqui é a MESMA que a F2-15 faz, e ela
   * devolve a mesma forma: ausência de linha é `available: false`, nunca um
   * zero e nunca um `complete` presumido.
   */
  async function seriesOf(
    client: PoolClient,
    window: SimulationWindow,
  ): Promise<{
    status: BackfillStatus;
    available: boolean;
    ingested: number;
    pages: number;
    failedPages: number;
  }> {
    const row = (
      await client.query<{
        status: string;
        quantity: string;
        pages: string;
        failed_pages: string;
      }>(
        `select status, quantity, pages, failed_pages
           from integration.polymarket_series
          where category = $1 and time_period = $2 and order_by = $3`,
        [window.category, window.timePeriod, window.orderBy],
      )
    ).rows[0];
    if (!row)
      return {
        status: 'unknown' as BackfillStatus,
        available: false,
        ingested: 0,
        pages: 0,
        failedPages: 0,
      };
    return {
      // O CHECK do banco é o enum de quatro valores, então o valor recebido é
      // um deles por construção; o cast documenta isso e o schema da borda
      // valida de novo.
      status: row.status as BackfillStatus,
      available: true,
      ingested: Number(row.quantity),
      pages: Number(row.pages),
      failedPages: Number(row.failed_pages),
    };
  }

  /**
   * As observações da janela, como LITERAIS exatos.
   *
   * `vol` e `pnl` voltam do `numeric(38, 18)` como TEXTO e são canonicalizados
   * com `canonicalDecimalToken` — o mesmo caminho da F2-15, pelo mesmo motivo:
   * um `Number` aqui devolveria `792578.39489937` para um literal que a origem
   * publicou como `792578.3948993701`, e a razão calculada sobre o valor errado
   * seria um número que ninguém mediu.
   *
   * A ordenação é `rank::bigint` (a posição declarada pela origem), e o teto é
   * o da PRIMEIRA página oficial (`LEADERBOARD_PAGE_LIMIT`), não o top 100 do
   * ranking: a taxa de dados ausentes é medida sobre a primeira página, e usar
   * um conjunto diferente tornaria a taxa uma medida de outra coisa.
   */
  async function observationsOf(
    client: PoolClient,
    window: SimulationWindow,
    limit: number,
  ): Promise<SimulationObservation[]> {
    const rows = (
      await client.query<{
        proxy_wallet: string;
        vol: string;
        pnl: string;
      }>(
        `select proxy_wallet, vol::text as vol, pnl::text as pnl
           from integration.polymarket_trader
          where category = $1 and time_period = $2 and order_by = $3
          order by rank::bigint asc
          limit $4`,
        [window.category, window.timePeriod, window.orderBy, limit],
      )
    ).rows;
    return rows.map((row) => ({
      proxyWallet: row.proxy_wallet,
      vol: canonicalDecimalToken(row.vol),
      pnl: canonicalDecimalToken(row.pnl),
    }));
  }

  /**
   * A GRAVAÇÃO do registro, e ela é única por pedido.
   *
   * `ON CONFLICT DO NOTHING` sobre `(organization_id, dedupe_key)` é o que
   * torna a reexecução um no-op declarado. O registro guarda o desfecho INTEIRO
   * — recusa com código, razão e remédio, ou apuração com cada número — e
   * guarda as premissas e os avisos que foram exibidos, para que o número não
   * possa ser lido fora do contexto que o limita.
   *
   * Os decimais entram como LITERAL de texto (`$n::numeric`) pelo mesmo motivo
   * da F2-14: nenhum `Number` toca esta coluna em lugar nenhum.
   */
  async function record(
    client: PoolClient,
    context: OrganizationContext,
    simulation: PolymarketSimulation,
    request: SimulationInput,
    minSample: number,
  ): Promise<void> {
    const number = simulation.indicative;
    await client.query(
      `insert into integration.polymarket_simulation
         (organization_id, category, time_period, order_by,
          stake, delay_ms, fee_rate, spread_rate, slippage_rate,
          series_status, series_available, observations, min_sample, missing_data_rate,
          refused, refusal_code, refusal_reason, refusal_remedy,
          indicative_stake, indicative_observations, indicative_published_ratio,
          indicative_published_pnl_sum, indicative_published_vol_sum,
          indicative_gross, indicative_fee_cost, indicative_spread_cost,
          indicative_slippage_cost, indicative_friction_cost, indicative_missing_band,
          indicative_net,
          premises, disclaimers, dedupe_key)
       values ($1, $2, $3, $4,
               $5::numeric, $6, $7::numeric, $8::numeric, $9::numeric,
               $10, $11, $12, $13, $14::numeric,
               $15, $16, $17, $18,
               $19::numeric, $20, $21::numeric, $22::numeric, $23::numeric,
               $24::numeric, $25::numeric, $26::numeric, $27::numeric, $28::numeric, $29::numeric,
               $30::numeric, $31::jsonb, $32::jsonb, $33)
       on conflict (organization_id, dedupe_key) do nothing`,
      [
        context.organizationId,
        request.window.category,
        request.window.timePeriod,
        request.window.orderBy,
        request.stake,
        request.delayMs,
        request.feeRate,
        request.spreadRate,
        request.slippageRate,
        simulation.coverage.status,
        simulation.coverage.available,
        simulation.coverage.n,
        minSample,
        simulation.coverage.missingDataRate,
        simulation.refusal.refused,
        simulation.refusal.code,
        simulation.refusal.reason,
        simulation.refusal.remedy,
        number?.stake ?? null,
        number?.observations ?? null,
        number?.publishedRatio ?? null,
        number?.publishedPnlSum ?? null,
        number?.publishedVolSum ?? null,
        number?.grossBeforePremises ?? null,
        number?.feeCost ?? null,
        number?.spreadCost ?? null,
        number?.slippageCost ?? null,
        number?.totalFrictionCost ?? null,
        number?.missingDataBand ?? null,
        number?.netAfterPremises ?? null,
        JSON.stringify(simulation.premises),
        JSON.stringify(simulation.disclaimers),
        simulationDedupeKey(request),
      ],
    );
  }

  /**
   * A APURAÇÃO completa, e a função que a rota chama.
   *
   * A transação é `repeatable read` pelo mesmo motivo das demais leituras
   * privadas: o status da série e as observações precisam ser vistas do MESMO
   * instante. Sem isso, uma reingerência concorrente poderia mudar o status
   * entre as duas consultas e produzir um número sobre uma cobertura que não
   * era a que o status descrevia.
   *
   * A gravação acontece DENTRO da mesma transação da leitura, e por isso um
   * registro não pode afirmar uma cobertura diferente da que produziu o
   * número.
   */
  async function simulate(
    context: OrganizationContext,
    request: SimulationInput,
    options: SimulationOptions,
  ): Promise<PolymarketSimulation> {
    if (!Number.isInteger(options.minSample) || options.minSample < 1)
      throw new PolymarketSimulationError('SIMULATION_WINDOW_INVALID');
    return tenant.withOrganizationTransaction(
      context,
      async (client) => {
        const series = await seriesOf(client, request.window);
        // As observações são lidas mesmo quando a série está incompleta, porque
        // a recusa precisa saber QUANTAS observações existem para dizer
        // "amostra pequena" ou "dados ausentes" em vez de repetir "não coletado".
        // A ordem de reporting é o que a política de recusa decide.
        const observations = series.available
          ? await observationsOf(client, request.window, FIRST_PAGE_LIMIT)
          : [];
        const simulation = runIndicativeSimulation({
          window: request.window,
          series,
          observations,
          request,
          minSample: options.minSample,
        });
        await record(client, context, simulation, request, options.minSample);
        return simulation;
      },
      { isolation: 'repeatable read' },
    );
  }

  return { simulate, seriesOf, observationsOf, record };
}
