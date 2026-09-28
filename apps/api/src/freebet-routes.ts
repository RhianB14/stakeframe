import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  FreebetError,
  type FreebetService,
  type NotificationService,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  apiErrorSchema,
  freebetEvaluationInputSchema,
  freebetInputSchema,
  freebetListQuerySchema,
  freebetPatchSchema,
  freebetRecordSchema,
  effectiveValueSchema,
  notificationPreferencesInputSchema,
  notificationPreferencesSchema,
  notificationRecordSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

// STK-F2-10 — rotas de freebets, calculadora e preferências de notificação.
//
// Autorização: o gate é o mesmo das demais rotas privadas (sessão + origem +
// consentimento) e a organização vem SEMPRE do usuário autenticado, nunca do
// corpo. A organização B recebendo o id de uma freebet da organização A recebe
// 404 — o mesmo comportamento do §15.

export function registerFreebetRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: FreebetService | undefined,
  notifications: NotificationService | undefined,
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    422: apiErrorSchema,
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
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service || !notifications) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    contexts.set(request, await service.ensureContext(owner.user.id));
  };
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof FreebetError) {
        const status =
          error.code === 'FREEBET_NOT_FOUND' ? 404 : error.code === 'FREEBET_INVALID' ? 400 : 409;
        return sendApiError(request, reply, status, error.code);
      }
      throw error;
    }
  };
  const common = { tags: ['Freebets'], security: ownerSessionSecurity };
  const params = z.object({ id: z.uuid() });

  app.get(
    '/api/v1/freebets',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listFreebets',
        summary: 'Listar as freebets registradas com situação e requisitos',
        querystring: freebetListQuerySchema,
        response: { 200: z.array(freebetRecordSchema), ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.list(contexts.get(request)!, freebetListQuerySchema.parse(request.query)),
      ),
  );
  app.post(
    '/api/v1/freebets',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'createFreebet',
        summary: 'Registrar uma freebet com casa, valor, validade e requisitos',
        body: freebetInputSchema,
        response: { 200: freebetRecordSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.create(contexts.get(request)!, freebetInputSchema.parse(request.body)),
      ),
  );
  app.get(
    '/api/v1/freebets/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getFreebet',
        summary: 'Consultar uma freebet registrada',
        params,
        response: { 200: freebetRecordSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.get(contexts.get(request)!, params.parse(request.params).id),
      ),
  );
  app.patch(
    '/api/v1/freebets/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'updateFreebet',
        summary: 'Alterar uma freebet ainda não utilizada',
        params,
        body: freebetPatchSchema,
        response: { 200: freebetRecordSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.update(
          contexts.get(request)!,
          params.parse(request.params).id,
          freebetPatchSchema.parse(request.body),
        ),
      ),
  );
  app.delete(
    '/api/v1/freebets/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'revokeFreebet',
        summary: 'Revogar uma freebet registrada que ainda não foi utilizada',
        params,
        response: { 200: freebetRecordSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.revoke(contexts.get(request)!, params.parse(request.params).id),
      ),
  );
  app.post(
    '/api/v1/freebets/evaluate',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'evaluateFreebet',
        summary: 'Calcular o valor efetivo de uma freebet com transparência das regras',
        body: freebetEvaluationInputSchema,
        response: { 200: effectiveValueSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.evaluate(contexts.get(request)!, freebetEvaluationInputSchema.parse(request.body)),
      ),
  );

  // ------------------------------------------------------------ preferências
  app.get(
    '/api/v1/notification-preferences',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getNotificationPreferences',
        summary: 'Consultar quiet hours, fuso e tópicos do usuário',
        response: { 200: notificationPreferencesSchema, ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      return execute(request, reply, () => service!.preferences(context, context.userId));
    },
  );
  app.put(
    '/api/v1/notification-preferences',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'updateNotificationPreferences',
        summary: 'Gravar quiet hours, fuso e tópicos do usuário',
        body: notificationPreferencesInputSchema,
        response: { 200: notificationPreferencesSchema, ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      return execute(request, reply, () =>
        service!.savePreferences(
          context,
          context.userId,
          notificationPreferencesInputSchema.parse(request.body),
        ),
      );
    },
  );
  app.get(
    '/api/v1/notifications',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listNotifications',
        summary: 'Consultar as notificações do usuário, incluindo adiadas por quiet hours',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
        response: { 200: z.array(notificationRecordSchema), ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      const { limit } = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(request.query);
      return execute(request, reply, () => notifications!.list(context, context.userId, limit));
    },
  );
}
