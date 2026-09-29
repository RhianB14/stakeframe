import type { FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorSchema, type ApiErrorCode } from '@stakeframe/shared';

const messages: Record<ApiErrorCode, string> = {
  NOT_FOUND: 'Recurso não encontrado.',
  EVENT_PROVIDER_DISABLED:
    'Esta fonte de eventos ainda não está ativada. Você pode informar a data manualmente.',
  EVENT_QUEUE_FULL: 'Há muitas consultas pendentes. Aguarde antes de solicitar outra busca.',
  IDEMPOTENCY_KEY_REQUIRED: 'Confirmação sem chave de idempotência válida. Tente novamente.',
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
  FREEBET_NOT_FOUND: 'Esta freebet não existe na sua organização.',
  FREEBET_ALREADY_USED: 'Esta freebet já foi utilizada e não pode ser alterada.',
  FREEBET_REVOKED: 'Esta freebet foi revogada e não pode ser alterada.',
  FREEBET_INVALID:
    'Confira a freebet: casa ativa, valor, validade, fuso horário e quiet hours informados.',
  INCOMPLETE_BET: 'Preencha todos os campos obrigatórios da aposta antes de alterar o status.',
  DUPLICATE_REVIEW_REQUIRED:
    'Há uma aposta possivelmente repetida. Confira e justifique o novo registro.',
  INVALID_INBOX_IMAGE: 'Envie uma imagem PNG ou JPEG válida, com até 8 MiB e 40 milhões de pixels.',
  INBOX_BUSY: 'Há imagens sendo verificadas. Aguarde e verifique o envio novamente.',
  INBOX_CAPACITY_REACHED:
    'O espaço temporário de importações está cheio. Revise os itens pendentes.',
  ATTACHMENT_UNAVAILABLE:
    'O comprovante não está disponível. O histórico da aposta permanece preservado.',
  TELEGRAM_LINK_INVALID: 'Este link do Telegram não é válido. Gere um novo e tente novamente.',
  TELEGRAM_LINK_EXPIRED:
    'Este link do Telegram expirou após cinco minutos. Gere um novo para continuar.',
  TELEGRAM_LINK_CONSUMED: 'Este link do Telegram já foi usado. Gere um novo para continuar.',
  TELEGRAM_LINK_REVOKED:
    'Este link do Telegram foi substituído por um novo. Gere outro para continuar.',
  TELEGRAM_LINK_NOT_CLAIMED:
    'Abra o link no Telegram antes de confirmar aqui. A confirmação precisa vir do próprio aplicativo.',
  TELEGRAM_LINK_ALREADY_LINKED:
    'Já existe uma conta do Telegram vinculada a esta conta. Revogue o vínculo anterior para trocar.',
  TELEGRAM_LINK_IDENTITY_CONFLICT:
    'Esta conta do Telegram já está vinculada a outro usuário do Stakeframe. Desvincule-a de lá antes de usar aqui.',
  TELEGRAM_LINK_NOT_LINKED: 'Nenhuma conta do Telegram está vinculada a esta conta.',
  TELEGRAM_LINK_UNAVAILABLE:
    'A conexão com o Telegram está indisponível agora. Tente novamente em alguns instantes.',
  TELEGRAM_TICKET_NOT_FOUND: 'Este bilhete não existe nesta organização.',
  TELEGRAM_TICKET_STATE_CONFLICT:
    'Este bilhete já foi decidido ou mudou de estado. Confira o preview novamente.',
  TELEGRAM_TICKET_DUPLICATE:
    'Esta imagem e contexto já chegaram antes. Abrimos o bilhete original.',
  TELEGRAM_TICKET_ARCHIVED:
    'Este bilhete está arquivado. Você pode recuperá-lo durante a janela de 30 dias.',
  TELEGRAM_TICKET_EXPIRED: 'A janela de recuperação de 30 dias deste bilhete terminou.',
  TELEGRAM_TICKET_NOT_RECOVERABLE:
    'Este arquivo não pode ser recuperado: ele já foi restaurado ou é uma duplicata.',
  TELEGRAM_TICKET_BUSY: 'Há um bilhete em processamento. Envie a próxima foto em instantes.',
  // STK-F2-12 — a mensagem é idêntica para "nunca vinculado" e "revogado" de
  // propósito: ela orienta o caminho (vincular no site) sem confirmar a
  // existência de um vínculo anterior, o que seria um vazamento sobre a conta.
  TELEGRAM_SESSION_NOT_LINKED:
    'Esta conta do Telegram ainda não está vinculada. Vincule pelo site para usar o aplicativo.',
  TELEGRAM_SESSION_REVOKED:
    'Esta conta do Telegram ainda não está vinculada. Vincule pelo site para usar o aplicativo.',
  TELEGRAM_SESSION_UNAVAILABLE:
    'A conexão com o Telegram está indisponível agora. Tente novamente em alguns instantes.',
  // STK-F2-13 — as três recusas de plano e orçamento terminam NO MESMO LUGAR:
  // orientam o preenchimento manual. A recusa é de plano ou de orçamento, nunca
  // defeito do bilhete, e a importação continua disponível para o usuário.
  ENTITLEMENT_FEATURE_DENIED:
    'Este recurso não está disponível no seu plano. Você pode continuar o preenchimento manual desta importação.',
  ENTITLEMENT_PLAN_LIMIT_REACHED:
    'Seu plano atingiu o limite deste recurso. A importação continua disponível para preenchimento manual.',
  PAID_CALL_CEILING_REACHED:
    'O limite de processamento do beta foi atingido. Esta importação segue disponível para você preencher manualmente.',
  // STK-F2-09 — a orientação da importação por arquivo sempre diz o QUE FAZER:
  // corrigir o mapeamento, dividir o arquivo, ou conferir o resultado do lote.
  IMPORT_BATCH_NOT_FOUND: 'Este lote não existe nesta organização.',
  IMPORT_BATCH_STATE_CONFLICT:
    'Este lote mudou de estado. Confira o resultado antes de tentar de novo.',
  IMPORT_BATCH_ALREADY_COMMITTED:
    'A confirmação deste lote já foi registrada. Reenvie com a mesma chave para ver o mesmo resultado.',
  IMPORT_TEMPLATE_UNAVAILABLE: 'O modelo de importação está indisponível agora. Tente novamente.',
  IMPORT_FILE_TOO_LARGE: 'O arquivo excede o tamanho aceito. Divida-o em lotes menores.',
  IMPORT_CSV_MALFORMED: 'O arquivo não pôde ser lido. Confira a codificação e o separador.',
  IMPORT_MAPPING_CONFLICT: 'Duas colunas do arquivo foram mapeadas para o mesmo campo.',
  // STK-F2-08 — relatório privado. A mensagem de "não encontrado" é a MESMA
  // para id inexistente e id de outra organização: essa indistinção é o que
  // impede sondar a existência de um relatório alheio pelo código de erro.
  REPORT_SNAPSHOT_NOT_FOUND: 'Este relatório não está disponível na sua conta.',
  REPORT_SNAPSHOT_NO_DATA:
    'Não há apostas no período deste relatório. Registre uma aposta para que ele possa ser gerado.',
  REPORT_SNAPSHOT_NOT_REVISABLE:
    'Só a versão mais recente deste relatório pode ser revisada. Abra a versão atual.',
  REPORT_SERVICE_UNAVAILABLE:
    'Os relatórios não estão disponíveis agora. Tente novamente em alguns instantes.',
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
