import { z } from 'zod';
import { AI_DAILY_REQUEST_LIMIT, AI_MONTHLY_REQUEST_LIMIT } from './admin.js';
import { ticketExtractionSchema } from './imports.js';

/**
 * STK-F2-06 — a política fail-closed da extração OCR/NLP, em uma superfície
 * pura e testável, sem banco, sem rede e sem segredo.
 *
 * Quatro garantias moram aqui, e cada uma é uma FUNÇÃO, não um comentário:
 *
 *  1) CONFIRMADA x INCERTA. Uma resposta que chegou de fato (mesmo má, mesmo
 *     inválida) é CONFIRMADA e admite o secundário (§8.3). Timeout,
 *     interrupção e conexão perdida são INCERTAS: o fornecedor pode ter
 *     processado a chamada, então repetir ou trocar de modelo pode duplicar
 *     trabalho pago. Incerta NUNCA cai para o secundário.
 *
 *  2) NADA BRUTO NO BANCO. `extractionAuditRecordSchema` é strictObject e o
 *     que se persiste é a ESTRUTURA sanitizada (`ticketExtractionSchema`, que
 *     já é strict), a versão do pipeline e hashes — nunca o prompt, nunca a
 *     resposta do fornecedor. Não existe campo para guardar texto livre: a
 *     ausência é o que garante a sanitização.
 *
 *  3) COTA SÓ NA APRESENTAÇÃO. A unidade é debitada quando a extração
 *     estruturada é APRESENTADA para revisão — mesmo que o usuário descarte
 *     depois. Falha técnica não consome cota, e o retorno da debitada é uma
 *     função do RESULTADO, não da chamada ter sido feita.
 *
 *  4) O ITEM NUNCA SOBRA. Recusa por cota, resposta incerta e resultado
 *     ambíguo deixam o item APENAS para preenchimento manual: nenhum deles
 *     escreve aposta, e nenhum some com o rascunho.
 *
 * Nenhuma função aqui recebe ou devolve conteúdo de bilhete em texto livre:
 * os identificadores são hashes, e os erros são códigos.
 */

/**
 * Versão do pipeline gravada com cada registro de extração. É o que permite
 * dizer, meses depois, com qual regra a estrutura foi produzida. Muda quando a
 * política muda — e muda junto com a migração, nunca sozinho.
 */
export const EXTRACTION_PIPELINE_VERSION = 'f2-06-v1';

/**
 * Categorias de erro da extração. O conjunto é FECHADO de propósito: o que
 * entra no banco é uma categoria, e um valor fora daqui é rejeitado pelo
 * schema, não gravado como texto livre.
 */
export const EXTRACTION_ERROR_CATEGORIES = [
  /** Timeout, sinal abortado ou exceção sem resposta: o resultado é desconhecido. */
  'uncertain_timeout',
  /** Conexão perdida antes da resposta: o fornecedor pode ter processado. */
  'uncertain_network',
  /** O fornecedor recusou por limite de taxa — nada foi processado. */
  'confirmed_rate_limited',
  /** O orçamento do provedor acabou — nada foi processado. */
  'confirmed_budget',
  /** Credencial recusada — nada foi processado. */
  'confirmed_auth',
  /** Requisição rejeitada na entrada — nada foi processado. */
  'confirmed_request',
  /** A resposta chegou e não serve: é um resultado definitivo, ainda assim. */
  'confirmed_response',
  /** Resposta HTTP de erro do fornecedor — a resposta chegou. */
  'confirmed_provider',
  /** Nenhuma chamada paga foi feita porque o teto da cota foi atingido. */
  'refused_quota',
] as const;
export const extractionErrorCategorySchema = z.enum(EXTRACTION_ERROR_CATEGORIES);
export type ExtractionErrorCategory = z.infer<typeof extractionErrorCategorySchema>;

/**
 * Falha CONFIRMADA é aquela em que a RESPOSTA chegou. É a única que abre
 * caminho para o secundário (§8.3). As duas categorias `uncertain_*` são a
 * resposta que nunca chegou — o resultado da chamada é desconhecido, e é
 * exatamente aí que o fallback automático é proibido.
 */
export const extractionCategoryIsConfirmed = (category: ExtractionErrorCategory): boolean =>
  category.startsWith('confirmed_');

/** Uma recusa de cota não é falha técnica: nenhuma chamada foi feita. */
export const extractionCategoryIsTechnicalFailure = (category: ExtractionErrorCategory): boolean =>
  category.startsWith('confirmed_') || category.startsWith('uncertain_');

/**
 * Desfecho de uma extração. `presented` e `candidates_pending` são os únicos
 * que põem a extração NA MESA do usuário; os demais deixam o item apenas para
 * preenchimento manual.
 */
export const EXTRACTION_OUTCOMES = [
  'presented',
  'candidates_pending',
  'uncertain',
  'confirmed_failure',
  'refused_quota',
] as const;
export const extractionOutcomeSchema = z.enum(EXTRACTION_OUTCOMES);
export type ExtractionOutcome = z.infer<typeof extractionOutcomeSchema>;

const PRESENTATION_OUTCOMES: readonly ExtractionOutcome[] = ['presented', 'candidates_pending'];

/** A extração estruturada foi APRESENTADA para revisão? */
export const extractionOutcomePresentsForReview = (outcome: ExtractionOutcome): boolean =>
  PRESENTATION_OUTCOMES.includes(outcome);

/**
 * A unidade de cota de uma extração — função pura do DESFECHO.
 *
 * Esta é a regra inteira da cota do card em uma linha: presented e
 * candidates_pending valem 1 (mesmo que o usuário descarte depois, porque a
 * unidade foi consumida pelo simples fato de a extração ter sido apresentada),
 * e uncertain, confirmed_failure e refused_quota valem 0 (nenhum deles
 * entrega nada ao usuário e nenhum deles pode virar trabalho pago duplicado).
 */
export const quotaUnitForOutcome = (outcome: ExtractionOutcome): 0 | 1 =>
  extractionOutcomePresentsForReview(outcome) ? 1 : 0;

/**
 * Consumo declarado de tokens. Sanitizado de propósito: só inteiros não
 * negativos, sem nome de modelo sugerido pelo fornecedor e sem texto.
 *
 * Sem `meta({id})` de propósito: esta é uma estrutura INTERNA de worker, não um
 * contrato de rota. Registrar id aqui a colocaria no `docs/openapi.json` como
 * componente órfão, e o repo só nomeia os schemas que uma rota expõe (é o que
 * `ticketExtractionSchema`, aninhado em `ImportDetail`, também faz).
 */
export const extractionUsageSchema = z.strictObject({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
});
export type ExtractionUsage = z.infer<typeof extractionUsageSchema>;

/** SHA-256 em hexadecimal minúsculo. A única forma de dado volátil aqui. */
export const extractionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * O registro de extração que pode ser gravado.
 *
 * `strictObject` nos três níveis é a sanitização: um objeto com `rawResponse`,
 * `content`, `choices`, `messages` ou `prompt` é REJEITADO na borda em vez de
 * ser filtrado depois. Não existe campo de texto livre, então não existe onde
 * o texto do fornecedor caberia.
 *
 * `candidates` comporta no máximo DUAS estruturas válidas — o caso em que dois
 * resultados são igualmente bons: ambos vão para a revisão e NENHUM é gravado
 * como escolhido.
 */
export const extractionAuditRecordSchema = z.strictObject({
  pipelineVersion: z.literal(EXTRACTION_PIPELINE_VERSION),
  outcome: extractionOutcomeSchema,
  /** Nulo exatamente quando a extração foi apresentada. */
  errorCategory: extractionErrorCategorySchema.nullable(),
  /** Identidade da imagem: hash dos bytes, nunca a imagem. */
  imageSha256: extractionHashSchema,
  /** Hash do prompt enviado e da resposta recebida — o texto, nunca. */
  promptHash: extractionHashSchema,
  responseHash: extractionHashSchema,
  /** Estrutura sanitizada. `null` quando nada foi extraído. */
  sanitized: ticketExtractionSchema.nullable(),
  /** Dois resultados válidos: ambos apresentados, nenhum escolhido. */
  candidates: z.array(ticketExtractionSchema).min(1).max(2).nullable(),
  usage: extractionUsageSchema,
  /** Modelo efetivamente atendido (nome de modelo, não conteúdo). */
  model: z.string().min(1).max(200).nullable(),
  elapsedMs: z.number().int().nonnegative().max(3_600_000).nullable(),
  /** Derivado de `outcome` por `quotaUnitForOutcome` — nunca digitado. */
  quotaUnit: z.union([z.literal(0), z.literal(1)]),
});
export type ExtractionAuditRecord = z.infer<typeof extractionAuditRecordSchema>;

/**
 * Usos declarados como vazios. Um fornecedor que não informa uso não inventa
 * zero: o campo fica nulo, e a contabilidade lê nulo como ausente.
 */
export const EMPTY_EXTRACTION_USAGE: ExtractionUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

/**
 * Tetos de cota: extrações APRESENTADAS por dia e por mês (UTC).
 *
 * Reaproveita os limites que a STK-F2-11 já espelha no painel e no monitor, em
 * vez de criar um terceiro número — o teto é o mesmo, muda o que ele conta.
 */
export const AI_QUOTA_CEILINGS = {
  dailyPresented: AI_DAILY_REQUEST_LIMIT,
  monthlyPresented: AI_MONTHLY_REQUEST_LIMIT,
} as const;

/** Escopos do circuit breaker: global, diário e por usuário. */
export const AI_CIRCUIT_BREAKER_SCOPES = ['global', 'daily', 'user'] as const;
export const aiCircuitBreakerScopeSchema = z.enum(AI_CIRCUIT_BREAKER_SCOPES);
export type AiCircuitBreakerScope = z.infer<typeof aiCircuitBreakerScopeSchema>;

export const AI_CIRCUIT_BREAKER_STATES = ['closed', 'open'] as const;
export const aiCircuitBreakerStateSchema = z.enum(AI_CIRCUIT_BREAKER_STATES);
export type AiCircuitBreakerState = z.infer<typeof aiCircuitBreakerStateSchema>;

/**
 * Situação da cota e dos breakers. É a resposta que o worker consulta ANTES de
 * qualquer chamada paga, e o que a operação lê para saber por que um item foi
 * recusado. Interna: sem `meta({id})`, pelo mesmo motivo de
 * `extractionUsageSchema`.
 */
export const extractionQuotaStatusSchema = z.object({
  /** Teto de extrações apresentadas no dia (UTC). */
  dailyPresented: z.number().int().nonnegative(),
  dailyCeiling: z.number().int().positive(),
  monthlyPresented: z.number().int().nonnegative(),
  monthlyCeiling: z.number().int().positive(),
  /**
   * STK-F2-13 — gasto ESTIMADO do mês em microreais (1 BRL = 1.000.000), por
   * preço de referência do fornecedor. É o que nós pagamos, não o que o usuário
   * paga: o beta não cobra (Plano §4.7). Inteiro, nunca float.
   */
  monthlySpendMicros: z.number().int().nonnegative(),
  /** Teto global de gasto (R$200/mês na política gravada pela 0025). */
  globalSpendCapMicros: z.number().int().nonnegative(),
  /** Breaker global aberto: nenhuma chamada paga em nenhuma organização. */
  globalOpen: z.boolean(),
  /** Breaker do dia aberto. */
  dailyOpen: z.boolean(),
  /** Breaker do usuário aberto (`false` sem usuário identificado). */
  userOpen: z.boolean(),
  /** Verdadeiro quando o gasto do mês atingiu o teto global. */
  spendExhausted: z.boolean(),
  /** Verdadeiro quando alguma fronteira impede nova chamada paga. */
  refusesPaidCalls: z.boolean(),
});
export type ExtractionQuotaStatus = z.infer<typeof extractionQuotaStatusSchema>;

/**
 * Códigos sanitizados desta fronteira (padrão `AI_*` já usado no worker).
 * Nenhum deles carrega conteúdo: o nome do código É a informação.
 */
export const EXTRACTION_POLICY_ERROR_CODES = [
  'AI_OUTCOME_UNCERTAIN',
  'AI_LOCAL_QUOTA_REACHED',
  'AI_CIRCUIT_BREAKER_OPEN',
  'AI_FALLBACK_REFUSED_UNCERTAIN',
] as const;
export const extractionPolicyErrorCodeSchema = z.enum(EXTRACTION_POLICY_ERROR_CODES);
export type ExtractionPolicyErrorCode = z.infer<typeof extractionPolicyErrorCodeSchema>;
