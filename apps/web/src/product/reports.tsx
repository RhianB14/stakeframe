import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatReportBRL,
  reportPeriodSchema,
  reportSnapshotListSchema,
  reportSnapshotSchema,
  saoPauloDate,
  type ReportPeriod,
  type ReportSnapshotPayload,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request } from './api.js';

// STK-F2-08 — a PÁGINA PRIVADA do relatório.
//
// A tela mostra o SNAPSHOT, não uma consulta. Isso é o que faz dela um
// documento: o número que aparece é o que foi gerado na emissão, com o hash
// que o comprova, e uma correção de dado não muda esta tela — ela cria a
// versão 2 ao lado, e a versão 1 continua legível e intacta.
//
// E o que esta tela NÃO faz é tão importante quanto o que ela faz:
//
//  - NÃO há download, botão de PDF, PNG, "copiar imagem" nem link público.
//    O card rejeita os três, e a ausência não é um esquecimento: e-mail, PDF e
//    URL temporária são as três formas pelas quais o conteúdo financeiro do
//    usuário escapa do controle de acesso da conta.
//
//  - NÃO há interpretação por modelo. A narrativa chega pronta do servidor,
//    com cada linha marcada como `fact` (o número) ou `heuristic` (a leitura
//    do produto), e a tela mostra essa distinção ao usuário.
//
//  - SEM DADOS É UM ESTADO, NÃO UM RELATÓRIO VAZIO. A janela sem apostas mostra
//    "sem apostas no período" e nada mais: um cartão de R$ 0,00 leria como
//    "apostou e não perdeu nada", que é uma leitura errada.

const PERIOD_LABEL: Record<ReportPeriod, string> = {
  daily: 'Diário',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

/** Janela padrão de cada cadência, expressa em datas civis do fuso do produto. */
function defaultWindow(period: ReportPeriod): { from: string; to: string } {
  const today = saoPauloDate(new Date());
  if (period === 'daily') return { from: today, to: today };
  if (period === 'weekly') {
    const start = new Date(`${today}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    return { from: start.toISOString().slice(0, 10), to: today };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

const percent = (value: string | null) =>
  value === null ? 'Sem base' : `${value.replace('.', ',')}%`;

function BreakdownTable({ payload }: { payload: ReportSnapshotPayload }) {
  const groups = new Map<string, { label: string; rows: ReportSnapshotPayload['breakdown'] }>();
  for (const row of payload.breakdown) {
    const key = row.id;
    const group = groups.get(key) ?? { label: row.label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (!groups.size)
    return (
      <p className="muted">
        Sem comparações neste período: as dimensões aparecem quando houver apostas registradas.
      </p>
    );
  return (
    <div className="table-scroll" role="region" aria-label="Comparação por dimensão" tabIndex={0}>
      <table className="product-table">
        <caption className="sr-only">
          Resultado e número de apostas por casa, esporte e tipster
        </caption>
        <thead>
          <tr>
            <th>Dimensão</th>
            <th>Valor</th>
            <th>Apostas</th>
            <th>Resultado</th>
          </tr>
        </thead>
        <tbody>
          {[...groups.values()].map((group) =>
            group.rows.map((row, index) => (
              <tr key={`${group.label}-${row.labelKey}`}>
                {index === 0 ? (
                  <th scope="rowgroup" rowSpan={group.rows.length}>
                    {group.label}
                  </th>
                ) : null}
                <td>{row.labelKey}</td>
                <td className="tabular">{row.bets}</td>
                <td
                  className={`tabular ${row.profit.startsWith('-') ? 'negative' : row.profit === '0.00' ? '' : 'positive'}`}
                >
                  {formatReportBRL(row.profit)}
                  {row.lowSample ? <small>amostra pequena</small> : null}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsPage() {
  const [period, setPeriod] = useState<ReportPeriod>('monthly');
  const [from, setFrom] = useState(() => defaultWindow('monthly').from);
  const [to, setTo] = useState(() => defaultWindow('monthly').to);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const report = useQuery({
    queryKey: ['product', 'report-snapshot', period, from, to],
    queryFn: () =>
      request(
        `/api/v1/report-snapshots?period=${period}&from=${from}&to=${to}`,
        reportSnapshotSchema,
      ),
  });
  const history = useQuery({
    queryKey: ['product', 'report-snapshots', period],
    queryFn: () =>
      request(`/api/v1/report-snapshots/history?period=${period}`, reportSnapshotListSchema),
  });
  // A versão específica vem só quando o usuário pede; por padrão a tela mostra
  // a última, e a revisão é a forma de ver o que foi publicado antes.
  const version = useQuery({
    queryKey: ['product', 'report-snapshot', selectedId],
    queryFn: () => request(`/api/v1/report-snapshots/${selectedId}`, reportSnapshotSchema),
    enabled: selectedId !== null,
  });
  const revise = useMutation({
    mutationFn: () =>
      request(
        `/api/v1/report-snapshots/${report.data?.snapshot.id}/revisions`,
        reportSnapshotSchema,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      ),
    onSuccess: () => {
      setReason('');
      setSelectedId(null);
      void report.refetch();
      void history.refetch();
    },
  });

  const shown = version.data ?? report.data;
  const change = (next: ReportPeriod) => {
    setPeriod(next);
    const window = defaultWindow(next);
    setFrom(window.from);
    setTo(window.to);
    setSelectedId(null);
  };

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Relatórios privados</h2>
            <p>Páginas da sua conta: exigem login e não são enviadas por e-mail, PDF ou imagem.</p>
          </div>
        </div>
        <div className="filter-grid">
          <Field label="Período">
            <select
              aria-label="Período do relatório"
              value={period}
              onChange={(event) => change(reportPeriodSchema.parse(event.target.value))}
            >
              {(Object.keys(PERIOD_LABEL) as ReportPeriod[]).map((item) => (
                <option key={item} value={item}>
                  {PERIOD_LABEL[item]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="De (data do evento)">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Até (data do evento)">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>
        {report.isError ? (
          <div className="notice warning" role="alert">
            Não foi possível gerar o relatório.{' '}
            <Button variant="secondary" onClick={() => void report.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : null}
        {report.isPending ? <p role="status">Preparando o relatório...</p> : null}
      </section>

      {shown && shown.empty ? (
        <section className="panel">
          <div className="empty-state">
            <span aria-hidden="true">▤</span>
            <h3>Sem apostas no período</h3>
            <p>
              Não há relatório para {PERIOD_LABEL[period].toLowerCase()} entre {from} e {to} porque
              nenhuma aposta foi registrada nesse intervalo. Nada foi enviado.
            </p>
          </div>
        </section>
      ) : null}

      {shown && !shown.empty ? (
        <>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>{shown.snapshot.title}</h2>
                <p>
                  Versão {shown.snapshot.version} · congelado em{' '}
                  {new Date(shown.snapshot.createdAt).toLocaleString('pt-BR', {
                    timeZone: 'America/Sao_Paulo',
                  })}
                  {shown.snapshot.revisionReason
                    ? ` · motivo da revisão: ${shown.snapshot.revisionReason}`
                    : ''}
                </p>
              </div>
              {selectedId ? (
                <Button variant="secondary" size="small" onClick={() => setSelectedId(null)}>
                  Ver a versão atual
                </Button>
              ) : null}
            </div>
            <p className="report-immutable">
              <strong>Documento imutável.</strong> O número abaixo é o que foi gerado no momento
              indicado e não muda com novas apostas. Uma correção cria uma versão nova, e esta
              continua disponível.
            </p>
            <p className="report-hash">
              <span className="sr-only">Identificador de integridade do conteúdo: </span>
              SHA-256: <code>{shown.snapshot.contentSha256}</code>
            </p>
            <div className="metric-grid">
              <div className="metric-card featured">
                <span>Resultado</span>
                <strong className={shown.metrics.profit.startsWith('-') ? 'negative' : ''}>
                  {formatReportBRL(shown.metrics.profit)}
                </strong>
                <small>
                  {shown.metrics.settledBets} liquidadas · {shown.metrics.openBets} abertas
                </small>
              </div>
              <div className="metric-card">
                <span>ROI real</span>
                <strong>{percent(shown.metrics.roiReal)}</strong>
                <small>principal real {formatReportBRL(shown.metrics.realPrincipalClosed)}</small>
              </div>
              <div className="metric-card">
                <span>Yield real</span>
                <strong>{percent(shown.metrics.yieldReal)}</strong>
                <small>retornos {formatReportBRL(shown.metrics.realReturns)}</small>
              </div>
              <div className="metric-card">
                <span>Exposição aberta</span>
                <strong>{formatReportBRL(shown.metrics.exposure)}</strong>
                <small>{shown.metrics.bets} apostas no período</small>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Leitura do período</h2>
                <p>
                  Frases de número e leitura do produto, com a origem de cada uma. Não há geração
                  por modelo: a narrativa sai dos mesmos números acima.
                </p>
              </div>
            </div>
            {shown.narrative.lowSample ? (
              <div className="notice warning" role="status">
                Amostra pequena ({shown.metrics.bets} de {shown.narrative.minSample} apostas): os
                percentuais são indicativos e não sustentam conclusão.
              </div>
            ) : null}
            <ul className="report-narrative">
              {shown.narrative.lines.map((line, index) => (
                <li key={index} className={line.kind}>
                  <span>{line.text}</span>
                  {line.fact ? <small>{line.fact}</small> : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Por casa, esporte e tipster</h2>
                <p>Resultado e número de apostas em cada valor da dimensão.</p>
              </div>
            </div>
            <BreakdownTable payload={shown} />
          </section>

          {shown.revisions.length > 1 ? (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>Versões deste relatório</h2>
                  <p>Nenhuma versão é alterada ou removida: correções criam a próxima.</p>
                </div>
              </div>
              <ul className="report-revisions">
                {shown.revisions.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant={item.id === shown.snapshot.id ? 'default' : 'secondary'}
                      size="small"
                      onClick={() => setSelectedId(item.id === shown.snapshot.id ? null : item.id)}
                    >
                      Versão {item.version}
                    </Button>
                    <small>
                      {new Date(item.createdAt).toLocaleString('pt-BR', {
                        timeZone: 'America/Sao_Paulo',
                      })}
                      {item.revisionReason ? ` · ${item.revisionReason}` : ''}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>Corrigir este relatório</h2>
                <p>
                  Uma correção de dado cria uma versão revisada e mantém a atual intacta. O
                  relatório revisado segue a cadência do seu plano; não há reenvio imediato.
                </p>
              </div>
            </div>
            {revise.isError ? (
              <p role="alert" className="notice warning">
                Não foi possível criar a revisão. Confira o motivo e tente novamente.
              </p>
            ) : null}
            <div className="button-row report-revise-row">
              <label className="sr-only" htmlFor="report-revise-reason">
                Motivo da revisão
              </label>
              <input
                id="report-revise-reason"
                type="text"
                value={reason}
                maxLength={200}
                placeholder="Ex.: liquidação corrigida após conferência"
                onChange={(event) => setReason(event.target.value)}
              />
              <Button
                disabled={reason.trim().length === 0 || revise.isPending}
                onClick={() => revise.mutate()}
              >
                {revise.isPending ? 'Criando revisão...' : 'Criar versão revisada'}
              </Button>
            </div>
          </section>
        </>
      ) : null}

      {history.data && history.data.items.length > 0 ? (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Histórico</h2>
              <p>Relatórios congelados desta conta, do mais recente para o mais antigo.</p>
            </div>
          </div>
          <div
            className="table-scroll"
            role="region"
            aria-label="Histórico de relatórios"
            tabIndex={0}
          >
            <table className="product-table">
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Versão</th>
                  <th>Emitido em</th>
                  <th>Versão do financeiro</th>
                  <th>
                    <span className="sr-only">Abrir</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td>{item.version}</td>
                    <td>
                      {new Date(item.createdAt).toLocaleString('pt-BR', {
                        timeZone: 'America/Sao_Paulo',
                      })}
                    </td>
                    <td className="tabular">{item.financialVersion}</td>
                    <td>
                      <Button variant="ghost" size="small" onClick={() => setSelectedId(item.id)}>
                        Abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
