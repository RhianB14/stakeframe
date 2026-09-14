import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  apiErrorSchema,
  consentAcceptSchema,
  consentAcceptedSchema,
  consentHistorySchema,
  consentStatusSchema,
  legalDocumentTypeSchema,
} from '@stakeframe/shared';
import { ConsentError } from '@stakeframe/db';
import type { OwnerAuth } from './auth.js';
import { sendApiError } from './api-errors.js';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

export function registerConsentRoutes(app: FastifyInstance, ownerAuth: OwnerAuth | undefined) {
  const refuse = sendApiError;
  function headersFor(request: FastifyRequest) {
    const headers = fromNodeHeaders(request.headers);
    for (const key of [
      'host',
      'authorization',
      'content-length',
      'transfer-encoding',
      'connection',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-for',
      'x-client-ip',
      'cf-connecting-ip',
    ])
      headers.delete(key);
    headers.set('x-real-ip', request.ip);
    return headers;
  }
  function originRefused(request: FastifyRequest) {
    return (
      request.method === 'POST' &&
      (request.headers.origin !== ownerAuth!.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    );
  }
  /**
   * Authentication-only access for the consent endpoints: a valid session of an admitted
   * identity is enough — the consent gate itself must stay reachable while it is pending.
   */
  async function identityOf(request: FastifyRequest, reply: FastifyReply) {
    if (!ownerAuth) {
      refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      return null;
    }
    const identity = await ownerAuth.getIdentity(headersFor(request));
    if (!identity) {
      refuse(request, reply, 401, 'UNAUTHENTICATED');
      return null;
    }
    return identity;
  }
  const restrictedErrors = {
    401: apiErrorSchema,
    403: apiErrorSchema,
    429: apiErrorSchema,
    500: apiErrorSchema,
    default: apiErrorSchema,
    503: apiErrorSchema,
  };
  app.get(
    '/api/v1/consents/status',
    {
      schema: {
        operationId: 'getConsentStatus',
        tags: ['Consentimentos'],
        summary: 'Consultar o estado dos consentimentos do usuário atual',
        security: [],
        description:
          'Sessão válida de identidade admitida (proprietário ou usuário beta com convite aceito). Retorna os documentos obrigatórios vigentes com versão, resumo, link de leitura, vigência e o estado do aceite do próprio usuário. Não retorna consentimentos de terceiros, dados da organização nem detalhes internos.',
        response: { 200: consentStatusSchema, ...restrictedErrors },
      },
    },
    async (request, reply) => {
      const identity = await identityOf(request, reply);
      if (!identity) return;
      const status = await ownerAuth!.consents.statusFor(identity.user.id);
      return reply.send(
        consentStatusSchema.parse({
          status: status.allAccepted ? 'accepted' : 'pending',
          documents: status.documents.map((document) => ({
            type: document.type,
            version: document.version,
            title: document.title,
            summary: document.summary,
            textUrl: document.textUrl,
            effectiveAt: document.effectiveAt.toISOString(),
            accepted: document.accepted,
            stale: document.stale,
            integrity: document.integrity,
            acceptedAt: document.acceptedAt ? document.acceptedAt.toISOString() : null,
          })),
          pendingTypes: status.pendingTypes,
        }),
      );
    },
  );
  app.post(
    '/api/v1/consents/accept',
    {
      schema: {
        operationId: 'acceptConsents',
        tags: ['Consentimentos'],
        summary: 'Aceitar os documentos obrigatórios vigentes',
        security: [],
        description:
          'Exige Origin igual à origem configurada e sessão válida. O servidor resolve as versões vigentes no catálogo — versões enviadas pelo cliente que não sejam as atuais são rejeitadas, o user_id nunca vem do corpo, o timestamp é gerado pelo banco e todos os aceites são gravados em uma única transação (sem aceite parcial). Repetir a operação é idempotente.',
        body: consentAcceptSchema,
        response: { 200: consentAcceptedSchema, ...restrictedErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const identity = await identityOf(request, reply);
      if (!identity) return;
      const body = request.body as { documents: { type: string; version?: string }[] };
      try {
        const result = await ownerAuth.consents.accept(
          identity.user.id,
          body.documents as Parameters<typeof ownerAuth.consents.accept>[1],
        );
        return reply.send(
          consentAcceptedSchema.parse({
            accepted: result.accepted.map((record) => ({
              type: record.type,
              version: record.version,
              acceptedAt: record.acceptedAt.toISOString(),
            })),
          }),
        );
      } catch (error) {
        if (error instanceof ConsentError && error.code === 'CONSENT_INVALID')
          return refuse(request, reply, 400, 'CONSENT_INVALID');
        if (error instanceof ConsentError && error.code === 'CONSENT_UNAVAILABLE')
          return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
        return refuse(request, reply, 500, 'INTERNAL_ERROR');
      }
    },
  );
  app.get(
    '/api/v1/consents/history',
    {
      schema: {
        operationId: 'getConsentHistory',
        tags: ['Consentimentos'],
        summary: 'Consultar o próprio histórico de aceites',
        security: [],
        description:
          'Sessão válida de identidade admitida. Retorna apenas os aceites do próprio usuário, em ordem determinística (mais recentes primeiro), sem IP, user-agent ou qualquer dado de terceiros; o histórico é somente leitura.',
        response: { 200: consentHistorySchema, ...restrictedErrors },
      },
    },
    async (request, reply) => {
      const identity = await identityOf(request, reply);
      if (!identity) return;
      const history = await ownerAuth!.consents.historyFor(identity.user.id);
      return reply.send(
        consentHistorySchema.parse({
          history: history.map((record) => ({
            type: record.type,
            version: record.version,
            acceptedAt: record.acceptedAt.toISOString(),
          })),
        }),
      );
    },
  );
  app.get(
    '/api/v1/legal/documents/:type/:version',
    {
      schema: {
        operationId: 'getLegalDocumentText',
        tags: ['Consentimentos'],
        summary: 'Ler o texto integral de um documento legal versionado',
        security: [],
        description:
          'Público: entrega o texto do documento exato (tipo e versão estáveis do catálogo) em texto simples, para leitura integral. Não requer sessão e não expõe dados de usuários.',
        params: z.object({
          type: legalDocumentTypeSchema,
          version: z.string().regex(VERSION_PATTERN),
        }),
        response: {
          200: z.string().describe('Texto integral do documento (text/plain).'),
          400: apiErrorSchema,
          404: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      const { type, version } = request.params as { type: string; version: string };
      const text = await ownerAuth.consents.documentText(
        type as Parameters<typeof ownerAuth.consents.documentText>[0],
        version,
      );
      if (text === null) return refuse(request, reply, 404, 'NOT_FOUND');
      return reply.type('text/plain; charset=utf-8').send(text);
    },
  );
}
