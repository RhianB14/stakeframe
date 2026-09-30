import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { PolymarketAlertsError, type PolymarketAlertsService } from '@stakeframe/db';
import type { FreebetService, OrganizationContext } from '@stakeframe/db';
import {
  ALERT_DEFAULT_THRESHOLD,
  ALERT_WINDOW_MINUTES,
  POLYMARKET_FAVORITES_LIMIT,
  apiErrorSchema,
  polymarketAlertConfigInputSchema,
  polymarketAlertConfigSchema,
  polymarketAlertLimitsSchema,
  polymarketFavoriteCreatedSchema,
  polymarketFavoriteInputSchema,
  polymarketFavoriteRemovedSchema,
  polymarketFavoritesResponseSchema,
  polymarketWalletSchema,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

/**
 * STK-F2-16 — favoritos e configuração de alertas de atividade Polymarket.
 *
 * O gate é o MESMO das demais rotas privadas (sessão + origem + consentimento) e
 * a organização vem SEMPRE do usuário autenticado, nunca do corpo: um cliente
 * que mandasse `userId` ou `organizationId` veria os favoritos e a cota diária
 * de outra conta. O usuário também vem do contexto — é ele quem tem o fuso, as
 * quiet hours e a cota.
 *
 * O que estas rotas NÃO fazem, e a ausência é estrutural:
 *
 *  - Não expõem o Composite Score. Não existe rota de leitura, nem
 *    `score=true` na query, nem campo opcional na resposta. O score é gravado
 *    pelo job silencioso e nenhuma linha deste arquivo o menciona.
 *  - Não ligam alerta ao favoritar. `POST /favorites` grava o favorito e nada
 *    mais; a ativação é `PUT /alerts/config`, uma chamada separada. Um cliente
 *    que favorite sem chamar a segunda recebe a lista com `alertEnabled: false`,
 *    e a tela escreve que nenhum alerta está ativo.
 *
 * Os erros usam os códigos estáveis de `apiErrorCodeSchema`. O excedente do
 * limite de 10 é `FAVORITES_LIMIT_REACHED` (409), porque o estado é de
 * conflito com um limite do produto, e não de requisição inválida: o pedido é
 * bem formado e o que falta é vaga.
 */
export function registerPolymarketAlertsRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: PolymarketAlertsService | undefined,
  finance: FreebetService | undefined,
  /**
   * STK-F2-16: o nome publicado pela origem para uma carteira, lido das MESMAS
   * tabelas que a tela de ranking lê. É injetado em vez de lido aqui porque a
   * rota é a camada HTTP e a leitura é dado: injetar mantém o SQL de produto em
   * um único lugar (`polymarketRankingStore`) e permite ao teste montar um
   * leitor sem abrir conexão.
   *
   * Devolve `''` quando a carteira não está mais na janela ingerida, e isso é
   * um resultado legítimo: um favorito sem nome continua válido e a tela mostra
   * a carteira pública, que é o identificador honesto.
   */
  traderName: (proxyWallet: string) => Promise<string> = async () => '',
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
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
    if (!service || !finance) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    // O contexto do tenant é provisionado no primeiro uso, como nas demais
    // rotas privadas; o `userId` do contexto é o dono dos favoritos.
    contexts.set(request, await finance.ensureContext(owner.user.id));
  };
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof PolymarketAlertsError) {
        const status =
          error.code === 'FAVORITE_NOT_FOUND'
            ? 404
            : error.code === 'ALERT_CONFIG_INVALID' || error.code === 'FAVORITE_INVALID'
              ? 400
              : 409;
        return sendApiError(request, reply, status, error.code);
      }
      throw error;
    }
  };
  const common = { tags: ['Integrações'], security: ownerSessionSecurity };
  const walletParams = z.object({ proxyWallet: polymarketWalletSchema });

  /**
   * A lista de favoritos com o uso do teto e o estado do alerta.
   *
   * O `alertEnabled` viaja JUNTO com a lista, e não numa chamada separada: a
   * pergunta que a tela precisa responder é "estou seguindo alguém e estou
   * recebendo aviso?", e responder com duas chamadas traria um estado
   * intermediário em que a resposta seria falsa. O valor vem da configuração
   * gravada, então favoritar sem ativar responde `false` de forma honesta.
   */
  app.get(
    '/api/v1/polymarket/favorites',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listPolymarketFavorites',
        summary: 'Listar os traders favoritos e o estado da configuração de alerta',
        description:
          'O limite de dez favoritos é do produto e o excedente é recusado, nunca paginado. ' +
          'Favoritar não ativa alerta: a ativação é gravada em /polymarket/alerts/config.',
        response: {
          200: polymarketFavoritesResponseSchema,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const context = contexts.get(request)!;
      return execute(request, reply, async () => {
        const [favorites, config] = await Promise.all([
          service!.listFavorites(context, context.userId),
          service!.alertConfig(context, context.userId),
        ]);
        return {
          ...favorites,
          alertEnabled: config.enabled,
          alertThreshold: config.threshold,
          alertDailyLimit: config.dailyLimit,
          alertWindowMinutes: config.windowMinutes,
        };
      });
    },
  );

  /**
   * Favoritar um trader. A resposta é a lista inteira, e não só o registro novo:
   * o que importa para o cliente depois de favoritar é saber QUANTOS favoritos
   * ele tem agora, e devolver só o registro obrigaria a tela a contar de novo.
   */
  app.post(
    '/api/v1/polymarket/favorites',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'createPolymarketFavorite',
        summary: 'Favoritar um trader do ranking oficial, com limite de dez por usuário',
        description:
          'O décimo primeiro favorito é recusado com FAVORITES_LIMIT_REACHED: o limite é do ' +
          'produto e o banco o impõe. Esta rota NÃO ativa alerta de atividade.',
        body: polymarketFavoriteInputSchema,
        response: {
          200: polymarketFavoriteCreatedSchema,
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const context = contexts.get(request)!;
      const input = polymarketFavoriteInputSchema.parse(request.body);
      return execute(request, reply, async () => {
        // O nome vem do LEITOR INJETADO (o que a F2-14 gravou), nunca do
        // corpo: um cliente poderia favoritar com o nome que quisesse e o
        // registro passaria a exibir algo que a origem nunca publicou.
        const known = await traderName(input.proxyWallet.toLowerCase());
        const added = await service!.addFavorite(context, context.userId, {
          proxyWallet: input.proxyWallet,
          userName: known,
        });
        const [favorites, config] = await Promise.all([
          service!.listFavorites(context, context.userId),
          service!.alertConfig(context, context.userId),
        ]);
        return {
          ...favorites,
          created: added.created,
          alertEnabled: config.enabled,
          alertThreshold: config.threshold,
          alertDailyLimit: config.dailyLimit,
          alertWindowMinutes: config.windowMinutes,
        };
      });
    },
  );

  app.delete(
    '/api/v1/polymarket/favorites/:proxyWallet',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'deletePolymarketFavorite',
        summary: 'Remover um trader dos favoritos',
        params: walletParams,
        response: { 200: polymarketFavoriteRemovedSchema, ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      const { proxyWallet } = walletParams.parse(request.params);
      return execute(request, reply, async () => {
        await service!.removeFavorite(context, context.userId, proxyWallet);
        return { removed: true as const };
      });
    },
  );

  app.get(
    '/api/v1/polymarket/alerts/config',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getPolymarketAlertConfig',
        summary: 'Consultar ativação, limiar, cota diária e janela do alerta de atividade',
        description:
          'Ausente no banco, a resposta é o padrão do produto: desligado, limiar de mil ' +
          'dólares por janela de cinco minutos. As quiet hours e o fuso vêm da preferência ' +
          'de notificação do usuário, nesta mesma conta.',
        response: { 200: polymarketAlertConfigSchema, ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      return execute(request, reply, () => service!.alertConfig(context, context.userId));
    },
  );

  /**
   * Grava a configuração. A ativação é um campo OBRIGATÓRIO do corpo: pedir a
   * config inteira sem decidir se liga ou desliga obrigaria o servidor a
   * escolher, e a escolha errada liga o alerta de um usuário que só queria
   * mudar o limiar.
   */
  app.put(
    '/api/v1/polymarket/alerts/config',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'updatePolymarketAlertConfig',
        summary: 'Gravar ativação, limiar ajustável e cota diária do alerta de atividade',
        body: polymarketAlertConfigInputSchema,
        response: { 200: polymarketAlertConfigSchema, ...errors },
      },
    },
    (request, reply) => {
      const context = contexts.get(request)!;
      const patch = polymarketAlertConfigInputSchema.parse(request.body);
      return execute(request, reply, () =>
        service!.saveAlertConfig(context, context.userId, patch),
      );
    },
  );

  app.get(
    '/api/v1/polymarket/alerts/limits',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getPolymarketAlertLimits',
        summary: 'Consultar os limites do produto: favoritos por usuário, janela e limiar padrão',
        description:
          'Existe para que a tela não escreva números próprios: o teto de dez favoritos, ' +
          'a janela de cinco minutos e o limiar padrão vêm do contrato.',
        response: { 200: polymarketAlertLimitsSchema, ...errors },
      },
    },
    (_request, reply) =>
      reply.send({
        favoritesLimit: POLYMARKET_FAVORITES_LIMIT,
        windowMinutes: ALERT_WINDOW_MINUTES,
        defaultThreshold: ALERT_DEFAULT_THRESHOLD,
      }),
  );
}
