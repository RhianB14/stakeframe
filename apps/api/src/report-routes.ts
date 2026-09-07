import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { FinanceError, type ReportService } from '@stakeframe/db';
import {
  apiErrorSchema,
  reportQuerySchema,
  reportDetailQuerySchema,
  reportSchema,
  reportBetPageSchema,
  reportOptionsSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

export function registerReportRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: ReportService | undefined,
) {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (!(await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }))))
      return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
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
          error.code === 'INVALID_FINANCIAL_OPERATION' ? 400 : 409,
          error.code,
        );
      throw error;
    }
  };
  const base = { tags: ['Análises'], security: ownerSessionSecurity };
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    409: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  app.get(
    '/api/v1/reports',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'getPerformanceReport',
        summary: 'Analisar resultados por data do último evento',
        querystring: reportQuerySchema,
        response: { 200: reportSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.report(reportQuerySchema.parse(request.query))),
  );
  app.get(
    '/api/v1/reports/bets',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'getPerformanceBets',
        summary: 'Detalhar as apostas incluídas nos indicadores',
        querystring: reportDetailQuerySchema,
        response: { 200: reportBetPageSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () => service!.bets(reportDetailQuerySchema.parse(request.query))),
  );
  app.get(
    '/api/v1/reports/options',
    {
      onRequest: authorize,
      schema: {
        ...base,
        operationId: 'getReportOptions',
        summary: 'Consultar esportes disponíveis nas análises',
        response: { 200: reportOptionsSchema, ...errors },
      },
    },
    (request, reply) => execute(request, reply, () => service!.options()),
  );
  for (const kind of ['csv', 'json'] as const) {
    app.get(
      `/api/v1/exports/${kind}`,
      {
        onRequest: authorize,
        schema: {
          ...base,
          operationId: kind === 'csv' ? 'exportFilteredBets' : 'exportStructuredHistory',
          summary:
            kind === 'csv'
              ? 'Exportar todas as apostas do filtro em CSV'
              : 'Exportar histórico estruturado privado em JSON',
          ...(kind === 'csv' ? { querystring: reportQuerySchema } : {}),
          response: { ...errors },
        },
      },
      async (request, reply) => {
        try {
          const query = kind === 'csv' ? reportQuerySchema.parse(request.query) : undefined;
          const stream = await service!.export(kind, query);
          const filename =
            kind === 'csv'
              ? `stakeframe-apostas-${query!.from}-${query!.to}.csv`
              : 'stakeframe-historico.json';
          reply.type(
            kind === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          );
          reply.header('content-disposition', `attachment; filename="${filename}"`);
          const disconnect = () => {
            if (!stream.destroyed) stream.destroy();
          };
          reply.raw.once('close', disconnect);
          stream.once('close', () => reply.raw.off('close', disconnect));
          return reply.send(stream);
        } catch (error) {
          if (error instanceof FinanceError)
            return sendApiError(
              request,
              reply,
              error.code === 'INVALID_FINANCIAL_OPERATION' ? 400 : 409,
              error.code,
            );
          throw error;
        }
      },
    );
  }
}
