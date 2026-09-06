import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorSchema, type ApiErrorCode } from '@stakeframe/shared';

const messages: Record<ApiErrorCode, string> = {
  NOT_FOUND: 'Recurso não encontrado.',
  INVALID_REQUEST: 'Solicitação inválida.',
  INTERNAL_ERROR: 'Não foi possível concluir a solicitação.',
  AUTH_NOT_CONFIGURED: 'Autenticação indisponível neste ambiente.',
  UNAUTHENTICATED: 'Entre com a conta autorizada para continuar.',
  ORIGIN_NOT_ALLOWED: 'Origem da solicitação não autorizada.',
  AUTH_REQUEST_FAILED: 'Não foi possível concluir a autenticação.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.',
  AUTH_UNAVAILABLE: 'Autenticação temporariamente indisponível.',
};

export function sendApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
) {
  return reply.code(status).send(
    apiErrorSchema.parse({
      error: { code, message: messages[code], requestId: request.id },
    }),
  );
}
