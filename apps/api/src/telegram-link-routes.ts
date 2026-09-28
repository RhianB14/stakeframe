import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {
  apiErrorSchema,
  buildTelegramDeepLink,
  telegramLinkConfirmSchema,
  telegramLinkRequestResultSchema,
  telegramLinkStateResultSchema,
  telegramLinkStatusSchema,
} from '@stakeframe/shared';
import { TELEGRAM_LINK_TTL_MS, TelegramLinkError, type TelegramLinkService } from '@stakeframe/db';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

/**
 * Rotas do vínculo Telegram (STK-F2-04).
 *
 * Mesmo gate de toda rota privada do produto: sessão válida de identidade
 * admitida (`ownerAuth.getOwner`) mais consentimento vigente, e Origin igual à
 * origem configurada em qualquer escrita. A organização vem SEMPRE do usuário
 * autenticado — o corpo da requisição nunca escolhe tenant, conta Telegram ou
 * identidade; o único dado que o cliente traz é o token de uso único do deep
 * link, que o servidor resolve pelo hash.
 *
 * Sem webhook e sem serviço novo: o bot continua sendo consumido por polling no
 * worker existente, que apenas reivindica a conta observada no Telegram. A
 * confirmação é sempre aqui.
 */
export function registerTelegramLinkRoutes(
  app: FastifyInstance,
  ownerAuth: OwnerAuth | undefined,
  service: TelegramLinkService | undefined,
) {
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
  const organizations = new WeakMap<FastifyRequest, string>();
  const identities = new WeakMap<FastifyRequest, string>();

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
    organizations.set(request, owner.organization.id);
    identities.set(request, owner.user.id);
  };

  /** Mapa código do serviço → status HTTP; nada além do código vaza. */
  const refuse = (error: unknown) => {
    if (!(error instanceof TelegramLinkError)) return null;
    switch (error.code) {
      case 'TELEGRAM_LINK_INVALID':
      case 'TELEGRAM_LINK_REVOKED':
        return 400;
      case 'TELEGRAM_LINK_NOT_LINKED':
        return 404;
      case 'TELEGRAM_LINK_EXPIRED':
      case 'TELEGRAM_LINK_CONSUMED':
      case 'TELEGRAM_LINK_NOT_CLAIMED':
      case 'TELEGRAM_LINK_ALREADY_LINKED':
      case 'TELEGRAM_LINK_IDENTITY_CONFLICT':
        return 409;
      default:
        return 503;
    }
  };

  app.get(
    '/api/v1/telegram/link',
    {
      onRequest: authorize,
      schema: {
        operationId: 'getTelegramLink',
        tags: ['Telegram'],
        summary: 'Consultar o estado do vínculo com a conta do Telegram',
        security: ownerSessionSecurity,
        description:
          'Estado do vínculo do próprio usuário autenticado: se há conta do Telegram vinculada e desde quando. Nunca devolve o identificador numérico da conta (dado de terceiro, desnecessário para a decisão). Exige sessão válida e consentimento vigente.',
        response: { 200: telegramLinkStatusSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      try {
        const status = await service.linkStatus({
          userId: identities.get(request)!,
          organizationId: organizations.get(request)!,
        });
        return reply.send(
          telegramLinkStatusSchema.parse({
            linked: status.linked,
            linkedAt: status.linkedAt,
            deepLink: null,
            expiresAt: null,
            expiresInSeconds: null,
          }),
        );
      } catch (error) {
        const status = refuse(error);
        if (status) return sendApiError(request, reply, status, (error as TelegramLinkError).code);
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/telegram/link',
    {
      onRequest: authorize,
      schema: {
        operationId: 'requestTelegramLink',
        tags: ['Telegram'],
        summary: 'Gerar um novo deep link de uso único para vincular a conta do Telegram',
        security: ownerSessionSecurity,
        description:
          'Emite um deep link de uso único válido por cinco minutos. Um pedido anterior ainda vivo do próprio usuário é invalidado no mesmo instante, de modo que existe no máximo um link utilizável por conta. O username do bot é resolvido pelo servidor a partir do Telegram; o navegador não influence. Repetir a operação é seguro: apenas o último link emitido vale. Exige Origin da aplicação, sessão válida e consentimento vigente.',
        response: { 200: telegramLinkRequestResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      const userId = identities.get(request)!;
      const organizationId = organizations.get(request)!;
      // Sem o username resolvido, nenhuma URL é inventada: falha fechada.
      const username = await service.botUsername().catch(() => null);
      if (!username) return sendApiError(request, reply, 503, 'TELEGRAM_LINK_UNAVAILABLE');
      try {
        const issued = await service.requestLink({ userId, organizationId });
        const deepLink = buildTelegramDeepLink(username, issued.token);
        if (!deepLink) return sendApiError(request, reply, 503, 'TELEGRAM_LINK_UNAVAILABLE');
        const expiresInSeconds = Math.max(
          1,
          Math.min(
            Math.ceil((new Date(issued.expiresAt).getTime() - Date.now()) / 1000),
            Math.ceil(TELEGRAM_LINK_TTL_MS / 1000),
          ),
        );
        return reply.send(
          telegramLinkRequestResultSchema.parse({
            deepLink,
            expiresAt: issued.expiresAt,
            expiresInSeconds,
          }),
        );
      } catch (error) {
        const status = refuse(error);
        if (status) return sendApiError(request, reply, status, (error as TelegramLinkError).code);
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/telegram/link/confirm',
    {
      onRequest: authorize,
      schema: {
        operationId: 'confirmTelegramLink',
        tags: ['Telegram'],
        summary: 'Confirmar no site o vínculo aberto no Telegram',
        security: ownerSessionSecurity,
        description:
          'Confirma o vínculo depois que o deep link foi aberto no Telegram. O servidor exige, nesta ordem: link existente, dentro dos cinco minutos, não consumido, pertencente a este usuário e com a conta já observada pelo bot — o navegador nunca escolhe a conta. Uma conta já ativa em outro usuário é recusada por conflito de identidade; um vínculo ativo anterior do próprio usuário é encerrado e relinkado com trilha de auditoria. Consumir o mesmo link duas vezes é idempotente. Exige Origin da aplicação, sessão válida e consentimento vigente.',
        body: telegramLinkConfirmSchema,
        response: { 200: telegramLinkStateResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      const body = telegramLinkConfirmSchema.parse(request.body);
      try {
        const confirmed = await service.confirmLink({
          userId: identities.get(request)!,
          organizationId: organizations.get(request)!,
          token: body.token,
        });
        return reply.send(
          telegramLinkStateResultSchema.parse({ linked: true, linkedAt: confirmed.linkedAt }),
        );
      } catch (error) {
        const status = refuse(error);
        if (status) return sendApiError(request, reply, status, (error as TelegramLinkError).code);
        throw error;
      }
    },
  );

  app.delete(
    '/api/v1/telegram/link',
    {
      onRequest: authorize,
      schema: {
        operationId: 'revokeTelegramLink',
        tags: ['Telegram'],
        summary: 'Revogar o vínculo com a conta do Telegram',
        security: ownerSessionSecurity,
        description:
          'Encerra o vínculo ATIVO do próprio usuário. A linha não é apagada: fica revogada com o instante da revogação e um evento de auditoria, preservando a trilha (inclusive de um relink posterior). Revogar quando não há vínculo responde `404 TELEGRAM_LINK_NOT_LINKED`. Exige Origin da aplicação, sessão válida e consentimento vigente.',
        response: { 200: telegramLinkStateResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (service === undefined) return;
      try {
        await service.revokeLink({
          userId: identities.get(request)!,
          organizationId: organizations.get(request)!,
        });
        return reply.send(telegramLinkStateResultSchema.parse({ linked: false, linkedAt: null }));
      } catch (error) {
        const status = refuse(error);
        if (status) return sendApiError(request, reply, status, (error as TelegramLinkError).code);
        throw error;
      }
    },
  );
}
