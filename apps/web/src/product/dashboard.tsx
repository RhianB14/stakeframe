import { useQuery } from '@tanstack/react-query';
import { analyticsDashboardSchema } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { request } from './api.js';
import { dashboardCards, lowSampleNotice } from './dashboard-metrics.js';

/**
 * STK-F2-02 — cards do dashboard analítico: ROI, P&L, yield e N juntos, com N
 * ao lado de cada métrica e aviso de baixa amostra (Plano §8.5). Alimentado
 * por `GET /api/v1/dashboard` (agregação indexada + cache curto no servidor).
 */
export function DashboardPanel({ search, version }: { search: string; version: number }) {
  const dashboard = useQuery({
    queryKey: ['product', 'dashboard', search, version],
    queryFn: () => request(`/api/v1/dashboard?${search}`, analyticsDashboardSchema),
  });
  if (dashboard.isError)
    return (
      <div className="notice warning" role="alert">
        Não foi possível carregar os indicadores.{' '}
        <Button variant="secondary" onClick={() => void dashboard.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  if (!dashboard.data) return <p role="status">Calculando indicadores...</p>;
  const { metrics, lowSample, minSample } = dashboard.data;
  const notice = lowSampleNotice({ n: metrics.bets, minSample });
  return (
    <>
      {lowSample ? (
        <div className="notice warning" role="status">
          <strong>{notice.title}</strong>
          <p>{notice.body}</p>
        </div>
      ) : null}
      <div className="metric-grid report-metrics">
        {dashboardCards({ metrics, lowSample }).map((card) => (
          <div key={card.key} className={`metric-card ${card.key === 'profit' ? 'featured' : ''}`}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            {card.details.map((line) => (
              <small key={line}>{line}</small>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
