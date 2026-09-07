import { Readable } from 'node:stream';
import {
  reportSchema,
  reportMetricsSchema,
  reportBetPageSchema,
  reportOptionsSchema,
  reportQuerySchema,
  reportDetailQuerySchema,
  type ReportQuery,
  type ReportDetailQuery,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import {
  reportRange,
  reportPopulation,
  reportValues,
  reportMetricsSql,
  reportBetSql,
} from './report-query.js';
import { FinanceError } from './finance-core.js';
import { portabilityTables } from './report-export.js';

export function csvCell(value: unknown, numeric = false) {
  let text = String(value ?? '');
  // Spreadsheet programs may ignore leading whitespace/control bytes before formulas.
  // eslint-disable-next-line no-control-regex
  if (!numeric && /^[\s\u0000-\u001f]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createReportService(database: Database) {
  let activeExports = 0;
  async function read<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await database.pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const result = await action(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
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
    async report(input: ReportQuery) {
      const query = reportQuerySchema.parse(input);
      const range = reportRange(query);
      return read(async (client) => {
        const version = (await client.query('select version from finance.settings where id=1'))
          .rows[0].version;
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
    async bets(input: ReportDetailQuery) {
      const query = reportDetailQuerySchema.parse(input);
      reportRange(query);
      return read(async (client) => {
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
    async options() {
      return read(async (client) =>
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
    async export(kind: 'csv' | 'json', input?: ReportQuery) {
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
        await client.query('begin isolation level repeatable read read only');
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
            const version = (await client.query('select version from finance.settings where id=1'))
              .rows[0].version;
            yield JSON.stringify({
              schemaVersion: 1,
              generatedAt: new Date().toISOString(),
              financialVersion: version,
              scope:
                'Structured finance and import history; excludes authentication, credentials and image bytes.',
            }).slice(0, -1);
            for (const table of portabilityTables) {
              yield `,${JSON.stringify(table.name)}:[`;
              let cursor: unknown[] | undefined;
              let first = true;
              for (;;) {
                const where = cursor
                  ? `where (${table.keys.join(',')}) > (${table.keys.map((_, i) => '$' + (i + 1)).join(',')})`
                  : '';
                const rows = (
                  await client.query(
                    `select ${table.columns} from ${table.name} ${where} order by ${table.keys.join(',')} limit 500`,
                    cursor,
                  )
                ).rows;
                for (const row of rows) {
                  yield `${first ? '' : ','}${JSON.stringify(row)}`;
                  first = false;
                }
                if (rows.length < 500) break;
                cursor = table.keys.map((key) => rows.at(-1)![key]);
              }
              yield ']';
            }
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
