import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { FinanceError, type ImportService } from '@stakeframe/db';
import {
  apiErrorSchema,
  importPageSchema,
  importQuerySchema,
  importDetailSchema,
  uploadSchema,
  commandHeadersSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

export function registerImportRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: ImportService | undefined,
) {
  const identities = new WeakMap<FastifyRequest, string>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    413: apiErrorSchema,
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
        return sendApiError(request, reply, error.code === 'NOT_FOUND' ? 404 : 409, error.code);
      if (error instanceof Error) {
        if (error.message === 'INBOX_BUSY') return sendApiError(request, reply, 429, 'INBOX_BUSY');
        if (error.message === 'INVALID_INBOX_IMAGE')
          return sendApiError(request, reply, 400, 'INVALID_INBOX_IMAGE');
        if (error.message === 'IDEMPOTENCY_CONFLICT')
          return sendApiError(request, reply, 409, 'IDEMPOTENCY_CONFLICT');
        if (error.message === 'INBOX_CAPACITY_REACHED')
          return sendApiError(request, reply, 409, 'INBOX_CAPACITY_REACHED');
        if (error.message === 'ATTACHMENT_UNAVAILABLE')
          return sendApiError(request, reply, 404, 'ATTACHMENT_UNAVAILABLE');
      }
      throw error;
    }
  };
  const common = { tags: ['Importações'], security: ownerSessionSecurity };
  const params = z.object({ id: z.uuid() });
  app.get(
    '/api/v1/imports',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listImports',
        summary: 'Consultar importações privadas',
        querystring: importQuerySchema,
        response: { 200: importPageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.list(importQuerySchema.parse(request.query))),
  );
  app.post(
    '/api/v1/imports',
    {
      onRequest: authorize,
      bodyLimit: 11_200_000,
      schema: {
        ...common,
        operationId: 'uploadTicket',
        summary: 'Enviar comprovante para revisão',
        headers: commandHeadersSchema,
        body: uploadSchema,
        response: { 200: z.object({ id: z.uuid() }), ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.upload(
          identities.get(request)!,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          uploadSchema.parse(request.body),
        ),
      ),
  );
  app.get(
    '/api/v1/imports/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getImport',
        summary: 'Conferir extração, aliases e possíveis duplicações',
        params,
        response: { 200: importDetailSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.detail(params.parse(request.params).id)),
  );
  app.get(
    '/api/v1/imports/:id/image',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getImportImage',
        summary: 'Ler comprovante privado com sessão do proprietário',
        params,
        response: { ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const result = await service!.image(params.parse(request.params).id);
        reply
          .type(result.mime)
          .header('content-disposition', 'inline')
          .header('cross-origin-resource-policy', 'same-origin');
        return result.image;
      }),
  );
}
