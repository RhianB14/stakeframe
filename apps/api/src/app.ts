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
  EntitlementService,
  ImportBatchService,
  ReportSnapshotService,
  PolymarketRankingStore,
  PolymarketSimulationStore,
} from '@stakeframe/db';
import { registerReportRoutes } from './report-routes.js';
import { registerReportSnapshotRoutes } from './report-snapshot-routes.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerImportRoutes } from './import-routes.js';
import { registerImportBatchRoutes } from './import-batch-routes.js';
import { registerEventRoutes } from './event-routes.js';
import { registerFreebetRoutes } from './freebet-routes.js';
import { registerOperationsRoutes, type OperationsService } from './operations.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerTelegramLinkRoutes } from './telegram-link-routes.js';
import { registerTelegramTicketRoutes } from './telegram-ticket-routes.js';
import {
  createTelegramSessionGate,
  registerTelegramSessionRoutes,
} from './telegram-session-routes.js';
import { registerDebugRoutes } from './debug-routes.js';
import { registerAdminPanelRoutes } from './admin-routes.js';
import { registerPolymarketRankingRoutes } from './polymarket-ranking-routes.js';
import { registerPolymarketSimulationRoutes } from './polymarket-simulation-routes.js';
import type { TelemetryHandle } from './telemetry.js';
import type {
  TelegramLinkService,
  TelegramTicketService,
  Database,
  OrganizationContext,
} from '@stakeframe/db';

export function createApp(options: {
  checkDatabase: () => Promise<void>;
  logger?: boolean;
  ownerAuth?: OwnerAuth;
  runtime?: 'local' | 'production';
  release?: ReleaseInfo;
  finance?: FinanceService;
  imports?: ImportService;
  /** STK-F2-09: importação por arquivo (template + CSV genérico); ausente = 503. */
  importBatches?: ImportBatchService;
  events?: EventService;
  freebets?: FreebetService;
  notifications?: NotificationService;
  reports?: ReportService;
  /**
   * STK-F2-08: snapshots congelados, revisão versionada e a página HTML
   * PRIVADA do relatório. Ausente = as rotas de snapshot respondem 503
   * (fail-closed): sem o banco de snapshot não se pode afirmar que o
   * relatório é auditável, e um relatório "privado" sem verificação de sessão
   * seria exatamente a URL pública que o card rejeita.
   */
  reportSnapshots?: ReportSnapshotService;
  operations?: OperationsService;
  onboarding?: OnboardingService;
  account?: { deletion: AccountDeletionService; exports: AccountExportService };
  /** STK-F2-11: painel interno do superadmin (metadados); ausente = rota 404. */
  adminPanel?: AdminPanelService;
  /**
   * STK-F2-13: porta de entitlement e custo antes de chamada paga. Ausente =
   * upload recusa em 503 (fail-closed), porque um produto sem o banco de
   * entitlement não pode afirmar que respeita plano.
   */
  entitlements?: EntitlementService;
  /**
   * STK-F2-15: o limiar de amostra do ranking Polymarket. Recebe o MESMO valor
   * do dashboard analítico (`DASHBOARD_MIN_SAMPLE`), para que "amostra
   * pequena" signifique a mesma coisa na tela de ranking e na de análises.
   */
  dashboardMinSample?: number;
  /** STK-F2-04: vínculo com a conta do Telegram; ausente = rotas indisponíveis. */
  telegramLink?: TelegramLinkService;
  /** STK-F2-05: fila/preview/decisão do bilhete; ausente = rotas indisponíveis. */
  telegramTickets?: TelegramTicketService;
  /**
   * STK-F2-15: a LEITURA do ranking oficial Polymarket, sobre as tabelas que a
   * F2-14 gravou. Ausente = a rota responde 503 (fail-closed): sem a tabela de
   * séries não há como exibir a completude gravada, e uma tela de ranking sem
   * completude é exatamente a cobertura parcial apresentada como total.
   */
  polymarketRanking?: PolymarketRankingStore;
  /**
   * STK-F2-17: a APURAÇÃO da simulação indicativa. Ausente = 503 (fail-closed),
   * pela mesma razão da F2-15 e com uma a mais: sem o serviço não há como
   * gravar o registro da tentativa, e uma recusa sem registro é uma recusa que
   * pode ser reescrita como se nunca tivesse acontecido.
   */
  polymarketSimulation?: PolymarketSimulationStore;
  /**
   * Resolve (e provisiona, no primeiro uso) a organização do usuário
   * autenticado. A simulação grava na organização do DONO, e ela nunca vem do
   * corpo da requisição — um id de destino seria impersonação.
   */
  ensureOrganization?: (userId: string) => Promise<OrganizationContext>;
  /** Handle do banco: a confirmação do preview precisa do serviço de importação. */
  database?: Database;
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
  // STK-F2-12 — o gate do Mini App é construído uma vez e entregue às rotas que
  // precisam dele. A organização do usuário autenticado é resolvida pelo mesmo
  // serviço da web (`finance.ensureContext`), então os dois caminhos de
  // autenticação convergem para o MESMO contexto canônico.
  const telegramGate = createTelegramSessionGate({
    ownerAuth: options.ownerAuth,
    telegramLink: options.telegramLink,
    organizationOf: async (userId: string) => {
      if (!options.finance) throw new Error('AUTH_UNAVAILABLE');
      return options.finance.ensureContext(userId);
    },
  });
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
    registerTelegramSessionRoutes(app, telegramGate, options.telegramLink);
    // STK-F2-12 — as rotas de leitura e o comando financeiro passam a aceitar a
    // sessão do Mini App (initData validado no servidor + vínculo da F2-04),
    // convergindo com o MESMO gate de escrita e contexto da web.
    registerFinanceRoutes(app, options.ownerAuth, options.finance, telegramGate);
    registerOnboardingRoutes(app, options.ownerAuth, options.onboarding);
    registerTelegramLinkRoutes(app, options.ownerAuth, options.telegramLink);
    registerTelegramTicketRoutes(app, options.ownerAuth, options.telegramTickets, options.database);
    // STK-F2-12 — o gate do Mini App é entregue também às importações, para que
    // o editor pontual (deep link da mensagem) aceite a sessão do Telegram
    // resolvida pelo vínculo da F2-04, e não só a sessão web por cookie.
    registerImportRoutes(
      app,
      options.ownerAuth,
      options.imports,
      telegramGate,
      options.entitlements,
    );
    // STK-F2-09 — a importação por arquivo é registrada junto das demais para
    // que o gate de recurso da F2-13 seja o MESMO: um recurso desligado no
    // plano recusa o CSV com o mesmo código que recusa a foto.
    registerImportBatchRoutes(app, options.ownerAuth, options.importBatches, options.entitlements);
    registerEventRoutes(app, options.ownerAuth, options.events);
    registerFreebetRoutes(app, options.ownerAuth, options.freebets, options.notifications);
    registerReportRoutes(app, options.ownerAuth, options.reports);
    // STK-F2-08 — a página HTML PRIVADA do relatório. Fica ao lado das rotas de
    // relatório de propósito: as duas leem o mesmo serviço e o mesmo contexto,
    // e uma delas ler o snapshot enquanto a outra recomputaria criaria
    // exatamente a divergência que o snapshot existe para evitar.
    registerReportSnapshotRoutes(app, options.ownerAuth, options.reportSnapshots, options.reports);
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
    // STK-F2-15 — o ranking oficial Polymarket. Fica ao lado das demais rotas
    // privadas e usa o MESMO gate (sessão + origem + consentimento); o limiar
    // de amostra é o do dashboard analítico, para que "amostra pequena" tenha
    // um único significado no produto inteiro.
    registerPolymarketRankingRoutes(app, options.ownerAuth, options.polymarketRanking, {
      // STK-F2-02: 30 é o padrão já gravado do dashboard (`DEFAULT_DASHBOARD_MIN_SAMPLE`).
      // Aqui ele é um PADRÃO DE MONTAGEM, e o servidor sempre passa o valor
      // configurado — nenhuma tela decide sozinha o que é amostra pequena.
      minSample: options.dashboardMinSample ?? 30,
    });
    // STK-F2-17 — a simulação MERAMENTE INDICATIVA. Fica ao lado do ranking
    // porque as duas leem o MESMO status gravado pela F2-14 e precisam dizer a
    // mesma coisa sobre a completude: duas telas discordando sobre a mesma
    // série seria pior do que nenhuma tela mostrar completude.
    //
    // A rota é registrada INCONDICIONALMENTE, como o ranking e as demais
    // opcionais: o `authorize` dela responde 503 quando o serviço ou o
    // resolvedor de organização não estão registrados. Registrar só quando
    // há serviço faria a rota sumir do contrato OpenAPI sempre que o build de
    // documentação não sobe com o banco — e um contrato que esconde a rota
    // não é um contrato, é uma ausência.
    //
    // A organização nunca vem do corpo: ela é resolvida do usuário
    // AUTENTICADO. Sem o resolvedor, 503 — jamais um tenant escolhido pelo
    // corpo, que seria impersonação.
    registerPolymarketSimulationRoutes(
      app,
      options.ownerAuth,
      options.polymarketSimulation,
      options.ensureOrganization,
      {
        // O MESMO limiar do dashboard e do ranking: "amostra pequena" tem um
        // único significado no produto inteiro.
        minSample: options.dashboardMinSample ?? 30,
      },
    );
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
