import {
  createDatabase,
  createFinanceService,
  createImportService,
  createR2Storage,
  createEventService,
  createFreebetService,
  createNotificationService,
  createReportService,
  createReportSnapshotService,
  createOnboardingService,
  createAccountDeletionService,
  createAccountExportService,
  createAdminPanelService,
  createEntitlementService,
  createImportBatchService,
  createTelegramLinkService,
  createTelegramTicketService,
  createPolymarketRankingStore,
  readEventSearchConfig,
} from '@stakeframe/db';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createOwnerAuth } from './auth.js';
import { createEmailService } from './email-service.js';
import {
  createMemoryEmailSender,
  createResendEmailSender,
  readEmailRuntimeConfig,
} from './email.js';
import { createOperationsService } from './operations.js';
import { initTelemetry } from './telemetry.js';

async function main() {
  const config = readConfig(process.env);
  const telemetry = initTelemetry(config.telemetry, config.release);
  const database = createDatabase(config.databaseUrl);
  const email = readEmailRuntimeConfig(config.runtime, process.env);
  const ownerAuth = config.auth.enabled
    ? createOwnerAuth(config.auth, database, {
        // Resend delivery in production (RESEND_API_KEY/RESEND_FROM via environment
        // secrets); the controlled in-memory adapter in local/CI. Without a configured
        // sender the password flows stay unavailable (sanitized 503) — e-mail
        // verification is never weakened to compensate.
        ...(email
          ? {
              emailService: createEmailService({
                sender:
                  email.kind === 'resend'
                    ? createResendEmailSender({ apiKey: email.apiKey, from: email.from })
                    : createMemoryEmailSender().sender,
                origin: config.auth.origin,
              }),
            }
          : {}),
      })
    : undefined;
  const operations = createOperationsService(database, process.env);
  const app = createApp({
    checkDatabase: database.check,
    logger: true,
    runtime: config.runtime,
    release: config.release,
    finance: createFinanceService(database),
    onboarding: createOnboardingService(database),
    imports: createImportService(database, createR2Storage(process.env)),
    // STK-F2-09: importação por arquivo (template Stakeframe + CSV genérico com
    // mapeamento declarado), com preview linha a linha, commit idempotente e
    // rollback pelo caminho financeiro canônico. Sem chamada paga: o arquivo já
    // está escrito, e a porta de recurso é a mesma da foto (F2-13).
    importBatches: createImportBatchService(database),
    // STK-F2-13: porta de entitlement e custo antes de qualquer chamada paga.
    // Sem este serviço o upload recusa em 503 — fail-closed, porque um produto
    // sem o banco de entitlement não pode afirmar que respeita plano.
    entitlements: createEntitlementService(database),
    events: createEventService(database, readEventSearchConfig(process.env)),
    freebets: createFreebetService(database),
    notifications: createNotificationService(database),
    reports: createReportService(database, {
      dashboardMinSample: config.dashboard.minSample,
      dashboardCacheTtlMs: config.dashboard.cacheTtlMs,
    }),
    // STK-F2-08: a página HTML PRIVADA do relatório. O serviço é construído
    // sobre o MESMO `createReportService` interno — os números vêm da mesma
    // agregação da tela de análises, e o que o snapshot acrescenta é a
    // imutabilidade e a versão, não uma segunda conta.
    reportSnapshots: createReportSnapshotService(database),
    account: {
      deletion: createAccountDeletionService(database),
      exports: createAccountExportService(database),
    },
    // STK-F2-11: o painel existe junto com a autenticação; sem sessão ele
    // responde 404, então nunca é uma superfície anônima. Recebe o estado
    // JÁ validado da telemetria (nenhum segredo, nenhum DSN sai daqui).
    ...(ownerAuth
      ? {
          adminPanel: createAdminPanelService(database, {
            telemetry: {
              sentry: {
                enabled: telemetry.config.sentry.enabled,
                environment: telemetry.config.sentry.environment,
              },
              posthog: { enabled: telemetry.config.posthog.enabled },
              betterStack: { enabled: telemetry.config.betterStack.enabled },
              debug: { enabled: telemetry.config.debug.enabled },
            },
          }),
        }
      : {}),
    telegramLink: createTelegramLinkService(database),
    // STK-F2-05: fila de uma foto por vez, preview obrigatório e arquivo
    // recuperável por 30 dias. A confirmação usa o serviço de importação, então
    // o handle do banco é entregue à app.
    telegramTickets: createTelegramTicketService(database),
    // STK-F2-15: o ranking oficial Polymarket é LEITURA das tabelas que a
    // F2-14 gravou. Nenhuma chamada externa nova, nenhum custo, nenhuma
    // gravação — por isso a porta de entitlement da F2-13 não é consultada
    // aqui: ela existe para pagar por uma chamada, e esta rota não paga por
    // nenhuma. O limiar de amostra é o mesmo do dashboard analítico.
    polymarketRanking: createPolymarketRankingStore(database),
    dashboardMinSample: config.dashboard.minSample,
    database,
    telemetry,
    ...(operations ? { operations } : {}),
    ...(ownerAuth ? { ownerAuth } : {}),
  });
  app.addHook('onClose', database.close);
  app.addHook('onClose', async () => {
    await telemetry.shutdown();
  });
  const stop = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (ownerAuth) await ownerAuth.auth.$context;
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    telemetry.captureError(error, { stage: 'startup' });
    throw new Error('API_START_FAILED', { cause: error });
  }
}

void main().catch(() => {
  console.error('API_START_FAILED: verify runtime configuration');
  process.exitCode = 1;
});
