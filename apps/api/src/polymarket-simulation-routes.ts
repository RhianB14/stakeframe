import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  SIMULATION_DISCLAIMERS,
  SIMULATION_MAX_DELAY_MS,
  apiErrorSchema,
  polymarketSimulationSchema,
  simulationInputSchema,
} from '@stakeframe/shared';
import {
  PolymarketSimulationError,
  type OrganizationContext,
  type PolymarketSimulationStore,
} from '@stakeframe/db';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

/**
 * STK-F2-17 — a rota da simulação MERAMENTE INDICATIVA.
 *
 * A rota é uma coisa só: ela pede uma APURAÇÃO e devolve o registro. Ela não
 * executa, não envia ordem, não otimiza e não promete retorno — e isso não é
 * uma promessa do texto, é a ausência de qualquer caminho de código que o
 * faça. O schema da resposta declara `executable: false` e `executed: false`
 * como literais, e o `refine` recusa qualquer payload que se declare
 * executável.
 *
 * DIFERENÇAS EM RELAÇÃO ÀS DEMAIS ROTAS, e cada uma é deliberada:
 *
 *  - A ORGANIZAÇÃO VEM DO USUÁRIO AUTENTICADO, nunca do corpo. A stake e as
 *    premissas são escolhas do dono, e o registro é gravado na SUA organização.
 *    Um `organizationId` no corpo seria impersonação — o mesmo motivo pelo
 *    qual o relatório e as freebets não aceitam id de destino.
 *
 *  - A ORIGEM É EXIGIDA EM POST, como nas demais mutações. A simulação grava
 *    uma linha, e uma gravação ace cross-site seria um registro forjado de
 *    outro tenant.
 *
 *  - A RECUSA NÃO É ERRO HTTP. Ela é uma RESPOSTA 200 com o motivo, e essa é
 *    a diferença mais importante desta rota. `truncated` é o estado REAL e
 *    normal deste backfill: se a recusa fosse um 4xx, o usuário veria "erro"
 *    numa situação que é o funcionamento esperado, e a tela não teria como
 *    mostrar a explicação. O card pede "impedir resultado", não "quebrar a
 *    tela" — e a explicação é o produto.
 *
 *  - A AUSÊNCIA DO SERVIÇO É 503 (fail-closed), como nas demais rotas
 *    opcionais: sem o serviço não há como garantir que a completude mostrada
 *    é a gravada, e sem o registro não há como garantir que a recusa ficou
 *    auditada.
 */
export function registerPolymarketSimulationRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  store: PolymarketSimulationStore | undefined,
  ensureContext: ((userId: string) => Promise<OrganizationContext>) | undefined,
  options: { minSample: number },
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
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
    // O serviço E o resolvedor de organização são exigidos juntos. Sem o
    // resolvedor a gravação iria para um tenant escolhido por nós, o que é a
    // mesma coisa que impersonação com outro nome.
    if (!store || !ensureContext) return sendApiError(request, reply, 503, 'AUTH_UNAVAILABLE');
    contexts.set(request, await ensureContext(owner.user.id));
  };

  app.post(
    '/api/v1/polymarket/simulation',
    {
      onRequest: authorize,
      schema: {
        tags: ['Integrações'],
        security: ownerSessionSecurity,
        operationId: 'runPolymarketSimulation',
        summary: 'Apurar uma simulação MERAMENTE INDICATIVA com stake fixa e premissas explícitas',
        description:
          'Aplica uma stake fixa às observações já publicadas pela Polymarket e devolve um ' +
          'número aritmético indicativo, com as premissas de atraso, taxas, spread, slippage e ' +
          'dados ausentes SEMPRE visíveis. A cobertura necessária é a status gravado pela ' +
          'ingestão: enquanto ela não for completa, a apuração é RECUSADA com o motivo e sem ' +
          'nenhum número. A resposta é sempre indicativa: nada é executado, nenhuma ordem é ' +
          'enviada e nenhum retorno é prometido. A tentativa, recusada ou apurada, é registrada.',
        body: simulationInputSchema,
        response: { 200: polymarketSimulationSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, () =>
        store!.simulate(contexts.get(request)!, simulationInputSchema.parse(request.body), {
          minSample: options.minSample,
        }),
      ),
  );

  /**
   * As PREMISSAS e os AVISOS que esta rota devolve sempre, e a FORMA da
   * entrada — expostos numa leitura para que a tela não escreva a lista à mão.
   *
   * A rota existe pelo mesmo motivo da `/ranking/filters` da F2-15: a
   * interface precisa oferecer exatamente o que o schema aceita, e duas listas
   * escritas à mão divergem na primeira edição. Os avisos viajam aqui também,
   * para que a tela possa exibir a MESMA lista que o motor e o banco gravam —
   * uma lista de avisos escrita no componente seria uma segunda versão da
   * mesma verdade, e a segunda versão é a que alguém edita sem querer.
   */
  app.get(
    '/api/v1/polymarket/simulation/premises',
    {
      onRequest: authorize,
      schema: {
        tags: ['Integrações'],
        security: ownerSessionSecurity,
        operationId: 'getPolymarketSimulationPremises',
        summary: 'Premissas aceitas, avisos obrigatórios e limites de entrada da simulação',
        description:
          'Contrato da simulação indicativa. As premissas de fricção são escolhidas pelo ' +
          'usuário e assim aparecem na tela: elas não são medidas da Polymarket. Os avisos são ' +
          'obrigatórios em toda saída e não podem ser removidos.',
        response: {
          200: z.strictObject({
            maxDelayMs: z.number().int().positive(),
            disclaimers: z.array(z.string().min(1)).min(1),
          }),
          ...errors,
        },
      },
    },
    (request, reply) =>
      reply.send({ maxDelayMs: SIMULATION_MAX_DELAY_MS, disclaimers: [...SIMULATION_DISCLAIMERS] }),
  );

  async function execute(
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof PolymarketSimulationError)
        return sendApiError(request, reply, 400, 'INVALID_REQUEST');
      throw error;
    }
  }
}
