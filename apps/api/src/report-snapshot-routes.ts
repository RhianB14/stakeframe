import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import {
  ReportSnapshotError,
  type OrganizationContext,
  type ReportService as ReportServiceBase,
  type ReportSnapshotRecord,
  type ReportSnapshotService,
} from '@stakeframe/db';
import {
  apiErrorSchema,
  reportPeriodSchema,
  reportRevisionInputSchema,
  reportSnapshotListSchema,
  reportSnapshotRefSchema,
  reportSnapshotSchema,
  reportMetricsSchema,
  type ReportSnapshotPayload,
  type ReportSnapshotRef,
} from '@stakeframe/shared';
import type { OwnerAuth } from './auth.js';
import { ownerSessionSecurity } from './openapi.js';
import { sendApiError } from './api-errors.js';

// STK-F2-08 — a PÁGINA HTML PRIVADA do relatório.
//
// O relatório é uma rota autenticada do produto (§4.3 / D020): sem URL pública
// temporária, sem token no endereço, sem PDF/PNG/e-mail. O Telegram entrega o
// RESUMO e o endereço daqui; abrir exige sessão do dono.
//
// A superfície tem quatro rotas e uma regra por trás de todas elas:
//
//  - A ORGANIZAÇÃO VEM DO USUÁRIO AUTENTICADO, nunca do corpo e nunca do id da
//    URL. Um relatório de outra organização devolve 404 — o mesmo
//    comportamento de freebets (§15), e pela mesma razão: um 403 confirmaria
//    que o id existe.
//
//  - O QUE SAI DAQUI É O SNAPSHOT, não uma recomputação. A página mostra o
//    número que foi publicado, com o hash; se o financeiro mudou depois, a
//    correção aparece como VERSÃO NOVA ao lado, e a anterior fica intacta.
//
//  - SEM DADOS É RESPOSTA PRÓPRIA (`empty: true`), não um relatório com zero.
//    "Apostou nada" e "apostou e perdeu zero" são afirmações diferentes, e
//    misturá-las seria mentir sobre o número do usuário.

/** As três dimensões que a página compara, todas vindas dos splits da F2-03. */
const BREAKDOWN_DIMENSIONS = new Set(['bookmaker', 'sport', 'tipster']);

const idParams = z.object({ id: z.uuid() });
const windowQuery = z.object({
  period: reportPeriodSchema,
  from: z.iso.date(),
  to: z.iso.date(),
});
const historyQuery = z.object({
  period: reportPeriodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

function refOf(record: ReportSnapshotRecord): ReportSnapshotRef {
  return reportSnapshotRefSchema.parse({
    id: record.id,
    version: record.version,
    period: record.period,
    from: record.from,
    to: record.to,
    financialVersion: record.financialVersion,
    title: record.title,
    contentSha256: record.contentSha256,
    requestedBy: record.requestedBy,
    revisionReason: record.revisionReason,
    createdAt: record.createdAt,
    latest: record.latest,
  });
}

/** Métricas zeradas para a janela sem dados — nunca um P&L "de verdade". */
const EMPTY_METRICS = {
  bets: 0,
  settledBets: 0,
  openBets: 0,
  realStake: '0.00',
  freebetStake: '0.00',
  realPrincipalClosed: '0.00',
  realReturns: '0.00',
  freebetReturns: '0.00',
  realProfit: '0.00',
  freebetProfit: '0.00',
  profit: '0.00',
  profitUnits: null,
  knownProfitUnits: '0.000000',
  missingUnitBets: 0,
  exposure: '0.00',
  roiReal: null,
  yieldReal: null,
  hitRateReal: null,
  hitWinsReal: 0,
  hitEligibleReal: 0,
} as const;

/** Só o que a página precisa dos splits: uma linha por valor da dimensão. */
type BreakdownSource = {
  dimensions: {
    id: string;
    label: string;
    rows: { label: string; lowSample: boolean; metrics: { bets: number; profit: string } }[];
  }[];
};

/**
 * A resposta da página, montada de UM record.
 *
 * Existe como função única porque as quatro rotas precisam exatamente do mesmo
 * documento: o `/relatorio` (F2-07), a página por id, a janela e a revisão.
 * Duplicar a montagem em cada rota criaria quatro lugares onde o número
 * mostrado pode divergir, e a divergência entre "o que o Telegram mandou" e
 * "o que a página mostra" é exatamente o defeito que o snapshot existe para
 * impedir.
 *
 * As dimensões vêm dos SPLITS da F2-03 com os MESMOS filtros combináveis do
 * relatório; nenhum número desta resposta é calculado aqui.
 */
function compose(
  record: ReportSnapshotRecord,
  revisions: ReportSnapshotRecord[],
  splits: BreakdownSource,
): ReportSnapshotPayload {
  return reportSnapshotSchema.parse({
    snapshot: refOf(record),
    metrics: reportMetricsSchema.parse(record.metrics),
    narrative: record.narrative,
    breakdown: splits.dimensions
      .filter((dimension) => BREAKDOWN_DIMENSIONS.has(dimension.id))
      .flatMap((dimension) =>
        dimension.rows.map((row) => ({
          id: dimension.id,
          label: dimension.label,
          labelKey: row.label,
          bets: row.metrics.bets,
          profit: row.metrics.profit,
          lowSample: row.lowSample,
        })),
      ),
    // Só as versões do MESMO par (período, janela) são a revisão daquele
    // relatório; o histórico completo fica em `/report-snapshots/history`.
    revisions: revisions
      .filter((item) => item.from === record.from && item.to === record.to)
      .map(refOf),
    empty: false,
  });
}

/** Resposta da janela sem dados: `empty: true` e nenhum documento congelado. */
function composeEmpty(query: z.infer<typeof windowQuery>): ReportSnapshotPayload {
  return reportSnapshotSchema.parse({
    snapshot: reportSnapshotRefSchema.parse({
      // UUID sentinela reservado: não existe no banco e não pode ser gerado
      // por `gen_random_uuid()`, então um cliente que o receba nunca o
      // confundiria com um relatório real.
      id: '00000000-0000-4000-8000-000000000000',
      // A versão é 1 (e não 0) porque o CONTRATO exige inteiro positivo, e o
      // cliente compara versões para ordenar a revisão: um 0 aqui quebraria a
      // ordenação. O sinal de "sem dados" é `empty`, e o `latest: true` impede
      // que a janela pareça "aguardando revisão" de um documento que não existe.
      version: 1,
      period: query.period,
      from: query.from,
      to: query.to,
      financialVersion: 1,
      title: `${query.period} — ${query.from} a ${query.to}`,
      contentSha256: '0'.repeat(64),
      latest: true,
      createdAt: new Date(0).toISOString(),
      requestedBy: null,
      revisionReason: null,
    }),
    metrics: reportMetricsSchema.parse(EMPTY_METRICS),
    narrative: { lines: [], lowSample: true, minSample: 0 },
    breakdown: [],
    revisions: [],
    empty: true,
  });
}

export function registerReportSnapshotRoutes(
  app: FastifyInstance,
  auth: OwnerAuth | undefined,
  service: ReportSnapshotService | undefined,
  reports: ReportServiceBase | undefined,
) {
  const contexts = new WeakMap<FastifyRequest, OrganizationContext>();
  const errors = {
    400: apiErrorSchema,
    401: apiErrorSchema,
    403: apiErrorSchema,
    404: apiErrorSchema,
    409: apiErrorSchema,
    503: apiErrorSchema,
    default: apiErrorSchema,
  };
  const common = { tags: ['Relatórios'], security: ownerSessionSecurity };
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!auth) return sendApiError(request, reply, 503, 'AUTH_NOT_CONFIGURED');
    const owner = await auth.getOwner(fromNodeHeaders({ cookie: request.headers.cookie }));
    if (!owner) return sendApiError(request, reply, 401, 'UNAUTHENTICATED');
    if (owner.status === 'consent_required')
      return sendApiError(request, reply, 403, 'CONSENT_REQUIRED');
    if (!service || !reports)
      return sendApiError(request, reply, 503, 'REPORT_SERVICE_UNAVAILABLE');
    // O contexto vem do SERVIÇO DE RELATÓRIO que já existe — o mesmo que
    // provisiona o espaço financeiro do usuário. É o mesmo contexto canônico
    // da tela de análises e do `/relatorio`, e não uma segunda resolução.
    contexts.set(request, await reports.ensureContext(owner.user.id));
  };
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await action());
    } catch (error) {
      if (error instanceof ReportSnapshotError) {
        // 404 para o que não existe (ou não tem dados), 409 para o que existe
        // mas não pode mudar de estado, e 400 para uma janela que o serviço de
        // relatório recusa (intervalo impossível). `REPORT_SNAPSHOT_INVALID` é
        // a forma que assume uma entrada que passou pelo schema e foi
        // recusada pelo relatório — erro do pedido, não do servidor.
        if (error.code === 'REPORT_SNAPSHOT_INVALID')
          return sendApiError(request, reply, 400, 'INVALID_REQUEST');
        const status =
          error.code === 'REPORT_SNAPSHOT_NOT_FOUND' || error.code === 'REPORT_SNAPSHOT_NO_DATA'
            ? 404
            : error.code === 'REPORT_SNAPSHOT_NOT_REVISABLE'
              ? 409
              : 400;
        return sendApiError(request, reply, status, error.code);
      }
      throw error;
    }
  };
  /** Monta o documento da página a partir de um snapshot já existente. */
  const page = async (context: OrganizationContext, record: ReportSnapshotRecord) =>
    compose(
      record,
      await service!.history(context, { period: record.period, limit: 20 }),
      (await reports!.splits(context, {
        from: record.from,
        to: record.to,
        kind: 'all',
        includeEstimated: 'false',
      })) as unknown as BreakdownSource,
    );

  /** A página: o snapshot pedido, com narrativa, versões e comparação. */
  app.get(
    '/api/v1/report-snapshots/:id',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'getReportSnapshot',
        summary: 'Abrir um relatório privado congelado com narrativa e versões',
        params: idParams,
        response: { 200: reportSnapshotSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const context = contexts.get(request)!;
        const { id } = idParams.parse(request.params);
        const record = await service!.find(context, id);
        // Id inexistente e id de outra organização são a MESMA resposta: é
        // essa indistinção que impede sondar a existência de um relatório
        // alheio testando ids.
        if (!record) throw new ReportSnapshotError('REPORT_SNAPSHOT_NOT_FOUND');
        return page(context, record);
      }),
  );

  /**
   * A página de uma JANELA, sem id. Gera o snapshot se ele ainda não existir —
   * é o que faz o `/relatorio` (F2-07) e a aba da página mostrarem o MESMO
   * documento. Janela sem apostas devolve `empty: true` e nada é congelado:
   * sem dados não se publica.
   */
  app.get(
    '/api/v1/report-snapshots',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'ensureReportSnapshot',
        summary: 'Gerar ou ler o relatório congelado de uma janela do período',
        querystring: windowQuery,
        response: { 200: reportSnapshotSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const context = contexts.get(request)!;
        const query = windowQuery.parse(request.query);
        const record = await service!.ensure(context, {
          period: query.period,
          from: query.from,
          to: query.to,
          // `requestedBy` fica gravado: a auditoria sabe se o documento veio
          // de um comando do usuário ou do job de cadência, sem precisar
          // inferir pelo horário.
          requestedBy: context.userId === 'system:worker' ? null : context.userId,
        });
        if (!record) return composeEmpty(query);
        return page(context, record);
      }),
  );

  /** O histórico do tenant, para a aba "relatórios" da página privada. */
  app.get(
    '/api/v1/report-snapshots/history',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'listReportSnapshots',
        summary: 'Consultar os relatórios congelados do período',
        querystring: historyQuery,
        response: { 200: reportSnapshotListSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const context = contexts.get(request)!;
        const query = historyQuery.parse(request.query);
        const items = await service!.history(context, {
          ...(query.period ? { period: query.period } : {}),
          limit: query.limit,
        });
        return reportSnapshotListSchema.parse({ items: items.map(refOf) });
      }),
  );

  /**
   * REVISÃO sob demanda. A correção de um dado muda o relatório de hoje, mas
   * não reescreve o que já foi publicado: esta rota cria a VERSÃO 2 ao lado da
   * 1, com o motivo da revisão, e o banco recusa qualquer tentativa de UPDATE
   * no snapshot antigo (trigger `immutable_report_snapshot`).
   *
   * Não há reenvio automático: revisar guarda a versão nova, e quem a envia é
   * o job de cadência, no horário e no fuso do usuário. Reenvio imediato é
   * escopo excluído do card.
   */
  app.post(
    '/api/v1/report-snapshots/:id/revisions',
    {
      onRequest: authorize,
      schema: {
        ...common,
        operationId: 'reviseReportSnapshot',
        summary: 'Criar uma versão revisada do relatório mantendo a anterior intacta',
        params: idParams,
        body: reportRevisionInputSchema,
        response: { 200: reportSnapshotSchema, ...errors },
      },
    },
    (request, reply) =>
      execute(request, reply, async () => {
        const context = contexts.get(request)!;
        const { id } = idParams.parse(request.params);
        const body = reportRevisionInputSchema.parse(request.body);
        return page(context, await service!.revise(context, { id, reason: body.reason }));
      }),
  );
}
