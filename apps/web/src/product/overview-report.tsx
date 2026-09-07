import { useQuery } from '@tanstack/react-query';
import { reportSchema, saoPauloDate, formatReportBRL } from '@stakeframe/shared';
import { request } from './api.js';
import { Button } from '../components/ui/button.js';

export function OverviewReport({ version }: { version: number }) {
  const today = saoPauloDate(new Date());
  const query = useQuery({
    queryKey: ['product', 'overview-report', today, version],
    queryFn: () =>
      request(`/api/v1/reports?from=${today.slice(0, 7)}-01&to=${today}`, reportSchema),
  });
  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <h2>Resultado do mês</h2>
          <p>Até hoje · último evento com data confirmada</p>
        </div>
        <a className="text-link" href="#analytics">
          Ver análises ↗
        </a>
      </div>
      {query.isError ? (
        <p role="alert">
          Não foi possível carregar o resultado.{' '}
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </p>
      ) : !query.data ? (
        <p role="status">Calculando resultado…</p>
      ) : (
        <>
          <div className="report-context">
            <p>
              Resultado: <strong>{formatReportBRL(query.data.metrics.profit)}</strong>
              <br />
              <small>
                {query.data.metrics.profitUnits === null
                  ? 'Unidades históricas a conferir'
                  : `${query.data.metrics.profitUnits.replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} u`}
              </small>
            </p>
            <p>
              Dinheiro real: <strong>{formatReportBRL(query.data.metrics.realProfit)}</strong>
              <br />
              <small>Freebets: {formatReportBRL(query.data.metrics.freebetProfit)}</small>
            </p>
            <p>
              <strong>{query.data.metrics.bets} apostas</strong> incluídas
              <br />
              <small>{query.data.metrics.openBets} em aberto neste período</small>
            </p>
          </div>
          {query.data.exclusions.unknownDateBets + query.data.exclusions.estimatedDateBets > 0 ? (
            <p className="pending-label">
              {query.data.exclusions.unknownDateBets} apostas com datas incompletas em todos os
              períodos; {query.data.exclusions.estimatedDateBets} com datas estimadas no mês.{' '}
              <a className="text-link" href="#calendar">
                Conferir datas ↗
              </a>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
