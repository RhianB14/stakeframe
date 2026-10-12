import { displayLocale, formatDisplayMoney } from './preferences.js';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { betPageSchema, reportSchema, saoPauloDate, type Workspace } from '@stakeframe/shared';
import { request } from './api.js';
import { Button } from '../components/ui/button.js';
import { readChartTokens } from './chart-tokens.js';
import { chartHasSample, lowChartSampleMessage } from './chart-domain.js';

export function OverviewReport({
  version,
  workspace,
  amountMode,
  hideAmounts,
  openBetCount,
  selectedDate,
  onSelectDate,
}: {
  version: number;
  workspace: Workspace;
  amountMode: 'money' | 'units';
  hideAmounts: boolean;
  openBetCount: number | undefined;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}) {
  const today = saoPauloDate(new Date());
  const month = today.slice(0, 7);
  const query = useQuery({
    queryKey: ['product', 'overview-report', month, version],
    queryFn: () => request(`/api/v1/reports?from=${month}-01&to=${today}`, reportSchema),
  });
  const betParams = new URLSearchParams({ page: '1', pageSize: '100' }).toString();
  const betsQuery = useQuery({
    queryKey: ['product', 'bets', version, betParams],
    queryFn: () => request(`/api/v1/bets?${betParams}`, betPageSchema),
  });
  const chart = readChartTokens();
  const unit = workspace.units.find((value) => value.month === month) ?? null;
  const unitCents = unit ? moneyCents(unit.amount) : 0n;
  const buckets = query.data?.timeline ?? [];
  const bucketsByDate = new Map(buckets.map((bucket) => [bucket.date, bucket]));
  const selectedBucket = bucketsByDate.get(selectedDate);
  const openBets = betsQuery.data?.items.filter((bet) => bet.state === 'open') ?? [];
  const openCount = openBetCount ?? openBets.length;
  const bankroll = Number(workspace.bankroll);
  const unitPercent = bankroll > 0 && unit ? (Number(unit.amount) / bankroll) * 100 : null;
  const exposurePercent = bankroll > 0 ? (Number(workspace.exposure) / bankroll) * 100 : null;
  const potentialProfitCents = openBets.reduce((total, bet) => {
    if (bet.stake === null || bet.odds === null) return total;
    const stake = Number(bet.stake);
    const odds = Number(bet.odds);
    if (!Number.isFinite(stake) || !Number.isFinite(odds) || odds <= 1) return total;
    return total + Math.round(stake * (odds - 1) * 100);
  }, 0);
  const potentialProfit = centsMoney(BigInt(potentialProfitCents));

  const series = useMemo(() => {
    let running = 0n;
    return buckets.map((bucket) => {
      const change = moneyCents(bucket.metrics.profit);
      running += change;
      return {
        date: bucket.date,
        accumulated: unitCents > 0n ? Number(running) / Number(unitCents) : Number(running) / 100,
        period: unitCents > 0n ? Number(change) / Number(unitCents) : Number(change) / 100,
        bets: bucket.metrics.bets,
      };
    });
  }, [buckets, unitCents]);
  const observed = series.filter((row) => row.bets > 0);
  const drawable = chartHasSample(observed.length);
  const latest = series.at(-1)?.accumulated ?? 0;
  const ceiling = series.reduce((best, row) => Math.max(best, row.accumulated), 0);
  const drawdown = series.reduce(
    (result, row) => {
      const nextPeak = Math.max(result.peak, row.accumulated);
      return { peak: nextPeak, worst: Math.max(result.worst, nextPeak - row.accumulated) };
    },
    { peak: 0, worst: 0 },
  ).worst;
  const underwaterDays = series.filter((row) => row.accumulated < ceiling).length;
  const observedBets = observed.reduce((total, row) => total + row.bets, 0);
  const losingBets = observed
    .filter((row) => row.period < 0)
    .reduce((total, row) => total + row.bets, 0);
  const losingPercent = observedBets ? Math.round((losingBets / observedBets) * 100) : 0;
  const last14 = buckets.slice(-14);
  const redDays = last14.filter((bucket) => moneyCents(bucket.metrics.profit) < 0n).length;
  const last14ProfitCents = last14.reduce(
    (total, bucket) => total + moneyCents(bucket.metrics.profit),
    0n,
  );
  const last14ProfitUnits =
    unitCents > 0n
      ? Number(last14ProfitCents) / Number(unitCents)
      : Number(last14ProfitCents) / 100;
  const dateStart = shiftDate(selectedDate, -13);
  const days = Array.from({ length: 21 }, (_, index) => shiftDate(dateStart, index));
  const todayIndex = days.indexOf(today);
  const monthLabel = new Intl.DateTimeFormat(displayLocale(), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${selectedDate}T12:00:00Z`));
  const rangeProfit = (date: string) => {
    const bucket = bucketsByDate.get(date);
    return bucket
      ? dashboardAmount(bucket.metrics.profit, unit?.amount ?? null, 'units', false)
      : 'no bets';
  };
  const moveSelectedDate = (offset: number) => onSelectDate(shiftDate(selectedDate, offset));

  return (
    <div className="overview-report">
      <section className="panel overview-timeline-panel" aria-label="Activity timeline">
        <div className="bettrack-timeline-month">
          <span>{monthLabel}</span>
          <button type="button" aria-label="Previous day" onClick={() => moveSelectedDate(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Next day" onClick={() => moveSelectedDate(1)}>
            ›
          </button>
        </div>
        <div className="overview-timeline" role="group" aria-label="Days around the selected date">
          <div className="overview-timeline-track" />
          {days.map((date, index) => {
            const bucket = bucketsByDate.get(date);
            const isToday = date === today;
            const isSelected = date === selectedDate;
            return (
              <button
                key={date}
                type="button"
                className={`overview-timeline-day${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
                style={{ left: `${(index / Math.max(1, days.length - 1)) * 100}%` }}
                aria-label={`${formatDay(date)} · ${rangeProfit(date)}`}
                aria-pressed={isSelected}
                title={`${formatDay(date)} · ${rangeProfit(date)}`}
                onClick={() => onSelectDate(date)}
              >
                {bucket && bucket.metrics.bets > 0 ? (
                  <span
                    className={`overview-day-marker${moneyCents(bucket.metrics.profit) < 0n ? ' is-negative' : ''}`}
                  />
                ) : null}
                {isToday ? <span className="overview-today-marker" /> : null}
              </button>
            );
          })}
        </div>
        <div className="bettrack-timeline-labels" aria-hidden="true">
          <span style={{ left: '0%' }}>{formatDayShort(days[0]!)}</span>
          <span style={{ left: `${(7 / 20) * 100}%` }}>{formatDayShort(days[7]!)}</span>
          {todayIndex >= 0 ? (
            <span style={{ left: `${(todayIndex / 20) * 100}%` }}>TODAY</span>
          ) : null}
        </div>
      </section>

      <div className="overview-dashboard-metrics">
        <section className="bettrack-dashboard-metric">
          <div className="bettrack-metric-heading">
            <span>BANKROLL</span>
            <MetricHelp label="What Bankroll means">
              The money available across your reserve and sportsbook accounts.
            </MetricHelp>
          </div>
          <strong>
            {dashboardAmount(workspace.bankroll, unit?.amount ?? null, amountMode, hideAmounts)}
          </strong>
          <div className="bettrack-metric-divider" />
          <div className="bettrack-metric-split">
            <span>1 UNIT</span>
            <span>OF BANKROLL</span>
          </div>
          <div className="bettrack-metric-unit-value">
            <b>{unit ? dashboardAmount(unit.amount, unit.amount, amountMode, hideAmounts) : '—'}</b>
            <b
              className={
                unitPercent === null || unitPercent < 1 || unitPercent > 3
                  ? 'is-warning'
                  : 'is-good'
              }
            >
              {hideAmounts ? '••••' : unitPercent === null ? '—' : `${unitPercent.toFixed(1)}%`}
            </b>
          </div>
          <div className="bettrack-unit-track" aria-hidden="true">
            <i style={{ left: `${Math.min(100, Math.max(2, (unitPercent ?? 0) * 12.5))}%` }} />
            <span />
          </div>
          <small>
            {unitPercent === null
              ? 'NO UNIT SET'
              : unitPercent < 1 || unitPercent > 3
                ? 'OUTSIDE 1–3%'
                : 'WITHIN 1–3%'}
          </small>
        </section>

        <section className="bettrack-dashboard-metric">
          <div className="bettrack-metric-heading">
            <span>AT STAKE NOW</span>
            <MetricHelp label="What At stake now means">
              The real amount committed to open bets, before any result is known.
            </MetricHelp>
          </div>
          <strong>
            {dashboardAmount(workspace.exposure, unit?.amount ?? null, amountMode, hideAmounts)}
          </strong>
          <div className="bettrack-metric-divider" />
          <div className="bettrack-metric-split">
            <span>
              {hideAmounts ? '••••' : `${openCount} ${openCount === 1 ? 'open' : 'open bets'}`}
            </span>
            <span>
              {hideAmounts
                ? '••••'
                : exposurePercent === null
                  ? '—'
                  : `${exposurePercent.toFixed(1)}% OF BANKROLL`}
            </span>
          </div>
          <div className="bettrack-metric-bottom">
            <span>IF EVERYTHING LANDS</span>
            <b>{signedAmount(potentialProfit, unit?.amount ?? null, amountMode, hideAmounts)}</b>
          </div>
        </section>

        <section className="bettrack-dashboard-metric">
          <div className="bettrack-metric-heading">
            <span>THE DAY</span>
            <MetricHelp label="What The day means">
              Settled result for the date selected on the activity timeline.
            </MetricHelp>
          </div>
          <strong
            className={`is-${selectedBucket ? signTone(selectedBucket.metrics.profit) : 'neutral'}`}
          >
            {dashboardAmount(
              selectedBucket?.metrics.profit ?? '0.00',
              unit?.amount ?? null,
              amountMode,
              hideAmounts,
            )}
          </strong>
          <div className="bettrack-metric-divider" />
          <div className="bettrack-metric-split">
            <span>RESULT FOR THE DAY</span>
            <span>
              {selectedBucket?.metrics.settledBets
                ? `${selectedBucket.metrics.settledBets} SETTLED`
                : 'NOTHING SETTLED'}
            </span>
          </div>
          <div className="bettrack-metric-bottom">
            <span>NO CAP SET</span>
            <a href="#finance">SET ONE</a>
          </div>
        </section>
      </div>

      <div className="overview-running-layout">
        <section className="panel overview-running-panel">
          <div className="bettrack-running-head">
            <div className="bettrack-running-title">
              <h2>RUNNING RESULT</h2>
              <MetricHelp label="What Running result means">
                The cumulative result of settled bets by event date.
              </MetricHelp>
            </div>
            <div className="bettrack-running-ceiling">
              <span>AT YOUR BEST POINT</span>
              <b>CEILING {hideAmounts ? '••••' : signedUnits(ceiling)}</b>
            </div>
          </div>
          <strong
            className={`bettrack-running-value is-${latest < 0 ? 'negative' : latest > 0 ? 'positive' : 'neutral'}`}
          >
            {hideAmounts ? '••••' : signedUnits(latest)}
          </strong>
          {query.isError ? (
            <p role="alert">
              Could not load the result.{' '}
              <Button variant="ghost" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </p>
          ) : !query.data ? (
            <p role="status">Calculating result…</p>
          ) : drawable ? (
            <div
              className="report-chart bettrack-running-chart"
              role="img"
              aria-label={`Running result this month. Ends at ${signedUnits(latest)} across ${query.data.metrics.settledBets} settled bets.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ left: 0, right: 2, top: 8, bottom: 0 }}>
                  <XAxis dataKey="date" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <ReferenceLine y={0} stroke={chart['--border-strong']} />
                  <Tooltip
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div className="report-tooltip">
                          {formatDay(String(payload[0].payload.date))}
                          <br />
                          Day: {signedUnits(Number(payload[0].payload.period))}
                          <br />
                          Running: {signedUnits(Number(payload[0].payload.accumulated))}
                        </div>
                      ) : null
                    }
                  />
                  <Line
                    type="monotone"
                    dataKey="accumulated"
                    name="Running result"
                    stroke={chart['--pos']}
                    strokeWidth={1.6}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="panel-footnote">
              {observed.length === 0
                ? 'No bets with an eligible event date this month.'
                : lowChartSampleMessage(observed.length)}
            </p>
          )}
          <div className="bettrack-running-foot">
            <span>WORST DRAWDOWN {hideAmounts ? '••••' : `${drawdown.toFixed(1)} U`}</span>
            <span>
              {underwaterDays} {underwaterDays === 1 ? 'DAY' : 'DAYS'} UNDERWATER
            </span>
            <span>{losingPercent}% OF YOUR BETS, BELOW</span>
          </div>
        </section>

        <aside className="panel overview-insights">
          <div className="section-heading">
            <div className="bettrack-insights-title">
              <h2>INSIGHTS</h2>
            </div>
          </div>
          <div
            className={`bettrack-insight-card${unitPercent === null || unitPercent < 1 || unitPercent > 3 ? ' is-warning' : ''}`}
          >
            <strong>
              {unitPercent === null || unitPercent < 1 || unitPercent > 3
                ? 'UNIT OUT OF RANGE'
                : 'UNIT IN RANGE'}
            </strong>
            <span>
              {hideAmounts
                ? '••••'
                : unitPercent === null
                  ? 'No unit set'
                  : `${unitPercent.toFixed(1)}% when healthy is 1–3%`}
            </span>
          </div>
          <div className="bettrack-insight-card">
            <strong>{hideAmounts ? '••••' : `${redDays} OF 14 DAYS IN THE RED`}</strong>
            <span>last 14 days · {hideAmounts ? '••••' : signedUnits(last14ProfitUnits)}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MetricHelp({ label, children }: { label: string; children: string }) {
  return (
    <details className="bettrack-metric-help">
      <summary aria-label={label}>i</summary>
      <p>{children}</p>
    </details>
  );
}

function dashboardAmount(
  amount: string,
  unitAmount: string | null,
  mode: 'money' | 'units',
  hidden: boolean,
) {
  if (hidden) return '••••';
  if (mode === 'money') return formatDisplayMoney(amount);
  if (!unitAmount) return '—';
  const unit = moneyCents(unitAmount);
  if (unit <= 0n) return '—';
  const raw = moneyCents(amount);
  const negative = raw < 0n;
  const hundredths = ((negative ? -raw : raw) * 100n + unit / 2n) / unit;
  const value = `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}U`;
  return `${negative && hundredths > 0n ? '−' : ''}${value}`;
}

function signedAmount(
  amount: string,
  unitAmount: string | null,
  mode: 'money' | 'units',
  hidden: boolean,
) {
  const formatted = dashboardAmount(amount, unitAmount, mode, hidden);
  if (hidden || formatted === '—') return formatted;
  return moneyCents(amount) > 0n ? `+${formatted}` : formatted;
}

function moneyCents(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -result : result;
}

function centsMoney(value: bigint): string {
  const negative = value < 0n;
  const cents = negative ? -value : value;
  return `${negative ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function signedUnits(value: number): string {
  const formatted = `${Math.abs(value).toFixed(1)} U`;
  return value > 0 ? `+${formatted}` : value < 0 ? `−${formatted}` : `0.0 U`;
}

function shiftDate(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

function formatDayShort(date: string): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
    .format(new Date(`${date}T12:00:00Z`))
    .toUpperCase();
}

export function signTone(value: string): 'neutral' | 'positive' | 'negative' {
  if (value.startsWith('-')) return 'negative';
  return Number(value) === 0 ? 'neutral' : 'positive';
}

export function unitsLabel(value: string): string {
  return `${value.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} un`;
}
