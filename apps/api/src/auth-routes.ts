import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  apiErrorSchema,
  authStatusSchema,
  authUserSummarySchema,
  betaInviteOpenedSchema,
  betaInviteOpenSchema,
  emailSignInSchema,
  emailSignUpSchema,
  emailVerificationResultSchema,
  googleSignInSchema,
  ownerSessionSchema,
  passwordResetRequestSchema,
  passwordResetSubmitSchema,
  resendVerificationSchema,
  signOutSchema,
} from '@stakeframe/shared';
import { BETA_INVITE_COOKIE, BETA_INVITE_COOKIE_MAX_AGE_SECONDS, type OwnerAuth } from './auth.js';
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
  async function callAuth(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    body?: object,
  ) {
    const incomingUrl = new URL(request.url, ownerAuth!.origin);
    const url = new URL(`/api/auth${path}`, ownerAuth!.origin);
    if (request.method === 'GET') url.search = incomingUrl.search;
    const headers = headersFor(request);
    if (body) headers.set('content-type', 'application/json');
    const response = await ownerAuth!.auth.handler(
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
    return response;
  }
  function originRefused(request: FastifyRequest) {
    return (
      request.method === 'POST' &&
      (request.headers.origin !== ownerAuth!.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    );
  }
  function mapAuthFailure(reply: FastifyReply, request: FastifyRequest, response: Response) {
    // Never expose provider/library error messages in the application API.
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
  async function authErrorCode(response: Response): Promise<string | undefined> {
    try {
      const body: unknown = await response.clone().json();
      const code = (body as { code?: unknown } | null)?.code;
      return typeof code === 'string' ? code : undefined;
    } catch {
      return undefined;
    }
  }
  async function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    body?: object,
    resultSchema?: z.ZodType,
  ) {
    if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const response = await callAuth(request, reply, path, body);
    if (response.status >= 400) return mapAuthFailure(reply, request, response);
    // OAuth callback redirects preserve Location and every Set-Cookie header, with no JSON body.
    if (response.status >= 300 && response.status < 400) return reply.send();
    const result: unknown = await response.json();
    return reply.send(
      resultSchema
        ? resultSchema.parse(result)
        : path === '/sign-in/social'
          ? googleSignInSchema.parse(result)
          : signOutSchema.parse(result),
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
    '/api/v1/beta-invite/open',
    {
      schema: {
        operationId: 'openBetaInvite',
        tags: ['Autenticação'],
        summary: 'Abrir o convite beta no navegador',
        security: [],
        description:
          'Valida um token de convite beta (existente, pendente e dentro da validade) e vincula o token à sessão deste navegador por cookie HttpOnly de vida curta, para uso no cadastro ou no login Google. Não consome o convite e não revela dados do convite; rejeições usam código sanitizado único.',
        body: betaInviteOpenSchema,
        response: { 200: betaInviteOpenedSchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const token = (request.body as { token: string }).token;
      try {
        await ownerAuth.beta.readAcceptableInvitation(token);
      } catch {
        return refuse(request, reply, 403, 'INVITE_REJECTED');
      }
      const cookie = [
        `${BETA_INVITE_COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${BETA_INVITE_COOKIE_MAX_AGE_SECONDS}`,
        ...(ownerAuth.origin.startsWith('https:') ? ['Secure'] : []),
      ].join('; ');
      reply.header('set-cookie', cookie);
      return reply.send({ ok: true });
    },
  );
  app.post(
    '/api/auth/sign-up/email',
    {
      schema: {
        operationId: 'signUpWithEmail',
        tags: ['Autenticação'],
        summary: 'Cadastro por e-mail e senha (somente com convite beta)',
        security: [],
        description:
          'Exige Origin igual à origem configurada e um convite beta aberto neste navegador. O cadastro só prossegue com convite pendente, dentro da validade e vinculado ao e-mail informado; a senha é tratada exclusivamente pelo provedor de autenticação. Nenhuma sessão é criada antes da verificação do e-mail e a resposta nunca revela se o e-mail já possui conta.',
        body: emailSignUpSchema,
        response: { 200: authUserSummarySchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const body = request.body as { name: string; email: string; password: string };
      const response = await callAuth(request, reply, '/sign-up/email', body);
      if (response.status >= 400) {
        if (response.status === 403) return refuse(request, reply, 403, 'INVITE_REJECTED');
        return mapAuthFailure(reply, request, response);
      }
      const result = await response
        .json()
        .then((value) =>
          z
            .looseObject({ user: z.looseObject({ id: z.string(), name: z.string().optional() }) })
            .nullable()
            .catch(null)
            .parse(value),
        )
        .catch(() => null);
      const user = result?.user;
      if (!user) return refuse(request, reply, 500, 'INTERNAL_ERROR');
      // The invitation is consumed inside the sign-up transaction itself (database hook);
      // a synthetic duplicate response carries no consumption.
      return reply.send(
        authUserSummarySchema.parse({ user: { id: user.id, name: user.name ?? '' } }),
      );
    },
  );
  app.post(
    '/api/auth/sign-in/email',
    {
      schema: {
        operationId: 'signInWithEmail',
        tags: ['Autenticação'],
        summary: 'Login por e-mail e senha (usuário convidado admitido)',
        security: [],
        description:
          'Exige Origin igual à origem configurada. Somente identidades admitidas (proprietário ou usuário com convite beta aceito) e e-mail verificado obtêm sessão; falhas usam código sanitizado único, sem distinguir e-mail inexistente, senha incorreta ou e-mail não verificado.',
        body: emailSignInSchema,
        response: { 200: authUserSummarySchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const body = request.body as { email: string; password: string };
      const response = await callAuth(request, reply, '/sign-in/email', body);
      if (response.status >= 400) {
        if (response.status === 429 || response.status === 503 || response.status >= 500)
          return mapAuthFailure(reply, request, response);
        // A correct password for an unverified e-mail reaches this point (the credential
        // was already validated by the library); the user gets the actionable, sanitized
        // code instead of the generic failure.
        if (response.status === 403 && (await authErrorCode(response)) === 'EMAIL_NOT_VERIFIED')
          return refuse(request, reply, 403, 'EMAIL_NOT_VERIFIED');
        return refuse(request, reply, 401, 'AUTH_REQUEST_FAILED');
      }
      const result = await response
        .json()
        .then((value) =>
          z
            .looseObject({ user: z.looseObject({ id: z.string(), name: z.string().optional() }) })
            .nullable()
            .catch(null)
            .parse(value),
        )
        .catch(() => null);
      const user = result?.user;
      if (!user) return refuse(request, reply, 500, 'INTERNAL_ERROR');
      return reply.send(
        authUserSummarySchema.parse({ user: { id: user.id, name: user.name ?? '' } }),
      );
    },
  );
  app.get(
    '/api/auth/verify-email',
    {
      schema: {
        operationId: 'verifyEmail',
        tags: ['Autenticação'],
        summary: 'Confirmar o e-mail do cadastro',
        security: [],
        description:
          'Uso exclusivo do link enviado pelo transporte de e-mail controlado. Confirma o e-mail e redireciona para a aplicação; o token de verificação é apresentado apenas nesta chamada e nunca é registrado.',
        querystring: z.looseObject({
          token: z.string().max(8192).optional(),
          callbackURL: z.string().max(2048).optional(),
        }),
        response: {
          200: emailVerificationResultSchema,
          302: z.undefined().describe('Redirecionamento para a aplicação após confirmação.'),
          400: apiErrorSchema,
          429: apiErrorSchema,
          500: apiErrorSchema,
          default: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      const response = await callAuth(request, reply, '/verify-email');
      if (response.status >= 400) return mapAuthFailure(reply, request, response);
      if (response.status >= 300 && response.status < 400) return reply.send();
      // Sanitized success acknowledgement; the library payload (which may carry the user
      // object) is never forwarded.
      await response.json().catch(() => undefined);
      return reply.send(emailVerificationResultSchema.parse({ status: true }));
    },
  );
  app.post(
    '/api/auth/request-password-reset',
    {
      schema: {
        operationId: 'requestPasswordReset',
        tags: ['Autenticação'],
        summary: 'Solicitar a redefinição de senha por e-mail',
        security: [],
        description:
          'Exige Origin igual à origem configurada. A resposta é sempre a mesma para e-mail existente ou inexistente (sem enumeração) e o link chega exclusivamente pelo e-mail da conta, com token de uso único e vida curta. A chamada nunca revela se o e-mail possui conta.',
        body: passwordResetRequestSchema,
        response: { 200: authStatusSchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const body = request.body as { email: string };
      const response = await callAuth(request, reply, '/request-password-reset', {
        email: body.email,
      });
      if (response.status >= 400) {
        if (response.status === 429 || response.status === 503 || response.status >= 500)
          return mapAuthFailure(reply, request, response);
        return refuse(request, reply, 400, 'INVALID_REQUEST');
      }
      return reply.send(authStatusSchema.parse({ status: true }));
    },
  );
  app.post(
    '/api/auth/reset-password',
    {
      schema: {
        operationId: 'resetPassword',
        tags: ['Autenticação'],
        summary: 'Definir nova senha com o token do e-mail',
        security: [],
        description:
          'Exige Origin igual à origem configurada. O token é de uso único, expira em 30 minutos e é aceito apenas se emitido para a conta; a senha é tratada exclusivamente pelo provedor de autenticação e as sessões antigas são revogadas após a redefinição. Falhas usam um único código sanitizado.',
        body: passwordResetSubmitSchema,
        response: { 200: authStatusSchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const body = request.body as { token: string; newPassword: string };
      const response = await callAuth(request, reply, '/reset-password', {
        newPassword: body.newPassword,
        token: body.token,
      });
      if (response.status >= 400) {
        if (response.status === 429 || response.status === 503 || response.status >= 500)
          return mapAuthFailure(reply, request, response);
        return refuse(request, reply, 400, 'RESET_REJECTED');
      }
      await response.json().catch(() => undefined);
      return reply.send(authStatusSchema.parse({ status: true }));
    },
  );
  app.post(
    '/api/auth/send-verification-email',
    {
      schema: {
        operationId: 'resendEmailVerification',
        tags: ['Autenticação'],
        summary: 'Reenviar a confirmação de e-mail',
        security: [],
        description:
          'Exige Origin igual à origem configurada. Responde de forma genérica com piso de tempo constante: e-mail sem conta pendente não dispara envio e não distingue da resposta de sucesso. Limitado por taxa e sem revelar existência de conta.',
        body: resendVerificationSchema,
        response: { 200: authStatusSchema, ...mutationErrors },
      },
    },
    async (request, reply) => {
      if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
      if (!ownerAuth.beta.emailPasswordEnabled)
        return refuse(request, reply, 503, 'AUTH_UNAVAILABLE');
      if (originRefused(request)) return refuse(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
      const body = request.body as { email: string };
      const response = await callAuth(request, reply, '/send-verification-email', {
        email: body.email,
      });
      if (response.status >= 400) {
        if (response.status === 429 || response.status === 503 || response.status >= 500)
          return mapAuthFailure(reply, request, response);
        return refuse(request, reply, 400, 'INVALID_REQUEST');
      }
      await response.json().catch(() => undefined);
      return reply.send(authStatusSchema.parse({ status: true }));
    },
  );
  app.post(
    '/api/auth/sign-in/google',
    {
      schema: {
        operationId: 'startGoogleSignIn',
        tags: ['Autenticação'],
        summary: 'Iniciar login Google (proprietário ou convidado com convite aberto)',
        security: [],
        description:
          'Exige Origin igual à origem configurada e autenticação habilitada. O navegador deve conservar os cookies e navegar para a URL retornada. Nenhum token Google é aceito no corpo. O proprietário entra com a identidade já autorizada; usuários externos só prosseguem com um convite beta aberto neste navegador e vinculado ao e-mail verificado do provedor.',
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
          'Uso exclusivo do fluxo de navegador iniciado pela aplicação. Requer estado, cookie e PKCE válidos; a identidade é verificada antes de criar sessão e externos dependem de convite beta aceito no gate. Falhas do fluxo redirecionam para mensagem genérica na aplicação.',
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
        summary: 'Consultar a sessão autenticada',
        security: ownerSessionSecurity,
        description:
          'Consulta o banco e revalida a identidade autorizada (proprietário ou usuário convidado admitido). Garante a organização técnica do usuário (criando a membership inicial owner quando ausente, de forma idempotente) e retorna id, nome, organização (id e papel) e expiração; não inclui e-mail, identificador Google, cookies ou tokens.',
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
