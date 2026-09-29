// STK-F2-11 — contrato do painel interno mínimo do superadmin (Plano Master §7.2, §15).
//
// Superfície de metadados: contas (rótulo, papel, estado), uso (cotas e filas),
// flags e erros recentes. NUNCA conteúdo: sem apostas, sem journal/posting,
// sem saldo, sem resultado, sem imagem, sem e-mail, sem token e sem conteúdo de
// usuário. A auditoria de acesso é gravada a cada tentativa (permitida ou
// negada) em `core.admin_panel_access`; a rota responde 404 para quem não for
// `superadmin` — a superfície não se anuncia.
//
// Impersonação é PROIBIDA (Plano §7.2): nenhuma rota aceita usuário ou
// organização de destino, e nenhuma delas abre dados de um tenant.

import { z } from 'zod';
import { GLOBAL_SPEND_CAP_MICROS, GLOBAL_SPEND_WINDOW, planIdSchema } from './entitlements.js';

export const adminPanelViewSchema = z
  .enum(['accounts', 'usage', 'flags', 'errors', 'audit'])
  .meta({ id: 'AdminPanelView' });
export type AdminPanelView = z.infer<typeof adminPanelViewSchema>;

export const adminPanelOutcomeSchema = z
  .enum(['allowed', 'denied'])
  .meta({ id: 'AdminPanelOutcome' });
export type AdminPanelOutcome = z.infer<typeof adminPanelOutcomeSchema>;

/**
 * Cotas do provedor de IA — GLOBAL, nunca escopada por organização (o mesmo
 * limite externo protege a infraestrutura inteira; escopar por tenant faria
 * cada organização multiplicar silenciosamente o limite). Espelha o limiar do
 * monitor externo em `apps/api/src/operations.ts` (60/dia, 1500/mês).
 */
export const AI_DAILY_REQUEST_LIMIT = 60;
export const AI_MONTHLY_REQUEST_LIMIT = 1500;

export const adminAccountsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type AdminAccountsQuery = z.infer<typeof adminAccountsQuerySchema>;

/** Uma conta do painel: metadados do tenant e do seu único membro. */
export const adminAccountSchema = z
  .object({
    organizationId: z.uuid(),
    organizationName: z.string().min(1).max(200),
    organizationCreatedAt: z.iso.datetime(),
    userId: z.string().min(1).max(200),
    role: z.enum(['owner', 'superadmin']),
    memberSince: z.iso.datetime(),
    onboardingCompletedAt: z.iso.datetime().nullable(),
    firstBetDeferredAt: z.iso.datetime().nullable(),
    consentsAccepted: z.number().int().min(0),
    deletionState: z.enum(['pending', 'cancelled', 'purged']).nullable(),
    lastSessionAt: z.iso.datetime().nullable(),
    activeSessions: z.number().int().min(0),
  })
  .strict();
export type AdminAccount = z.infer<typeof adminAccountSchema>;

export const adminAccountsSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    total: z.number().int().min(0),
    truncated: z.boolean(),
    accounts: z.array(adminAccountSchema).max(200),
  })
  .strict()
  .meta({ id: 'AdminAccounts' });
export type AdminAccounts = z.infer<typeof adminAccountsSchema>;

/** Contagens de fila por organização — nenhum item, nenhuma linha de conteúdo. */
export const adminQueueSchema = z
  .object({
    organizationId: z.uuid(),
    organizationName: z.string().min(1).max(200),
    importPending: z.number().int().min(0),
    importProcessing: z.number().int().min(0),
    importFailed: z.number().int().min(0),
    importReview: z.number().int().min(0),
    eventPending: z.number().int().min(0),
    eventProcessing: z.number().int().min(0),
    eventFailed: z.number().int().min(0),
    outboxPending: z.number().int().min(0),
    outboxFailed: z.number().int().min(0),
  })
  .strict();
export type AdminQueue = z.infer<typeof adminQueueSchema>;

/**
 * STK-F2-13 — estado dos circuit breakers por escopo, exposto ao superadmin.
 *
 * METADADOS DE OPERAÇÃO, nunca conteúdo de usuário: escopo, estado, contador de
 * falhas confirmadas e a janela de recuperação. O escopo `user` aparece pelo
 * NÚMERO DE CIRCUITOS ABERTOS, e cada circuito individual traz um identificador
 * derivado (hash) — nunca o id do usuário, que é o identificador pessoal.
 */
export const adminBreakerSchema = z
  .object({
    scope: z.enum(['global', 'daily', 'user']),
    state: z.enum(['closed', 'open']),
    /** Falhas CONFIRMADAS consecutivas. Incerteza não conta. */
    confirmedFailures: z.number().int().min(0),
    /** Fim da janela de recuperação; null quando o circuito está fechado. */
    recoversAt: z.iso.datetime().nullable(),
    /** Teto de gasto do escopo em microreais, ou null se não existe. */
    spendCapMicros: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AdminBreaker = z.infer<typeof adminBreakerSchema>;

/**
 * STK-F2-13 — gasto estimado contra o teto global de R$200/mês (Plano §4.7).
 *
 * É o que NÓS pagamos ao fornecedor, estimado por preço de referência: o beta não
 * cobra do usuário, então não existe preço de venda aqui e nenhum valor de
 * receita aparece nesta visão. Microreais saem como inteiros; a conversão para
 * real é problema de exibição, não do contrato.
 */
export const adminSpendSchema = z
  .object({
    /** Gasto estimado na janela, em microreais. */
    micros: z.number().int().nonnegative(),
    capMicros: z.number().int().nonnegative().nullable(),
    window: z.enum(['day', 'month']).nullable(),
    /** Verdadeiro quando o teto foi atingido: novas chamadas pagas são recusadas. */
    exhausted: z.boolean(),
  })
  .strict();
export type AdminSpend = z.infer<typeof adminSpendSchema>;

/**
 * Plano de UMA organização, com os tetos de uso e a marca de preço indefinido.
 *
 * O preço é `null` de propósito (§4.7: preços indefinidos, sem cobrança no
 * beta) — e `pricesDefined: false` diz isso explicitamente, para que a
 * interface nunca apresente zero como se fosse gratuito.
 */
export const adminPlanSchema = z
  .object({
    organizationId: z.uuid(),
    organizationName: z.string().min(1).max(200),
    plan: planIdSchema,
    /** Consumo do recurso mais restritivo, na unidade do recurso. */
    ocrUsedMonth: z.number().int().min(0),
    ocrLimitMonth: z.number().int().nonnegative().nullable(),
    /** `null` = preço indefinido no beta. NUNCA zero. */
    priceBRL: z.number().nonnegative().nullable(),
    pricesDefined: z.literal(false),
  })
  .strict();
export type AdminPlan = z.infer<typeof adminPlanSchema>;

/** Teto global declarado, para a operação comparar sem consultar a política. */
export const ADMIN_GLOBAL_SPEND_CAP_MICROS = GLOBAL_SPEND_CAP_MICROS;
export const ADMIN_GLOBAL_SPEND_WINDOW = GLOBAL_SPEND_WINDOW;

export const adminUsageSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    // Cota global do provedor de IA: somadas as organizações de propósito.
    ai: z
      .object({
        requestsToday: z.number().int().min(0),
        requestsMonth: z.number().int().min(0),
        dailyLimit: z.number().int().min(1),
        monthlyLimit: z.number().int().min(1),
        state: z.enum(['ready', 'warning', 'exhausted']),
      })
      .strict(),
    // STK-F2-13: gasto estimado e teto de R$200/mês, ao lado dos breakers.
    spend: adminSpendSchema,
    breakers: z.array(adminBreakerSchema).max(50),
    /** Quantos circuitos por usuário estão abertos (contagem, não identidades). */
    openUserBreakers: z.number().int().min(0),
    plans: z.array(adminPlanSchema).max(200),
    plansTruncated: z.boolean(),
    organizations: z.number().int().min(0),
    truncated: z.boolean(),
    queues: z.array(adminQueueSchema).max(200),
  })
  .strict()
  .meta({ id: 'AdminUsage' });
export type AdminUsage = z.infer<typeof adminUsageSchema>;

/**
 * Toggles operacionais de rollout realmente configurados no processo (o mesmo
 * conjunto validado por `readTelemetryConfig`/monitor). `rollout.keys` lista as
 * chaves de rollout consultadas pelo produto — hoje nenhuma, porque o produto
 * ainda não faz consulta de flag; a lista é exposta para que o painel não finja
 * existir o que não existe.
 */
export const adminFlagsSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    rollout: z
      .object({
        source: z.enum(['posthog', 'none']),
        keys: z.array(z.string().min(1).max(120)).max(50),
      })
      .strict(),
    toggles: z
      .array(z.object({ key: z.string().min(1).max(64), enabled: z.boolean() }).strict())
      .max(30),
  })
  .strict()
  .meta({ id: 'AdminFlags' });
export type AdminFlags = z.infer<typeof adminFlagsSchema>;

/**
 * Erros recentes: falhas sanitizadas do próprio produto (código de erro por
 * origem, contagem e última ocorrência) mais o estado da telemetria. NUNCA o
 * conteúdo de um erro, uma mensagem, um usuário ou uma requisição. O DSN do
 * Sentry é segredo e não sai daqui — só o fato de a integração estar ligada,
 * o ambiente e o release.
 */
export const adminErrorKindSchema = z
  .object({
    source: z.enum(['import', 'event_search', 'telegram_outbox']),
    code: z.string().min(1).max(120),
    occurrences: z.number().int().min(0),
    lastSeenAt: z.iso.datetime().nullable(),
  })
  .strict();
export type AdminErrorKind = z.infer<typeof adminErrorKindSchema>;

export const adminErrorsSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    telemetry: z
      .object({
        sentry: z.object({ enabled: z.boolean(), environment: z.string().min(1).max(64) }).strict(),
        posthog: z.object({ enabled: z.boolean() }).strict(),
        betterStack: z.object({ enabled: z.boolean() }).strict(),
        debug: z.object({ enabled: z.boolean() }).strict(),
      })
      .strict(),
    truncated: z.boolean(),
    kinds: z.array(adminErrorKindSchema).max(200),
  })
  .strict()
  .meta({ id: 'AdminErrors' });
export type AdminErrors = z.infer<typeof adminErrorsSchema>;

/** Últimos acessos ao painel (a própria trilha de auditoria, em metadados). */
export const adminAuditSchema = z
  .object({
    id: z.uuid(),
    actorUserId: z.string().min(1).max(200),
    view: adminPanelViewSchema,
    outcome: adminPanelOutcomeSchema,
    requestId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type AdminAudit = z.infer<typeof adminAuditSchema>;

export const adminAuditTrailSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    entries: z.array(adminAuditSchema).max(100),
  })
  .strict()
  .meta({ id: 'AdminAuditTrail' });
export type AdminAuditTrail = z.infer<typeof adminAuditTrailSchema>;
