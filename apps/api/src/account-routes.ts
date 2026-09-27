import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import {
  AccountDeletionError,
  type AccountDeletionService,
  type AccountExportService,
  type OrganizationContext,
  type ReportService,
} from '@stakeframe/db';
import { accountDeletionResponseSchema, apiErrorSchema } from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

/**
 * STK-F1-08: the authenticated user's own export (JSON + BETS-02 CSV) and the account
 * deletion flow (request → immediate block → 30-day grace → cancel or purge). The owner
 * always comes from the session: no route accepts a user or organization identifier.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  reports: ReportService | undefined,
  deletion: AccountDeletionService | undefined,
  exports: AccountExportService | undefined,
) {
  const contexts = new WeakMap<FastifyRequest, { context: OrganizationContext; userId: string }>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!reports || !deletion || !exports)
      return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    contexts.set(request, {
      context: await reports.ensureContext(owner.user.id),
      userId: owner.user.id,
    });
  };
  // Light abuse guard: one export per user and route per minute (heavy long-lived snapshots).
  const exportStamps = new Map<string, number>();
  const throttled = (key: string) => {
    const now = Date.now();
    const last = exportStamps.get(key);
    if (last !== undefined && now - last < 60_000) return true;
    exportStamps.set(key, now);
    return false;
  };
  const sendStream = async (request: FastifyRequest, reply: FastifyReply, kind: 'json' | 'csv') => {
    const { context, userId } = contexts.get(request)!;
    if (throttled(`${userId}:${kind}`)) return sendApiError(request, reply, 429, 'RATE_LIMITED');
    try {
      const stream =
        kind === 'json'
          ? await exports!.json(context, userId)
          : await exports!.betsCsv(context, userId);
      reply.type(kind === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="${kind === 'json' ? 'stakeframe-dados.json' : 'stakeframe-apostas.csv'}"`,
      );
      const disconnect = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once('close', disconnect);
      stream.once('close', () => reply.raw.off('close', disconnect));
      return reply.send(stream);
    } catch (error) {
      // One long-lived snapshot at a time: a concurrent export is a retryable conflict.
      if (error instanceof Error && error.message === 'EXPORT_BUSY')
        return sendApiError(request, reply, 409, 'STATE_CONFLICT');
      throw error;
    }
  };
  // The package entry can resolve to a different build copy than the service under test
  // (dist vs src), so the mapping checks the class name as well as the prototype chain.
  const isDeletionError = (error: unknown): error is AccountDeletionError =>
    error instanceof AccountDeletionError ||
    (error instanceof Error && error.name === 'AccountDeletionError');
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (isDeletionError(error))
        return sendApiError(
          request,
          reply,
          error.code === 'DELETION_NOT_FOUND' ? 404 : 409,
          error.code === 'DELETION_NOT_FOUND' ? 'NOT_FOUND' : 'STATE_CONFLICT',
        );
      throw error;
    }
  };
  const base = { tags: ['Conta'], security: ownerSessionSecurity };
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    409: apiErrorSchema,
    429: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  app.get(
    '/api/v1/account/export.json',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'exportAccountData',
        summary: 'Exportar todos os dados da própria conta em JSON',
        response: { ...errors },
      },
    },
    (request, reply) => sendStream(request, reply, 'json'),
  );
  app.get(
    '/api/v1/account/export/bets.csv',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'exportAccountBets',
        summary: 'Exportar todas as apostas da própria conta em CSV',
        response: { ...errors },
      },
    },
    (request, reply) => sendStream(request, reply, 'csv'),
  );
  app.post(
    '/api/v1/account/exclusion-request',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'requestAccountExclusion',
        summary: 'Solicitar exclusão da conta (bloqueio imediato, carência de 30 dias)',
        response: { 200: accountDeletionResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const { context, userId } = contexts.get(request)!;
        return { deletion: await deletion!.request(userId, context.organizationId) };
      }),
  );
  app.post(
    '/api/v1/account/exclusion-cancel',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'cancelAccountExclusion',
        summary: 'Cancelar a exclusão da conta dentro da carência',
        response: { 200: accountDeletionResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const { userId } = contexts.get(request)!;
        return { deletion: await deletion!.cancel(userId) };
      }),
  );
}
