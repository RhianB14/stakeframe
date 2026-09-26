// STK-F1-10 — instrumentação sintética de telemetria.
//
// A rota de erro sintético só existe com TELEMETRY_DEBUG_ENABLED=true e exige
// a mesma autenticação das rotas privadas (sessão + consentimento): serve para
// validar ponta a ponta o pipeline Sentry/logs após a configuração real na
// VPS, sem depender de um erro de produção. O erro é um literal — nenhum dado
// do usuário participa dele.

import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { apiErrorSchema } from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import type { TelemetryHandle } from './telemetry.js';
import { sendApiError } from './api-errors.js';

export const TELEMETRY_DEBUG_SYNTHETIC_ERROR = 'TELEMETRY_DEBUG_SYNTHETIC_ERROR';

export function registerDebugRoutes(
  app: FastifyInstance,
  ownerAuth: OwnerAuth | undefined,
  telemetry: TelemetryHandle | undefined,
) {
  if (!telemetry?.config.debug.enabled) return;
  app.post(
    '/api/v1/debug/telemetry-error',
    {
      schema: {
        operationId: 'postTelemetryDebugError',
        tags: ['Operação'],
        summary: 'Gerar um erro sintético para validar a telemetria',
        security: [],
        response: {
          401: apiErrorSchema,
          403: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (
        request.headers.origin !== ownerAuth.origin ||
        request.headers['sec-fetch-site'] === 'cross-site'
      )
        return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const headers = fromNodeHeaders({ cookie: request.headers.cookie });
      const owner = await ownerAuth.getOwner(headers);
      if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
      if (owner.status === 'consent_required')
        return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
      throw new Error(TELEMETRY_DEBUG_SYNTHETIC_ERROR);
    },
  );
}
