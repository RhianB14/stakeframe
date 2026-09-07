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
  STATE_CONFLICT: 'O registro mudou ou esta operação já foi realizada. Atualize os dados.',
  VERSION_CONFLICT:
    'Os dados foram atualizados em outra operação. Recarregue e confira antes de tentar novamente.',
  IDEMPOTENCY_CONFLICT: 'Esta identificação de operação já foi usada com dados diferentes.',
  INVALID_FINANCIAL_OPERATION: 'Confira valores, contas, datas e regras desta operação.',
  UNIT_REQUIRED:
    'A unidade deste mês está pendente. Informe a unidade histórica ou confirme a revisão.',
  NOT_INITIALIZED: 'Confira os saldos iniciais antes de continuar.',
  ALIAS_CONFLICT: 'Este nome ou alias já pertence a outro cadastro.',
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
