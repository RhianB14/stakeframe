import {
  createDatabase,
  createFinanceService,
  createImportService,
  createR2Storage,
  createEventService,
  createReportService,
  createOnboardingService,
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

async function main() {
  const config = readConfig(process.env);
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
    events: createEventService(database, readEventSearchConfig(process.env)),
    reports: createReportService(database),
    ...(operations ? { operations } : {}),
    ...(ownerAuth ? { ownerAuth } : {}),
  });
  app.addHook('onClose', database.close);
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
  } catch {
    await app.close();
    throw new Error('API_START_FAILED');
  }
}

void main().catch(() => {
  console.error('API_START_FAILED: verify runtime configuration');
  process.exitCode = 1;
});
