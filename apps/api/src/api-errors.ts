import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorSchema, type ApiErrorCode } from '@stakeframe/shared';

const messages: Record<ApiErrorCode, string> = {
  NOT_FOUND: 'Recurso não encontrado.',
  EVENT_PROVIDER_DISABLED:
    'Esta fonte de eventos ainda não está ativada. Você pode informar a data manualmente.',
  EVENT_QUEUE_FULL: 'Há muitas consultas pendentes. Aguarde antes de solicitar outra busca.',
  INVALID_REQUEST: 'Solicitação inválida.',
  INTERNAL_ERROR: 'Não foi possível concluir a solicitação.',
  AUTH_NOT_CONFIGURED: 'Autenticação indisponível neste ambiente.',
  UNAUTHENTICATED: 'Entre com a conta autorizada para continuar.',
  ORIGIN_NOT_ALLOWED: 'Origem da solicitação não autorizada.',
  AUTH_REQUEST_FAILED: 'Não foi possível concluir a autenticação.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.',
  AUTH_UNAVAILABLE: 'Autenticação temporariamente indisponível.',
  INVITE_REJECTED:
    'Este convite beta não está disponível. Confira o link ou solicite um novo convite.',
  RESET_REJECTED:
    'Este link de redefinição de senha não é mais válido. Solicite um novo link e tente novamente.',
  EMAIL_NOT_VERIFIED:
    'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada ou reenvie a confirmação.',
  CONSENT_REQUIRED:
    'É necessário aceitar os documentos legais vigentes (Termos de Uso, Política de Privacidade e declaração de idade mínima) para continuar.',
  CONSENT_INVALID:
    'Não foi possível registrar o aceite. Recarregue a página, revise os documentos e tente novamente.',
  ONBOARDING_PREREQUISITE:
    'Conclua o perfil e a configuração da banca inicial antes de encerrar os primeiros passos.',
  STATE_CONFLICT: 'O registro mudou ou esta operação já foi realizada. Atualize os dados.',
  VERSION_CONFLICT:
    'Os dados foram atualizados em outra operação. Recarregue e confira antes de tentar novamente.',
  IDEMPOTENCY_CONFLICT: 'Esta identificação de operação já foi usada com dados diferentes.',
  INVALID_FINANCIAL_OPERATION: 'Confira valores, contas, datas e regras desta operação.',
  UNIT_REQUIRED:
    'A unidade deste mês está pendente. Informe a unidade histórica ou confirme a revisão.',
  NOT_INITIALIZED: 'Confira os saldos iniciais antes de continuar.',
  ALIAS_CONFLICT: 'Este nome ou alias já pertence a outro cadastro.',
  ORIGIN_REQUIRED: 'Confirme a origem da aposta (dinheiro real ou freebet) antes de registrar.',
  FREEBET_UNRESOLVED: 'Confira o crédito de freebet escolhido para esta aposta.',
  DUPLICATE_REVIEW_REQUIRED:
    'Há uma aposta possivelmente repetida. Confira e justifique o novo registro.',
  INVALID_INBOX_IMAGE: 'Envie uma imagem PNG ou JPEG válida, com até 8 MiB e 40 milhões de pixels.',
  INBOX_BUSY: 'Há imagens sendo verificadas. Aguarde e verifique o envio novamente.',
  INBOX_CAPACITY_REACHED:
    'O espaço temporário de importações está cheio. Revise os itens pendentes.',
  ATTACHMENT_UNAVAILABLE:
    'O comprovante não está disponível. O histórico da aposta permanece preservado.',
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
