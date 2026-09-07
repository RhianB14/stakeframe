import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { FinanceError, type EventService } from '@stakeframe/db';
import {
  apiErrorSchema,
  calendarQuerySchema,
  calendarPageSchema,
  calendarItemSchema,
  commandHeadersSchema,
  eventSearchInputSchema,
  eventSearchSchema,
  eventSearchStatusSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

export function registerEventRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: EventService | undefined,
) {
  const identities = new WeakMap<FastifyRequest, string>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    429: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method !== 'GET' &&
      (request.headers.origin !== auth.origin || request.headers['sec-fetch-site'] === 'cross-site')
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    identities.set(request, owner.user.id);
  };
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
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
      if (error instanceof Error && error.message === 'EVENT_PROVIDER_DISABLED')
        return sendApiError(request, reply, 503, 'EVENT_PROVIDER_DISABLED');
      if (error instanceof Error && error.message === 'EVENT_QUEUE_FULL')
        return sendApiError(request, reply, 429, 'EVENT_QUEUE_FULL');
      throw error;
    }
  };
  const common = { tags: ['Eventos'], security: ownerSessionSecurity };
  const params = z.object({ id: z.uuid() });
  app.get(
    '/api/v1/calendar',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getCalendar',
        summary: 'Consultar eventos sem duplicar valores de apostas',
        querystring: calendarQuerySchema,
        response: { 200: calendarPageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.calendar(calendarQuerySchema.parse(request.query))),
  );
  app.get(
    '/api/v1/events/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getEvent',
        summary: 'Consultar data e origem da programação de uma seleção',
        params,
        response: { 200: calendarItemSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.selection(params.parse(request.params).id)),
  );
  app.get(
    '/api/v1/event-search/status',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getEventSearchStatus',
        summary: 'Consultar disponibilidade e cotas das buscas',
        response: { 200: eventSearchStatusSchema, ...errors },
      },
    },
    (request, reply) => execute(request, reply, () => service!.status()),
  );
  app.get(
    '/api/v1/event-search',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listEventSearches',
        summary: 'Consultar as vinte buscas mais recentes para a seleção',
        querystring: z.object({ selectionId: z.uuid() }),
        response: { 200: z.array(eventSearchSchema), ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.searches(z.object({ selectionId: z.uuid() }).parse(request.query).selectionId),
      ),
  );
  app.get(
    '/api/v1/event-search/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getEventSearch',
        summary: 'Consultar uma busca persistida',
        params,
        response: { 200: eventSearchSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.search(params.parse(request.params).id)),
  );
  app.post(
    '/api/v1/event-search',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'requestEventSearch',
        summary: 'Solicitar busca externa sem alterar datas registradas',
        body: eventSearchInputSchema,
        headers: commandHeadersSchema,
        response: { 200: eventSearchSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.request(
          identities.get(request)!,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          eventSearchInputSchema.parse(request.body),
        ),
      ),
  );
}
