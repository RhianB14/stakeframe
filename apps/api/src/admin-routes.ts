// STK-F2-11 — rota interna do painel mínimo do superadmin (Plano Master §7.2).
//
// Regra de acesso, sem exceção e sem atalho:
//  1. sem autenticação configurada  → 404 (a superfície não existe);
//  2. sem sessão válida             → 401 (o chamador se authenticate);
//  3. consentimento pendente        → 403 CONSENT_REQUIRED (mesma regra das
//     rotas privadas: nada de organização é resolvido antes do aceite);
//  4. papel diferente de superadmin → 404 NOT_FOUND. A rota NÃO se anuncia para
//     um `owner`: um 403 confirmaria a existência de uma superfície interna.
//
// A autorização vem SEMPRE do membership da sessão (campo `role` devolvido por
// `getOwner`), nunca de um parâmetro de rota, query ou corpo — impersonação é
// PROIBIDA (Plano §7.2) e não existe rota que aceite usuário ou organização de
// destino. Toda tentativa, permitida ou negada, é gravada pelo serviço em
// `core.admin_panel_access` ANTES de qualquer leitura.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { AdminPanelError, type AdminPanelService } from '@stakeframe/db';
import {
  adminAccountsQuerySchema,
  adminAccountsSchema,
  adminAuditTrailSchema,
  adminErrorsSchema,
  adminFlagsSchema,
  adminUsageSchema,
  apiErrorSchema,
  type AdminPanelView,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

const AUDIT_TRAIL_MAX_ROWS = 50;

type Session = { userId: string };

export function registerAdminPanelRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: AdminPanelService | undefined,
) {
  const sessions = new WeakMap<FastifyRequest, Session>();

  /**
   * Fail-closed gate. Returns 404 for anything that is not a superadmin session
   * — the panel is not advertised to a non-superadmin and cannot be probed for
   * existence. The denial is audited for a KNOWN user; an anonymous or unknown
   * caller has no identity to attribute, and its refusal carries no content.
   */
  const authorize = async (request: FastifyRequest, reply: FastifyReply, view: AdminPanelView) => {
    if (!auth || !service) return sendApiError(request, reply, 404, 'NOT_FOUND');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (owner.organization.role !== 'superadmin') {
      await service.deny(owner.user.id, view, request.id).catch(() => undefined);
      return sendApiError(request, reply, 404, 'NOT_FOUND');
    }
    sessions.set(request, { userId: owner.user.id });
  };

  /**
   * Maps a domain refusal to a stable API code; anything else stays a 500.
   * The role gate runs in `authorize` (before this), so the only failure
   * reaching here is the audit write: fail closed with 503 rather than serve an
   * unaudited view.
   */
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: (session: Session) => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action(sessions.get(request)!));
    } catch (error) {
      if (error instanceof AdminPanelError) {
        if (error.code === 'ADMIN_AUDIT_FAILED')
          return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
        if (error.code === 'ADMIN_ROLE_MISMATCH')
          return sendApiError(request, reply, 404, 'NOT_FOUND');
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR');
      }
      throw error;
    }
  };

  const base = { tags: ['Administração'], security: ownerSessionSecurity };
  const errors = {
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };

  app.get(
    '/api/v1/admin/accounts',
    {
      onRequest: (request, reply) => authorize(request, reply, 'accounts'),
      schema: {
        ...base,
        operationId: 'getAdminAccounts',
        summary: 'Metadados das contas (rótulo, papel e estado), sem conteúdo de usuário',
        querystring: adminAccountsQuerySchema,
        response: { 200: adminAccountsSchema, ...errors },
      },
    },
    (request, reply) => {
      const query = adminAccountsQuerySchema.parse(request.query);
      return execute(request, reply, (session) =>
        service!.accounts(session.userId, request.id, query),
      );
    },
  );

  app.get(
    '/api/v1/admin/usage',
    {
      onRequest: (request, reply) => authorize(request, reply, 'usage'),
      schema: {
        ...base,
        operationId: 'getAdminUsage',
        summary: 'Uso, cotas do provedor e contagens de fila por organização',
        response: { 200: adminUsageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, (session) => service!.usage(session.userId, request.id)),
  );

  app.get(
    '/api/v1/admin/flags',
    {
      onRequest: (request, reply) => authorize(request, reply, 'flags'),
      schema: {
        ...base,
        operationId: 'getAdminFlags',
        summary: 'Feature flags de rollout e toggles operacionais configurados',
        response: { 200: adminFlagsSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, (session) => service!.flags(session.userId, request.id)),
  );

  app.get(
    '/api/v1/admin/errors',
    {
      onRequest: (request, reply) => authorize(request, reply, 'errors'),
      schema: {
        ...base,
        operationId: 'getAdminErrors',
        summary: 'Erros recentes por código e origem, sem mensagem nem conteúdo',
        response: { 200: adminErrorsSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, (session) => service!.errors(session.userId, request.id)),
  );

  app.get(
    '/api/v1/admin/audit',
    {
      onRequest: (request, reply) => authorize(request, reply, 'audit'),
      schema: {
        ...base,
        operationId: 'getAdminAuditTrail',
        summary: 'Trilha de auditoria dos acessos ao painel interno',
        response: { 200: adminAuditTrailSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, (session) =>
        service!.auditTrail(session.userId, request.id, AUDIT_TRAIL_MAX_ROWS),
      ),
  );
}
