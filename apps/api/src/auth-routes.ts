import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  apiErrorSchema,
  googleSignInSchema,
  ownerSessionSchema,
  signOutSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { sendApiError } from './api-errors.js';
import { ownerSessionSecurity } from './openapi.js';

export function registerAuthRoutes(app: FastifyInstance, ownerAuth: OwnerAuth | undefined) {
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
  async function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    body?: object,
  ) {
    if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method === 'POST' &&
      (request.headers.origin !== ownerAuth.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const incomingUrl = new URL(request.url, ownerAuth.origin);
    const url = new URL(`/api/auth${path}`, ownerAuth.origin);
    if (request.method === 'GET') url.search = incomingUrl.search;
    const headers = headersFor(request);
    if (body) headers.set('content-type', 'application/json');
    const response = await ownerAuth.auth.handler(
      new Request(url, {
        method: request.method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      if (!['set-cookie', 'content-length', 'content-type'].includes(key)) reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    // Never expose provider/library error messages in the application API.
    if (response.status >= 400) {
      const code =
        response.status === 429
          ? 'RATE_LIMITED'
          : response.status === 503
            ? 'AUTH_UNAVAILABLE'
            : response.status >= 500
              ? 'INTERNAL_ERROR'
              : 'AUTH_REQUEST_FAILED';
      return refuse(request, reply, response.status, code);
    }
    // OAuth callback redirects preserve Location and every Set-Cookie header, with no JSON body.
    if (response.status >= 300 && response.status < 400) return reply.send();
    const result: unknown = await response.json();
    return reply.send(
      path === '/sign-in/social' ? googleSignInSchema.parse(result) : signOutSchema.parse(result),
    );
  }
  const ignoredBody = z
    .looseObject({})
    .nullish()
    .describe(
      'Objeto opcional. Campos enviados são ignorados; provider, callback e redirect são definidos exclusivamente pelo servidor.',
    );
  const mutationErrors = {
    400: apiErrorSchema,
    403: apiErrorSchema,
    413: apiErrorSchema,
    415: apiErrorSchema,
    429: apiErrorSchema,
    500: apiErrorSchema,
    default: apiErrorSchema,
    503: apiErrorSchema,
  };
  app.post(
    '/api/auth/sign-in/google',
    {
      schema: {
        operationId: 'startGoogleSignIn',
        tags: ['Autenticação'],
        summary: 'Iniciar login Google do proprietário',
        security: [],
        description:
          'Exige Origin igual à origem configurada e autenticação habilitada. O navegador deve conservar os cookies e navegar para a URL retornada. Nenhum token Google é aceito no corpo.',
        body: ignoredBody,
        response: { 200: googleSignInSchema, ...mutationErrors },
      },
    },
    (request, reply) =>
      forward(request, reply, '/sign-in/social', {
        provider: 'google',
        callbackURL: '/',
        errorCallbackURL: '/?auth=failed',
        disableRedirect: true,
      }),
  );
  app.get(
    '/api/auth/callback/google',
    {
      schema: {
        operationId: 'completeGoogleSignIn',
        tags: ['Autenticação'],
        summary: 'Receber retorno do Google',
        security: [],
        description:
          'Uso exclusivo do fluxo de navegador iniciado pela aplicação. Requer estado, cookie e PKCE válidos; a identidade é verificada antes de criar sessão. Falhas do fluxo redirecionam para mensagem genérica na aplicação.',
        querystring: z.looseObject({
          code: z.string().max(8192).optional(),
          state: z.string().max(512).optional(),
          error: z.string().max(256).optional(),
          error_description: z.string().max(2048).optional(),
        }),
        response: {
          302: z
            .undefined()
            .describe(
              'Redirecionamento para a aplicação; Location e cookies definidos pelo fluxo OAuth.',
            ),
          400: apiErrorSchema,
          429: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    (request, reply) => forward(request, reply, '/callback/google'),
  );
  app.post(
    '/api/auth/sign-out',
    {
      schema: {
        operationId: 'signOut',
        tags: ['Autenticação'],
        summary: 'Encerrar a sessão do navegador',
        security: [{}, ...ownerSessionSecurity],
        description:
          'Exige Origin igual à origem configurada. Revoga a sessão apresentada e remove os cookies; também permite encerrar quando não existe sessão.',
        body: ignoredBody,
        response: { 200: signOutSchema, ...mutationErrors },
      },
    },
    (request, reply) => forward(request, reply, '/sign-out', {}),
  );
  app.get(
    '/api/v1/me',
    {
      schema: {
        operationId: 'getOwnerSession',
        tags: ['Autenticação'],
        summary: 'Consultar a sessão do proprietário',
        security: ownerSessionSecurity,
        description:
          'Consulta o banco e revalida a identidade autorizada. Retorna somente id, nome e expiração; não inclui e-mail, identificador Google, cookies ou tokens.',
        response: {
          200: ownerSessionSchema,
          401: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      const owner = await ownerAuth.getOwner(headersFor(request));
      if (!owner) return refuse(request, reply, 401, 'UNAUTHENTICATED');
      return reply.send(owner);
    },
  );
}
