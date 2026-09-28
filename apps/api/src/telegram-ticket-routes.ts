import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  apiErrorSchema,
  telegramArchiveListSchema,
  telegramArchiveRestoreSchema,
  telegramPreviewActionResultSchema,
  telegramPreviewActionSchema,
  telegramTicketPreviewSchema,
} from '@stakeframe/shared';
import { FinanceError, TelegramTicketError, createImportService } from '@stakeframe/db';
import type { Database, OrganizationContext, TelegramTicketService } from '@stakeframe/db';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';
import { createHash } from 'node:crypto';

/**
 * Rotas do fluxo da mensagem Telegram até o bilhete (STK-F2-05).
 *
 * Mesma fronteira de toda rota privada do produto: sessão válida de identidade
 * admitida, consentimento vigente e — em escrita — Origin igual à origem
 * configurada. A organização vem SEMPRE do usuário autenticado: o corpo nunca
 * escolhe tenant, bilhete ou conta.
 *
 * O preview é OBRIGATÓRIO e é a única coisa que existe antes da decisão.
 * Nenhuma destas rotas cria aposta por conta própria: a aposta nasce quando o
 * usuário CONFIRMA, e mesmo aí pelo comando financeiro canônico, montado a
 * partir do rascunho — nenhum valor vem do cliente.
 *
 * A recuperação do arquivo é uma operação explícita e separada: 30 dias são
 * uma janela do REGISTRO, não um `/undo` temporizado. Duplicata não é
 * recuperável — o registro a recuperar é sempre o original.
 */
export function registerTelegramTicketRoutes(
  app: FastifyInstance,
  ownerAuth: OwnerAuth | undefined,
  service: TelegramTicketService | undefined,
  database?: Database,
) {
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ownerAuth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method !== 'GET' &&
      (request.headers.origin !== ownerAuth.origin ||
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const owner = await ownerAuth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    const organizationId = owner.organization.id;
    // A organização vem do usuário autenticado — nunca do corpo.
    contexts.set(request, {
      organizationId,
      role: 'owner',
      userId: owner.user.id,
    });
  };

  /** Mapa código → status HTTP; nada além do código vaza. */
  const refuse = (error: unknown) => {
    if (error instanceof TelegramTicketError) {
      switch (error.code) {
        case 'TELEGRAM_TICKET_NOT_FOUND':
          return 404;
        case 'TELEGRAM_TICKET_STATE_CONFLICT':
        case 'TELEGRAM_TICKET_DUPLICATE':
        case 'TELEGRAM_TICKET_ARCHIVED':
        case 'TELEGRAM_TICKET_EXPIRED':
        case 'TELEGRAM_TICKET_NOT_RECOVERABLE':
        case 'TELEGRAM_TICKET_BUSY':
          return 409;
        default:
          return 503;
      }
    }
    if (error instanceof FinanceError) {
      switch (error.code) {
        case 'NOT_FOUND':
          return 404;
        case 'INVALID_FINANCIAL_OPERATION':
          return 400;
        default:
          return 409;
      }
    }
    return null;
  };
  const fail = async (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    const status = refuse(error);
    if (status && error instanceof TelegramTicketError)
      return sendApiError(request, reply, status, error.code);
    if (status && error instanceof FinanceError)
      return sendApiError(request, reply, status, error.code);
    throw error;
  };

  const ticketParams = z.object({ id: z.uuid() });
  const archiveParams = z.object({ archiveId: z.uuid() });

  app.get(
    '/api/v1/telegram/tickets/:id/preview',
    {
      onRequest: authorize,
      schema: {
        operationId: 'getTelegramTicketPreview',
        tags: ['Telegram'],
        summary: 'Ler o preview estruturado do bilhete antes de qualquer lançamento',
        security: ownerSessionSecurity,
        description:
          'Estado do bilhete que chegou pelo Telegram, antes de qualquer decisão. Nenhuma escrita financeira acontece nesta leitura: enquanto o preview existir, a aposta e o lançamento são os de antes do recebimento. A data de envio é o instante da mensagem original e é imutável; a data do evento é um campo separado, que nasce pendente e nunca é inferida da data de envio. A duplicata é decidida pela identidade determinística da imagem e do contexto — não por horário. Exige sessão válida e consentimento vigente.',
        params: ticketParams,
        response: { 200: telegramTicketPreviewSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!service) return;
      const { id } = ticketParams.parse(request.params);
      try {
        return reply.send(await service.preview(contexts.get(request)!, id));
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.post(
    '/api/v1/telegram/tickets/:id/decision',
    {
      onRequest: authorize,
      schema: {
        operationId: 'decideTelegramTicketPreview',
        tags: ['Telegram'],
        summary: 'Confirmar, descartar ou reprocessar o bilhete do preview',
        security: ownerSessionSecurity,
        description:
          'Decisão explícita sobre o preview. `confirm` monta o comando financeiro canônico a partir do rascunho e é o ÚNICO caminho que cria aposta e lançamento; `discard` arquiva o registro por 30 dias sem apagar nada; `retry` volta a extração para a fila. Nenhuma decisão é temporizada e não existe desfazer automático. Repetir a mesma decisão com a mesma versão é idempotente. Exige Origin da aplicação, sessão válida e consentimento vigente.',
        params: ticketParams,
        body: telegramPreviewActionSchema,
        response: { 200: telegramPreviewActionResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!service) return;
      const { id } = ticketParams.parse(request.params);
      const body = telegramPreviewActionSchema.parse(request.body);
      const context = contexts.get(request)!;
      try {
        if (body.decision === 'discard') {
          const preview = await service.preview(context, id);
          if (preview.state === 'imported')
            throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
          // Descartar NÃO apaga: arquiva por 30 dias. Já arquivado mantém o
          // prazo vigente do arquivo vivo, sem abrir uma segunda janela.
          const recoverableUntil = preview.archive.archived
            ? (preview.archive.recoverableUntil ?? new Date(0).toISOString())
            : (await service.archive(context, id, 'discarded')).recoverableUntil;
          return reply.send(
            telegramPreviewActionResultSchema.parse({
              id,
              version: preview.version,
              state: 'discarded',
              betId: null,
              restored: false,
              recoverableUntil,
            }),
          );
        }
        if (body.decision === 'retry') {
          const preview = await service.preview(context, id);
          if (!preview.actions.includes('retry'))
            throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
          const retried = await service.retry(context, id, body.version);
          return reply.send(telegramPreviewActionResultSchema.parse(retried));
        }
        return reply.send(
          telegramPreviewActionResultSchema.parse(
            await confirmPreview(database, context, id, body.version),
          ),
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.get(
    '/api/v1/telegram/tickets/archive',
    {
      onRequest: authorize,
      schema: {
        operationId: 'listTelegramTicketArchive',
        tags: ['Telegram'],
        summary: 'Listar bilhetes arquivados e ainda recuperáveis',
        security: ownerSessionSecurity,
        description:
          'Bilhetes descartados ou identificados como duplicata que ainda estão dentro da janela de recuperação de 30 dias. Nada é apagado ao descartar: o registro continua endereçável por aqui. Duplicatas aparecem para diagnóstico, mas a recuperação devolve o registro original e nunca cria um segundo lançamento.',
        response: { 200: telegramArchiveListSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!service) return;
      try {
        return reply.send(
          telegramArchiveListSchema.parse({
            items: await service.listArchive(contexts.get(request)!, 50),
          }),
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.post(
    '/api/v1/telegram/tickets/archive/:archiveId/restore',
    {
      onRequest: authorize,
      schema: {
        operationId: 'restoreTelegramTicketArchive',
        tags: ['Telegram'],
        summary: 'Recuperar um bilhete arquivado dentro dos 30 dias',
        security: ownerSessionSecurity,
        description:
          'Devolve o bilhete à fila de decisão dentro da janela de recuperação. Nenhuma aposta é criada pela recuperação: o registro volta a aparecer no preview e o usuário decide de novo. Fora da janela a resposta é expirado; arquivo já restaurado ou duplicata não é recuperável. Exige Origin da aplicação, sessão válida e consentimento vigente.',
        params: archiveParams,
        body: telegramArchiveRestoreSchema,
        response: { 200: telegramPreviewActionResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (!service) return;
      const { archiveId } = archiveParams.parse(request.params);
      telegramArchiveRestoreSchema.parse(request.body);
      const context = contexts.get(request)!;
      try {
        const restored = await service.restore(context, archiveId);
        const preview = await service.preview(context, restored.inboxId);
        return reply.send(
          telegramPreviewActionResultSchema.parse({
            id: restored.inboxId,
            version: restored.version,
            state: preview.state,
            betId: null,
            restored: true,
            recoverableUntil: null,
          }),
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );
}

/**
 * Confirmação do preview: o ÚNICO caminho que cria aposta.
 *
 * A aposta nasce pelo `confirmDraft` — o mesmo serviço que o Mini App usa, que
 * monta `import.confirm` a partir do rascunho canônico e o entrega ao serviço
 * financeiro, que revalida casa, origem, crédito, campos e duplicata no
 * servidor. Nenhum valor chega do cliente.
 *
 * A chave de idempotência é DETERMINÍSTICA (importação + versão): repetir a
 * mesma confirmação converge no mesmo efeito, e uma versão diferente exige uma
 * nova leitura do preview.
 */
async function confirmPreview(
  database: Database | undefined,
  context: OrganizationContext,
  id: string,
  version: number,
) {
  if (!database) throw new TelegramTicketError('TELEGRAM_TICKET_STATE_CONFLICT');
  const imports = createImportService(database);
  const applied = await imports.confirmDraft(
    context,
    id,
    { version },
    'web',
    telegramPreviewIdempotencyKey(id, version),
  );
  return {
    id,
    version: applied.version,
    state: 'imported' as const,
    betId: applied.betId,
    restored: false,
    recoverableUntil: null,
  };
}

/** Chave de idempotência determinística por importação + versão do preview. */
function telegramPreviewIdempotencyKey(id: string, version: number): string {
  const digest = createHash('sha256').update(`telegram:preview:${id}:${version}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
