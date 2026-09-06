import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { systemStatusSchema } from '@stakeframe/shared';
import { registerAuthRoutes } from './auth-routes.js';
import type { OwnerAuth } from './auth.js';

export function createApp(options: {
  checkDatabase: () => Promise<void>;
  logger?: boolean;
  ownerAuth?: OwnerAuth;
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
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await options.checkDatabase();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/v1/system/status', async () => {
    let database: 'available' | 'unavailable' = 'available';
    try {
      await options.checkDatabase();
    } catch {
      database = 'unavailable';
    }
    return systemStatusSchema.parse({
      name: 'Stakeframe',
      stage: 'local-setup',
      database,
      authentication: options.ownerAuth ? 'google' : 'not-configured',
      productEnabled: false,
    });
  });
  registerAuthRoutes(app, options.ownerAuth);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.', requestId: request.id },
    }),
  );
  app.setErrorHandler((_error, request, reply) => {
    const candidate =
      _error instanceof Error && 'statusCode' in _error ? _error.statusCode : undefined;
    const status =
      typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
    const code = status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    app.log.warn({ code, requestId: request.id }, 'Request refused');
    return reply.code(status).send({
      error: {
        code,
        message:
          status >= 500 ? 'Não foi possível concluir a solicitação.' : 'Solicitação inválida.',
        requestId: request.id,
      },
    });
  });
  return app;
}
