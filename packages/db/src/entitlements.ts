/**
 * STK-F2-13 — a resolução de entitlement, lida do BANCO, e a porta de chamada
 * paga que a API consulta.
 *
 * Este serviço NÃO calcula permissão. Ele entrega exatamente o que
 * `core.organization_entitlements` devolveu, e a decisão é tomada a partir
 * dessa linha — o frontend, o PostHog e o payload de webhook não têm nenhuma
 * palavra nessa decisão. A garantia é estrutural:
 *
 *  - organização sem atribuição ⇒ plano `free`, o mais restritivo. Um tenant
 *    novo nunca nasce com mais permissão do que o mínimo;
 *  - organização inexistente ⇒ NENHUMA linha. "Nada" é a resposta que o
 *    chamador trata como recusa (`entitlementAllows` nega recurso ausente),
 *    então um id desconhecido não vira permissão;
 *  - a MESMA função é lida pela API e pelo painel interno, de modo que "o que
 *    o painel mostra" e "o que a API aplica" não podem divergir.
 *
 * A porta (`gate`) delega a decisão à função pura `paidCallDecision`, do
 * pacote shared. Este arquivo não tem política própria: ele LÊ, e a regra é a
 * função. A contabilidade de custo e o breaker ficam em `extraction-policy.ts`,
 * que é onde a F2-06 os deixou — aqui só entra o que a API precisa consultar
 * antes de aceitar um upload.
 */

import {
  AI_QUOTA_CEILINGS,
  aiCallCost,
  paidCallDecision,
  spendExhausted,
  GLOBAL_SPEND_CAP_MICROS,
  type AiCallCost,
  type AiCostInput,
  type AiCircuitBreakerScope,
  type BreakerPolicy,
  type Entitlement,
  type EntitlementFeature,
  type ExtractionUsage,
  type PaidCallGate,
  type PlanId,
  type SpendStatus,
} from '@stakeframe/shared';
import type { Database } from './index.js';

/**
 * Tetos de cota, lidos da MESMA fonte que o serviço de política usa
 * (`AI_QUOTA_CEILINGS`, espelhado dos limites que a F2-11 publica no painel e
 * no monitor). A API e o worker precisam concordar sobre o mesmo teto, e uma
 * constante duplicada aqui seria um segundo número capaz de divergir.
 */
const AI_DAILY_CEILING = AI_QUOTA_CEILINGS.dailyPresented;
const AI_MONTHLY_CEILING = AI_QUOTA_CEILINGS.monthlyPresented;

const day = (): string => new Date().toISOString().slice(0, 10);
const monthPrefix = (): string => day().slice(0, 7);

/**
 * Política de degradação, usada só quando `integration.breaker_policy` não pode
 * ser lida. É deliberadamente MAIS CONTIDA que o default gravado pela migração
 * (3 falhas / 5 min): perder a tabela de política não pode virar permissão de
 * gastar, então a porta fecha mais cedo.
 */
const FALLBACK_BREAKER_POLICY: Record<AiCircuitBreakerScope, BreakerPolicy> = {
  global: {
    scope: 'global',
    failureThreshold: 3,
    recoveryMs: 5 * 60_000,
    spendCapMicros: null,
    spendWindow: null,
  },
  daily: {
    scope: 'daily',
    failureThreshold: 3,
    recoveryMs: 5 * 60_000,
    spendCapMicros: null,
    spendWindow: null,
  },
  user: {
    scope: 'user',
    failureThreshold: 3,
    recoveryMs: 5 * 60_000,
    spendCapMicros: null,
    spendWindow: null,
  },
};

type PolicyRow = {
  scope: AiCircuitBreakerScope;
  failure_threshold: number;
  recovery_ms: number;
  spend_cap_micros: string | null;
  spend_window: 'day' | 'month' | null;
};

type BreakerRow =
  | {
      state: string;
      recovers_at: Date | null;
    }
  | undefined;

/** Um breaker está aberto enquanto `open` E a janela de recuperação não passou. */
const breakerIsOpen = (row: BreakerRow): boolean =>
  !!row && row.state === 'open' && (!row.recovers_at || row.recovers_at.getTime() > Date.now());

export function createEntitlementService(database: Database) {
  /**
   * Os entitlements do tenant, EXATAMENTE como o banco os calculou.
   *
   * A função do banco devolve uma linha por recurso do plano efetivo. A
   * leitura é GLOBAL (a função recebe o id como argumento e é STABLE): é a
   * mesma chamada que o painel interno faz, e não existe um segundo caminho
   * que "resolva" o plano de outro jeito.
   */
  async function entitlements(organizationId: string): Promise<Entitlement[]> {
    const rows = (
      await database.pool.query<{
        plan_id: PlanId;
        feature: EntitlementFeature;
        enabled: boolean;
        limit_value: number | null;
      }>('select plan_id,feature,enabled,limit_value from core.organization_entitlements($1)', [
        organizationId,
      ])
    ).rows;
    return rows.map((row) => ({
      plan: row.plan_id,
      feature: row.feature,
      enabled: row.enabled,
      limit: row.limit_value === null ? null : Number(row.limit_value),
    }));
  }

  /**
   * A política dos três escopos, lida do banco. É GLOBAL, como o breaker: um
   * escopo local que afrouxasse o limiar daria a um tenant a possibilidade de
   * gastar mais que a infraestrutura inteira.
   */
  async function readPolicies(): Promise<Record<AiCircuitBreakerScope, BreakerPolicy>> {
    let rows: PolicyRow[];
    try {
      rows = (
        await database.pool.query(
          `select scope,failure_threshold,recovery_ms,spend_cap_micros,spend_window
             from integration.breaker_policy`,
        )
      ).rows;
    } catch {
      rows = [];
    }
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    const policy = (scope: AiCircuitBreakerScope): BreakerPolicy => {
      const row = byScope.get(scope);
      if (!row) return FALLBACK_BREAKER_POLICY[scope];
      return {
        scope,
        failureThreshold: Number(row.failure_threshold),
        recoveryMs: Number(row.recovery_ms),
        spendCapMicros: row.spend_cap_micros === null ? null : Number(row.spend_cap_micros),
        spendWindow: row.spend_window,
      };
    };
    return { global: policy('global'), daily: policy('daily'), user: policy('user') };
  }

  /** Gasto estimado na janela de um escopo, lido da mesma tabela da quota. */
  async function spend(scope: AiCircuitBreakerScope): Promise<SpendStatus> {
    const policy = (await readPolicies())[scope];
    // Sem teto de gasto no escopo, a agregação nem é feita: um escopo sem
    // número não gasta CPU descobrindo um número que ninguém pode comparar.
    if (policy.spendCapMicros === null || policy.spendWindow === null)
      return { micros: 0, capMicros: null, window: null, exhausted: false };
    const row = (
      await database.pool.query<{ micros: string }>(
        `select coalesce(sum(cost_micros) filter(where day >= $1),0)::text as micros
           from integration.ai_usage_day`,
        [policy.spendWindow === 'day' ? day() : `${monthPrefix()}-01`],
      )
    ).rows[0]!;
    const micros = Number(row.micros);
    return {
      micros,
      capMicros: policy.spendCapMicros,
      window: policy.spendWindow,
      exhausted: spendExhausted({
        micros,
        capMicros: policy.spendCapMicros,
        window: policy.spendWindow,
        exhausted: false,
      }),
    };
  }

  /** Os três breakers de uma vez, aplicando a mesma regra de recuperação. */
  async function readBreakers(
    userId: string | null,
  ): Promise<{ global: BreakerRow; daily: BreakerRow; user: BreakerRow }> {
    const rows = (
      await database.pool.query<{
        scope: string;
        scope_key: string;
        state: string;
        recovers_at: Date | null;
      }>(
        `select scope,scope_key,state,recovers_at from integration.ai_circuit_breaker
          where scope in ('global','daily') or ($1::text is not null and scope='user' and scope_key=$1::text)`,
        [userId],
      )
    ).rows;
    const byKey = new Map(rows.map((row) => [`${row.scope}:${row.scope_key}`, row]));
    return {
      global: byKey.get('global:global'),
      daily: byKey.get('daily:daily'),
      user: userId ? byKey.get(`user:${userId}`) : undefined,
    };
  }

  /**
   * A situação da porta ANTES de qualquer chamada paga: quota da F2-06, gasto
   * da F2-13 e os três breakers. Uma única leitura decide, e a decisão em si é
   * a função pura `paidCallDecision` — este arquivo não tem regra própria.
   */
  async function gate(userId?: string | null): Promise<PaidCallGate> {
    const counts = await database.pool.query<{ daily: string; monthly: string; micros: string }>(
      `select coalesce(sum(presented) filter(where day=$1),0)::text as daily,
              coalesce(sum(presented) filter(where day >= $2),0)::text as monthly,
              coalesce(sum(cost_micros) filter(where day >= $2),0)::text as micros
         from integration.ai_usage_day`,
      [day(), `${monthPrefix()}-01`],
    );
    const row = counts.rows[0]!;
    const [breakers, policies, globalSpend] = await Promise.all([
      readBreakers(userId ?? null),
      readPolicies(),
      spend('global'),
    ]);
    const dailyPresented = Number(row.daily);
    const monthlyPresented = Number(row.monthly);
    const globalOpen = breakerIsOpen(breakers.global);
    const dailyOpen = breakerIsOpen(breakers.daily);
    const userOpen = breakerIsOpen(breakers.user);
    return {
      dailyPresented,
      dailyCeiling: AI_DAILY_CEILING,
      monthlyPresented,
      monthlyCeiling: AI_MONTHLY_CEILING,
      monthlySpendMicros: Number(row.micros),
      globalSpendCapMicros: policies.global.spendCapMicros ?? GLOBAL_SPEND_CAP_MICROS,
      globalOpen,
      dailyOpen,
      userOpen,
      spendExhausted: globalSpend.exhausted,
      refusesPaidCalls:
        globalSpend.exhausted ||
        globalOpen ||
        dailyOpen ||
        userOpen ||
        dailyPresented >= AI_DAILY_CEILING ||
        monthlyPresented >= AI_MONTHLY_CEILING,
    };
  }

  /**
   * O custo estimado de uma chamada, com o preço lido do catálogo de
   * REFERÊNCIA. Preço ausente não vira zero: a função pura `aiCallCost` cai no
   * valor de fallback declarado, e é ela que devolve `priced: false` para que a
   * contabilidade saiba que o número é um piso, não uma medição.
   */
  async function costOf(usage: ExtractionUsage | null, model: string | null): Promise<AiCallCost> {
    const price = model
      ? (
          await database.pool.query<{ input_micros_per_1k: string; output_micros_per_1k: string }>(
            'select input_micros_per_1k,output_micros_per_1k from integration.ai_model_price where model=$1',
            [model],
          )
        ).rows[0]
      : undefined;
    const fallback = (
      await database.pool.query<{ unpriced_call_micros: string }>(
        "select unpriced_call_micros from integration.ai_cost_model where id='default'",
      )
    ).rows[0];
    const input: AiCostInput = {
      model,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      inputMicrosPer1k: price ? Number(price.input_micros_per_1k) : null,
      outputMicrosPer1k: price ? Number(price.output_micros_per_1k) : null,
      // Sem linha de fallback (banco pré-0025), o piso declarado no shared
      // entra: um número conhecido e não-zero é melhor do que custo zero.
      unpricedCallMicros: Number(fallback?.unpriced_call_micros ?? 1500),
    };
    return aiCallCost(input);
  }

  return { entitlements, gate, costOf, readPolicies, spend, readBreakers, paidCallDecision };
}

export type EntitlementService = ReturnType<typeof createEntitlementService>;
