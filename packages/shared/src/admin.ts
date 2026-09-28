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
