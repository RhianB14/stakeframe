import { createHash } from 'node:crypto';
import {
  buildReportNarrative,
  reportDeliveryKey,
  reportHasData,
  reportPeriodTitle,
  reportWindow,
  reportNarrativeSchema,
  reportMetricsSchema,
  analyticsDashboardSchema,
  type AnalyticsDashboard,
  type ReportMetrics,
  type ReportPeriod,
  type ReportNarrative,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { createTenantContext, type OrganizationContext } from './tenant-context.js';
import { createReportService } from './reports.js';
import { createEntitlementService } from './entitlements.js';
import { createFreebetService, DEFAULT_TIMEZONE } from './freebets.js';
import type { Database } from './index.js';

// STK-F2-08 — snapshots de relatório IMUTÁVEIS, revisão versionada e
// deduplicação de envio.
//
// Este serviço é uma CAMADA sobre o serviço de relatório que já existe
// (`createReportService`, F2-02/F2-03). Ele não reconstrói nenhuma agregação:
// `dashboard` e `splits` são os MESMOS métodos que a tela de análises e o
// `/hoje` da F2-07 já chamam, sobre os MESMOS filtros. O que este arquivo
// acrescenta é tempo:
//
//  - CONGELA o resultado num snapshot com hash, o que torna auditável a
//    afirmação "na terça-feira o relatório dizia X";
//  - VERSIONA a correção: um dado corrigido não reescreve o que foi publicado,
//    ele produz uma versão nova, e o banco recusa o UPDATE de qualquer jeito
//    (trigger `immutable_report_snapshot`);
//  - DEDUPLICA o envio por (janela × versão financeira), de modo que rodar o
//    job cinco vezes no dia envie um relatório e não cinco.
//
// E os três preservam o que o resto do produto já faz: a organização vem do
// contexto autenticado ou do registry de tenants, nunca do payload; o serviço
// de relatório continua sendo quem aplica RLS; e nada aqui envia nada — o
// envio é do worker, e ele só recebe a decisão.

const ORG = `current_setting($$app.organization_id$$, true)::uuid`;

export type ReportSnapshotErrorCode =
  | 'REPORT_SNAPSHOT_NOT_FOUND'
  | 'REPORT_SNAPSHOT_NOT_REVISABLE'
  | 'REPORT_SNAPSHOT_NO_DATA'
  | 'REPORT_SNAPSHOT_INVALID';

export class ReportSnapshotError extends Error {
  constructor(public readonly code: ReportSnapshotErrorCode) {
    super(code);
    this.name = 'ReportSnapshotError';
  }
}

export type ReportSnapshotRecord = {
  id: string;
  version: number;
  period: ReportPeriod;
  from: string;
  to: string;
  financialVersion: number;
  metrics: ReportMetrics;
  dashboard: AnalyticsDashboard;
  narrative: ReportNarrative;
  title: string;
  contentSha256: string;
  requestedBy: string | null;
  revisionReason: string | null;
  createdAt: string;
  /** `true` quando existe uma versão posterior: a atual é a última do período. */
  latest: boolean;
};

type SnapshotRow = {
  id: string;
  version: number;
  period: ReportPeriod;
  from: string;
  to: string;
  financial_version: number;
  metrics: unknown;
  payload: unknown;
  content_sha256: string;
  requested_by: string | null;
  revision_reason: string | null;
  created_at: Date;
  latest: boolean;
};

/**
 * Hash do conteúdo publicado.
 *
 * O SHA-256 é sobre a FORMA CANÔNICA do payload (chaves ordenadas), não sobre
 * `JSON.stringify` do objeto: a ordem das chaves do parser muda entre
 * versões do Node e um snapshot que "muda de hash" sem mudar de número seria
 * um falso positivo de auditoria. Como o payload é gerado por nós com um
 * número fixo de chaves, a forma canônica é estável por construção.
 */
export function snapshotContentHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * O que fica GRAVADO quando o envio falha: um CÓDIGO, nunca a mensagem.
 *
 * A resposta do Telegram pode carregar texto que não pertence ao repositório
 * (e um erro de driver pode carregar o DSN). A auditoria precisa saber que
 * falhou e por qual classe; o detalhe pertence ao log sanitizado, não à fila.
 */
export function sanitizeReportDeliveryError(error: unknown): string {
  // `TelegramOperationError` traz o código na própria `message`, e ele já é
  // SCREAMING_SNAKE estável; qualquer outra coisa (erro de driver com DSN,
  // exceção do pg) vira o código genérico.
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,60}$/.test(error.message)) return error.message;
  return 'REPORT_DELIVERY_FAILED';
}

/**
 * Magnitude de um valor monetário em centavos, sem sinal.
 *
 * Comparar resultados por módulo é a operação que a narrativa e a página
 * precisam: numa janela negativa, a casa com o MAIOR resultado (`-10.00` < `-
 * 2.00` em ordem numérica) é a de menor perda, e ordenar por valor mostraria
 * a dimensão que menos importa. O dinheiro é `bigint` (nunca float) e o
 * `reportMoneySchema` já garante duas casas.
 */
function magnitudeOf(value: string): bigint {
  const scaled = BigInt(value.replace('.', ''));
  return scaled < 0n ? -scaled : scaled;
}

export function createReportSnapshotService(database: Database) {
  const tenant = createTenantContext(database);
  const reports = createReportService(database);
  // A F2-13 é a FONTE do plano, e ela é lida do banco — o serviço existe aqui
  // para que a página e o job leiam a MESMA resolução, e não porque o
  // snapshot decida permissão (ele não decide: ele usa o que a F2-13 devolve).
  const entitlements = createEntitlementService(database);

  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });
  const write = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action);

  /**
   * Os números que viram snapshot: o DASHBOARD da F2-02 (mesma agregação,
   * mesma política de baixa amostra) e os SPLITS da F2-03, para a página ter
   * a comparação por casa, esporte e tipster. Ambos usam os filtros
   * combináveis já existentes — nada aqui reconstrói SQL.
   */
  async function collect(
    context: OrganizationContext,
    period: ReportPeriod,
    from: string,
    to: string,
  ): Promise<{ dashboard: AnalyticsDashboard; narrative: ReportNarrative }> {
    const query = { from, to, kind: 'all', includeEstimated: 'false' } as const;
    const dashboard = await reports.dashboard(context, query);
    const splits = await reports.splits(context, query);
    // A dimensão com maior resultado em MAGNITUDE: numa janela negativa, a
    // casa que mais perdeu é a que o usuário precisa ver, e "maior" em módulo
    // captura isso. A mesma ordenação por módulo já é a do relatório (§3.8).
    const byMagnitude = (a: { metrics: ReportMetrics }, b: { metrics: ReportMetrics }) =>
      magnitudeOf(b.metrics.profit) > magnitudeOf(a.metrics.profit) ? 1 : -1;
    const topBookmaker = splits.dimensions
      .find((dimension) => dimension.id === 'bookmaker')
      ?.rows.sort(byMagnitude)[0];
    const topSport = splits.dimensions
      .find((dimension) => dimension.id === 'sport')
      ?.rows.sort(byMagnitude)[0];
    const narrative = buildReportNarrative({
      metrics: dashboard.metrics,
      minSample: dashboard.minSample,
      periodLabel: reportPeriodTitle(period, from, to),
      topBookmaker: topBookmaker
        ? { label: topBookmaker.label, profit: topBookmaker.metrics.profit }
        : null,
      topSport: topSport ? { label: topSport.label, profit: topSport.metrics.profit } : null,
    });
    return { dashboard, narrative };
  }

  function recordOf(row: SnapshotRow, period: ReportPeriod): ReportSnapshotRecord {
    return {
      id: row.id,
      version: row.version,
      period: row.period,
      from: row.from,
      to: row.to,
      financialVersion: row.financial_version,
      metrics: reportMetricsSchema.parse(row.metrics),
      dashboard: analyticsDashboardSchema.parse((row.payload as { dashboard: unknown }).dashboard),
      narrative: reportNarrativeSchema.parse((row.payload as { narrative: unknown }).narrative),
      title: reportPeriodTitle(period, row.from, row.to),
      contentSha256: row.content_sha256,
      requestedBy: row.requested_by,
      revisionReason: row.revision_reason,
      createdAt: row.created_at.toISOString(),
      latest: row.latest,
    };
  }

  const selectSnapshot = `
    select s.id,s.version,s.period,s."from"::text as "from",s."to"::text as "to",
      s.financial_version,s.metrics,s.payload,s.content_sha256,s.requested_by,s.revision_reason,
      s.created_at,
      (s.version = (select max(v.version) from integration.report_snapshot v
        where v.organization_id=s.organization_id and v.period=s.period
          and v."from"=s."from" and v."to"=s."to")) as latest
    from integration.report_snapshot s
    where s.organization_id=${ORG}`;

  /**
   * GERA e INSERE uma versão do snapshot.
   *
   * O `ON CONFLICT` de `ensure` precisa devolver a linha vencedora: o
   * `DO NOTHING` devolveria zero linhas numa colisão, o que o chamador não
   distinguiria de "não existe". Por isso a colisão faz `DO UPDATE SET id =
   * report_snapshot.id`, devolvendo o snapshot já publicado no `RETURNING` — o
   * job reenfileira o documento existente, nunca um duplicado.
   *
   * `revise` grava a PRÓXIMA versão, que por construção não colide: se
   * colidir, é porque duas revisões correram em paralelo, e aí o banco recusa
   * (é a garantia de que não existem duas linhas com a mesma versão).
   */
  async function generate(
    context: OrganizationContext,
    input: {
      period: ReportPeriod;
      from: string;
      to: string;
      requestedBy: string | null;
      revisionReason: string | null;
      version: number;
    },
  ): Promise<SnapshotRow | null> {
    const collected = await collect(context, input.period, input.from, input.to);
    // SEM DADOS, NÃO SE CONGELA. A decisão vem do mesmo `reportHasData` que a
    // página e o job usam, e ela acontece ANTES do INSERT: um relatório sem
    // apostas é a afirmação "você apostou e perdeu zero", que é uma leitura
    // errada do número, e apagar depois não é opção — o snapshot é imutável
    // por trigger.
    if (!reportHasData(collected.dashboard.metrics)) return null;
    const payload = { dashboard: collected.dashboard, narrative: collected.narrative };
    const hash = snapshotContentHash({
      ...payload,
      financialVersion: collected.dashboard.version,
    });
    // A versão financeira do snapshot é a MESMA que o dashboard leu: os dois
    // vêm da mesma transação de leitura, então o número publicado e a versão
    // gravada descrevem o mesmo estado do financeiro. Gravar uma versão
    // diferente da que gerou o número seria um registro que não prova nada.
    const inserted = await write(context, async (client) => {
      const result = await client.query<{
        id: string;
        version: number;
        period: ReportPeriod;
        from: string;
        to: string;
        financial_version: number;
        metrics: unknown;
        payload: unknown;
        content_sha256: string;
        requested_by: string | null;
        revision_reason: string | null;
        created_at: Date;
      }>(
        `insert into integration.report_snapshot
           (organization_id,version,period,"from","to",financial_version,metrics,payload,
            content_sha256,requested_by,revision_reason)
         values(${ORG},$1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10)
         on conflict (organization_id,period,"from","to",version)
           do update set id = integration.report_snapshot.id
         returning id,version,period,"from"::text as "from","to"::text as "to",financial_version,
           metrics,payload,content_sha256,requested_by,revision_reason,created_at`,
        [
          input.version,
          input.period,
          input.from,
          input.to,
          collected.dashboard.version,
          JSON.stringify(collected.dashboard.metrics),
          JSON.stringify(payload),
          hash,
          input.requestedBy,
          input.revisionReason,
        ],
      );
      return result.rows[0];
    });
    if (!inserted) return null;
    // O `latest` é derivado: a revisão acaba de ser a maior versão do período,
    // então consultamos a janela uma vez para saber se há posterior.
    return { ...inserted, latest: true };
  }

  /**
   * Snapshot da janela, gerado se ainda não existir. `null` = sem dados.
   *
   * É o caminho do comando `/relatorio` (F2-07), da página privada e do job de
   * cadência — os três leem o MESMO snapshot, e é por isso que o número que o
   * Telegram mandou e o número que a página mostra não podem divergir.
   *
   * Um relatório sem apostas NÃO gera snapshot e devolve `null`: sem dados não
   * se publica (o card), e um P&L zero leria como "apostou e perdeu nada", que
   * é uma leitura errada do número.
   */
  async function ensure(
    context: OrganizationContext,
    input: { period: ReportPeriod; from: string; to: string; requestedBy?: string | null },
  ): Promise<ReportSnapshotRecord | null> {
    const existing = (await read(
      context,
      async (client) =>
        (
          await client.query<SnapshotRow>(
            `${selectSnapshot}
             and s.period=$1 and s."from"=$2::date and s."to"=$3::date
             order by s.version desc limit 1`,
            [input.period, input.from, input.to],
          )
        ).rows[0],
    )) as SnapshotRow | undefined;
    if (existing) return recordOf(existing, input.period);
    // A AUSÊNCIA É VERIFICADA ANTES DE GRAVAR. Sem apostas, `generate` não
    // produz linha nenhuma (a checagem é feita sobre o dashboard, e o INSERT só
    // acontece quando há o que congelar) — publicar primeiro e apagar depois
    // seria impossível aqui, porque o snapshot é IMUTÁVEL por trigger.
    const created = await generate(context, {
      period: input.period,
      from: input.from,
      to: input.to,
      requestedBy: input.requestedBy ?? null,
      revisionReason: null,
      version: 1,
    });
    if (!created) return null;
    return recordOf(created, input.period);
  }

  return {
    reports,
    entitlements,
    ensure,

    async revise(
      context: OrganizationContext,
      input: { id: string; reason: string },
    ): Promise<ReportSnapshotRecord> {
      const reason = input.reason.trim();
      if (!reason || reason.length > 200) throw new ReportSnapshotError('REPORT_SNAPSHOT_INVALID');
      const current = (await read(
        context,
        async (client) =>
          (await client.query<SnapshotRow>(`${selectSnapshot} and s.id=$1::uuid`, [input.id]))
            .rows[0],
      )) as SnapshotRow | undefined;
      if (!current) throw new ReportSnapshotError('REPORT_SNAPSHOT_NOT_FOUND');
      if (!current.latest)
        // Revisar uma versão que não é a última criaria duas linhas com a
        // mesma (janela, versão) e a chave de revisão recusaria a segunda —
        // mas o erro seria opaco. A recusa aqui diz o que aconteceu.
        throw new ReportSnapshotError('REPORT_SNAPSHOT_NOT_REVISABLE');
      // A revisão é uma NOVA versão do MESMO par (período, janela): o número
      // antigo continua intacto e continua auditável, e o novo entra ao lado.
      const created = await generate(context, {
        period: current.period,
        from: current.from,
        to: current.to,
        requestedBy: null,
        revisionReason: reason,
        version: current.version + 1,
      });
      // `null` aqui é a única forma de `generate` não produzir linha: a janela
      // ficou sem apostas (o usuário corrigiu tudo para pendente). Não existe
      // documento revisado de um período sem dados, e dizer isso é melhor que
      // devolver a versão 1 como se fosse a nova.
      if (!created) throw new ReportSnapshotError('REPORT_SNAPSHOT_NO_DATA');
      return recordOf(created, current.period);
    },

    async find(context: OrganizationContext, id: string): Promise<ReportSnapshotRecord | null> {
      const row = (await read(
        context,
        async (client) =>
          (await client.query<SnapshotRow>(`${selectSnapshot} and s.id=$1::uuid`, [id])).rows[0],
      )) as SnapshotRow | undefined;
      return row ? recordOf(row, row.period) : null;
    },

    async history(
      context: OrganizationContext,
      filter: { period?: ReportPeriod; limit?: number },
    ): Promise<ReportSnapshotRecord[]> {
      const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
      const rows = await read(context, async (client) =>
        client
          .query<SnapshotRow>(
            `${selectSnapshot}
           and ($1::text is null or s.period=$1)
           order by s.created_at desc, s.version desc limit $2`,
            [filter.period ?? null, limit],
          )
          .then((result) => result.rows),
      );
      return rows.map((row) => recordOf(row, row.period));
    },

    async deliveryOf(
      context: OrganizationContext,
      input: { period: ReportPeriod; from: string; to: string; financialVersion: number },
    ): Promise<{ state: string; deliveredAt: string | null; snapshotId: string } | null> {
      const row = await read(context, async (client) =>
        client
          .query<{ state: string; delivered_at: Date | null; snapshot_id: string }>(
            `select state,delivered_at,snapshot_id from integration.report_delivery
             where organization_id=${ORG} and period=$1 and "from"=$2::date and "to"=$3::date
               and financial_version=$4
             limit 1`,
            [input.period, input.from, input.to, input.financialVersion],
          )
          .then((result) => result.rows[0]),
      );
      return row
        ? {
            state: row.state,
            deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
            snapshotId: row.snapshot_id,
          }
        : null;
    },

    async reserveDelivery(
      context: OrganizationContext,
      input: { snapshot: ReportSnapshotRecord; userId: string; scheduledFor: Date },
    ): Promise<{ id: string; dedupeKey: string } | null> {
      const key = reportDeliveryKey(
        context.organizationId,
        input.snapshot.period,
        input.snapshot.from,
        input.snapshot.to,
        input.snapshot.financialVersion,
      );
      const row = await write(context, async (client) =>
        client
          .query<{ id: string; dedupe_key: string }>(
            `insert into integration.report_delivery
               (organization_id,snapshot_id,period,"from","to",financial_version,dedupe_key,
                user_id,scheduled_for)
             values(${ORG},$1,$2,$3::date,$4::date,$5,$6,$7,$8)
             on conflict (organization_id,dedupe_key) do nothing
             returning id,dedupe_key`,
            [
              input.snapshot.id,
              input.snapshot.period,
              input.snapshot.from,
              input.snapshot.to,
              input.snapshot.financialVersion,
              key,
              input.userId,
              input.scheduledFor,
            ],
          )
          .then((result) => result.rows[0]),
      );
      return row ? { id: row.id, dedupeKey: row.dedupe_key } : null;
    },

    async completeDelivery(
      context: OrganizationContext,
      id: string,
      outcome: { delivered: true } | { failed: string },
    ): Promise<void> {
      await write(context, async (client) => {
        if ('delivered' in outcome) {
          await client.query(
            `update integration.report_delivery
             set state='delivered',attempts=attempts+1,delivered_at=now(),last_error=null,updated_at=now()
             where organization_id=${ORG} and id=$1 and state='pending'`,
            [id],
          );
          return;
        }
        // A entrega que falha volta para `pending` com backoff. Marcar como
        // entregue sem ter entregado seria o pior resultado possível: o
        // relatório sumiria do canal e ninguém poderia saber que faltou.
        const row = (
          await client.query<{ attempts: number }>(
            `select attempts from integration.report_delivery
             where organization_id=${ORG} and id=$1 and state='pending'`,
            [id],
          )
        ).rows[0];
        if (!row) return;
        const code = 'failed' in outcome ? outcome.failed : 'REPORT_DELIVERY_FAILED';
        const exhausted = row.attempts >= 4;
        if (exhausted) {
          await client.query(
            `update integration.report_delivery
             set state='failed',last_error=$2,attempts=attempts+1,updated_at=now()
             where organization_id=${ORG} and id=$1`,
            [id, code],
          );
          return;
        }
        const backoff = Math.min(60 * 2 ** row.attempts, 900);
        await client.query(
          `update integration.report_delivery
           set state='pending',last_error=$2,attempts=attempts+1,updated_at=now(),
               scheduled_for=now()+($3::int * interval '1 second')
           where organization_id=${ORG} and id=$1`,
          [id, code, backoff],
        );
      });
    },

    async due(
      context: OrganizationContext,
      input: { periods: readonly ReportPeriod[]; timezone: string; now: Date },
    ): Promise<
      { period: ReportPeriod; from: string; to: string; snapshot: ReportSnapshotRecord }[]
    > {
      const out: {
        period: ReportPeriod;
        from: string;
        to: string;
        snapshot: ReportSnapshotRecord;
      }[] = [];
      for (const period of input.periods) {
        const window = reportWindow(period, input.now, input.timezone);
        const snapshot = await ensure(context, {
          period,
          from: window.from,
          to: window.to,
          requestedBy: null,
        });
        if (!snapshot) continue;
        // A dedupe é consultada ANTES de reservar: um relatório já enviado
        // nesta janela/versão não volta a ser enviado, e o job pode rodar
        // quantas vezes quiser.
        const delivered = await read(context, async (client) =>
          client
            .query<{ state: string }>(
              `select state from integration.report_delivery
               where organization_id=${ORG} and period=$1 and "from"=$2::date and "to"=$3::date
                 and financial_version=$4
               limit 1`,
              [period, window.from, window.to, snapshot.financialVersion],
            )
            .then((result) => result.rows[0]),
        );
        if (delivered && delivered.state !== 'failed') continue;
        out.push({ period, from: window.from, to: window.to, snapshot });
      }
      return out;
    },

    async recordEmptyWindow(
      context: OrganizationContext,
      input: { period: ReportPeriod; from: string; to: string; financialVersion: number },
    ): Promise<void> {
      // A janela vazia é registrada para que o job não reavalie a mesma
      // ausência a cada passe. Não há snapshot (não há número para
      // congelar); o registro é a marca de "já olhei e não havia dados".
      await write(context, async (client) => {
        await client.query(
          `insert into integration.report_delivery
             (organization_id,snapshot_id,period,"from","to",financial_version,dedupe_key,
              user_id,state,scheduled_for)
           select ${ORG},s.id,$1,$2::date,$3::date,$4,
             'report-empty:'||$1||':'||$2||':'||$3||':'||$4,
             $5,'skipped_no_data',now()
             from integration.report_snapshot s
            where s.organization_id=${ORG} and s.period=$1 and s."from"=$2::date
              and s."to"=$3::date and s.financial_version=$4
           on conflict (organization_id,dedupe_key) do nothing`,
          [input.period, input.from, input.to, input.financialVersion, context.userId],
        );
      });
    },
  };
}

/** Fuso do usuário, com o padrão explícito do produto quando não há preferência. */
export async function reportTimezoneOf(
  database: Database,
  context: OrganizationContext,
  userId: string,
): Promise<string> {
  return (await createFreebetService(database).preferences(context, userId)).timezone;
}

export type ReportSnapshotService = ReturnType<typeof createReportSnapshotService>;

export { DEFAULT_TIMEZONE };
