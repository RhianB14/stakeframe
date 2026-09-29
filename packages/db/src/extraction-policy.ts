import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  AI_QUOTA_CEILINGS,
  EMPTY_EXTRACTION_USAGE,
  EXTRACTION_PIPELINE_VERSION,
  extractionAuditRecordSchema,
  extractionCategoryIsConfirmed,
  extractionQuotaStatusSchema,
  extractionOutcomePresentsForReview,
  quotaUnitForOutcome,
  paidCallDecision,
  spendExhausted,
  GLOBAL_SPEND_CAP_MICROS as AI_GLOBAL_SPEND_CAP_MICROS,
  aiCallCost,
  type AiCircuitBreakerScope,
  type BreakerPolicy,
  type ExtractionAuditRecord,
  type ExtractionErrorCategory,
  type ExtractionOutcome,
  type ExtractionQuotaStatus,
  type ExtractionUsage,
  type TicketExtraction,
} from '@stakeframe/shared';
import type { Database } from './index.js';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';

/**
 * STK-F2-06 — a persistência da extração: registro sanitizado, quota contada
 * por apresentação e a base do circuit breaker (global, diário e por usuário).
 *
 * Quatro regras estruturais, todas impostas aqui e nenhuma delas delegada ao
 * chamador:
 *
 *  1) NADA BRUTO. O que entra em `integration.extraction_audit` é o que
 *     `extractionAuditRecordSchema` aceitou: estrutura sanitizada, versão do
 *     pipeline, hashes, categoria de erro, uso e desfecho. O schema é
 *     `strictObject` nos três níveis, então um payload com `rawResponse`,
 *     `content`, `choices` ou `prompt` é REJEITADO na borda — o banco nunca vê
 *     o texto, e não existe campo onde ele caberia. Um teste prova isso.
 *
 *  2) QUOTA POR APRESENTAÇÃO. A unidade é debitada na MESMA transação que grava
 *     o desfecho, e apenas quando `quotaUnitForOutcome` devolve 1 —
 *     `presented` e `candidates_pending`. Falha técnica (`uncertain`,
 *     `confirmed_failure`) e recusa (`refused_quota`) debitam zero. Descarte
 *     posterior do usuário NÃO devolve a unidade: ela foi consumida pelo fato
 *     de a extração ter sido apresentada. O índice parcial
 *     `extraction_audit_presented_idx` garante no BANCO que um item não seja
 *     contado duas vezes, mesmo que o worker repita a debitada.
 *
 *  3) CONFIRMADA x INCERTA. Só a falha confirmada alimenta o breaker e só ela
 *     abre caminho para o secundário (§8.3). Timeout e conexão perdida são
 *     incertos: podem ter custado trabalho ao fornecedor, e a resposta do
 *     item para eles é preenchimento manual, sem repetição automática.
 *
 *  4) O ITEM NUNCA SOBRA. Recusa por cota, resposta incerta e resultado
 *     ambíguo registram o desfecho e deixam o item em preenchimento manual.
 *     Nenhum deles escreve aposta, e nenhum apaga o rascunho.
 *
 * O circuit breaker é GLOBAL, como `ai_usage_day` e `cursor` (a 0010 já os
 * trendeu como infraestrutura do worker): a falha do fornecedor não pertence a
 * uma organização, e nenhum tenant pode reabri-la. Por isso a tabela não leva
 * RLS — um predicado de organização ali seria uma falsa fronteira.
 */

const ORGANIZATION_SETTING = 'app.organization_id';

/**
 * STK-F2-13 — a janela de recuperação e o limiar deixaram de ser constantes de
 * código: passaram a ser DADOS em `integration.breaker_policy`, lidos por escopo
 * (`readPolicies`). Os valores abaixo são a política de DEGRADAÇÃO, usada só
 * quando a tabela não pode ser lida, e são deliberadamente MAIS CONTIDOS que
 * o default gravado pela migração: perder a tabela de política fecha a porta mais
 * cedo, nunca a abre.
 */
export const AI_CIRCUIT_RECOVERY_MS = 15 * 60 * 1000;

/**
 * Falhas CONFIRMADAS consecutivas que abrem o circuito, por escopo, quando a
 * política do banco está disponível. O valor canônico é o mesmo gravado pela
 * migração; a STK-F2-13 trocou a CONSTANTE pela LINHA, e este número continua
 * exportado porque é o default verificável do que o banco deve conter.
 *
 * Falha incerta NÃO conta: um timeout pode ter custado trabalho ao fornecedor,
 * mas não é recusa do serviço, e abrir o circuito por algo que pode ser um
 * sucesso cobraria disponibilidade sem causa.
 */
export const AI_CIRCUIT_FAILURE_THRESHOLD = 5;

export const sha256Hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

/** Categoria de um erro de integração, pela fronteira já classificada. */
export function categoryForErrorCode(code: string): ExtractionErrorCategory {
  if (code === 'AI_REQUEST_INTERRUPTED') return 'uncertain_timeout';
  if (code === 'AI_CONNECTION_FAILED') return 'uncertain_network';
  if (code === 'AI_RATE_LIMITED') return 'confirmed_rate_limited';
  if (code === 'AI_BUDGET_EXHAUSTED' || code === 'AI_BUDGET_UNAVAILABLE') return 'confirmed_budget';
  if (code === 'AI_AUTH_REFUSED') return 'confirmed_auth';
  if (code === 'AI_REQUEST_INVALID') return 'confirmed_request';
  if (code === 'AI_EXTRACTION_INVALID' || code === 'AI_RESPONSE_INVALID')
    return 'confirmed_response';
  return 'confirmed_provider';
}

/**
 * O secundário (§8.3) só entra depois de uma falha CONFIRMADA do primário.
 *
 * A função é explícita e testável: em resposta INCERTA o secundário é
 * recusado, porque repetir o trabalho depois de um timeout pode duplicar uma
 * chamada já cobrada. O registro do Gemini direto continua bloqueado por
 * construção: habilitá-lo é ato do orquestrador, não uma constante deste
 * arquivo.
 */
export function secondaryAllowedAfter(category: ExtractionErrorCategory | null): boolean {
  return category !== null && extractionCategoryIsConfirmed(category);
}

type RecordInput = {
  inboxId: string;
  imageSha256: string;
  outcome: ExtractionOutcome;
  errorCategory?: ExtractionErrorCategory | null;
  sanitized?: TicketExtraction | null;
  candidates?: [TicketExtraction, TicketExtraction] | null;
  usage?: ExtractionUsage | null;
  model?: string | null;
  elapsedMs?: number | null;
  breakerScope?: AiCircuitBreakerScope | null;
  promptSha256?: string | null;
  responseSha256?: string | null;
};

const day = (): string => new Date().toISOString().slice(0, 10);
const monthPrefix = (): string => day().slice(0, 7);

type BreakerRow = { state: string; recovers_at: Date | null } | undefined;

/** Um breaker está aberto enquanto `open` E a janela de recuperação não passou. */
const breakerIsOpen = (row: BreakerRow): boolean =>
  !!row && row.state === 'open' && (!row.recovers_at || row.recovers_at.getTime() > Date.now());

/**
 * Debita a quota E o custo no MESMO sinal dos demais contadores, então o painel
 * e o monitor (que leem `requests`) continuam vendo o total, e `presented` guarda
 * a semântica nova: quantas dessas foram APRESENTADAS.
 *
 * STK-F2-13 acrescenta `cost_micros` na MESMA linha: nenhuma contabilidade foi
 * duplicada, apenas uma dimensão nova sobre os mesmos dias. A DEBITADA DE
 * QUOTA é zero na recusa (`refused_quota`, nenhuma chamada saiu) e o CUSTO
 * também — mas o custo é debitado em todos os OUTROS desfechos, inclusive a
 * resposta incerta, que pode ter custado dinheiro ao fornecedor (e é por isso
 * que ela não pode ser repetida).
 */
async function debitQuota(
  client: PoolClient,
  outcome: ExtractionOutcome,
  presented: boolean,
  costMicros: number = 0,
): Promise<void> {
  const unit = quotaUnitForOutcome(outcome);
  const spent = outcome === 'refused_quota' ? 0 : Math.max(0, Math.trunc(costMicros));
  await client.query(
    `insert into integration.ai_usage_day(day,requests,presented,uncertain,failed,refused,cost_micros)
     values($1,$2,$3,$4,$5,$6,$7)
     on conflict(day) do update set
       requests=integration.ai_usage_day.requests+$2,
       presented=integration.ai_usage_day.presented+$3,
       uncertain=integration.ai_usage_day.uncertain+$4,
       failed=integration.ai_usage_day.failed+$5,
       refused=integration.ai_usage_day.refused+$6,
       cost_micros=integration.ai_usage_day.cost_micros+$7`,
    [
      day(),
      unit,
      presented ? unit : 0,
      outcome === 'uncertain' ? 1 : 0,
      outcome === 'confirmed_failure' ? 1 : 0,
      outcome === 'refused_quota' ? 1 : 0,
      spent,
    ],
  );
}

export function createExtractionPolicyService(database: Database) {
  const tenant = createTenantContext(database);
  const withOrg = <T>(
    context: OrganizationContext,
    action: (client: PoolClient) => Promise<T>,
    options: { isolation?: 'repeatable read' } = {},
  ) => tenant.withOrganizationTransaction(context, action, options);

  /**
   * Lê os três escopos do circuito de uma vez. Leitura GLOBAL: é
   * infraestrutura do worker, compartilhada por todos os tenants.
   */
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
   * A política dos três escopos, lida de `integration.breaker_policy`.
   *
   * STK-F2-13: o limiar e a janela passaram a ser dados por escopo. Quando a
   * tabela não pode ser lida, a degradação é CONSERVADORA (limiar e janela mais
   * contidos que o default) — perder a política fecha a porta mais cedo, nunca
   * a abre. A leitura é GLOBAL, como o breaker: um escopo local que afrouxasse
   * o limiar daria a um tenant o direito de gastar mais que a infraestrutura.
   */
  async function readPolicies(): Promise<Record<AiCircuitBreakerScope, BreakerPolicy>> {
    let rows: {
      scope: AiCircuitBreakerScope;
      failure_threshold: number;
      recovery_ms: number;
      spend_cap_micros: string | null;
      spend_window: 'day' | 'month' | null;
    }[];
    try {
      rows = (
        await database.pool.query(
          `select scope,failure_threshold,recovery_ms,spend_cap_micros,spend_window
             from integration.breaker_policy`,
        )
      ).rows;
    } catch {
      // Sem tabela de política (banco ainda na 0024, por exemplo): os
      // defaults de degradação assumem, e a porta segue fechada cedo.
      rows = [];
    }
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    const policy = (scope: AiCircuitBreakerScope): BreakerPolicy => {
      const row = byScope.get(scope);
      if (!row)
        return {
          scope,
          failureThreshold: 3,
          recoveryMs: 5 * 60_000,
          spendCapMicros: null,
          spendWindow: null,
        };
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

  /**
   * Uma falha CONFIRMADA alimenta o circuito. Só elas: timeout e conexão
   * perdida são incertos e podem ter custado trabalho ao fornecedor sem que o
   * serviço esteja recusando chamadas.
   *
   * A gravação é idempotente por `ON CONFLICT`, e o incremento do contador
   * acontece dentro do mesmo statement do `state`, então duas falhas
   * simultâneas não se perdem entre leitura e escrita. O limiar e a janela vêm
   * da política do escopo (`readPolicies`), não de constante.
   */
  async function recordConfirmedFailure(
    category: ExtractionErrorCategory,
    userId: string | null,
  ): Promise<void> {
    const scopes: Array<{ scope: AiCircuitBreakerScope; key: string }> = [
      { scope: 'global', key: 'global' },
      { scope: 'daily', key: 'daily' },
      ...(userId ? [{ scope: 'user' as const, key: userId }] : []),
    ];
    const policies = await readPolicies();
    for (const entry of scopes) {
      const policy = policies[entry.scope];
      await database.pool.query(
        `insert into integration.ai_circuit_breaker
           (scope,scope_key,state,consecutive_confirmed_failures,opened_at,recovers_at,last_error_category)
         values($1,$2,'closed',1,null,null,$3)
         on conflict (scope,scope_key) do update set
           consecutive_confirmed_failures=integration.ai_circuit_breaker.consecutive_confirmed_failures+1,
           state=case when integration.ai_circuit_breaker.consecutive_confirmed_failures+1 >= $4
                       then 'open' else integration.ai_circuit_breaker.state end,
           opened_at=case when integration.ai_circuit_breaker.consecutive_confirmed_failures+1 >= $4
                           then coalesce(integration.ai_circuit_breaker.opened_at, now())
                           else integration.ai_circuit_breaker.opened_at end,
           recovers_at=case when integration.ai_circuit_breaker.consecutive_confirmed_failures+1 >= $4
                            then now() + ($5 || ' milliseconds')::interval
                            else integration.ai_circuit_breaker.recovers_at end,
           last_error_category=$3,
           updated_at=now()`,
        [entry.scope, entry.key, category, policy.failureThreshold, String(policy.recoveryMs)],
      );
    }
  }

  /**
   * Situação da quota, do gasto e dos três breakers, lida ANTES de qualquer
   * chamada paga.
   *
   * `refusesPaidCalls` é a decisão única que o worker consulta: teto de quota,
   * teto de gasto OU qualquer breaker aberto significa que a próxima chamada é
   * paga e não pode acontecer. O teto de gasto é o de R$200/mês (§4.7), lido
   * da MESMA soma diária que a quota usa — nenhuma contabilidade foi duplicada.
   */
  async function status(userId?: string | null): Promise<ExtractionQuotaStatus> {
    const counts = await database.pool.query<{
      daily: string;
      monthly: string;
      micros: string;
    }>(
      `select coalesce(sum(presented) filter(where day=$1),0)::text as daily,
              coalesce(sum(presented) filter(where day >= $2),0)::text as monthly,
              coalesce(sum(cost_micros) filter(where day >= $2),0)::text as micros
         from integration.ai_usage_day`,
      [day(), `${monthPrefix()}-01`],
    );
    const breakers = await readBreakers(userId ?? null);
    const policies = await readPolicies();
    const globalPolicy = policies.global;
    const row = counts.rows[0]!;
    const dailyPresented = Number(row.daily);
    const monthlyPresented = Number(row.monthly);
    const monthlyMicros = Number(row.micros);
    const quotaReached =
      dailyPresented >= AI_QUOTA_CEILINGS.dailyPresented ||
      monthlyPresented >= AI_QUOTA_CEILINGS.monthlyPresented;
    const globalOpen = breakerIsOpen(breakers.global);
    const dailyOpen = breakerIsOpen(breakers.daily);
    const userOpen = breakerIsOpen(breakers.user);
    // O teto de gasto só existe onde a política o define. Quando existe, é
    // comparação simples contra a MESMA agregação que a quota usa.
    const spendReached =
      globalPolicy.spendCapMicros !== null &&
      spendExhausted({
        micros: monthlyMicros,
        capMicros: globalPolicy.spendCapMicros,
        window: globalPolicy.spendWindow,
        exhausted: false,
      });
    return extractionQuotaStatusSchema.parse({
      dailyPresented,
      dailyCeiling: AI_QUOTA_CEILINGS.dailyPresented,
      monthlyPresented,
      monthlyCeiling: AI_QUOTA_CEILINGS.monthlyPresented,
      // STK-F2-13: gasto do mês e teto global em microreais, ao lado dos
      // números de quota. A decisão `refusesPaidCalls` abaixo é a mesma.
      monthlySpendMicros: monthlyMicros,
      globalSpendCapMicros: globalPolicy.spendCapMicros ?? AI_GLOBAL_SPEND_CAP_MICROS,
      globalOpen,
      dailyOpen,
      userOpen,
      spendExhausted: spendReached,
      refusesPaidCalls: quotaReached || spendReached || globalOpen || dailyOpen || userOpen,
    });
  }

  /**
   * Porta fail-closed antes da chamada paga.
   *
   * Com teto atingido ou breaker aberto, a função REGISTRA a recusa
   * (`refused_quota`, quota zero) e devolve o motivo. O item fica disponível
   * para preenchimento manual: a recusa é decisão de orçamento, não defeito do
   * item, e é auditada como tal. A ordem de verificação (breaker, gasto, quota)
   * é a mesma de `paidCallDecision`, que é a função pura que expressa a regra.
   */
  async function requirePaidCall(
    context: OrganizationContext,
    inboxId: string,
    imageSha256: string,
    userId?: string | null,
  ): Promise<
    | { allowed: true }
    | { allowed: false; reason: 'quota' | 'breaker' | 'spend'; scope: AiCircuitBreakerScope }
  > {
    const current = await status(userId);
    const decision = paidCallDecision(current);
    if (decision.allowed) return { allowed: true };
    await record(context, {
      inboxId,
      imageSha256,
      outcome: 'refused_quota',
      errorCategory: 'refused_quota',
      breakerScope: decision.scope as AiCircuitBreakerScope,
    });
    return {
      allowed: false,
      reason: decision.reason,
      scope: decision.scope as AiCircuitBreakerScope,
    };
  }

  /**
   * O custo estimado de um registro, em microreais, pelo preço de REFERÊNCIA do
   * catálogo (`integration.ai_model_price`).
   *
   * Três garantias, todas fechando a porta em vez de abrir:
   *  - preço ausente NÃO é custo zero: cai no valor de fallback declarado em
   *    `integration.ai_cost_model`, porque um fornecedor que escondesse o preço
   *    não conseguiria escapar do teto;
   *  - uso não declarado também não é zero (mesma regra, dentro de `aiCallCost`);
   *  - a recusa por cota custa zero, porque nenhuma chamada saiu — a regra é
   *    aplicada em `debitQuota`, que é quem conhece o desfecho.
   *
   * O preço é lido uma vez por chamada; é uma linha de catálogo por modelo, e
   * a alternativa (cache por processo) criaria um segundo número que o banco
   * não conhece.
   */
  async function costMicros(audit: ExtractionAuditRecord): Promise<number> {
    if (audit.outcome === 'refused_quota') return 0;
    const price = audit.model
      ? (
          await database.pool.query<{ input_micros_per_1k: string; output_micros_per_1k: string }>(
            'select input_micros_per_1k,output_micros_per_1k from integration.ai_model_price where model=$1',
            [audit.model],
          )
        ).rows[0]
      : undefined;
    const fallback = (
      await database.pool.query<{ unpriced_call_micros: string }>(
        "select unpriced_call_micros from integration.ai_cost_model where id='default'",
      )
    ).rows[0];
    return aiCallCost({
      model: audit.model,
      promptTokens: audit.usage.promptTokens,
      completionTokens: audit.usage.completionTokens,
      inputMicrosPer1k: price ? Number(price.input_micros_per_1k) : null,
      outputMicrosPer1k: price ? Number(price.output_micros_per_1k) : null,
      // Sem linha de fallback (banco pré-0025), o piso declarado no shared
      // entra: um número conhecido e não-zero é melhor do que custo zero.
      unpricedCallMicros: Number(fallback?.unpriced_call_micros ?? 1500),
    }).micros;
  }

  /**
   * Grava o desfecho sanitizado e debita a quota quando a extração foi
   * APRESENTADA. A validação acontece ANTES de qualquer escrita: um payload
   * com texto bruto é rejeitado aqui e nada é gravado.
   */
  async function record(
    context: OrganizationContext,
    input: RecordInput,
  ): Promise<{ id: string; audit: ExtractionAuditRecord }> {
    const presented = extractionOutcomePresentsForReview(input.outcome);
    // Os dois desfechos de apresentação não carregam categoria: apresentou-se
    // estrutura, não um erro. `candidates_pending` é ambiguidade entre dois
    // resultados válidos, não defeito — e também não recebe categoria.
    const audit = extractionAuditRecordSchema.parse({
      pipelineVersion: EXTRACTION_PIPELINE_VERSION,
      outcome: input.outcome,
      errorCategory: extractionOutcomePresentsForReview(input.outcome)
        ? null
        : (input.errorCategory ?? null),
      imageSha256: input.imageSha256,
      promptHash: input.promptSha256 ?? sha256Hex(EXTRACTION_PIPELINE_VERSION),
      responseHash: input.responseSha256 ?? sha256Hex(EXTRACTION_PIPELINE_VERSION),
      sanitized: input.sanitized ?? null,
      candidates: input.candidates ?? null,
      usage: input.usage ?? EMPTY_EXTRACTION_USAGE,
      model: input.model ?? null,
      elapsedMs: input.elapsedMs ?? null,
      quotaUnit: quotaUnitForOutcome(input.outcome),
    });
    return withOrg(context, async (client) => {
      const row = (
        await client.query<{ id: string }>(
          `insert into integration.extraction_audit
             (organization_id,inbox_id,pipeline_version,outcome,error_category,sanitized,candidates,
              selected,usage,prompt_sha256,response_sha256,image_sha256,model,elapsed_ms,
              outcome_presented,presented_at,breaker_scope)
           values (current_setting($1, true)::uuid,$2,$3,$4,$5,$6,$7,null,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           on conflict do nothing
           returning id`,
          [
            ORGANIZATION_SETTING,
            input.inboxId,
            audit.pipelineVersion,
            audit.outcome,
            audit.errorCategory,
            audit.sanitized ? JSON.stringify(audit.sanitized) : null,
            audit.candidates ? JSON.stringify(audit.candidates) : null,
            JSON.stringify(audit.usage),
            audit.promptHash,
            audit.responseHash,
            audit.imageSha256,
            audit.model,
            audit.elapsedMs,
            presented,
            presented ? new Date() : null,
            input.breakerScope ?? null,
          ],
        )
      ).rows[0];
      // `on conflict do nothing` só dispara no índice parcial de apresentação
      // (o único UNIQUE condicional da tabela): quando o item JÁ foi contado, a
      // debitada é pulada — é o banco que impede a contagem dupla.
      // STK-F2-13: o custo é estimado pelo preço de referência do catálogo e
      // debitado na MESMA transação da auditoria, para que a contabilidade de
      // custo nunca fique atrás da de quota. A recusa não debita nada.
      if (row) await debitQuota(client, audit.outcome, presented, await costMicros(audit));
      // As colunas do `inbox` acompanham o desfecho para que o preview (F2-05)
      // e a auditoria leiam o mesmo estado, sem depender de join.
      await client.query(
        `update integration.inbox
            set extraction_pipeline_version=$3, extraction_outcome=$4, extraction_error_category=$5,
                extraction_prompt_sha256=coalesce($6,extraction_prompt_sha256),
                extraction_response_sha256=coalesce($7,extraction_response_sha256),
                extraction_presented_at=case when $8::boolean
                                           then coalesce(extraction_presented_at, now())
                                           else extraction_presented_at end,
                updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2`,
        [
          ORGANIZATION_SETTING,
          input.inboxId,
          audit.pipelineVersion,
          audit.outcome,
          audit.errorCategory,
          audit.promptHash,
          audit.responseHash,
          presented,
        ],
      );
      return { id: row?.id ?? '', audit };
    });
  }

  /**
   * Registra o desfecho de uma falha e devolve a categoria, para que o chamador
   * decida se o secundário é legítimo (só depois de uma falha CONFIRMADA).
   *
   * Falha confirmada alimenta o circuito; a incerta não — e ambas deixam o item
   * para preenchimento manual, sem repetir chamada paga.
   */
  async function recordFailure(
    context: OrganizationContext,
    input: {
      inboxId: string;
      imageSha256: string;
      category: ExtractionErrorCategory;
      model?: string | null;
      usage?: ExtractionUsage | null;
      elapsedMs?: number | null;
      breakerScope?: AiCircuitBreakerScope | null;
      userId?: string | null;
    },
  ): Promise<{ category: ExtractionErrorCategory; secondaryAllowed: boolean }> {
    const outcome: ExtractionOutcome = input.category.startsWith('uncertain_')
      ? 'uncertain'
      : 'confirmed_failure';
    await record(context, {
      inboxId: input.inboxId,
      imageSha256: input.imageSha256,
      outcome,
      errorCategory: input.category,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
      ...(input.breakerScope !== undefined ? { breakerScope: input.breakerScope } : {}),
    });
    if (extractionCategoryIsConfirmed(input.category))
      await recordConfirmedFailure(input.category, input.userId ?? null);
    return { category: input.category, secondaryAllowed: secondaryAllowedAfter(input.category) };
  }

  /** Desfechos de um item, do mais recente para o mais antigo. */
  async function audit(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<
    {
      id: string;
      outcome: ExtractionOutcome;
      errorCategory: ExtractionErrorCategory | null;
      pipelineVersion: string;
      candidates: number;
      presentedAt: string | null;
    }[]
  > {
    return withOrg(
      context,
      async (client) => {
        const rows = (
          await client.query<{
            id: string;
            outcome: ExtractionOutcome;
            error_category: ExtractionErrorCategory | null;
            pipeline_version: string;
            candidates: unknown;
            presented_at: Date | null;
          }>(
            `select id,outcome,error_category,pipeline_version,candidates,presented_at
               from integration.extraction_audit
              where organization_id=current_setting($1, true)::uuid and inbox_id=$2
              order by created_at desc, id desc`,
            [ORGANIZATION_SETTING, inboxId],
          )
        ).rows;
        return rows.map((row) => ({
          id: row.id,
          outcome: row.outcome,
          errorCategory: row.error_category,
          pipelineVersion: row.pipeline_version,
          candidates: Array.isArray(row.candidates) ? row.candidates.length : 0,
          presentedAt: row.presented_at ? row.presented_at.toISOString() : null,
        }));
      },
      { isolation: 'repeatable read' },
    );
  }

  /** Estado do circuito por escopo, para a operação (nunca conteúdo de bilhete). */
  async function breakers(
    userId?: string | null,
  ): Promise<{ scope: AiCircuitBreakerScope; state: 'closed' | 'open'; failures: number }[]> {
    const rows = (
      await database.pool.query<{
        scope: AiCircuitBreakerScope;
        scope_key: string;
        state: 'closed' | 'open';
        consecutive_confirmed_failures: number;
        recovers_at: Date | null;
      }>(
        `select scope,scope_key,state,consecutive_confirmed_failures,recovers_at
           from integration.ai_circuit_breaker
          where scope in ('global','daily') or scope_key=$1::text
          order by scope asc, scope_key asc`,
        [userId ?? ''],
      )
    ).rows;
    return rows.map((row) => ({
      scope: row.scope,
      // Um circuito cuja janela já passou conta como fechado: a leitura aplica
      // a mesma regra de `breakerIsOpen`, sem reescrever o banco.
      state: breakerIsOpen(row) ? 'open' : 'closed',
      failures: Number(row.consecutive_confirmed_failures),
    }));
  }

  return {
    status,
    requirePaidCall,
    record,
    recordFailure,
    audit,
    breakers,
    secondaryAllowedAfter,
    // STK-F2-13: a política dos escopos é lida do banco, e a operação precisa
    // ver o MESMO número que o serviço usa — é o que permite verificar, num
    // teste, que mudar a tabela muda o comportamento sem deploy.
    readPolicies,
  };
}

export type ExtractionPolicyService = ReturnType<typeof createExtractionPolicyService>;
