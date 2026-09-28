import { Readable } from 'node:stream';
import {
  reportSchema,
  reportMetricsSchema,
  reportBetPageSchema,
  reportOptionsSchema,
  reportQuerySchema,
  reportDetailQuerySchema,
  analyticsDashboardSchema,
  analyticsSplitsSchema,
  type ReportQuery,
  type ReportDetailQuery,
  type AnalyticsDashboard,
  type AnalyticsSplits,
  type AnalyticsSplitRow,
  type AnalyticsSplitDimension,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import {
  createTenantContext,
  ORGANIZATION_CONTEXT_SETTING,
  type OrganizationContext,
} from './tenant-context.js';
import {
  reportRange,
  reportPopulation,
  reportValues,
  reportMetricsSql,
  reportBetSql,
  splitDimensions,
  splitDimensionSql,
} from './report-query.js';
import { FinanceError } from './finance-core.js';
import { exportPortabilityJson } from './report-export.js';
import { createTtlCache } from './ttl-cache.js';

export type ReportServiceOptions = {
  /** STK-F2-02: N mínimo para leitura confiável (env `DASHBOARD_MIN_SAMPLE`). */
  dashboardMinSample?: number;
  /** STK-F2-02: TTL do cache do dashboard; `0` desliga (env `DASHBOARD_CACHE_TTL_MS`). */
  dashboardCacheTtlMs?: number;
};
const DEFAULT_DASHBOARD_MIN_SAMPLE = 30;
const DEFAULT_DASHBOARD_CACHE_TTL_MS = 30_000;
function readDashboardOptions(options: ReportServiceOptions) {
  const minSample = options.dashboardMinSample ?? DEFAULT_DASHBOARD_MIN_SAMPLE;
  const cacheTtlMs = options.dashboardCacheTtlMs ?? DEFAULT_DASHBOARD_CACHE_TTL_MS;
  if (!Number.isInteger(minSample) || minSample < 1 || minSample > 100_000)
    throw new Error('INVALID_DASHBOARD_MIN_SAMPLE');
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 600_000)
    throw new Error('INVALID_DASHBOARD_CACHE_TTL');
  return { minSample, cacheTtlMs };
}

export function csvCell(value: unknown, numeric = false) {
  let text = String(value ?? '');
  // Spreadsheet programs may ignore leading whitespace/control bytes before formulas.
  // eslint-disable-next-line no-control-regex
  if (!numeric && /^[\s\u0000-\u001f]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createReportService(database: Database, options: ReportServiceOptions = {}) {
  const dashboard = readDashboardOptions(options);
  // STK-F2-02: cache curto por organização + versão + filtros. A versão na
  // chave invalida o cache a cada movimentação financeira; o TTL cobre o resto.
  const dashboardCache = createTtlCache<AnalyticsDashboard>({ ttlMs: dashboard.cacheTtlMs });
  // STK-F2-03: cache próprio dos splits — mesma utilidade e mesmo TTL do
  // dashboard, chave separada para os dois payloads nunca colidirem.
  const splitsCache = createTtlCache<AnalyticsSplits>({ ttlMs: dashboard.cacheTtlMs });
  let activeExports = 0;
  const tenant = createTenantContext(database);
  /**
   * Repeatable read (with the organization context) — deliberately NOT read only: a read-only
   * transaction rejects `set_config`, and every statement here must see the RLS context.
   */
  const read = <T>(context: OrganizationContext, action: (client: PoolClient) => Promise<T>) =>
    tenant.withOrganizationTransaction(context, action, { isolation: 'repeatable read' });
  async function metrics(client: PoolClient, query: ReportQuery) {
    return reportMetricsSchema.parse(
      (
        await client.query(
          `${reportPopulation} select ${reportMetricsSql} from eligible`,
          reportValues(query),
        )
      ).rows[0],
    );
  }
  return {
    /** Returns the authenticated user's organization context (provisioning on first use). */
    ensureContext(userId: string) {
      return tenant.ensureOrganizationMembership(userId);
    },
    async report(context: OrganizationContext, input: ReportQuery) {
      const query = reportQuerySchema.parse(input);
      const range = reportRange(query);
      return read(context, async (client) => {
        const version = (
          await client.query(
            'select version from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
          )
        ).rows[0].version;
        const current = await metrics(client, query);
        const previous = await metrics(client, {
          ...query,
          from: range.previousFrom,
          to: range.previousTo,
        });
        const exclusions = (
          await client.query(
            `${reportPopulation} select
          count(*) filter(where event_date is null)::int as "unknownDateBets",
          count(*) filter(where event_date between $1::date and $2::date and not confirmed and not $8::boolean)::int as "estimatedDateBets"
          from population`,
            reportValues(query),
          )
        ).rows[0];
        const timelineRows = (
          await client.query(
            `${reportPopulation}
          select date_trunc('${range.granularity}',event_date)::date::text date, ${reportMetricsSql}
          from eligible group by 1 order by 1`,
            reportValues(query),
          )
        ).rows;
        const empty = reportMetricsSchema.parse(
          (
            await client.query(
              `${reportPopulation} select ${reportMetricsSql} from eligible where false`,
              reportValues(query),
            )
          ).rows[0],
        );
        const byDate = new Map(
          timelineRows.map((row) => [row.date, reportMetricsSchema.parse(row)]),
        );
        const timeline = [];
        const date = new Date(
          `${range.granularity === 'month' ? query.from.slice(0, 7) + '-01' : query.from}T00:00:00Z`,
        );
        while (date.getTime() <= Date.parse(`${query.to}T00:00:00Z`)) {
          const key = date.toISOString().slice(0, 10);
          timeline.push({ date: key, metrics: byDate.get(key) ?? empty });
          if (range.granularity === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
          else date.setUTCDate(date.getUTCDate() + 1);
        }
        async function breakdown(key: string, label: string) {
          return (
            await client.query(
              `${reportPopulation} select ${key} as key, ${label} as label,
            ${reportMetricsSql} from eligible group by 1,2 order by sum(profit) desc,2,1`,
              reportValues(query),
            )
          ).rows.map((row) => ({
            key: row.key,
            label: row.label,
            metrics: reportMetricsSchema.parse(row),
          }));
        }
        return reportSchema.parse({
          generatedAt: new Date().toISOString(),
          version,
          filters: query,
          dateBasis: 'last_event_sao_paulo',
          granularity: range.granularity,
          metrics: current,
          previous: { from: range.previousFrom, to: range.previousTo, metrics: previous },
          exclusions,
          timeline,
          byBookmaker: await breakdown('bookmaker_id::text', 'bookmaker'),
          byTipster: await breakdown("coalesce(tipster_id::text,'none')", 'tipster'),
          bySport: await breakdown('sport_key', 'sport'),
        });
      });
    },
    /**
     * STK-F2-02 — dashboard analítico: uma única agregação sobre as mesmas
     * consultas indexadas do relatório (sem materialized view), com cache curto
     * em memória. `lowSample` marca N abaixo do limiar configurado; o cliente
     * exibe apenas os números crus nesse caso (Plano §8.5 / §15).
     */
    async dashboard(context: OrganizationContext, input: ReportQuery): Promise<AnalyticsDashboard> {
      const query = reportQuerySchema.parse(input);
      reportRange(query);
      return read(context, async (client) => {
        const version = (
          await client.query(
            'select version from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
          )
        ).rows[0].version;
        const cacheKey = `${context.organizationId}|${version}|${JSON.stringify(query)}`;
        const cached = dashboardCache.get(cacheKey);
        if (cached) return cached;
        const current = await metrics(client, query);
        const payload = analyticsDashboardSchema.parse({
          generatedAt: new Date().toISOString(),
          version,
          filters: query,
          minSample: dashboard.minSample,
          lowSample: current.bets < dashboard.minSample,
          metrics: current,
        });
        dashboardCache.set(cacheKey, payload);
        return payload;
      });
    },
    /**
     * STK-F2-03 — os 12 splits analíticos: uma linha por valor de cada dimensão,
     * com ROI, P&L, yield e `N` juntos, sobre os mesmos filtros combináveis do
     * relatório. `lowSample` é calculado por linha pela regra do dashboard
     * (`N < minSample`); dimensões sem coluna no modelo saem com uma única
     * linha `unknown` (Plano §8.5 / §15). Cache curto por organização + versão
     * + filtros, sem materialized view.
     */
    async splits(context: OrganizationContext, input: ReportQuery): Promise<AnalyticsSplits> {
      const query = reportQuerySchema.parse(input);
      reportRange(query);
      return read(context, async (client) => {
        const version = (
          await client.query(
            'select version from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
          )
        ).rows[0].version;
        const cacheKey = `splits|${context.organizationId}|${version}|${JSON.stringify(query)}`;
        const cached = splitsCache.get(cacheKey);
        if (cached) return cached;
        const overall = await metrics(client, query);
        const dimensions: AnalyticsSplitDimension[] = [];
        for (const definition of splitDimensions) {
          const rows: AnalyticsSplitRow[] = (
            await client.query(splitDimensionSql(definition), reportValues(query))
          ).rows.map((row) => {
            const parsed = reportMetricsSchema.parse(row);
            return {
              key: String(row.key),
              label: String(row.label),
              lowSample: parsed.bets < dashboard.minSample,
              metrics: parsed,
            };
          });
          dimensions.push({
            id: definition.id,
            label: definition.label,
            source: definition.source,
            available: definition.available,
            note: definition.note,
            rows,
          });
        }
        const payload = analyticsSplitsSchema.parse({
          generatedAt: new Date().toISOString(),
          version,
          filters: query,
          minSample: dashboard.minSample,
          lowSample: overall.bets < dashboard.minSample,
          metrics: overall,
          dimensions,
        });
        splitsCache.set(cacheKey, payload);
        return payload;
      });
    },
    async bets(context: OrganizationContext, input: ReportDetailQuery) {
      const query = reportDetailQuerySchema.parse(input);
      reportRange(query);
      return read(context, async (client) => {
        const values = reportValues(query);
        const total = (
          await client.query(`${reportPopulation} select count(*)::int total from eligible`, values)
        ).rows[0].total;
        const items = (
          await client.query(
            `${reportPopulation} select ${reportBetSql} from eligible
          order by event_date desc,id limit $9 offset $10`,
            [...values, query.pageSize, (query.page - 1) * query.pageSize],
          )
        ).rows;
        return reportBetPageSchema.parse({
          items,
          total,
          page: query.page,
          pageSize: query.pageSize,
        });
      });
    },
    async options(context: OrganizationContext) {
      return read(context, async (client) =>
        reportOptionsSchema.parse({
          sports: (
            await client.query(
              `${reportPopulation} select distinct sport_key key,sport label from population order by 2,1`,
              reportValues(reportQuerySchema.parse({ from: '2000-01-01', to: '2100-01-01' })),
            )
          ).rows,
        }),
      );
    },
    async export(kind: 'csv' | 'json', context: OrganizationContext, input?: ReportQuery) {
      const query = input ? reportQuerySchema.parse(input) : undefined;
      if (kind === 'csv' && !query) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      if (query) reportRange(query);
      // One long-lived snapshot per process leaves connections for commands and reads.
      if (activeExports >= 1) throw new FinanceError('STATE_CONFLICT');
      activeExports++;
      let client: PoolClient;
      try {
        client = await database.pool.connect();
      } catch (error) {
        activeExports--;
        throw error;
      }
      try {
        await client.query('begin isolation level repeatable read');
        await client.query('SELECT set_config($1, $2, true)', [
          ORGANIZATION_CONTEXT_SETTING,
          context.organizationId,
        ]);
      } catch (error) {
        activeExports--;
        client.release(true);
        throw error;
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        activeExports--;
        try {
          await client.query('rollback');
          client.release();
        } catch {
          client.release(true);
        }
      };
      async function* content() {
        try {
          if (kind === 'json') {
            const version = (
              await client.query(
                'select version from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
              )
            ).rows[0].version;
            yield JSON.stringify({
              schemaVersion: 1,
              generatedAt: new Date().toISOString(),
              financialVersion: version,
              scope:
                'Structured finance and import history; excludes authentication, credentials and image bytes.',
            }).slice(0, -1);
            yield* exportPortabilityJson(client, ',');
            yield '}';
          } else {
            const columns = [
              'id',
              'reference',
              'eventSummary',
              'eventDate',
              'dateStatus',
              'bookmaker',
              'tipster',
              'sport',
              'state',
              'freebet',
              'stake',
              'remaining',
              'returns',
              'profit',
              'profitUnits',
              'placedAt',
            ];
            const numeric = new Set(['stake', 'remaining', 'returns', 'profit', 'profitUnits']);
            yield '\uFEFF' + columns.map((column) => csvCell(column)).join(',') + '\r\n';
            // Execute the cohort once; FETCH reuses the cursor plan and snapshot
            // instead of aggregating the entire history again for every batch.
            await client.query(
              `declare report_csv no scroll cursor for ${reportPopulation} select ${reportBetSql} from eligible order by event_date desc,id`,
              reportValues(query!),
            );
            for (;;) {
              const rows: Record<string, unknown>[] = (
                await client.query('fetch forward 500 from report_csv')
              ).rows;
              for (const row of rows)
                yield columns.map((column) => csvCell(row[column], numeric.has(column))).join(',') +
                  '\r\n';
              if (rows.length < 500) break;
            }
          }
        } finally {
          await release();
        }
      }
      const stream = Readable.from(content());
      const timer = setTimeout(() => stream.destroy(new Error('EXPORT_TIMEOUT')), 120_000);
      timer.unref();
      stream.once('close', () => {
        clearTimeout(timer);
        void release();
      });
      return stream;
    },
  };
}
export type ReportService = ReturnType<typeof createReportService>;
