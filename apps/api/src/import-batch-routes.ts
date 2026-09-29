import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { EntitlementService, ImportBatchService, OrganizationContext } from '@stakeframe/db';
import {
  apiErrorSchema,
  commandHeadersSchema,
  importBatchCommitSchema,
  importBatchListSchema,
  importBatchResultSchema,
  importBatchRollbackSchema,
  importPreviewRequestSchema,
  importPreviewSchema,
  importTemplateSchema,
  IMPORT_BATCH_ERROR_CODES,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { sendApiError } from './api-errors.js';
import { ownerSessionSecurity } from './openapi.js';

/** A resposta do preview: a identidade do lote mais o veredito linha a linha. */
const importPreviewResponseSchema = z
  .object({
    batchId: z.uuid(),
    version: z.number().int().positive(),
    preview: importPreviewSchema,
  })
  .meta({ id: 'ImportPreviewResponse' });

/**
 * STK-F2-09 — as rotas da importação por arquivo.
 *
 * A fronteira é a mesma da foto: sessão do proprietário, contexto de
 * organização vindo do servidor, e NADA financeiro antes do preview.
 *
 * O gate de entitlement da F2-13 é consultado em TODAS as rotas, e não só no
 * preview. A razão é específica deste card: a importação por arquivo é um
 * recurso do produto (o `ocr_extraction` é o recurso de leitura de comprovante,
 * e o CSV é o mesmo recurso por outro caminho de entrada), e um tenant sem o
 * recurso não pode convertê-lo em aposta em massa. Sem serviço de entitlement
 * configurado, a rota NÃO é publicada: um produto sem banco de entitlement não
 * pode afirmar que respeita plano, e silenciar a checagem seria aceitar o
 * recurso sem teto.
 *
 * Nenhuma destas rotas chama fornecedor, faz parser de arquivo de concorrente
 * nem fala com API de casa. E não há SSE: o progresso do job é lido no estado do
 * lote (GET do lote), que é o que o card determina.
 */
export function registerImportBatchRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: ImportBatchService | undefined,
  entitlements?: EntitlementService,
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    413: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const common = { tags: ['Importação por arquivo'], security: ownerSessionSecurity };

  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.method !== 'GET' &&
      (request.headers.origin !== auth.origin || request.headers['sec-fetch-site'] === 'cross-site')
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    // A organização vem do usuário autenticado — nunca do cliente. Por isso
    // esta rota NÃO aceita initData do Mini App: o Mini App não tem upload de
    // arquivo, e um caminho de importação que o Telegram abre seria um caminho
    // de importação que ninguém revisou.
    contexts.set(request, await service.ensureContext(owner.user.id));
  };

  /**
   * O gate do recurso. O CSV é o MESMO recurso de leitura de comprovante que a
   * foto, então a consulta é a mesma: recurso ausente da lista = negado, e
   * teto de plano esgotado = negado. Não há teto de chamada paga aqui porque
   * NENHUMA chamada paga acontece nesta fronteira — o arquivo já está escrito,
   * e inventar uma cota de "chamadas pagas" para um upload seria um número
   * sem lastro.
   */
  const resourceGate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!entitlements) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    const list = await entitlements.entitlements(contexts.get(request)!.organizationId);
    const ocr = list.find((entry) => entry.feature === 'ocr_extraction');
    if (!ocr || !ocr.enabled)
      return sendApiError(request, reply, 403, 'ENTITLEMENT_FEATURE_DENIED');
  };

  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const code = String(error.code);
        if ((IMPORT_BATCH_ERROR_CODES as readonly string[]).includes(code))
          return sendApiError(
            request,
            reply,
            code === 'IMPORT_BATCH_NOT_FOUND' ? 404 : code === 'IMPORT_CSV_MALFORMED' ? 400 : 409,
            code as never,
          );
      }
      throw error;
    }
  };

  // O TEMPLATE do produto. É um recurso estático do contrato, mas a rota
  // existe para que o cliente nunca precise reconstruir a lista de colunas
  // (e para que a ordem das colunas seja a do servidor, não a do arquivo).
  app.get(
    '/api/v1/import-batches/template',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getImportTemplate',
        summary: 'Baixar o modelo de importação do Stakeframe',
        response: { 200: importTemplateSchema, ...errors },
      },
    },
    (request, reply) => execute(request, reply, async () => service!.template()),
  );

  // A PREVIEW: lê o arquivo, valida linha a linha e devolve o veredito. Nenhuma
  // escrita financeira acontece aqui — nem em `finance.bet`, nem em journal,
  // nem em posting.
  app.post(
    '/api/v1/import-batches/preview',
    {
      onRequest: async (request, reply) => {
        await authorize(request, reply);
        if (reply.sent) return;
        await resourceGate(request, reply);
      },
      bodyLimit: 4_500_000,
      schema: {
        ...common,
        operationId: 'previewImportBatch',
        summary: 'Validar um arquivo linha a linha antes de registrar qualquer aposta',
        body: importPreviewRequestSchema,
        response: { 200: importPreviewResponseSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const input = importPreviewRequestSchema.parse(request.body);
        const result = await service!.preview(contexts.get(request)!, input);
        return { batchId: result.batchId, version: result.version, preview: result.preview };
      }),
  );

  const params = z.object({ id: z.uuid() });
  app.get(
    '/api/v1/import-batches',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listImportBatches',
        summary: 'Consultar os lotes de importação e o estado do job',
        response: { 200: importBatchListSchema, ...errors },
      },
    },
    (request, reply) => execute(request, reply, () => service!.list(contexts.get(request)!)),
  );

  // O ESTADO DO JOB. O progresso vem daqui e não de SSE: é a mesma leitura de
  // recurso que toda a API já faz, e continua correta com a aba fechada.
  app.get(
    '/api/v1/import-batches/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getImportBatch',
        summary: 'Consultar o resultado de um lote de importação',
        params,
        response: { 200: importBatchResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.detail(contexts.get(request)!, params.parse(request.params).id),
      ),
  );

  // A CONFIRMAÇÃO. Carrega a chave de idempotência como as demais ações do
  // produto: o retry do cliente reenvia a MESMA chave e recebe o MESMO
  // resultado, sem duplicar aposta nem duplicar a exposição.
  app.post(
    '/api/v1/import-batches/:id/commit',
    {
      onRequest: async (request, reply) => {
        await authorize(request, reply);
        if (reply.sent) return;
        await resourceGate(request, reply);
      },
      schema: {
        ...common,
        operationId: 'commitImportBatch',
        summary: 'Registrar as apostas do lote aprovado',
        params,
        headers: commandHeadersSchema,
        body: importBatchCommitSchema,
        response: { 200: importBatchResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.commit(
          contexts.get(request)!,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          params.parse(request.params).id,
          importBatchCommitSchema.parse(request.body),
        ),
      ),
  );

  // A REVERSÃO. Disponível enquanto o lote não foi confirmado — e também
  // depois, que é o caso de uso real: o usuário descobre a linha errada depois
  // de gravar. A reversão é pelo caminho canônico de cancelamento, então o
  // lançamento e o seu estorno permanecem no histórico.
  app.post(
    '/api/v1/import-batches/:id/rollback',
    {
      onRequest: async (request, reply) => {
        await authorize(request, reply);
        if (reply.sent) return;
        await resourceGate(request, reply);
      },
      schema: {
        ...common,
        operationId: 'rollbackImportBatch',
        summary: 'Reverter as apostas registradas por um lote de importação',
        params,
        headers: commandHeadersSchema,
        body: importBatchRollbackSchema,
        response: { 200: importBatchResultSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        service!.rollback(
          contexts.get(request)!,
          commandHeadersSchema.parse(request.headers)['idempotency-key'],
          params.parse(request.params).id,
          importBatchRollbackSchema.parse(request.body),
        ),
      ),
  );
}
