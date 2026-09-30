import { z } from 'zod';
import { releaseInfoSchema } from './release.js';
export * from './imports.js';
export * from './import-csv.js';
export * from './telegram.js';
export * from './telegram-flow.js';
export * from './returns.js';
export * from './decimal.js';
export * from './finance.js';
export * from './bet-table.js';
export * from './account.js';
export * from './release.js';
export * from './automatic-policy.js';
export * from './telemetry.js';
export * from './entitlements.js';
export * from './polymarket.js';
export * from './polymarket-ranking.js';
// STK-F2-16: favoritos, configuração de alertas de atividade e o job SILENCIOSO
// do Composite Score. Nenhuma exportação daqui devolve o score: o serviço
// grava a versão e só isso, e é essa ausência que mantém a avaliação paralela.
export * from './polymarket-alerts.js';

export const systemStatusSchema = z
  .object({
    name: z.literal('Stakeframe'),
    stage: z.enum(['local-setup', 'production-setup']),
    database: z.enum(['available', 'unavailable']),
    authentication: z.enum(['not-configured', 'google']),
    productEnabled: z.boolean(),
    release: releaseInfoSchema,
  })
  .meta({ id: 'SystemStatus' });

export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const apiErrorCodeSchema = z.enum([
  'NOT_FOUND',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'AUTH_NOT_CONFIGURED',
  'UNAUTHENTICATED',
  'ORIGIN_NOT_ALLOWED',
  'AUTH_REQUEST_FAILED',
  'RATE_LIMITED',
  'AUTH_UNAVAILABLE',
  'INVITE_REJECTED',
  'RESET_REJECTED',
  'EMAIL_NOT_VERIFIED',
  'CONSENT_REQUIRED',
  'CONSENT_INVALID',
  'ONBOARDING_PREREQUISITE',
  'STATE_CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_FINANCIAL_OPERATION',
  'UNIT_REQUIRED',
  'NOT_INITIALIZED',
  'ALIAS_CONFLICT',
  'ORIGIN_REQUIRED',
  'FREEBET_UNRESOLVED',
  'FREEBET_NOT_FOUND',
  'FREEBET_ALREADY_USED',
  'FREEBET_REVOKED',
  'FREEBET_INVALID',
  // STK-F2-16 — favoritos e alerta de atividade. A recusa do limite de dez é
  // de CONFLITO com uma regra do produto, não de requisição inválida: o pedido
  // é bem formado e o que falta é vaga na lista.
  'FAVORITE_NOT_FOUND',
  'FAVORITES_LIMIT_REACHED',
  'FAVORITE_INVALID',
  'ALERT_CONFIG_INVALID',
  'INCOMPLETE_BET',
  'DUPLICATE_REVIEW_REQUIRED',
  'INVALID_INBOX_IMAGE',
  'INBOX_BUSY',
  'INBOX_CAPACITY_REACHED',
  'ATTACHMENT_UNAVAILABLE',
  'EVENT_PROVIDER_DISABLED',
  'EVENT_QUEUE_FULL',
  'IDEMPOTENCY_KEY_REQUIRED',
  'TELEGRAM_LINK_INVALID',
  'TELEGRAM_LINK_EXPIRED',
  'TELEGRAM_LINK_CONSUMED',
  'TELEGRAM_LINK_REVOKED',
  'TELEGRAM_LINK_NOT_CLAIMED',
  'TELEGRAM_LINK_ALREADY_LINKED',
  'TELEGRAM_LINK_IDENTITY_CONFLICT',
  'TELEGRAM_LINK_NOT_LINKED',
  'TELEGRAM_LINK_UNAVAILABLE',
  'TELEGRAM_TICKET_NOT_FOUND',
  'TELEGRAM_TICKET_STATE_CONFLICT',
  'TELEGRAM_TICKET_DUPLICATE',
  'TELEGRAM_TICKET_ARCHIVED',
  'TELEGRAM_TICKET_EXPIRED',
  'TELEGRAM_TICKET_NOT_RECOVERABLE',
  'TELEGRAM_TICKET_BUSY',
  // STK-F2-12 — sessão do Mini App: a conta do Telegram é autêntica, mas não
  // resolve para nenhum usuário vinculado (ou foi revogada). Distinguir os três
  // estados permite orientar a interface sem revelar nada do vínculo.
  'TELEGRAM_SESSION_NOT_LINKED',
  'TELEGRAM_SESSION_REVOKED',
  'TELEGRAM_SESSION_UNAVAILABLE',
  // STK-F2-13 — entitlement recusado e teto de chamada paga atingido. As três
  // mensagens orientam o FLUXO MANUAL em vez de encerrar a conversa: a recusa
  // é de plano ou de orçamento, nunca defeito do bilhete.
  'ENTITLEMENT_FEATURE_DENIED',
  'ENTITLEMENT_PLAN_LIMIT_REACHED',
  'PAID_CALL_CEILING_REACHED',
  // STK-F2-09 — importação por arquivo. As recusas de MAPEAMENTO orientam o
  // usuário a corrigir a tela de mapeamento, e as de ESTADO a consultar o
  // resultado do lote; nenhuma delas diz que o dado do arquivo está errado.
  'IMPORT_BATCH_NOT_FOUND',
  'IMPORT_BATCH_STATE_CONFLICT',
  'IMPORT_BATCH_ALREADY_COMMITTED',
  'IMPORT_TEMPLATE_UNAVAILABLE',
  'IMPORT_FILE_TOO_LARGE',
  'IMPORT_CSV_MALFORMED',
  'IMPORT_MAPPING_CONFLICT',
  // STK-F2-08 — relatório privado. As quatro mensagens são de ACESSO ou de
  // ESTADO, nunca de conteúdo: quem recebe `REPORT_SNAPSHOT_NOT_FOUND` não
  // consegue distinguir "não existe" de "é de outra conta", e é essa
  // indistinção que impede sondar a existência de um relatório alheio.
  'REPORT_SNAPSHOT_NOT_FOUND',
  'REPORT_SNAPSHOT_NO_DATA',
  'REPORT_SNAPSHOT_NOT_REVISABLE',
  'REPORT_SERVICE_UNAVAILABLE',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const apiErrorSchema = z
  .object({
    error: z.object({ code: apiErrorCodeSchema, message: z.string(), requestId: z.uuid() }),
  })
  .meta({ id: 'ApiError' });

export const livenessSchema = z.object({ status: z.literal('alive') }).meta({ id: 'Liveness' });
export const readinessSchema = z.object({ status: z.literal('ready') }).meta({ id: 'Readiness' });
export const unavailabilitySchema = z
  .object({ status: z.literal('unavailable') })
  .meta({ id: 'Unavailability' });
export const googleSignInSchema = z
  .object({ url: z.url(), redirect: z.literal(false) })
  .meta({ id: 'GoogleSignIn' });
export const signOutSchema = z.object({ success: z.literal(true) }).meta({ id: 'SignOut' });

export const betaInviteOpenSchema = z
  .object({ token: z.string().min(1).max(512) })
  .meta({ id: 'BetaInviteOpen' });
export const betaInviteOpenedSchema = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'BetaInviteOpened' });

export const emailSignUpSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email(),
    password: z.string().min(8).max(128),
  })
  .meta({ id: 'EmailSignUp' });
export const emailSignInSchema = z
  .object({ email: z.email(), password: z.string().min(8).max(128) })
  .meta({ id: 'EmailSignIn' });

/** Sanitized session summary; never carries tokens, e-mail, cookies or provider data. */
export const authUserSummarySchema = z
  .object({ user: z.object({ id: z.string().min(1), name: z.string() }) })
  .meta({ id: 'AuthUserSummary' });
export const emailVerificationResultSchema = z
  .object({ status: z.literal(true) })
  .meta({ id: 'EmailVerificationResult' });
export const authStatusSchema = z.object({ status: z.literal(true) }).meta({ id: 'AuthStatus' });

export const passwordResetRequestSchema = z
  .object({ email: z.email().max(320) })
  .meta({ id: 'PasswordResetRequest' });
export const passwordResetSubmitSchema = z
  .object({ token: z.string().min(1).max(512), newPassword: z.string().min(8).max(128) })
  .meta({ id: 'PasswordResetSubmit' });
export const resendVerificationSchema = z
  .object({ email: z.email().max(320) })
  .meta({ id: 'ResendVerification' });

/** Stable legal-document types; never derived from display text. */
export const legalDocumentTypeSchema = z
  .enum(['terms_of_use', 'privacy_policy', 'minimum_age'])
  .meta({ id: 'LegalDocumentType' });
export type LegalDocumentTypeName = z.infer<typeof legalDocumentTypeSchema>;

export const consentDocumentStatusSchema = z
  .object({
    type: legalDocumentTypeSchema,
    version: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(600),
    textUrl: z.string().min(1).max(300),
    effectiveAt: z.iso.datetime(),
    accepted: z.boolean(),
    stale: z.boolean(),
    integrity: z.enum(['ok', 'changed']),
    acceptedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ConsentDocumentStatus' });

export const consentStatusSchema = z
  .object({
    status: z.enum(['accepted', 'pending']),
    documents: z.array(consentDocumentStatusSchema).min(1),
    pendingTypes: z.array(legalDocumentTypeSchema),
  })
  .meta({ id: 'ConsentStatus' });

export const consentAcceptSchema = z
  .object({
    documents: z
      .array(
        z.object({
          type: legalDocumentTypeSchema,
          /** Optional echo of the version the client displayed; must match the effective one. */
          version: z.string().min(1).max(64).optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .meta({ id: 'ConsentAccept' });

export const consentAcceptedSchema = z
  .object({
    accepted: z.array(
      z.object({
        type: legalDocumentTypeSchema,
        version: z.string().min(1).max(64),
        acceptedAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'ConsentAccepted' });

export const consentHistorySchema = z
  .object({
    history: z.array(
      z.object({
        type: legalDocumentTypeSchema,
        version: z.string().min(1).max(64),
        acceptedAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'ConsentHistory' });

export const probeSchema = z.object({ nonce: z.string().uuid() }).strict();
export const PROBE_QUEUE = 'system-probe';

export const organizationRoleSchema = z.enum(['owner', 'superadmin']);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const ownerSessionSchema = z
  .object({
    user: z.object({ id: z.string(), name: z.string() }),
    organization: z.object({ id: z.uuid(), role: organizationRoleSchema }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'OwnerSession' });
export type OwnerSession = z.infer<typeof ownerSessionSchema>;

/**
 * STK-F1-10: configuração pública de telemetria exposta ao cliente web. Contém
 * apenas identificadores públicos por natureza (DSN do Sentry, chave do
 * PostHog); tokens de servidor (Better Stack) nunca aparecem aqui. `null`
 * significa desligado — zero config = zero telemetria.
 */
export const telemetryPublicConfigSchema = z
  .object({
    sentry: z.object({ dsn: z.string().min(1), environment: z.string().min(1) }).nullable(),
    posthog: z.object({ key: z.string().min(1) }).nullable(),
    release: z.object({ version: z.string().min(1), commit: z.string().min(1) }),
  })
  .meta({ id: 'TelemetryPublicConfig' });
export type TelemetryPublicConfig = z.infer<typeof telemetryPublicConfigSchema>;
export * from './events.js';
export * from './freebets.js';
export * from './reports.js';
export * from './automatic.js';
export * from './operations.js';
export * from './onboarding.js';
export * from './admin.js';
export * from './telegram-link.js';
export * from './extraction-policy.js';
export * from './telegram-commands.js';
export * from './telegram-text.js';
export * from './report-snapshots.js';
export * from './report-snapshot-contract.js';
