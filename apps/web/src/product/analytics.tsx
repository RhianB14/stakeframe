import { displayLocale, formatDisplayMoney } from './preferences.js';
import { dailyLimitStateSchema } from './daily-limit.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
  LabelList,
} from 'recharts';
import {
  analyticsDashboardSchema,
  reportSchema,
  reportBetPageSchema,
  reportOptionsSchema,
  saoPauloDate,
  type Workspace,
  type PerformanceReport,
  type ReportQuery,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';
import type { OpenModal } from './ProductApp.js';
import { betFinancialDisplay } from './financial-display.js';
import { DashboardPanel } from './dashboard.js';
import { readChartTokens } from './chart-tokens.js';
import { SplitsPanel } from './splits.js';

const dayLabel = (date: string) => date.split('-').reverse().join('/');
const units = (value: string | null) =>
  value === null
    ? 'Unidades a conferir'
    : `${value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} u`;
const amount = (value: string) => BigInt(value.replace('.', ''));
const decimal = (value: bigint) =>
  `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const percent = (value: string | null) =>
  value === null ? 'Sem base' : value.replace('.', ',') + '%';
const exactCents = (value: string) => BigInt(value.replace('.', ''));
const signedUnitText = (value: string | null) => {
  if (value === null) return '—';
  const units = Number(value);
  return `${units > 0 ? '+' : units < 0 ? '−' : ''}${Math.abs(units).toFixed(1)} U`;
};
function params(query: ReportQuery) {
  return new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ).toString();
}
function Evolution({ report }: { report: PerformanceReport }) {
  // STK-F2-18 (Fase 4): as cores do gráfico saem da camada de tokens, não de
  // literais no JSX. `stroke` é atributo de apresentação SVG e NÃO resolve
  // custom property — daí resolver o token uma vez e passar a cor concreta.
  const chart = readChartTokens();
  let real = 0n;
  let promo = 0n;
  const series = report.timeline.map((bucket) => {
    real += amount(bucket.metrics.realProfit);
    promo += amount(bucket.metrics.freebetProfit);
    return {
      date: bucket.date,
      real: Number(real) / 100,
      promo: Number(promo) / 100,
      realExact: decimal(real),
      promoExact: decimal(promo),
      period: Number(bucket.metrics.profit),
      periodExact: bucket.metrics.profit,
      bets: bucket.metrics.bets,
    };
  });
  const observed = series.filter((row) => row.bets > 0);
  const sparse = observed.length < 8;
  return (
    <div className="panel report-evolution">
      <div className="section-heading">
        <div>
          <h2>{sparse ? 'Resultado por data de evento' : 'Resultado acumulado no período'}</h2>
          <p>
            Último evento de cada aposta · {report.granularity === 'day' ? 'por dia' : 'por mês'} ·
            em reais
          </p>
        </div>
      </div>
      {observed.length < 4 ? (
        <p className="muted">
          {observed.length === 0
            ? 'Nenhuma aposta com data elegível neste período.'
            : 'Poucas datas com apostas. Confira os valores na tabela abaixo.'}
        </p>
      ) : (
        <div
          className="report-chart"
          role="img"
          aria-label={
            sparse
              ? 'Barras dos resultados por data. Valores completos disponíveis na tabela.'
              : 'Linhas dos resultados acumulados reais e de freebets. Valores completos disponíveis na tabela.'
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            {sparse ? (
              <BarChart data={observed} margin={{ left: 12, right: 12, top: 12, bottom: 8 }}>
                <CartesianGrid stroke={chart['--border']} vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => String(date).slice(5).split('-').reverse().join('/')}
                  stroke={chart['--text-tertiary']}
                />
                <YAxis stroke={chart['--text-tertiary']} width={64} />
                <ReferenceLine y={0} stroke={chart['--border-strong']} />
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="report-tooltip">
                        {dayLabel(payload[0].payload.date)}
                        <br />
                        {formatDisplayMoney(payload[0].payload.periodExact)}
                      </div>
                    ) : null
                  }
                />
                <Bar
                  dataKey="period"
                  name="Resultado"
                  fill={chart['--accent-ink']}
                  isAnimationActive={false}
                />
              </BarChart>
            ) : (
              <LineChart data={series} margin={{ left: 12, right: 12, top: 12, bottom: 8 }}>
                <CartesianGrid stroke={chart['--border']} vertical={false} />
                <XAxis
                  dataKey="date"
                  minTickGap={45}
                  tickFormatter={(date) => String(date).slice(5).split('-').reverse().join('/')}
                  stroke={chart['--text-tertiary']}
                />
                <YAxis stroke={chart['--text-tertiary']} width={64} />
                <ReferenceLine y={0} stroke={chart['--border-strong']} />
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="report-tooltip">
                        {dayLabel(payload[0].payload.date)}
                        <br />
                        Real: {formatDisplayMoney(payload[0].payload.realExact)}
                        <br />
                        Freebets: {formatDisplayMoney(payload[0].payload.promoExact)}
                      </div>
                    ) : null
                  }
                />
                <Legend />
                <Line
                  type="linear"
                  dataKey="real"
                  name="Dinheiro real"
                  stroke={chart['--accent-ink']}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="promo"
                  name="Freebets"
                  stroke={chart['--warn']}
                  strokeDasharray="5 4"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      <details className="report-definitions">
        <summary>Ver valores por {report.granularity === 'day' ? 'dia' : 'mês'}</summary>
        <div className="table-scroll">
          <table className="product-table report-table">
            <caption className="sr-only">
              Resultados exatos por data, inclusive períodos sem movimento
            </caption>
            <thead>
              <tr>
                <th>Data</th>
                <th>Apostas</th>
                <th>Real</th>
                <th>Freebets</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {report.timeline.map((row) => (
                <tr key={row.date}>
                  <td>{dayLabel(row.date)}</td>
                  <td>{row.metrics.bets}</td>
                  <td>{formatDisplayMoney(row.metrics.realProfit)}</td>
                  <td>{formatDisplayMoney(row.metrics.freebetProfit)}</td>
                  <td>{formatDisplayMoney(row.metrics.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** BetTrack presentation for the same account-owned report data. */
export function BetTrackAnalyticsPage({ workspace }: { workspace: Workspace }) {
  const today = saoPauloDate(new Date());
  const month = today.slice(0, 7);
  const monday = new Date(`${today}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const currentWeekStart = monday.toISOString().slice(0, 10);
  const previousMonday = new Date(monday);
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
  const previousWeekStart = previousMonday.toISOString().slice(0, 10);
  const twoWeeksBackDate = new Date(previousMonday);
  twoWeeksBackDate.setUTCDate(twoWeeksBackDate.getUTCDate() - 7);
  const twoWeeksBackStart = twoWeeksBackDate.toISOString().slice(0, 10);
  const lastCompletedDay = new Date(monday);
  lastCompletedDay.setUTCDate(lastCompletedDay.getUTCDate() - 1);
  const lastCompletedDate = lastCompletedDay.toISOString().slice(0, 10);
  const report = useQuery({
    queryKey: ['product', 'overview-report', month, workspace.version],
    queryFn: () => request(`/api/v1/reports?from=${month}-01&to=${today}`, reportSchema),
  });
  const weeklyReport = useQuery({
    queryKey: ['product', 'weekly-net', twoWeeksBackStart, lastCompletedDate, workspace.version],
    queryFn: () =>
      request(`/api/v1/reports?from=${twoWeeksBackStart}&to=${lastCompletedDate}`, reportSchema),
  });
  const dashboard = useQuery({
    queryKey: ['product', 'dashboard', month, today, workspace.version],
    queryFn: () =>
      request(
        `/api/v1/dashboard?from=${month}-01&to=${today}&kind=all&includeEstimated=false`,
        analyticsDashboardSchema,
      ),
  });
  const dailyLimit = useQuery({
    queryKey: ['product', 'daily-limit', workspace.version],
    queryFn: () => request('/api/v1/bankroll/rules', dailyLimitStateSchema),
  });
  const [dimension, setDimension] = useState<'sport' | 'book' | 'tipster' | 'amount'>('sport');
  if (report.isError || dashboard.isError)
    return <p role="alert">Could not load your analytics.</p>;
  if (!report.data || !dashboard.data) return <p role="status">Loading analytics…</p>;

  const summary = report.data.metrics;
  const indicators = dashboard.data.indicators;
  const settledCount = dashboard.data.metrics.settledBets;
  const positiveCents = exactCents(indicators.grossWinProfit);
  const negativeCents = exactCents(indicators.grossLossProfit);
  const profitFactor =
    negativeCents > 0n
      ? (Number(positiveCents) / Number(negativeCents)).toFixed(2)
      : positiveCents > 0n
        ? '∞'
        : '—';
  const firstResult =
    report.data.timeline.find((bucket) => bucket.metrics.settledBets > 0)?.date ?? today;
  const firstResultLabel = new Intl.DateTimeFormat(displayLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${firstResult}T12:00:00Z`));
  const weeklyNet = [twoWeeksBackStart, previousWeekStart].map((start, index) => {
    const rows = (weeklyReport.data?.timeline ?? []).filter((bucket) => {
      const upperBound = index === 0 ? previousWeekStart : currentWeekStart;
      return bucket.date >= start && bucket.date < upperBound;
    });
    let total = 0n;
    let missingUnits = false;
    for (const row of rows) {
      if (
        row.metrics.settledBets > 0 &&
        (row.metrics.profitUnits === null || row.metrics.missingUnitBets > 0)
      )
        missingUnits = true;
      if (row.metrics.profitUnits !== null)
        total += BigInt(row.metrics.profitUnits.replace('.', ''));
    }
    const absolute = total < 0n ? -total : total;
    const unitsValue = missingUnits
      ? null
      : `${total < 0n ? '-' : ''}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, '0')}`;
    return {
      label: new Intl.DateTimeFormat(displayLocale(), {
        day: 'numeric',
        month: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${start}T12:00:00Z`)),
      units: unitsValue === null ? 0 : Number(unitsValue),
      unitsLabel: unitsValue === null ? 'units unavailable' : signedUnitText(unitsValue),
      missingUnits,
    };
  });
  const redWeeks = weeklyNet.filter((week) => week.units < 0).length;
  const chartTokens = readChartTokens();
  const sample = settledCount;
  const sampleLabel =
    sample < 25 ? 'TOO EARLY' : sample < 100 ? 'A HINT' : sample < 300 ? 'A TREND' : 'PER SPORT';
  const sampleHeadline =
    sample < 25
      ? "IT'S TOO EARLY TO TELL WHETHER YOU'RE WINNING"
      : sample < 100
        ? 'THERE IS A HINT, NOT A CONCLUSION'
        : sample < 300
          ? 'A TREND IS TAKING SHAPE'
          : 'ENOUGH DATA TO COMPARE SPORTS';
  const sampleWarningHeadline =
    sample < 25
      ? "THE MONEY IS REAL. THE CONCLUSION ISN'T."
      : sample < 100
        ? 'A HINT IS NOT A CONCLUSION.'
        : 'A TREND IS NOT A PROMISE.';
  const sourceRows =
    dimension === 'sport'
      ? report.data.bySport
      : dimension === 'book'
        ? report.data.byBookmaker
        : dimension === 'tipster'
          ? report.data.byTipster
          : [];
  const amountRows =
    dimension === 'amount'
      ? [
          { label: 'UNDER 1 U', bets: indicators.underOneUnitBets },
          { label: '1–3 U', bets: indicators.oneToThreeUnitBets },
          { label: 'OVER 3 U', bets: indicators.overThreeUnitBets },
        ].filter((row) => row.bets > 0)
      : [];
  const bestDay = report.data.timeline
    .filter((bucket) => bucket.metrics.settledBets > 0)
    .reduce<(typeof report.data.timeline)[number] | null>(
      (best, bucket) =>
        !best || exactCents(bucket.metrics.profit) > exactCents(best.metrics.profit)
          ? bucket
          : best,
      null,
    );
  const latestWinStreak = indicators.currentWinStreak;
  const longestStreak = indicators.longestWinStreak;
  const unit = workspace.units.find((item) => item.month === month)?.amount ?? null;
  const betsInsideRange = indicators.oneToThreeUnitBets;
  const parlayShare = Math.round(Number(indicators.parlayStakeSharePct));
  const lossCount = indicators.lossBets;

  return (
    <div className="bettrack-analytics">
      <div className="bettrack-analytics-divider" />
      <h2 className="bettrack-analytics-confidence">{sampleHeadline}</h2>
      <div className="bettrack-analytics-kpis">
        <div>
          <span>NET</span>
          <strong className="is-positive">{signedUnitText(summary.profitUnits)}</strong>
          <small>
            {formatDisplayMoney(summary.profit)} · 1 U = {unit ? formatDisplayMoney(unit) : '—'}
          </small>
        </div>
        <div>
          <span>YIELD</span>
          <strong>
            {summary.yieldReal === null
              ? '—'
              : `${Number(summary.yieldReal) > 0 ? '+' : ''}${Number(summary.yieldReal).toFixed(1)}%`}
          </strong>
          <small>per unit risked</small>
        </div>
        <div>
          <span>PROFIT FACTOR</span>
          <strong>{profitFactor}</strong>
          <small>
            {profitFactor === '—' ? 'not enough settled results' : 'you win for every 1 you lose'}
          </small>
        </div>
        <div>
          <span>HIT RATE</span>
          <strong>
            {summary.hitRateReal === null ? '—' : `${Number(summary.hitRateReal).toFixed(1)}%`}
          </strong>
          <small>
            {summary.hitWinsReal} of {summary.hitEligibleReal} · not the metric
          </small>
        </div>
      </div>

      <section className="bettrack-weekly-net" aria-labelledby="bettrack-weekly-net-title">
        <header>
          <h2 id="bettrack-weekly-net-title">WEEKLY NET · 2 WEEKS</h2>
          <span>{redWeeks} IN THE RED</span>
        </header>
        {weeklyReport.isError ? (
          <p role="alert">Could not load weekly results.</p>
        ) : weeklyReport.isPending ? (
          <p role="status">Loading weekly results…</p>
        ) : (
          <div
            className="bettrack-weekly-chart"
            role="img"
            aria-label={`Weekly net in units: ${weeklyNet.map((week) => `${week.label} ${week.unitsLabel}`).join(', ')}`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyNet} margin={{ top: 22, right: 18, bottom: 0, left: 18 }}>
                <CartesianGrid stroke={chartTokens['--border']} vertical={false} />
                <XAxis dataKey="label" stroke={chartTokens['--text-tertiary']} />
                <YAxis hide />
                <ReferenceLine y={0} stroke={chartTokens['--border-strong']} />
                <Tooltip
                  formatter={(value) =>
                    `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)} U`
                  }
                />
                <Bar dataKey="units" isAnimationActive={false} minPointSize={5}>
                  <LabelList
                    dataKey="unitsLabel"
                    position="top"
                    fill={chartTokens['--text-secondary']}
                    fontSize={11}
                    fontWeight={700}
                  />
                  {weeklyNet.map((week) => (
                    <Cell
                      key={week.label}
                      fill={week.units >= 0 ? chartTokens['--pos'] : chartTokens['--neg']}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {weeklyNet.some((week) => week.missingUnits) ? (
          <p>UNITS ARE NOT AVAILABLE FOR SOME BETS IN THIS PERIOD.</p>
        ) : null}
      </section>

      <section className="bettrack-sample-warning">
        <div>
          <h2>{sampleWarningHeadline}</h2>
          <p>
            You won or lost real money and it's in your bankroll. But at {sample} bets, the result
            is almost all chance: the same number comes from someone with a method and from someone
            lucky.
          </p>
        </div>
        <div className="bettrack-sample-scale">
          <strong>YOU'RE HERE · {sample} BETS</strong>
          <div
            className="bettrack-sample-track"
            aria-label={`${sample} settled bets. ${sampleLabel}`}
          >
            {[25, 25, 25, 25].map((width, index) => (
              <span
                key={index}
                className={
                  (sample < 25 && index === 0) ||
                  (sample >= 25 && sample < 100 && index === 1) ||
                  (sample >= 100 && sample < 300 && index === 2) ||
                  (sample >= 300 && index === 3)
                    ? 'is-current'
                    : ''
                }
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
          <div className="bettrack-sample-labels">
            <span>
              0–24
              <br />
              too early
            </span>
            <span>
              25–99
              <br />a hint
            </span>
            <span>
              100–299
              <br />a trend
            </span>
            <span>
              300+
              <br />
              per sport
            </span>
          </div>
        </div>
      </section>

      <section className="bettrack-segments">
        <header>
          <div>
            <h2>{sample < 25 ? 'NOTHING TO GO ON YET' : 'BY DIMENSION'}</h2>
            <p>
              {sample < 25
                ? 'Yield per segment is missing on purpose: at these volumes it would be a number that looks like a finding and isn’t. Only the count goes here.'
                : 'Yield per segment stays hidden at low volumes. Only the count goes here.'}
            </p>
          </div>
          <div className="bettrack-segment-tabs" role="group" aria-label="Compare by">
            <button
              className={dimension === 'sport' ? 'is-active' : ''}
              aria-pressed={dimension === 'sport'}
              onClick={() => setDimension('sport')}
            >
              SPORT
            </button>
            <button
              className={dimension === 'book' ? 'is-active' : ''}
              aria-pressed={dimension === 'book'}
              onClick={() => setDimension('book')}
            >
              BOOK
            </button>
            <button
              className={dimension === 'tipster' ? 'is-active' : ''}
              aria-pressed={dimension === 'tipster'}
              onClick={() => setDimension('tipster')}
            >
              TIPSTER
            </button>
            <button
              className={dimension === 'amount' ? 'is-active' : ''}
              aria-pressed={dimension === 'amount'}
              onClick={() => setDimension('amount')}
            >
              AMOUNT
            </button>
          </div>
        </header>
        <div className="bettrack-segment-table">
          <div className="bettrack-segment-row is-heading">
            <span>
              {dimension === 'sport'
                ? 'SPORT'
                : dimension === 'book'
                  ? 'BOOK'
                  : dimension === 'tipster'
                    ? 'TIPSTER'
                    : 'AMOUNT'}
            </span>
            <span>BETS</span>
            <span>UNITS</span>
            <span>ROI</span>
          </div>
          {dimension === 'amount'
            ? amountRows.map((row) => (
                <div className="bettrack-segment-row" key={row.label}>
                  <strong>{row.label}</strong>
                  <span>{row.bets}</span>
                  <span>—</span>
                  <span>—</span>
                </div>
              ))
            : sourceRows.map((row) => (
                <div className="bettrack-segment-row" key={row.key}>
                  <strong>{row.label.toUpperCase()}</strong>
                  <span>{row.metrics.settledBets}</span>
                  <span>
                    {row.metrics.settledBets >= 25 ? signedUnitText(row.metrics.profitUnits) : '—'}
                  </span>
                  <span>{row.metrics.settledBets >= 25 ? percent(row.metrics.roiReal) : '—'}</span>
                  {row.metrics.settledBets < 25 ? (
                    <small>{25 - row.metrics.settledBets} MORE BEFORE THIS ROW SAYS ANYTHING</small>
                  ) : null}
                </div>
              ))}
          {dimension !== 'amount' && sourceRows.length === 0 ? (
            <p className="bettrack-analytics-empty">NO SETTLED BETS IN THIS SEGMENT YET</p>
          ) : null}
        </div>
        {sample < 25 ? (
          <p className="bettrack-market-note">
            MARKET CAN’T BE SEGMENTED YET · NEEDS STRUCTURE FROM EXTRACTION
          </p>
        ) : null}
      </section>

      <section className="bettrack-records">
        <header>
          <h2>YOUR FIRST RECORDS</h2>
          <p>
            Records and consistency, worked out from your own bets. They look backwards on purpose.
          </p>
        </header>
        <div className="bettrack-record-grid">
          <article>
            <span>BEST DAY</span>
            <strong>{bestDay ? signedUnitText(bestDay.metrics.profitUnits) : '—'}</strong>
            <small>
              {bestDay
                ? new Intl.DateTimeFormat(displayLocale(), {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  }).format(new Date(`${bestDay.date}T12:00:00Z`))
                : 'No settled bets yet'}
            </small>
          </article>
          <article>
            <span>LONGEST WINNING STREAK</span>
            <strong>{longestStreak || '—'}</strong>
            <small>
              {bestDay
                ? `${new Intl.DateTimeFormat(displayLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${bestDay.date}T12:00:00Z`))} · a record, not where you are now`
                : 'No settled bets yet'}
            </small>
          </article>
          <article>
            <span>BETS LOGGED</span>
            <strong>{summary.bets}</strong>
            <small>logging is what makes the rest possible</small>
          </article>
        </div>
      </section>

      <section className="bettrack-behaviour">
        <header>
          <h2>YOUR BEHAVIOUR CAN ALREADY BE SEEN</h2>
          <p>Counting needs no sample; inferring does. Facts appear from the first bet.</p>
        </header>
        <div className="bettrack-behaviour-grid">
          <article className="is-fact">
            <span>FACT · NEEDS NO SAMPLE</span>
            <h3>
              {betsInsideRange} OF {settledCount} BETS FIT IN 1–3 U
            </h3>
            <p>The professional standard is 1–3% of the bankroll per bet.</p>
          </article>
          <article>
            <span>
              {dailyLimit.isPending
                ? 'LIMIT LOADING'
                : dailyLimit.isError
                  ? 'LIMIT UNAVAILABLE'
                  : dailyLimit.data?.dailyLimitPercent
                    ? 'LIMIT SET'
                    : 'NO LIMIT SET'}
            </span>
            <h3>
              {dailyLimit.data?.dailyLimit
                ? `${formatDisplayMoney(dailyLimit.data.dailyLimit)} DAILY LIMIT`
                : dailyLimit.isPending
                  ? 'CHECKING YOUR BANKROLL'
                  : dailyLimit.isError
                    ? 'LIMIT STATUS UNAVAILABLE'
                    : "YOU HAVEN'T SET A DAILY LIMIT"}
            </h3>
            <p>
              {dailyLimit.data?.dailyLimit
                ? `${formatDisplayMoney(dailyLimit.data.usedToday)} USED · ${formatDisplayMoney(dailyLimit.data.remainingToday)} REMAINING TODAY`
                : 'A limit is configured from Bankroll and recalculates when your bankroll changes.'}
            </p>
            <a href="#finance">OPEN BANKROLL</a>
          </article>
          <article className="bettrack-behaviour-wide">
            <span>{lossCount < 20 ? 'CAN’T BE READ YET' : 'LOSSES OBSERVED'}</span>
            <h3>WHETHER YOU RAISE YOUR STAKE AFTER LOSING</h3>
            <p>
              It's the pattern that costs the most money, and seeing it needs at least 20 settled
              losses. You're at {lossCount}. We won't say you do it: the data can't tell us yet.
            </p>
            <div className="bettrack-behaviour-track">
              <i style={{ width: `${Math.min(100, (lossCount / 20) * 100)}%` }} />
            </div>
            <small>{lossCount} OF 20 LOSSES</small>
          </article>
          <article>
            <span>{settledCount < 25 ? 'STREAK · NO READING' : 'WINNING STREAK'}</span>
            <h3>
              {latestWinStreak || longestStreak} WINS IN A ROW
              {settledCount < 25 ? ', AND THAT’S EXPECTED' : ''}
            </h3>
            <p>
              At {settledCount} bets, a run of up to 3 either way is normal. A streak is not a
              measure of skill.
            </p>
          </article>
          <article>
            <span>PARLAYS · DATA</span>
            <h3>{parlayShare}% OF WHAT YOU RISK GOES ON PARLAYS</h3>
            <p>Their performance can be compared when enough settled tickets are available.</p>
          </article>
        </div>
      </section>
      <p className="bettrack-analytics-period">
        {summary.settledBets} SETTLED BETS · SINCE {firstResultLabel.toUpperCase()} ·{' '}
        <a
          href={`/api/v1/exports/csv?from=${month}-01&to=${today}&kind=all&includeEstimated=false`}
        >
          EXPORT CSV ↓
        </a>
      </p>
    </div>
  );
}

export default function AnalyticsPage({
  workspace,
  open,
}: {
  workspace: Workspace;
  open: OpenModal;
}) {
  const today = saoPauloDate(new Date());
  const initial: ReportQuery = {
    from: today.slice(0, 7) + '-01',
    to: today,
    kind: 'all',
    includeEstimated: 'false',
  };
  const [draft, setDraft] = useState(initial);
  const [filter, setFilter] = useState(initial);
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState<'byBookmaker' | 'byTipster' | 'bySport'>('byBookmaker');
  const [validation, setValidation] = useState('');
  const search = params(filter);
  const report = useQuery({
    queryKey: ['product', 'report', search, workspace.version],
    queryFn: () => request(`/api/v1/reports?${search}`, reportSchema),
  });
  const bets = useQuery({
    queryKey: ['product', 'report-bets', search, page, workspace.version],
    queryFn: () =>
      request(`/api/v1/reports/bets?${search}&page=${page}&pageSize=25`, reportBetPageSchema),
  });
  const options = useQuery({
    queryKey: ['product', 'report-options', workspace.version],
    queryFn: () => request('/api/v1/reports/options', reportOptionsSchema),
  });
  const change = (key: keyof ReportQuery, value: string) =>
    setDraft((previous) => {
      const next = { ...previous };
      if (value || key === 'from' || key === 'to') Object.assign(next, { [key]: value });
      else delete next[key];
      return next;
    });
  return (
    <>
      <p className="report-intro">
        Acompanhe o resultado das apostas pela data do último evento. Valores em unidades usam a
        unidade histórica de cada registro.
      </p>
      <form
        className="panel report-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.from > draft.to) {
            setValidation('A data inicial deve ser anterior ou igual à final.');
            return;
          }
          setValidation('');
          setFilter({ ...draft });
          setPage(1);
        }}
      >
        <div className="report-filter-grid">
          <Field label="De">
            <input
              aria-label="Data inicial da análise"
              type="date"
              required
              value={draft.from}
              onChange={(event) => change('from', event.target.value)}
            />
          </Field>
          <Field label="Até">
            <input
              aria-label="Data final da análise"
              type="date"
              required
              value={draft.to}
              onChange={(event) => change('to', event.target.value)}
            />
          </Field>
          <Field label="Casa">
            <select
              value={draft.bookmakerId ?? ''}
              onChange={(event) => change('bookmakerId', event.target.value)}
            >
              <option value="">Todas as casas</option>
              {workspace.catalog
                .filter((row) => row.kind === 'bookmaker')
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Tipster">
            <select
              value={draft.tipsterId ?? ''}
              onChange={(event) => change('tipsterId', event.target.value)}
            >
              <option value="">Todos os tipsters</option>
              <option value="none">Sem tipster</option>
              {workspace.catalog
                .filter((row) => row.kind === 'tipster')
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <details className="report-definitions">
          <summary>Mais filtros</summary>
          <div className="report-filter-grid">
            <Field label="Esporte">
              <select
                disabled={!options.data}
                value={draft.sport ?? ''}
                onChange={(event) => change('sport', event.target.value)}
              >
                <option value="">Todos os esportes</option>
                {options.data?.sports.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Origem do valor">
              <select value={draft.kind} onChange={(event) => change('kind', event.target.value)}>
                <option value="all">Real e freebets</option>
                <option value="real">Dinheiro real</option>
                <option value="freebet">Freebets</option>
              </select>
            </Field>
            <Field label="Situação">
              <select
                value={draft.state ?? ''}
                onChange={(event) => change('state', event.target.value)}
              >
                <option value="">Abertas e liquidadas</option>
                <option value="open">Em aberto</option>
                <option value="settled">Liquidadas</option>
              </select>
            </Field>
            <label className="report-check">
              <input
                type="checkbox"
                checked={draft.includeEstimated === 'true'}
                onChange={(event) => change('includeEstimated', String(event.target.checked))}
              />{' '}
              Incluir datas estimadas
            </label>
          </div>
          {options.isError ? (
            <p role="alert">
              Não foi possível carregar os esportes.{' '}
              <button type="button" className="text-link" onClick={() => void options.refetch()}>
                Tentar novamente
              </button>
            </p>
          ) : null}
        </details>
        <div className="button-row">
          <Button type="submit">Aplicar filtros</Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(initial);
              setFilter(initial);
              setPage(1);
              setValidation('');
            }}
          >
            Este mês
          </Button>
        </div>
        {validation ? (
          <p role="alert" className="notice warning">
            {validation}
          </p>
        ) : null}
      </form>
      {/* STK-F2-02: ROI, P&L, yield e N juntos; N ao lado de cada métrica e
          aviso de baixa amostra, independentemente do relatório completo. */}
      <DashboardPanel search={search} version={workspace.version} />
      {/* STK-F2-03: os 12 splits com ROI, P&L, yield e N juntos, filtros
          combináveis, unknown preservado e aviso de baixa amostra por split. */}
      <SplitsPanel search={search} version={workspace.version} />
      {report.isError ? (
        <div className="notice warning" role="alert">
          Não foi possível carregar a análise.{' '}
          <Button variant="secondary" onClick={() => void report.refetch()}>
            Tentar novamente
          </Button>
        </div>
      ) : !report.data ? (
        <p role="status">Calculando resultados…</p>
      ) : (
        <>
          <div className="section-heading">
            <p>
              {dayLabel(filter.from)} a {dayLabel(filter.to)}
              {filter.includeEstimated === 'true'
                ? ' · Inclui datas estimadas'
                : ' · Datas confirmadas'}
            </p>
            <a className="text-link" href={`/api/v1/exports/csv?${search}`} download>
              Exportar apostas em CSV ↓
            </a>
          </div>
          {report.data.exclusions.unknownDateBets > 0 ||
          report.data.exclusions.estimatedDateBets > 0 ? (
            <div className="notice warning">
              <strong>Datas a conferir</strong>
              <p>
                {report.data.exclusions.unknownDateBets} apostas com datas incompletas em todos os
                períodos; {report.data.exclusions.estimatedDateBets} com datas estimadas neste
                período foram excluídas.
              </p>
              <a className="text-link" href="#calendar">
                Conferir calendário ↗
              </a>
            </div>
          ) : null}
          {report.data.metrics.missingUnitBets > 0 ? (
            <div className="notice warning">
              {report.data.metrics.missingUnitBets} apostas com resultado não têm unidade histórica.
              O total em reais está completo; a parcela com unidade conhecida soma{' '}
              {units(report.data.metrics.knownProfitUnits)}. Associe a unidade no detalhe da aposta.
            </div>
          ) : null}
          <div className="report-context">
            <p>
              Resultado anterior:{' '}
              <strong>{formatDisplayMoney(report.data.previous.metrics.profit)}</strong>
              <br />
              <small>
                {dayLabel(report.data.previous.from)} a {dayLabel(report.data.previous.to)} · mesmos
                filtros
              </small>
            </p>
            <p>
              Resultado real: <strong>{formatDisplayMoney(report.data.metrics.realProfit)}</strong>
              <br />
              <small>Freebets: {formatDisplayMoney(report.data.metrics.freebetProfit)}</small>
            </p>
            <p>
              Taxa de acerto real: <strong>{percent(report.data.metrics.hitRateReal)}</strong>
              <br />
              <small>
                {report.data.metrics.hitWinsReal} vitórias completas ou parciais /{' '}
                {report.data.metrics.hitEligibleReal} elegíveis
              </small>
            </p>
          </div>
          <Evolution report={report.data} />
          <div className="panel report-context">
            <p>
              Retornos reais: <strong>{formatDisplayMoney(report.data.metrics.realReturns)}</strong>
              <br />
              <small>Liquidações ativas, sem estornos</small>
            </p>
            <p>
              Retornos de freebets:{' '}
              <strong>{formatDisplayMoney(report.data.metrics.freebetReturns)}</strong>
              <br />
              <small>Créditos recebidos na banca real</small>
            </p>
            <p>
              Valor apostado em freebets:{' '}
              <strong>{formatDisplayMoney(report.data.metrics.freebetStake)}</strong>
              <br />
              <small>Separado do principal real</small>
            </p>
          </div>
          <div className="panel">
            <div className="section-heading">
              <h2>Resultado por origem</h2>
              <Field label="Agrupar por">
                <select
                  value={group}
                  onChange={(event) => setGroup(event.target.value as typeof group)}
                >
                  <option value="byBookmaker">Casa</option>
                  <option value="byTipster">Tipster</option>
                  <option value="bySport">Esporte</option>
                </select>
              </Field>
            </div>
            {report.data[group].length === 0 ? (
              <p className="muted">Nenhuma aposta incluída.</p>
            ) : (
              <div className="table-scroll">
                <table className="product-table report-table">
                  <thead>
                    <tr>
                      <th>Origem</th>
                      <th>Apostas</th>
                      <th>Resultado</th>
                      <th>Unidades</th>
                      <th>ROI real</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data[group].map((row) => (
                      <tr key={row.key}>
                        <td>
                          <button
                            className="text-link"
                            onClick={() => {
                              const key =
                                group === 'byBookmaker'
                                  ? 'bookmakerId'
                                  : group === 'byTipster'
                                    ? 'tipsterId'
                                    : 'sport';
                              const next = { ...filter, [key]: row.key };
                              setFilter(next);
                              setDraft(next);
                              setPage(1);
                            }}
                          >
                            {row.label} ↗
                          </button>
                        </td>
                        <td>{row.metrics.bets}</td>
                        <td className={row.metrics.profit.startsWith('-') ? 'negative' : ''}>
                          {formatDisplayMoney(row.metrics.profit)}
                        </td>
                        <td>{units(row.metrics.profitUnits)}</td>
                        <td>{percent(row.metrics.roiReal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="panel">
            <div className="section-heading">
              <div>
                <h2>Apostas que compõem o resultado</h2>
                <p>Uma linha por aposta, inclusive múltiplas.</p>
              </div>
            </div>
            {bets.isError ? (
              <p role="alert">
                Não foi possível carregar o detalhamento.{' '}
                <Button variant="ghost" onClick={() => void bets.refetch()}>
                  Tentar novamente
                </Button>
              </p>
            ) : !bets.data ? (
              <p role="status">Carregando apostas…</p>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="product-table report-table">
                    <thead>
                      <tr>
                        <th>Último evento</th>
                        <th>Aposta</th>
                        <th>Casa</th>
                        <th>Situação</th>
                        <th>Resultado realizado</th>
                        <th>Unidades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bets.data.items.map((row) => {
                        const financial = betFinancialDisplay({
                          state: row.state,
                          returnAmount: row.returns,
                          profit: row.profit,
                        });
                        return (
                          <tr key={row.id}>
                            <td>
                              {dayLabel(row.eventDate)}
                              {row.dateStatus === 'estimated' ? ' · estimada' : ''}
                            </td>
                            <td>
                              <button
                                className="text-link report-event"
                                onClick={() => open({ kind: 'detail', id: row.id })}
                              >
                                {row.eventSummary}
                              </button>
                              {row.freebet ? <small className="muted"> · Freebet</small> : null}
                            </td>
                            <td>{row.bookmaker}</td>
                            <td>{row.state === 'open' ? 'Em aberto' : 'Liquidada'}</td>
                            <td className={financial.tone}>
                              {financial.profitText}
                              {financial.qualifier !== 'Realizado' ? (
                                <small>{financial.qualifier}</small>
                              ) : null}
                            </td>
                            <td>{units(row.profitUnits)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {bets.data.total === 0 ? (
                  <p className="muted">Nenhuma aposta corresponde a estes filtros.</p>
                ) : null}
                <div className="report-pagination">
                  <span>
                    {bets.data.total} apostas · página {page} de{' '}
                    {Math.max(1, Math.ceil(bets.data.total / 25))}
                  </span>
                  <div className="button-row">
                    <Button variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
                      Anterior
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={page * 25 >= bets.data.total}
                      onClick={() => setPage(page + 1)}
                    >
                      Próxima
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
          <details className="panel report-definitions">
            <summary>Como estes resultados são calculados</summary>
            <p>
              O período usa a data do último evento de cada aposta em São Paulo. Todos os eventos
              precisam ter data; estimativas entram apenas quando o filtro está ativado.
              Cancelamentos e liquidações estornadas são excluídos.
            </p>
            <p>
              Resultado real = retornos ativos menos principal real liquidado. ROI real = resultado
              real / principal real liquidado, incluindo anulações e cashouts. Yield real =
              resultado real / valor apostado em dinheiro real no período (inclui apostas ainda
              abertas no denominador); quando a base é zero o indicador fica ausente, nunca zero.
              Freebets ficam separadas e não entram nesses denominadores. Entradas, retiradas e
              conciliações não entram no resultado de apostas.
            </p>
            <p>
              A taxa de acerto inclui apenas apostas reais totalmente liquidadas em vitória, meia
              vitória, derrota ou meia derrota. Vitórias completas ou parciais contam como acerto.
              Apostas com anulação ou cashout são excluídas.
            </p>
            <p>
              Exposição é o principal real ainda aberto nas apostas do filtro, consultado agora. Os
              gráficos mostram desempenho por evento; períodos sem movimento têm valor zero.
              Unidades usam o valor histórico congelado de cada aposta.
            </p>
            <p>
              CSV contém todas as apostas do filtro, com valores decimais separados por ponto. JSON
              contém todo o histórico estruturado, inclusive lançamentos, auditoria e importações;
              as imagens e os dados de login não fazem parte desse arquivo.
            </p>
          </details>
        </>
      )}
      <div className="panel report-export">
        <div>
          <h2>Seu histórico com você</h2>
          <p>Baixe todos os registros estruturados, independentemente dos filtros.</p>
        </div>
        <a className="text-link" href="/api/v1/exports/json" download>
          Baixar histórico em JSON ↓
        </a>
      </div>
    </>
  );
}
