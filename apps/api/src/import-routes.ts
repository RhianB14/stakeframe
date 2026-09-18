import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { FinanceError, type ImportService } from '@stakeframe/db';
import type { OrganizationContext } from '@stakeframe/db';
import {
  apiErrorSchema,
  importPageSchema,
  importQuerySchema,
  importDetailSchema,
  uploadSchema,
  commandHeadersSchema,
  draftUpdateSchema,
  draftUpdateResultSchema,
  importStatusSchema,
  importStatusResultSchema,
  importBookmakerActionSchema,
  importBookmakerResultSchema,
  importOriginActionSchema,
  importOriginResultSchema,
  importEventActionSchema,
  importEventResultSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { validateTelegramInitData } from './telegram-init-data.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

export function registerImportRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: ImportService | undefined,
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
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
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    // The organization always comes from the authenticated user — never from the client.
    contexts.set(request, await service.ensureContext(owner.user.id));
  };
  // STK-G0-19-R5 — edição canônica do rascunho por duas interfaces do MESMO
  // registro: sessão web (cookie) ou Mini App (initData validado no servidor,
  // vinculado ao Telegram ID do proprietário). A web nunca chama o Telegram.
  const authorizeDraft = async (request: FastifyRequest, reply: FastifyReply) => {
    const initData = request.headers['x-telegram-init-data'];
    if (typeof initData === 'string' && initData.length > 0) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
      const expectedTelegramId = process.env.TELEGRAM_OWNER_USER_ID?.trim() ?? null;
      if (!botToken || !expectedTelegramId)
        return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      const validated = validateTelegramInitData(initData, botToken);
      if (!validated) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
      if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
      const context = await service.telegramOwnerContext(validated.user.id, expectedTelegramId);
      if (!context) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
      contexts.set(request, context);
      return;
    }
    return authorize(request, reply);
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
      execute(request, reply, () =>
        service!.list(contexts.get(request)!, importQuerySchema.parse(request.query)),
      ),
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
          contexts.get(request)!,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          uploadSchema.parse(request.body),
        ),
      ),
  );
  app.patch(
    '/api/v1/imports/:id',
    {
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'updateImportDraft',
        summary: 'Atualizar rascunho da importação (origem, crédito e data do evento)',
        params,
        body: draftUpdateSchema,
        response: {
          200: draftUpdateResultSchema,
          ...errors,
        },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const actor = request.headers['x-telegram-init-data'] ? 'telegram:miniapp' : 'web';
        return service!.updateDraft(
          contexts.get(request)!,
          params.parse(request.params).id,
          draftUpdateSchema.parse(request.body),
          actor,
        );
      }),
  );
  app.post(
    '/api/v1/imports/:id/status',
    {
      // STK-G0-19-R7 — transição REAL de status pelo Mini App ("Alterar
      // Status"): liquidação da aposta pendente pelo comando financeiro
      // canônico, com o MESMO autorizador do detalhe (sessão web ou initData
      // validado no servidor). O cliente envia apenas a ação; estado,
      // organização e valores vêm do registro canônico.
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'updateImportStatus',
        summary: 'Liquidar a aposta da importação (vitória/derrota)',
        params,
        body: importStatusSchema,
        response: { 200: importStatusResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const actor = request.headers['x-telegram-init-data'] ? 'telegram:miniapp' : 'web';
        return service!.setStatus(
          contexts.get(request)!,
          params.parse(request.params).id,
          importStatusSchema.parse(request.body),
          actor,
        );
      }),
  );
  app.get(
    '/api/v1/imports/:id',
    {
      // STK-G0-19-R6: a leitura do detalhe aceita sessão web OU initData válido
      // do Mini App (o PATCH já usava o mesmo autorizador; o GET ficou alinhado).
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'getImport',
        summary: 'Conferir extração, aliases e possíveis duplicações',
        params,
        response: { 200: importDetailSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.detail(contexts.get(request)!, params.parse(request.params).id),
      ),
  );
  // STK-G0-19-R8 — ações canônicas por importação: casa, origem e data do
  // evento. Cada rota roteia o rascunho (updateDraft) ou a aposta importada
  // (comandos financeiros canônicos com versão otimista e idempotência) — o
  // cliente nunca escreve direto na inbox quando há aposta registrada.
  const actorOf = (request: FastifyRequest) =>
    request.headers['x-telegram-init-data'] ? 'telegram:miniapp' : 'web';
  app.post(
    '/api/v1/imports/:id/bookmaker',
    {
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'updateImportBookmaker',
        summary: 'Trocar a casa do rascunho ou da aposta importada',
        params,
        body: importBookmakerActionSchema,
        response: { 200: importBookmakerResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.applyBookmaker(
          contexts.get(request)!,
          params.parse(request.params).id,
          importBookmakerActionSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.post(
    '/api/v1/imports/:id/origin',
    {
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'updateImportOrigin',
        summary: 'Trocar a origem (real/freebet) do rascunho ou da aposta importada',
        params,
        body: importOriginActionSchema,
        response: { 200: importOriginResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.applyOrigin(
          contexts.get(request)!,
          params.parse(request.params).id,
          importOriginActionSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.post(
    '/api/v1/imports/:id/event',
    {
      onRequest: authorizeDraft,
      schema: {
        ...common,
        operationId: 'updateImportEventDate',
        summary: 'Salvar a data do evento de uma seleção (simples ou múltipla)',
        params,
        body: importEventActionSchema,
        response: { 200: importEventResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.applyEvent(
          contexts.get(request)!,
          params.parse(request.params).id,
          importEventActionSchema.parse(request.body),
          actorOf(request),
        ),
      ),
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
        const result = await service!.image(
          contexts.get(request)!,
          params.parse(request.params).id,
        );
        reply
          .type(result.mime)
          .header('content-disposition', 'inline')
          .header('cross-origin-resource-policy', 'same-origin');
        return result.image;
      }),
  );
}
