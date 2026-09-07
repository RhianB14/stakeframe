import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import {
  apiErrorSchema,
  livenessSchema,
  readinessSchema,
  systemStatusSchema,
  unavailabilitySchema,
} from '@stakeframe/shared';
import { registerAuthRoutes } from './auth-routes.js';
import type { OwnerAuth } from './auth.js';
import { registerApiContracts } from './openapi.js';
import { sendApiError } from './api-errors.js';
import { registerFinanceRoutes } from './finance-routes.js';
import type { FinanceService, ImportService, EventService } from '@stakeframe/db';
import { registerImportRoutes } from './import-routes.js';
import { registerEventRoutes } from './event-routes.js';

export function createApp(options: {
  checkDatabase: () => Promise<void>;
  logger?: boolean;
  ownerAuth?: OwnerAuth;
  runtime?: 'local' | 'production';
  finance?: FinanceService;
  imports?: ImportService;
  events?: EventService;
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
        });
      },
    );
    registerAuthRoutes(app, options.ownerAuth);
    registerFinanceRoutes(app, options.ownerAuth, options.finance);
    registerImportRoutes(app, options.ownerAuth, options.imports);
    registerEventRoutes(app, options.ownerAuth, options.events);
    app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  });
  app.setNotFoundHandler((request, reply) => sendApiError(request, reply, 404, 'NOT_FOUND'));
  app.setErrorHandler((_error, request, reply) => {
    const candidate =
      _error instanceof Error && 'statusCode' in _error ? _error.statusCode : undefined;
    const status =
      typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    const code = status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    app.log.warn({ code, requestId: request.id }, 'Request refused');
    return sendApiError(request, reply, status, code);
  });
  return app;
}
