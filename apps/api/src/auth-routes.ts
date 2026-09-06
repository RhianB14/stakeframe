import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { OwnerAuth } from './auth.js';

export function registerAuthRoutes(app: FastifyInstance, ownerAuth: OwnerAuth | undefined) {
  const refuse = (request: FastifyRequest, reply: FastifyReply, status: number, code: string) =>
    reply.code(status).send({
      error: { code, message: 'Acesso indisponível ou não autorizado.', requestId: request.id },
    });
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
      if (key !== 'set-cookie') reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    // Callback errors are intentionally rendered as a generic message by the web.
    return reply.send(response.body ? await response.text() : null);
  }
  app.post('/api/auth/sign-in/google', (request, reply) =>
    forward(request, reply, '/sign-in/social', {
      provider: 'google',
      callbackURL: '/',
      errorCallbackURL: '/?auth=failed',
      disableRedirect: true,
    }),
  );
  app.get('/api/auth/callback/google', (request, reply) =>
    forward(request, reply, '/callback/google'),
  );
  app.post('/api/auth/sign-out', (request, reply) => forward(request, reply, '/sign-out', {}));
  app.get('/api/v1/me', async (request, reply) => {
    if (!ownerAuth) return refuse(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    const owner = await ownerAuth.getOwner(headersFor(request));
    if (!owner) return refuse(request, reply, 401, 'UNAUTHENTICATED');
    return reply.send(owner);
  });
}
