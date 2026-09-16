import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { FinanceError, type FinanceService } from '@stakeframe/db';
import type { OrganizationContext } from '@stakeframe/db';
import {
  apiErrorSchema,
  workspaceSchema,
  financeCommandSchema,
  commandHeadersSchema,
  commandResultSchema,
  betQuerySchema,
  betPageSchema,
  betDetailSchema,
  pageQuerySchema,
  journalPageSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

export function registerFinanceRoutes(
  app: FastifyInstance,
  ownerAuth: OwnerAuth | undefined,
  service: FinanceService | undefined,
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ownerAuth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method !== 'GET' &&
      (request.headers.origin !== ownerAuth.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const headers = fromNodeHeaders({ cookie: request.headers.cookie });
    const owner = await ownerAuth.getOwner(headers);
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    // The organization always comes from the authenticated user — never from the client.
    const context = await service.ensureContext(owner.user.id);
    contexts.set(request, context);
  };
  const execute = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<T>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof FinanceError)
        return sendApiError(
          request,
          reply,
          error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'INVALID_FINANCIAL_OPERATION'
              ? 400
              : 409,
          error.code,
        );
      throw error;
    }
  };
  app.get(
    '/api/v1/workspace',
    {
      onRequest: authorize,
      schema: {
        operationId: 'getWorkspace',
        tags: ['Financeiro'],
        summary: 'Consultar banca, contas e cadastros privados',
        security: ownerSessionSecurity,
        response: { 200: workspaceSchema, ...errors },
      },
    },
    (request, reply) => execute(request, reply, () => service!.workspace(contexts.get(request)!)),
  );
  app.post(
    '/api/v1/commands',
    {
      onRequest: authorize,
      bodyLimit: 65_536,
      schema: {
        operationId: 'executeFinanceCommand',
        tags: ['Financeiro'],
        summary: 'Executar operação idempotente com versão conferida',
        security: ownerSessionSecurity,
        headers: commandHeadersSchema,
        body: financeCommandSchema,
        response: { 200: commandResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => {
        const context = contexts.get(request)!;
        return service!.command(
          context,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          financeCommandSchema.parse(request.body),
        );
      }),
  );
  app.get(
    '/api/v1/bets',
    {
      onRequest: authorize,
      schema: {
        operationId: 'listBets',
        tags: ['Apostas'],
        summary: 'Listar apostas por data de realização',
        security: ownerSessionSecurity,
        querystring: betQuerySchema,
        response: { 200: betPageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.bets(contexts.get(request)!, betQuerySchema.parse(request.query)),
      ),
  );
  app.get(
    '/api/v1/bets/:id',
    {
      onRequest: authorize,
      schema: {
        operationId: 'getBet',
        tags: ['Apostas'],
        summary: 'Conferir aposta e histórico de liquidações',
        security: ownerSessionSecurity,
        params: z.object({ id: z.uuid() }),
        response: { 200: betDetailSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.bet(contexts.get(request)!, z.object({ id: z.uuid() }).parse(request.params).id),
      ),
  );
  app.get(
    '/api/v1/journal',
    {
      onRequest: authorize,
      schema: {
        operationId: 'listJournal',
        tags: ['Financeiro'],
        summary: 'Consultar lançamentos e estornos',
        security: ownerSessionSecurity,
        querystring: pageQuerySchema,
        response: { 200: journalPageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.journal(contexts.get(request)!, pageQuerySchema.parse(request.query)),
      ),
  );
}
