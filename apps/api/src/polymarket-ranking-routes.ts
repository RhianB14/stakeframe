import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  POLYMARKET_CATEGORY_LABELS,
  POLYMARKET_DEFAULT_WINDOW,
  POLYMARKET_ORDER_LABELS,
  POLYMARKET_PERIOD_LABELS,
  POLYMARKET_RANKING_CATEGORIES,
  apiErrorSchema,
  polymarketRankingQuerySchema,
  polymarketRankingSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';
import { PolymarketRankingError, type PolymarketRankingStore } from '@stakeframe/db';

/**
 * STK-F2-15 — a rota de leitura do ranking oficial Polymarket.
 *
 * O gate é o mesmo das demais rotas privadas (sessão + origem + consentimento)
 * e a rota NÃO aceita organização, usuário ou tenant: o ranking é dado público
 * de integração externa, idêntico para qualquer conta, e um parâmetro de
 * destino seria uma superfície de impersonação que o card não abre.
 *
 * A rota é SOMENTE LEITURA. Ela não chama a Polymarket: o dado vem das
 * tabelas que a F2-14 gravou, com a completude que a F2-14 gravou. Não há
 * cache próprio, não há gravação e não há chamada externa nova — por isso
 * esta tarefa não consulta a porta de entitlement da F2-13, que existe para
 * pagar por uma chamada, e não para ler o que já está no nosso banco.
 *
 * A ABSÊNCIA DE SERVIÇO responde 503 (fail-closed), como nas demais rotas
 * opcionais: sem o serviço de leitura não há como afirmar que a completude
 * mostrada é a gravada.
 */
export function registerPolymarketRankingRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  store: PolymarketRankingStore | undefined,
  options: { minSample: number },
) {
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    500: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };

  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    if (
      request.headers.origin !== auth.origin ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      return sendApiError(request, reply, 403, 'ORIGIN_NOT_ALLOWED');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!store) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
  };

  app.get(
    '/api/v1/polymarket/ranking',
    {
      onRequest: authorize,
      schema: {
        tags: ['Integrações'],
        security: ownerSessionSecurity,
        operationId: 'getPolymarketRanking',
        summary:
          'Ranking oficial de traders da Polymarket com P&L, volume, amostra e completude da série',
        description:
          'Lê o leaderboard oficial já ingerido pela F2-14. A completude exibida é o status ' +
          'gravado pela ingestão, nunca inferida da contagem de linhas. A resposta traz ' +
          'exclusivamente as métricas publicadas pela origem.',
        querystring: polymarketRankingQuerySchema,
        response: { 200: polymarketRankingSchema, ...errors },
      },
    },
    (request, reply) => {
      const query = polymarketRankingQuerySchema.parse(request.query);
      return execute(request, reply, () => store!.ranking(query, { minSample: options.minSample }));
    },
  );

  /**
   * Os FILTROS que a tela pode oferecer, lidos do enum oficial.
   *
   * A rota existe para que a interface não escreva uma lista de categorias à
   * mão: ela recebe o mesmo conjunto que o schema de consulta aceita, e por
   * isso um filtro offered e um filtro aceito não podem divergir. Os rótulos
   * em português viajam junto, e a grafia oficial continua sendo o VALOR.
   */
  app.get(
    '/api/v1/polymarket/ranking/filters',
    {
      onRequest: authorize,
      schema: {
        tags: ['Integrações'],
        security: ownerSessionSecurity,
        operationId: 'getPolymarketRankingFilters',
        summary: 'Períodos, categorias e ordenações aceitos pela API oficial do leaderboard',
        description:
          'Enums verificados por probe contra a origem: um rótulo fora da lista oficial ' +
          'devolve 400. A lista de categorias é maior do que a ingerida hoje; as ' +
          'categorias ainda não coletadas respondem com a série ausente, não vazia.',
        response: {
          200: z.strictObject({
            categories: z.array(
              z.strictObject({ value: z.enum(POLYMARKET_RANKING_CATEGORIES), label: z.string() }),
            ),
            timePeriods: z.array(z.strictObject({ value: z.string(), label: z.string() })),
            orderBy: z.array(z.strictObject({ value: z.string(), label: z.string() })),
            defaultWindow: z.strictObject({
              category: z.enum(POLYMARKET_RANKING_CATEGORIES),
              timePeriod: z.string(),
              orderBy: z.string(),
            }),
          }),
          ...errors,
        },
      },
    },
    (request, reply) =>
      reply.send({
        categories: POLYMARKET_RANKING_CATEGORIES.map((value) => ({
          value,
          label: POLYMARKET_CATEGORY_LABELS[value],
        })),
        timePeriods: Object.entries(POLYMARKET_PERIOD_LABELS).map(([value, label]) => ({
          value,
          label,
        })),
        orderBy: Object.entries(POLYMARKET_ORDER_LABELS).map(([value, label]) => ({
          value,
          label,
        })),
        defaultWindow: {
          category: POLYMARKET_DEFAULT_WINDOW.category,
          timePeriod: POLYMARKET_DEFAULT_WINDOW.timePeriod,
          orderBy: POLYMARKET_DEFAULT_WINDOW.orderBy,
        },
      }),
  );

  async function execute(
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof PolymarketRankingError)
        return sendApiError(request, reply, 500, 'INTERNAL_ERROR');
      throw error;
    }
  }
}
