import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsSplitsSchema, type SplitDimensionId } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';
import { splitNotice, splitRowViews } from './splits-metrics.js';

/**
 * STK-F2-03 — os 12 splits analíticos no painel de análises: uma dimensão por
 * vez, com ROI, P&L, yield e `N` juntos em cada linha, os mesmos filtros do
 * relatório e o aviso de baixa amostra por split (Plano §8.5, §15). Origem e
 * cobertura de cada dimensão vêm no payload — sem leitura ou recomendação.
 */
export function SplitsPanel({ search, version }: { search: string; version: number }) {
  const [selected, setSelected] = useState<SplitDimensionId>('sport');
  const splits = useQuery({
    queryKey: ['product', 'splits', search, version],
    queryFn: () => request(`/api/v1/analytics/splits?${search}`, analyticsSplitsSchema),
  });
  if (splits.isError)
    return (
      <div className="notice warning" role="alert">
        Não foi possível carregar as comparações por dimensão.{' '}
        <Button variant="secondary" onClick={() => void splits.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  if (!splits.data) return <p role="status">Calculando as dimensões...</p>;
  const dimension =
    splits.data.dimensions.find((item) => item.id === selected) ?? splits.data.dimensions[0];
  if (!dimension) return <p className="muted">Nenhuma dimensão disponível.</p>;
  const rows = splitRowViews(dimension);
  const notice = splitNotice({ dimension, minSample: splits.data.minSample });
  return (
    <div className="panel">
      <div className="section-heading">
        <div>
          <h2>Comparação por dimensão</h2>
          <p>ROI, P&amp;L, yield e N em cada valor da dimensão, com os filtros acima.</p>
        </div>
        <Field label="Dimensão">
          <select
            aria-label="Dimensão da comparação"
            value={dimension.id}
            onChange={(event) => setSelected(event.target.value as SplitDimensionId)}
          >
            {splits.data.dimensions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {notice ? (
        <div className="notice warning" role="status">
          <strong>{notice.title}</strong>
          <p>{notice.body}</p>
        </div>
      ) : null}
      {dimension.note ? <p className="muted">{dimension.note}</p> : null}
      <div className="table-scroll">
        <table className="product-table report-table">
          <thead>
            <tr>
              <th>{dimension.label}</th>
              <th>P&amp;L realizado</th>
              <th>ROI real</th>
              <th>Yield real</th>
              <th>N</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className={row.negative ? 'negative' : ''}>{row.profit}</td>
                <td>{row.roi}</td>
                <td>{row.yieldReal}</td>
                <td>
                  {row.n}
                  {row.lowSample ? <small className="muted"> · Baixa amostra</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="muted">Nenhuma aposta incluída.</p> : null}
    </div>
  );
}
