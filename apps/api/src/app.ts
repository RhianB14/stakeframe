import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import {
  apiErrorSchema,
  livenessSchema,
  readinessSchema,
  resolveReleaseInfo,
  systemStatusSchema,
  telemetryPublicConfigSchema,
  unavailabilitySchema,
  type ReleaseInfo,
} from '@stakeframe/shared';
import { registerAuthRoutes } from './auth-routes.js';
import { registerConsentRoutes } from './consent-routes.js';
import type { OwnerAuth } from './auth.js';
import { registerApiContracts } from './openapi.js';
import { sendApiError } from './api-errors.js';
import { registerFinanceRoutes } from './finance-routes.js';
import type {
  FinanceService,
  ImportService,
  EventService,
  FreebetService,
  NotificationService,
  ReportService,
  OnboardingService,
  AccountDeletionService,
  AccountExportService,
  AdminPanelService,
} from '@stakeframe/db';
import { registerReportRoutes } from './report-routes.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerEventRoutes } from './event-routes.js';
import { registerFreebetRoutes } from './freebet-routes.js';
import { registerOperationsRoutes, type OperationsService } from './operations.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerTelegramLinkRoutes } from './telegram-link-routes.js';
import { registerDebugRoutes } from './debug-routes.js';
import { registerAdminPanelRoutes } from './admin-routes.js';
import type { TelemetryHandle } from './telemetry.js';
import type { TelegramLinkService } from '@stakeframe/db';

export function createApp(options: {
  checkDatabase: () => Promise<void>;
  logger?: boolean;
  ownerAuth?: OwnerAuth;
  runtime?: 'local' | 'production';
  release?: ReleaseInfo;
  finance?: FinanceService;
  imports?: ImportService;
  events?: EventService;
  freebets?: FreebetService;
  notifications?: NotificationService;
  reports?: ReportService;
  operations?: OperationsService;
  onboarding?: OnboardingService;
  account?: { deletion: AccountDeletionService; exports: AccountExportService };
  /** STK-F2-11: painel interno do superadmin (metadados); ausente = rota 404. */
  adminPanel?: AdminPanelService;
  /** STK-F2-04: vínculo com a conta do Telegram; ausente = rotas indisponíveis. */
  telegramLink?: TelegramLinkService;
  telemetry?: TelemetryHandle;
}) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 16_384,
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  registerApiContracts(app);
  app.after(() => {
    app.get(
      '/health/live',
      {
        schema: {
          operationId: 'getLiveness',
          tags: ['Operação'],
          summary: 'Verificar se a API está em execução',
          security: [],
          response: { 200: livenessSchema, 500: apiErrorSchema, default: apiErrorSchema },
        },
      },
      async () => ({ status: 'alive' }),
    );
    app.get(
      '/health/ready',
      {
        schema: {
          operationId: 'getReadiness',
          tags: ['Operação'],
          summary: 'Verificar disponibilidade do banco',
          security: [],
          response: {
            200: readinessSchema,
            503: unavailabilitySchema,
            500: apiErrorSchema,
            default: apiErrorSchema,
          },
        },
      },
      async (_request, reply) => {
        try {
          await options.checkDatabase();
          return { status: 'ready' };
        } catch {
          return reply.code(503).send({ status: 'unavailable' });
        }
      },
    );
    app.get(
      '/api/v1/system/status',
      {
        schema: {
          operationId: 'getSystemStatus',
          tags: ['Operação'],
          summary: 'Consultar o estado técnico da aplicação',
          security: [],
          response: { 200: systemStatusSchema, 500: apiErrorSchema, default: apiErrorSchema },
        },
      },
      async () => {
        let database: 'available' | 'unavailable' = 'available';
        try {
          await options.checkDatabase();
        } catch {
          database = 'unavailable';
        }
        return systemStatusSchema.parse({
          name: 'Stakeframe',
          stage: options.runtime === 'production' ? 'production-setup' : 'local-setup',
          database,
          authentication: options.ownerAuth ? 'google' : 'not-configured',
          productEnabled: Boolean(options.finance),
          release: options.release ?? resolveReleaseInfo(),
        });
      },
    );
    // STK-F1-10: configuração pública de telemetria do cliente (o web ativa
    // Sentry/PostHog em runtime a partir daqui — apenas identificadores
    // públicos; o token do Better Stack nunca sai do servidor).
    app.get(
      '/api/v1/telemetry/config',
      {
        schema: {
          operationId: 'getTelemetryConfig',
          tags: ['Operação'],
          summary: 'Consultar a configuração pública de telemetria do cliente',
          security: [],
          response: {
            200: telemetryPublicConfigSchema,
            500: apiErrorSchema,
            default: apiErrorSchema,
          },
        },
      },
      async () => {
        const telemetry = options.telemetry;
        const release = options.release ?? resolveReleaseInfo();
        // STK-F1-10: o cliente web usa o projeto Sentry PÚBLICO (sentry_dsn_web);
        // o DSN do servidor nunca sai daqui.
        const sentry =
          telemetry?.config.sentry.enabled && telemetry.config.sentry.publicDsn
            ? {
                dsn: telemetry.config.sentry.publicDsn,
                environment: telemetry.config.sentry.environment,
              }
            : null;
        const posthog =
          telemetry?.config.posthog.enabled && telemetry.config.posthog.key
            ? { key: telemetry.config.posthog.key }
            : null;
        return { sentry, posthog, release: { version: release.version, commit: release.commit } };
      },
    );
    registerAuthRoutes(app, options.ownerAuth);
    registerConsentRoutes(app, options.ownerAuth);
    registerFinanceRoutes(app, options.ownerAuth, options.finance);
    registerOnboardingRoutes(app, options.ownerAuth, options.onboarding);
    registerTelegramLinkRoutes(app, options.ownerAuth, options.telegramLink);
    registerImportRoutes(app, options.ownerAuth, options.imports);
    registerEventRoutes(app, options.ownerAuth, options.events);
    registerFreebetRoutes(app, options.ownerAuth, options.freebets, options.notifications);
    registerReportRoutes(app, options.ownerAuth, options.reports);
    registerAccountRoutes(
      app,
      options.ownerAuth,
      options.reports,
      options.account?.deletion,
      options.account?.exports,
    );
    registerOperationsRoutes(app, options.operations);
    registerDebugRoutes(app, options.ownerAuth, options.telemetry);
    registerAdminPanelRoutes(app, options.ownerAuth, options.adminPanel);
    app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  });
  app.setNotFoundHandler((request, reply) => sendApiError(request, reply, 404, 'NOT_FOUND'));
  app.setErrorHandler((_error, request, reply) => {
    const candidate =
      _error instanceof Error && 'statusCode' in _error ? _error.statusCode : undefined;
    const status =
      typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    // STK-G0-19-R10 — as três ações de importação exigem `idempotency-key`; a
    // ausência do header na validação de schema responde com o código estável e
    // sanitizado documentado no contrato (IDEMPOTENCY_KEY_REQUIRED).
    const actionPath = /^\/api\/v1\/imports\/[^/]+\/(bookmaker|origin|event)$/.test(
      request.url.split('?')[0]!,
    );
    const code =
      status >= 500
        ? 'INTERNAL_ERROR'
        : status === 400 && actionPath && !request.headers['idempotency-key']
          ? 'IDEMPOTENCY_KEY_REQUIRED'
          : 'INVALID_REQUEST';
    // STK-F1-10: apenas falhas internas (>=500) alimentam o Sentry — o
    // beforeSend sanitiza o evento (§4.6); 4xx nunca poluem a telemetria.
    if (status >= 500) {
      options.telemetry?.captureError(_error, {
        requestId: request.id,
        path: request.url.split('?')[0],
      });
    }
    app.log.warn({ code, requestId: request.id }, 'Request refused');
    return sendApiError(request, reply, status, code);
  });
  return app;
}
