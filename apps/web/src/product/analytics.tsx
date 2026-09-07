import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Legend,
} from 'recharts';
import {
  reportSchema,
  reportBetPageSchema,
  reportOptionsSchema,
  formatReportBRL,
  saoPauloDate,
  type Workspace,
  type ReportMetrics,
  type PerformanceReport,
  type ReportQuery,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';
import type { OpenModal } from './ProductApp.js';

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
function params(query: ReportQuery) {
  return new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ).toString();
}
function Summary({ metrics }: { metrics: ReportMetrics }) {
  return (
    <div className="metric-grid report-metrics">
      <div className="metric-card featured">
        <span>Resultado realizado</span>
        <strong>{units(metrics.profitUnits)}</strong>
        <small>{formatReportBRL(metrics.profit)} · real + freebets</small>
      </div>
      <div className="metric-card">
        <span>ROI real</span>
        <strong>{percent(metrics.roiReal)}</strong>
        <small>Sobre {formatReportBRL(metrics.realPrincipalClosed)} de principal liquidado</small>
      </div>
      <div className="metric-card">
        <span>Valor apostado real</span>
        <strong>{formatReportBRL(metrics.realStake)}</strong>
        <small>
          {metrics.bets} apostas incluídas · {metrics.openBets} em aberto
        </small>
      </div>
      <div className="metric-card">
        <span>Exposição atual do período</span>
        <strong>{formatReportBRL(metrics.exposure)}</strong>
        <small>Principal real ainda aberto nas apostas deste filtro</small>
      </div>
    </div>
  );
}
function Evolution({ report }: { report: PerformanceReport }) {
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
                <CartesianGrid stroke="#303847" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => String(date).slice(5).split('-').reverse().join('/')}
                  stroke="#9fa9ba"
                />
                <YAxis stroke="#9fa9ba" width={64} />
                <ReferenceLine y={0} stroke="#b8c5df" />
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="report-tooltip">
                        {dayLabel(payload[0].payload.date)}
                        <br />
                        {formatReportBRL(payload[0].payload.periodExact)}
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="period" name="Resultado" fill="#92adff" isAnimationActive={false} />
              </BarChart>
            ) : (
              <LineChart data={series} margin={{ left: 12, right: 12, top: 12, bottom: 8 }}>
                <CartesianGrid stroke="#303847" vertical={false} />
                <XAxis
                  dataKey="date"
                  minTickGap={45}
                  tickFormatter={(date) => String(date).slice(5).split('-').reverse().join('/')}
                  stroke="#9fa9ba"
                />
                <YAxis stroke="#9fa9ba" width={64} />
                <ReferenceLine y={0} stroke="#b8c5df" />
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="report-tooltip">
                        {dayLabel(payload[0].payload.date)}
                        <br />
                        Real: {formatReportBRL(payload[0].payload.realExact)}
                        <br />
                        Freebets: {formatReportBRL(payload[0].payload.promoExact)}
                      </div>
                    ) : null
                  }
                />
                <Legend />
                <Line
                  type="linear"
                  dataKey="real"
                  name="Dinheiro real"
                  stroke="#92adff"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="promo"
                  name="Freebets"
                  stroke="#dfbe76"
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
                  <td>{formatReportBRL(row.metrics.realProfit)}</td>
                  <td>{formatReportBRL(row.metrics.freebetProfit)}</td>
                  <td>{formatReportBRL(row.metrics.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
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
          <Summary metrics={report.data.metrics} />
          <div className="report-context">
            <p>
              Resultado anterior:{' '}
              <strong>{formatReportBRL(report.data.previous.metrics.profit)}</strong>
              <br />
              <small>
                {dayLabel(report.data.previous.from)} a {dayLabel(report.data.previous.to)} · mesmos
                filtros
              </small>
            </p>
            <p>
              Resultado real: <strong>{formatReportBRL(report.data.metrics.realProfit)}</strong>
              <br />
              <small>Freebets: {formatReportBRL(report.data.metrics.freebetProfit)}</small>
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
              Retornos reais: <strong>{formatReportBRL(report.data.metrics.realReturns)}</strong>
              <br />
              <small>Liquidações ativas, sem estornos</small>
            </p>
            <p>
              Retornos de freebets:{' '}
              <strong>{formatReportBRL(report.data.metrics.freebetReturns)}</strong>
              <br />
              <small>Créditos recebidos na banca real</small>
            </p>
            <p>
              Valor apostado em freebets:{' '}
              <strong>{formatReportBRL(report.data.metrics.freebetStake)}</strong>
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
                          {formatReportBRL(row.metrics.profit)}
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
                        <th>Resultado</th>
                        <th>Unidades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bets.data.items.map((row) => (
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
                          <td>{formatReportBRL(row.profit)}</td>
                          <td>{units(row.profitUnits)}</td>
                        </tr>
                      ))}
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
              real / principal real liquidado, incluindo anulações e cashouts. Freebets ficam
              separadas e não entram nesse denominador. Entradas, retiradas e conciliações não
              entram no resultado de apostas.
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
