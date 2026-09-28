import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { apiErrorSchema, telegramSessionSchema } from '@stakeframe/shared';
import {
  TelegramSessionError,
  readSecret,
  type OrganizationContext,
  type TelegramLinkService,
} from '@stakeframe/db';
import type { OwnerAuth } from './auth.js';
import { validateTelegramInitData } from './telegram-init-data.js';
import { sendApiError } from './api-errors.js';
import { ownerSessionSecurity } from './openapi.js';

/**
 * STK-F2-12 — Mini App do Telegram sobre a web responsiva.
 *
 * A web (F2-01) e o painel de importação já são a fonte canônica: este arquivo
 * NÃO duplica regra de negócio, tela nem contrato. Ele entrega uma coisa só, que
 * a web tem de graça e o Telegram não: uma IDENTIDADE para as mesmas rotas.
 * Dentro do cliente do Telegram não existe cookie do navegador, então a ponte
 * é o `initData` — e ele é conferido aqui, no servidor, pelo mesmo HMAC do
 * G0-19-R6, antes de qualquer leitura ou escrita.
 *
 * Fronteiras, em ordem de aplicação:
 *
 *  1. `initData` ausente, malformado, com hash forjado, expirado, no futuro,
 *     com parâmetro sensível duplicado ou assinado por outro bot ⇒ 401. O
 *     cliente não escolhe nada disso, e o mesmo 401 cobre todos os casos: um
 *     atacante não distingue "hash quebrado" de "conta errada".
 *  2. A conta autenticada pelo Telegram é resolvida pelo VÍNCULO ATIVO da
 *     F2-04 (`core.telegram_link`). Nunca por um identificador de ambiente
 *     (`TELEGRAM_OWNER_USER_ID` é o atalho do beta antigo e não é consultado
 *     aqui), nunca por um campo do corpo, nunca por header do cliente.
 *  3. Sem vínculo ativo ⇒ 403, e um vínculo REVOGADO continua revogado: cada
 *     requisição re-resolve o vínculo, então revogar no site encerra o acesso
 *     na requisição seguinte. Reativar é do §8.2, pelo deep link, auditado.
 *  4. Uma vez resolvido o usuário, o gate de acesso é o MESMO da web
 *     (`ownerAuth.resolveAccess`): exclusão pendente/purgada, admissão beta,
 *     consentimento vigente e membership. O Mini App não é mais permissivo.
 *  5. A organização vem SEMPRE do vínculo, reconferido contra a membership do
 *     usuário — o corpo da requisição nunca escolhe tenant, papel ou conta.
 *
 * Sobre escrita financeira: os quatro fluxos do Mini App usam as rotas e os
 * formulários da web, com a confirmação que o produto já exige. Nada aqui
 * contorna confirmação, cria atalho de liquidação nem grava saldo direto.
 */
export interface TelegramSessionGateOptions {
  ownerAuth: OwnerAuth | undefined;
  telegramLink: TelegramLinkService | undefined;
  /** Resolve a organização do usuário autenticado (o mesmo caminho da web). */
  organizationOf: (userId: string) => Promise<OrganizationContext>;
}

export function createTelegramSessionGate(options: TelegramSessionGateOptions) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const identities = new WeakMap<FastifyRequest, string>();

  /** Bot token: segredo em produção, variável simples em local/CI. Nunca logado. */
  function readBotToken(): string | null {
    try {
      return readSecret(process.env, 'TELEGRAM_BOT_TOKEN')?.trim() || null;
    } catch {
      return null;
    }
  }

  /** Caminho legado da web: Origin em toda escrita, sessão e consentimento. */
  async function authorizeSession(request: FastifyRequest, reply: FastifyReply) {
    const auth = options.ownerAuth;
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
    if (!options.telegramLink) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    // The organization always comes from the authenticated user — never from the client.
    const context = await options.organizationOf(owner.user.id);
    contexts.set(request, context);
    identities.set(request, owner.user.id);
  }

  /**
   * Autentica a requisição pelo initData do Telegram e publica a organização e a
   * identidade resolvidas. É o ÚNICO caminho pelo qual o Mini App alcança uma
   * rota de produto; sem o header, a requisição é anônima como sempre foi.
   */
  async function authorizeMiniApp(request: FastifyRequest, reply: FastifyReply) {
    if (!options.ownerAuth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (!options.telegramLink) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    const raw = request.headers['x-telegram-init-data'];
    if (typeof raw !== 'string' || raw.length === 0) return authorizeSession(request, reply);
    if (raw.length > 8_192) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    const botToken = readBotToken();
    if (!botToken) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    const validated = validateTelegramInitData(raw, botToken);
    if (!validated) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    let session: { organizationId: string; userId: string; role: string };
    try {
      // Re-resolvido a CADA requisição: é o que faz a revogação do §8.2 valer
      // imediatamente, sem esperar expirar nada.
      session = await options.telegramLink.resolveSession(validated.user.id);
    } catch (error) {
      if (error instanceof TelegramSessionError)
        return sendApiError(
          request,
          reply,
          error.code === 'TELEGRAM_SESSION_UNAVAILABLE' ? 503 : 403,
          error.code,
        );
      throw error;
    }
    // A sessão do Mini App não tem cookie: o `expiresAt` não é publicado por
    // rota do Mini App, e o gate de acesso só precisa da identidade e do papel.
    const owner = await options.ownerAuth.resolveAccess(session.userId, { expiresAt: '' });
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (owner.organization.id !== session.organizationId)
      return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    contexts.set(request, {
      organizationId: owner.organization.id,
      role: owner.organization.role,
      userId: owner.user.id,
    });
    identities.set(request, owner.user.id);
  }

  return {
    authorizeMiniApp,
    authorizeSession,
    contexts,
    identities,
    readBotToken,
    telegramLink: options.telegramLink,
  };
}

export type TelegramSessionGate = ReturnType<typeof createTelegramSessionGate>;

export function registerTelegramSessionRoutes(
  app: FastifyInstance,
  gate: ReturnType<typeof createTelegramSessionGate>,
  telegramLink: TelegramLinkService | undefined,
) {
  const body = z.object({ initData: z.string().min(1).max(8_192) });

  app.post(
    '/api/v1/telegram/session',
    {
      schema: {
        operationId: 'createTelegramSession',
        tags: ['Telegram'],
        summary: 'Conferir a sessão do usuário vinculado ao Telegram',
        security: ownerSessionSecurity,
        description:
          'Endpoint de diagnóstico do Mini App: valida o initData no servidor pelo HMAC do Telegram e responde o estado do vínculo do usuário resolvido. NÃO emite cookie, NÃO cria sessão e NÃO abre organização — a autorização real de cada rota acontece no autorizador da própria rota, sempre. Existe para que o Mini App distinga "conta sem vínculo" (orientação para vincular no site) de conta revogada e de erro de transporte, sem expor nada além do próprio estado do vínculo. Nunca devolve o identificador numérico do Telegram, a organização ou qualquer dado financeiro; o `userId` é o identificador interno pseudônimo do próprio titular, o mesmo que a web já entrega ao navegador dele.',
        body,
        response: {
          200: telegramSessionSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
          503: apiErrorSchema,
          default: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!telegramLink) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      const botToken = gate.readBotToken();
      if (!botToken) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      const validated = validateTelegramInitData(body.parse(request.body).initData, botToken);
      if (!validated) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
      try {
        const session = await telegramLink.resolveSession(validated.user.id);
        return reply.send({
          linked: true as const,
          linkedAt: session.linkedAt,
          role: session.role as 'owner' | 'member' | 'superadmin',
          userId: session.userId,
        });
      } catch (error) {
        if (error instanceof TelegramSessionError) {
          const status = error.code === 'TELEGRAM_SESSION_UNAVAILABLE' ? 503 : 403;
          return sendApiError(request, reply, status, error.code);
        }
        throw error;
      }
    },
  );
}
