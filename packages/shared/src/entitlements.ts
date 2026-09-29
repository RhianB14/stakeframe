// STK-F2-13 — entitlements e circuit breakers de custo, na superfície pura e
// testável (sem banco, sem rede, sem segredo).
//
// Quatro garantias moram aqui, e cada uma é uma FUNÇÃO, não um comentário:
//
//  1) O PLANO É DADO, NÃO CÓDIGO. `free` é o plano padrão implícito: uma
//     organização sem atribuição tem o plano mais restritivo, e o chamador
//     nunca presume um plano melhor do que o banco devolveu. O plano efetivo e
//     a lista de permissões chegam do banco já resolvidos
//     (`core.organization_entitlements`); nada aqui recalcula permissão.
//
//  2) SEM PREÇO E SEM COBRANÇA. Não existe preço de venda neste arquivo nem em
//     qualquer schema do produto no beta. `PLAN_PRICES_ARE_UNDEFINED` existe
//     porque a AUSÊNCIA de preço é uma informação que a interface precisa
//     expor de forma honesta ("a definir"), em vez de zero — que seria uma
//     promessa de grátis que o produto não faz.
//
//  3) CUSTO é INTEIRO em microreais e nunca float. A conversão de token para
//     custo arredonda para CIMA: subestimar o custo abriria a porta quando ela
//     deveria estar fechada, e a diferença de um microreal é irrelevante contra
//     um teto de R$200. Preço ausente não é custo zero: é o preço de fallback
//     declarado, porque preço desconhecido não pode ser tratado como grátis.
//
//  4) RECUSA É FAIL-CLOSED E O ITEM SOBREVIVE. `paidCallDecision` é a função
//     única que decide se uma chamada paga pode acontecer; ela devolve o motivo
//     e o escopo, e nenhum caminho devolve "pode" com um breakers aberto. O
//     chamador registra `refused_quota` (quota zero) e mantém o item para
//     preenchimento manual.

import { z } from 'zod';

/** Planos do beta. O catálogo vive no banco; aqui só o vocabulário. */
export const PLAN_IDS = ['free', 'starter', 'pro'] as const;
export const planIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof planIdSchema>;

/** Plano implícito: o mais restritivo, aplicado a quem não tem atribuição. */
export const DEFAULT_PLAN_ID: PlanId = 'free';

/** Ordem de classificação. É ordem de exibição, nunca valor financeiro. */
export const PLAN_RANKS: Record<PlanId, number> = { free: 0, starter: 1, pro: 2 };

/**
 * SEM PREÇO no beta (Plano §4.7; cobrança é Fase 4 / Mercado Pago e está fora
 * do escopo deste card). O marcador existe para que a interface exiba "a
 * definir" em vez de um número inventado, e para que nenhum teste finja que
 * houve preço.
 */
export const PLAN_PRICES_ARE_UNDEFINED = true as const;

/** Recursos que um plano pode liberar. Conjunto FECHADO, como as categorias. */
export const ENTITLEMENT_FEATURES = [
  'ocr_extraction',
  'telegram_ticket_flow',
  'event_search',
  'freebet_alerts',
  'advanced_dashboards',
] as const;
export const entitlementFeatureSchema = z.enum(ENTITLEMENT_FEATURES);
export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;

/**
 * Uma permissão JÁ RESOLVIDA pelo banco. Esta é a forma que atravessa a
 * fronteira: o serviço entrega exatamente o que `core.organization_entitlements`
 * devolveu, e nenhuma camada acima reconstrói a decisão.
 *
 * `limit` é o teto de uso do recurso (unidades por mês, na unidade do
 * recurso) ou `null` para "sem teto próprio". Ele NÃO é preço e NÃO autoriza
 * gasto: acima dele continuam valendo o teto global de quota e o teto global de
 * R$200/mês, porque plano nunca amplia a capacidade da infraestrutura.
 */
export const entitlementSchema = z.strictObject({
  plan: planIdSchema,
  feature: entitlementFeatureSchema,
  enabled: z.boolean(),
  limit: z.number().int().nonnegative().nullable(),
});
export type Entitlement = z.infer<typeof entitlementSchema>;

/**
 * Custo estimado de UMA chamada, derivado do uso declarado e do preço de
 * referência do modelo. É ESTIMATIVA do que pagamos ao fornecedor, não o que
 * recebemos: o beta não cobra nada do usuário (Plano §4.7).
 */
export const aiCallCostSchema = z.strictObject({
  /** Microreais (1 BRL = 1.000.000 micros). Inteiro, nunca float. */
  micros: z.number().int().nonnegative(),
  /** Verdadeiro quando o preço do modelo não está no catálogo. */
  priced: z.boolean(),
});
export type AiCallCost = z.infer<typeof aiCallCostSchema>;

/** Entrada de custo: o que o fornecedor declarou e o preço de referência. */
export const aiCostInputSchema = z.strictObject({
  model: z.string().min(1).max(200).nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  /** Preço de referência do modelo, quando o catálogo o conhece. */
  inputMicrosPer1k: z.number().int().nonnegative().nullable(),
  outputMicrosPer1k: z.number().int().nonnegative().nullable(),
  /** Custo de uma chamada sem preço conhecido; nunca zero. */
  unpricedCallMicros: z.number().int().nonnegative(),
});
export type AiCostInput = z.infer<typeof aiCostInputSchema>;

const ceilMicros = (tokens: number, microsPer1k: number): number =>
  Math.ceil((tokens * microsPer1k) / 1000);

/**
 * O custo de uma chamada, em microreais.
 *
 * Três decisões, todas favoring fechar a porta:
 *
 *  - ARREDONDA PARA CIMA. Uma divisão exata daria a um teto a chance de ser
 *    furado por fração de microreal acumulado; arredondar para cima torna o
 *    valor declarado um TETO do custo real, nunca uma estimativa otimista.
 *  - USO AUSENTE ≠ CUSTO ZERO. Se o fornecedor não declara tokens, o custo não
 *    é zero: é o preço de fallback declarado. Um fornecedor que escondesse o
 *    uso não conseguiria escapar do teto.
 *  - PREÇO AUSENTE = CHAMADA INTEIRA. Modelo fora do catálogo custa o valor de
 *    uma chamada completa, não a soma de tokens desconhecidos.
 */
export function aiCallCost(input: AiCostInput): AiCallCost {
  const parsed = aiCostInputSchema.parse(input);
  const { inputMicrosPer1k, outputMicrosPer1k, model } = parsed;
  if (inputMicrosPer1k === null || outputMicrosPer1k === null || model === null)
    return { micros: parsed.unpricedCallMicros, priced: false };
  const prompt = parsed.promptTokens ?? 0;
  const completion = parsed.completionTokens ?? 0;
  if (prompt === 0 && completion === 0)
    // A chamada saiu e o fornecedor não declarou uso: assume-se o piso de uma
    // chamada, nunca zero.
    return { micros: parsed.unpricedCallMicros, priced: false };
  return {
    micros: ceilMicros(prompt, inputMicrosPer1k) + ceilMicros(completion, outputMicrosPer1k),
    priced: true,
  };
}

/** Escopos do breaker: os mesmos três da F2-06, com a política lida do banco. */
export const BREAKER_POLICY_SCOPES = ['global', 'daily', 'user'] as const;
export const breakerPolicyScopeSchema = z.enum(BREAKER_POLICY_SCOPES);
export type BreakerPolicyScope = z.infer<typeof breakerPolicyScopeSchema>;

/**
 * Política de um escopo, lida de `integration.breaker_policy`. A F2-06 tinha
 * limiar e janela como constante de código; a F2-13 os torna DADOS, por escopo.
 */
export const breakerPolicySchema = z.strictObject({
  scope: breakerPolicyScopeSchema,
  failureThreshold: z.number().int().positive(),
  recoveryMs: z.number().int().nonnegative(),
  /** Teto de gasto do escopo em microreais, ou null se não existe. */
  spendCapMicros: z.number().int().nonnegative().nullable(),
  /** 'day' | 'month' | null. */
  spendWindow: z.enum(['day', 'month']).nullable(),
});
export type BreakerPolicy = z.infer<typeof breakerPolicySchema>;

/** Situação de gasto agregada de um escopo, já lida do banco. */
export const spendStatusSchema = z.strictObject({
  /** Gasto acumulado na janela, em microreais. */
  micros: z.number().int().nonnegative(),
  /** Teto da janela, ou null quando o escopo não tem teto de gasto. */
  capMicros: z.number().int().nonnegative().nullable(),
  /** Janela do teto, ou null. */
  window: z.enum(['day', 'month']).nullable(),
  /** Verdadeiro quando o gasto atingiu o teto. */
  exhausted: z.boolean(),
});
export type SpendStatus = z.infer<typeof spendStatusSchema>;

/**
 * O gasto atingiu o teto? Sem teto (`capMicros === null`), NUNCA: um escopo sem
 * teto não é um escopo liberado, é um escopo sem número — e inventar um teto
 * aqui seria política que não está no banco.
 */
export function spendExhausted(status: SpendStatus): boolean {
  if (status.capMicros === null) return false;
  return status.micros >= status.capMicros;
}

/** Teto global de gasto do beta: R$200 por mês (Plano Master §4.7). */
export const GLOBAL_SPEND_CAP_MICROS = 200_000_000;
export const GLOBAL_SPEND_WINDOW = 'month' as const;

/** Como a teto de R$200 é apresentado: em reais, para leitura da operação. */
export function microsToBRL(micros: number): number {
  return micros / 1_000_000;
}

/**
 * Situação completa da porta de chamada paga: o que a F2-06 já expôs (quota por
 * apresentação e os três breakers) mais o que a F2-13 acrescenta (gasto do mês
 * e o teto global em microreais).
 *
 * `refusesPaidCalls` continua sendo A DECISÃO ÚNICA: teto de quota, teto de
 * gasto ou qualquer breaker aberto significam que a próxima chamada é paga e
 * não pode acontecer.
 *
 * A forma é declarada AQUI, e não reaproveitada de `extraction-policy`, para
 * manter o grafo de importações do pacote acíclico: `extraction-policy` já
 * importa `admin` (pelos limites de cota) e `admin` importa este arquivo, então
 * importar de volta criaria um ciclo — e um ciclo entre dois arquivos que
 * exportam schemas quebra a geração do OpenAPI, não só o typecheck.
 */
export const paidCallGateSchema = z.object({
  dailyPresented: z.number().int().nonnegative(),
  dailyCeiling: z.number().int().positive(),
  monthlyPresented: z.number().int().nonnegative(),
  monthlyCeiling: z.number().int().positive(),
  /** Gasto estimado do mês, em microreais (o que nós pagamos ao fornecedor). */
  monthlySpendMicros: z.number().int().nonnegative(),
  globalSpendCapMicros: z.number().int().nonnegative(),
  globalOpen: z.boolean(),
  dailyOpen: z.boolean(),
  userOpen: z.boolean(),
  /** Verdadeiro quando o gasto do mês atingiu o teto global. */
  spendExhausted: z.boolean(),
  /** Verdadeiro quando alguma fronteira impede nova chamada paga. */
  refusesPaidCalls: z.boolean(),
});
export type PaidCallGate = z.infer<typeof paidCallGateSchema>;

/**
 * A decisão da porta, com o motivo e o escopo que a abriram. É a função que a
 * API e o worker consultam ANTES de qualquer chamada paga.
 *
 * A ordem de verificação é deliberada: breakers primeiro, porque circuito
 * aberto é a informação mais específica (diz QUAL escopo recusou), e a quota
 * depois. Nenhum caminho devolve "pode" com qualquer um destes abertos.
 */
export function paidCallDecision(
  gate: PaidCallGate,
): { allowed: true } | { allowed: false; reason: 'quota' | 'breaker' | 'spend'; scope: string } {
  const parsed = paidCallGateSchema.parse(gate);
  if (parsed.globalOpen) return { allowed: false, reason: 'breaker', scope: 'global' };
  if (parsed.userOpen) return { allowed: false, reason: 'breaker', scope: 'user' };
  if (parsed.dailyOpen) return { allowed: false, reason: 'breaker', scope: 'daily' };
  if (parsed.spendExhausted) return { allowed: false, reason: 'spend', scope: 'global' };
  if (parsed.dailyPresented >= parsed.dailyCeiling)
    return { allowed: false, reason: 'quota', scope: 'daily' };
  if (parsed.monthlyPresented >= parsed.monthlyCeiling)
    return { allowed: false, reason: 'quota', scope: 'global' };
  return { allowed: true };
}

/**
 * O tenant pode usar o recurso? A resposta vem das permissões que o BANCO
 * devolveu: nada é presumido e nada é ampliado. Um recurso ausente da lista é
 * negado, o que faz da ausência a forma fail-closed.
 */
export function entitlementAllows(
  entitlements: readonly Entitlement[],
  feature: EntitlementFeature,
): boolean {
  return entitlements.some((entry) => entry.feature === feature && entry.enabled);
}

/**
 * O tenant ainda tem folga do plano para este recurso?
 *
 * `used` é o consumo medido na unidade do próprio recurso (extrações
 * apresentadas, no caso da OCR). Sem `limit` não há teto de plano; e o teto de
 * plano NUNCA amplia a infraestrutura: quem tem teto de plano esgotado é
 * negado, e quem não tem é limitado pelos tetos globais como qualquer outro.
 */
export function entitlementWithinLimit(
  entitlements: readonly Entitlement[],
  feature: EntitlementFeature,
  used: number,
): boolean {
  const entry = entitlements.find((candidate) => candidate.feature === feature);
  if (!entry || !entry.enabled) return false;
  if (entry.limit === null) return true;
  return used < entry.limit;
}

/** Códigos sanitizados da fronteira de entitlement (padrão já usado na API). */
export const ENTITLEMENT_ERROR_CODES = [
  'ENTITLEMENT_FEATURE_DENIED',
  'ENTITLEMENT_PLAN_LIMIT_REACHED',
  'PAID_CALL_CEILING_REACHED',
] as const;
export const entitlementErrorCodeSchema = z.enum(ENTITLEMENT_ERROR_CODES);
export type EntitlementErrorCode = z.infer<typeof entitlementErrorCodeSchema>;

/**
 * Orientação de tela para a recusa. A regra do card é que o item continue
 * disponível para o FLUXO MANUAL: a recusa é de orçamento ou de plano, não
 * defeito do bilhete, então a mensagem diz o que fazer em vez de terminar a
 * conversa. O texto é fixo por código — nenhum valor, nome ou id entra nele.
 */
export const manualFlowGuidance = {
  ENTITLEMENT_FEATURE_DENIED:
    'Este recurso não está disponível no seu plano. Você pode continuar o preenchimento manual desta importação.',
  ENTITLEMENT_PLAN_LIMIT_REACHED:
    'Seu plano atingiu o limite deste recurso. A importação continua disponível para preenchimento manual.',
  PAID_CALL_CEILING_REACHED:
    'O limite de processamento do beta foi atingido. Esta importação segue disponível para você preencher manualmente.',
  AI_LOCAL_QUOTA_REACHED:
    'O limite de processamento do beta foi atingido. Esta importação segue disponível para você preencher manualmente.',
  AI_CIRCUIT_BREAKER_OPEN:
    'A leitura automática está temporariamente pausada. Esta importação segue disponível para você preencher manualmente.',
} as const satisfies Record<string, string>;

/**
 * Tetos de cota da F2-06, espelhados aqui para que a decisão pura da porta não
 * dependa do módulo que já consome `admin`. O valor é o mesmo: 60 extrações
 * apresentadas por dia e 1500 por mês. A duplicação é deliberada e restrita a
 * DUAS constantes de leitura — o serviço real lê `AI_QUOTA_CEILINGS`, que é a
 * fonte, e este espelho existe só para a superfície pura não criar ciclo.
 */
export const AI_QUOTA_CEILING_SNAPSHOT = { dailyPresented: 60, monthlyPresented: 1500 } as const;
