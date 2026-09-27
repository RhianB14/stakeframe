import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  betPageSchema,
  betDetailSchema,
  journalPageSchema,
  formatBRL,
  saoPauloDate,
  type Bet,
  type Workspace,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request, dateLabel } from './api.js';
import type { OpenModal } from './ProductApp.js';
import { BetAttachments } from './imports.js';
import { betFinancialDisplay } from './financial-display.js';
import {
  betResultLabel,
  betResultQualifier,
  betTableColumns,
  betTablePresentation,
  sortBetRows,
  type BetTableColumnKey,
  type BetTableRow,
  type BetTableSortDirection,
} from '@stakeframe/shared';
import { readConsent, updateTelemetryConsent } from '../lib/telemetry.js';

const stateLabels = { open: 'Em aberto', settled: 'Liquidada', cancelled: 'Cancelada' };
const outcomeLabels: Record<string, string> = {
  win: 'Vitória',
  loss: 'Derrota',
  void: 'Anulação',
  half_win: 'Meia vitória',
  half_loss: 'Meia derrota',
  cashout: 'Cashout total',
  partial_cashout: 'Cashout parcial',
};
const journalLabels: Record<string, string> = {
  opening: 'Saldo inicial',
  deposit: 'Entrada',
  withdrawal: 'Retirada',
  transfer: 'Transferência',
  reconcile: 'Conciliação',
  bet_stake: 'Aposta registrada',
  settlement: 'Liquidação',
  freebet_return: 'Retorno de freebet',
  reversal: 'Estorno',
};
const catalogName = (workspace: Workspace, id: string | null) =>
  id ? (workspace.catalog.find((item) => item.id === id)?.name ?? '—') : '—';

const betAccessibleTitle = (bet: Bet) =>
  bet.selections[0]?.event?.trim() || bet.reference?.trim() || 'sem título';

function selectionScheduleText(selection: Bet['selections'][number]) {
  const label = selection.eventAt
    ? dateLabel(selection.eventAt)
    : selection.eventDate
      ? `${selection.eventDate.split('-').reverse().join('/')} · horário não informado`
      : 'Data do evento pendente';
  return selection.dateStatus === 'estimated' ? `${label} · estimada` : label;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const settle = (result: 'copied' | 'failed') => {
    setFeedback(result);
    timer.current = window.setTimeout(() => setFeedback('idle'), 2000);
  };
  const copy = async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      settle('copied');
    } catch {
      settle('failed');
    }
  };
  return (
    <span className="copy-id">
      <Button variant="ghost" size="small" aria-label={label} onClick={() => void copy()}>
        {feedback === 'copied' ? 'Copiado' : feedback === 'failed' ? 'Falhou' : 'Copiar'}
      </Button>
      <span className="sr-only" role="status">
        {feedback === 'copied'
          ? 'ID técnico copiado'
          : feedback === 'failed'
            ? 'Não foi possível copiar o ID'
            : ''}
      </span>
    </span>
  );
}

function BetIdValue({ bet }: { bet: Bet }) {
  return (
    <span className="bet-id-value">
      <code className="bet-id-compact" title={bet.id}>
        {bet.id}
      </code>
      <CopyButton
        value={bet.id}
        label={`Copiar ID técnico completo da aposta ${bet.ticketNumber}`}
      />
    </span>
  );
}

const columnClassNames: Partial<Record<BetTableColumnKey, string>> = {
  ticket: 'tabular',
  gameDate: 'tabular',
  gameTime: 'tabular',
  event: 'bet-event-cell',
  selection: 'bet-description-cell',
  stake: 'tabular',
  odds: 'tabular',
  id: 'bet-id-cell',
};

function BetTableCell({ row, column }: { row: BetTableRow; column: BetTableColumnKey }) {
  const { bet, details, result, tipster, bookmaker } = row;
  switch (column) {
    case 'ticket':
      return (
        <>
          <strong>#{bet.ticketNumber}</strong>
          {bet.freebetId ? <small>Freebet</small> : null}
        </>
      );
    case 'gameDate':
      return (
        <>
          {details.gameDate}
          {details.scheduleQualifier ? <small>{details.scheduleQualifier}</small> : null}
        </>
      );
    case 'gameTime':
      return <>{details.gameTime}</>;
    case 'event':
      return <>{details.event}</>;
    case 'selection':
      return <>{details.selection}</>;
    case 'market':
      return <>{details.market}</>;
    case 'ticketKind':
      return <>{details.ticketKind}</>;
    case 'tipster':
      return <>{tipster}</>;
    case 'bookmaker':
      return <>{bookmaker}</>;
    case 'stake':
      return <>{bet.stake === null ? 'A definir' : formatBRL(bet.stake)}</>;
    case 'odds':
      return <>{bet.odds ?? 'A definir'}</>;
    case 'return': {
      const financial = betFinancialDisplay(bet);
      return (
        <>
          {financial.returnText}
          {financial.qualifier !== 'Realizado' ? <small>{financial.qualifier}</small> : null}
        </>
      );
    }
    case 'result': {
      const qualifier = betResultQualifier(bet);
      return (
        <>
          <span className={`status-badge status-${bet.state}`}>{result}</span>
          {qualifier ? <small>{qualifier}</small> : null}
        </>
      );
    }
    case 'id':
      return <BetIdValue bet={bet} />;
  }
}

function BetListDetails({
  bet,
  workspace,
  open,
}: {
  bet: Bet;
  workspace: Workspace;
  open: OpenModal;
}) {
  const financial = betFinancialDisplay(bet);
  const freebetAmount =
    workspace.freebets.find((freebet) => freebet.id === bet.freebetId)?.amount ?? null;
  const details = betTablePresentation(bet, freebetAmount);
  const tipster = catalogName(workspace, bet.tipsterId);
  const bookmaker = catalogName(workspace, bet.bookmakerId);
  const result = betResultLabel(bet);
  const resultQualifier = betResultQualifier(bet);
  const accessibleTitle = bet.selections[0]?.event?.trim() || bet.reference?.trim() || 'sem título';
  const fields: { label: string; wide?: boolean; value: ReactNode }[] = [
    {
      label: 'Nº do bilhete',
      value: `#${bet.ticketNumber}${bet.freebetId ? ' · Freebet' : ''}`,
    },
    { label: 'Data do jogo', value: details.gameDate },
    { label: 'Hora do jogo', value: details.gameTime },
    { label: 'Evento', wide: true, value: details.event },
    { label: 'Aposta/seleção', wide: true, value: details.selection },
    { label: 'Mercado', value: details.market },
    { label: 'Tipo da aposta', value: details.ticketKind },
    { label: 'Tipster', value: tipster },
    { label: 'Casa de aposta', value: bookmaker },
    { label: 'Valor apostado', value: bet.stake === null ? 'A definir' : formatBRL(bet.stake) },
    { label: 'Odd', value: bet.odds ?? 'A definir' },
    {
      label: 'Retorno recebido',
      value: (
        <>
          <span className={financial.tone}>{financial.returnText}</span>
          {financial.qualifier !== 'Realizado' ? <small>{financial.qualifier}</small> : null}
        </>
      ),
    },
    {
      label: 'Resultado/status',
      wide: true,
      value: (
        <>
          <span className={`status-badge status-${bet.state}`}>{result}</span>
          {resultQualifier ? <small>{resultQualifier}</small> : null}
        </>
      ),
    },
    { label: 'ID técnico da aposta', wide: true, value: <BetIdValue bet={bet} /> },
  ];

  return (
    <article className="bet-list-card">
      <div className="bet-list-card-heading">
        <div>
          <small className="ticket-number">Bilhete #{bet.ticketNumber}</small>
          <strong>{details.event}</strong>
        </div>
        <span className={`status-badge status-${bet.state}`}>{result}</span>
      </div>
      <dl className="bet-list-card-fields">
        {fields.map((field) => (
          <div className={field.wide ? 'wide' : ''} key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      {bet.selections.length > 1 ? (
        <details className="bet-card-selections">
          <summary>Seleções do bilhete ({bet.selections.length})</summary>
          <ol>
            {bet.selections.map((selection, index) => (
              <li key={selection.id ?? `${bet.id}-${index}`}>
                <strong>
                  {index + 1}. {selection.event}
                </strong>
                <small>
                  {selection.market} · {selection.selection}
                </small>
                <small className={selection.dateStatus !== 'confirmed' ? 'pending-label' : 'muted'}>
                  {selectionScheduleText(selection)}
                </small>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {details.scheduleQualifier ? (
        <p className="bet-schedule-note">{details.scheduleQualifier}</p>
      ) : null}
      <Button
        variant="secondary"
        onClick={() => open({ kind: 'detail', id: bet.id })}
        aria-label={`Ver aposta ${accessibleTitle}`}
      >
        Abrir bilhete
      </Button>
    </article>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">▤</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function QueryNotice({
  error,
  loading,
  retry,
}: {
  error: boolean;
  loading: boolean;
  retry: () => void;
}) {
  return error ? (
    <div className="notice warning" role="alert">
      Não foi possível carregar os registros.
      <Button variant="secondary" onClick={retry}>
        Tentar novamente
      </Button>
    </div>
  ) : loading ? (
    <p className="loading-note" role="status">
      Carregando registros…
    </p>
  ) : null;
}
function Pagination({
  page,
  total,
  size,
  change,
}: {
  page: number;
  total: number;
  size: number;
  change: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total} {total === 1 ? 'registro' : 'registros'} · Página {page}
      </span>
      <div className="button-row">
        <Button
          variant="secondary"
          size="small"
          disabled={page === 1}
          onClick={() => change(page - 1)}
        >
          Anterior
        </Button>
        <Button
          variant="secondary"
          size="small"
          disabled={page * size >= total}
          onClick={() => change(page + 1)}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}
export function BetsPage({
  workspace,
  open,
  compact = false,
}: {
  workspace: Workspace;
  open: OpenModal;
  compact?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [house, setHouse] = useState('');
  const [tipster, setTipster] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<{
    column: BetTableColumnKey;
    direction: BetTableSortDirection;
  } | null>(null);
  const params = new URLSearchParams({ page: String(page), pageSize: compact ? '5' : '25' });
  if (state) params.set('state', state);
  if (house) params.set('bookmakerId', house);
  if (tipster) params.set('tipsterId', tipster);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = useQuery({
    queryKey: ['product', 'bets', workspace.version, params.toString()],
    queryFn: () => request(`/api/v1/bets?${params}`, betPageSchema),
  });
  const rows = useMemo<BetTableRow[]>(() => {
    if (!query.data) return [];
    return query.data.items.map((bet) => ({
      bet,
      details: betTablePresentation(
        bet,
        workspace.freebets.find((freebet) => freebet.id === bet.freebetId)?.amount ?? null,
      ),
      result: betResultLabel(bet),
      tipster: catalogName(workspace, bet.tipsterId),
      bookmaker: catalogName(workspace, bet.bookmakerId),
    }));
  }, [query.data, workspace]);
  const sortedRows = useMemo(
    () => (sort ? sortBetRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );
  const toggleSort = (column: BetTableColumnKey) => {
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
        : { column, direction: 'ascending' },
    );
  };
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{compact ? 'Últimas apostas' : 'Seus bilhetes'}</h2>
          <p>Valores e datas conforme seus registros</p>
        </div>
        {compact ? (
          <a className="text-link" href="#bets">
            Ver todas ↗
          </a>
        ) : null}
      </div>
      {!compact ? (
        <div className="filter-grid">
          <Field label="Situação">
            <select value={state} onChange={(event) => change(setState, event.target.value)}>
              <option value="">Todas</option>
              {Object.entries(stateLabels).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Casa">
            <select value={house} onChange={(event) => change(setHouse, event.target.value)}>
              <option value="">Todas as casas</option>
              {workspace.catalog
                .filter((item) => item.kind === 'bookmaker')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Tipster">
            <select value={tipster} onChange={(event) => change(setTipster, event.target.value)}>
              <option value="">Todos</option>
              {workspace.catalog
                .filter((item) => item.kind === 'tipster')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Data da aposta desde">
            <input
              type="date"
              value={from}
              onChange={(event) => change(setFrom, event.target.value)}
            />
          </Field>
          <Field label="Data da aposta até">
            <input type="date" value={to} onChange={(event) => change(setTo, event.target.value)} />
          </Field>
        </div>
      ) : null}
      <QueryNotice
        error={query.isError}
        loading={query.isPending}
        retry={() => {
          void query.refetch();
        }}
      />
      {query.data && !query.isError ? (
        query.data.total === 0 ? (
          <Empty
            title="Nenhuma aposta por aqui"
            detail={
              compact
                ? 'Seus bilhetes aparecerão aqui depois do primeiro registro.'
                : 'Registre uma aposta ou ajuste os filtros para consultar seu histórico.'
            }
          />
        ) : (
          <>
            {!compact ? (
              <p className="bet-table-scroll-hint">
                A tabela é mais larga que a tela. Deslize horizontalmente para ver todas as colunas.
                Use o título de uma coluna para ordenar os registros desta página.
              </p>
            ) : null}
            {!compact ? (
              <div className="bet-list-cards">
                {sortedRows.map((row) => (
                  <BetListDetails
                    key={row.bet.id}
                    bet={row.bet}
                    workspace={workspace}
                    open={open}
                  />
                ))}
              </div>
            ) : null}
            <div
              className={`table-scroll${compact ? '' : ' bet-table-desktop'}`}
              role="region"
              aria-label="Tabela de apostas"
              tabIndex={0}
            >
              <table className={`product-table${compact ? '' : ' bet-detail-table'}`}>
                <caption className="sr-only">
                  Apostas com jogo, mercado, tipo, valores e resultado
                </caption>
                <thead>
                  <tr>
                    {compact ? (
                      <>
                        <th>Nº / bilhete / evento</th>
                        <th>Casa</th>
                        <th>Valor</th>
                        <th>Odd</th>
                        <th>Situação</th>
                        <th>Resultado realizado</th>
                      </>
                    ) : (
                      betTableColumns.map((column) => (
                        <th
                          key={column.key}
                          aria-sort={column.key === sort?.column ? sort.direction : 'none'}
                        >
                          <button
                            type="button"
                            className="table-sort"
                            onClick={() => toggleSort(column.key)}
                          >
                            {column.label}
                          </button>
                        </th>
                      ))
                    )}
                    <th>
                      <span className="sr-only">Abrir</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const bet = row.bet;
                    const details = row.details;
                    const financial = betFinancialDisplay(bet);
                    if (!compact) {
                      return (
                        <tr key={bet.id}>
                          {betTableColumns.map((column) => (
                            <td
                              key={column.key}
                              className={
                                column.key === 'return'
                                  ? `tabular ${financial.tone}`
                                  : columnClassNames[column.key]
                              }
                            >
                              <BetTableCell row={row} column={column.key} />
                            </td>
                          ))}
                          <td>
                            <Button
                              variant="ghost"
                              size="small"
                              aria-label={`Ver aposta ${betAccessibleTitle(bet)}`}
                              onClick={() => open({ kind: 'detail', id: bet.id })}
                            >
                              Ver ↗
                            </Button>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={bet.id}>
                        <td>
                          <small className="ticket-number">Bilhete #{bet.ticketNumber}</small>
                          <button
                            className="table-title"
                            onClick={() => open({ kind: 'detail', id: bet.id })}
                          >
                            {details.event}
                            {bet.selections.length > 1 ? ` +${bet.selections.length - 1}` : ''}
                          </button>
                          <small>
                            {dateLabel(bet.placedAt)}
                            {bet.freebetId ? ' · Freebet' : ''}
                          </small>
                          {bet.selections.some((item) => item.dateStatus !== 'confirmed') ? (
                            <span className="pending-label">Data do evento a conferir</span>
                          ) : null}
                        </td>
                        <td>{catalogName(workspace, bet.bookmakerId)}</td>
                        <td className="tabular">
                          {formatBRL(bet.stake ?? '0.00')}
                          <small>
                            {bet.stakeUnits === null
                              ? 'Unidade a conferir'
                              : `${Number(bet.stakeUnits).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} u`}
                          </small>
                        </td>
                        <td className="tabular">{bet.odds ?? 'A definir'}</td>
                        <td>
                          <span className={`status-badge status-${bet.state}`}>
                            {stateLabels[bet.state]}
                          </span>
                        </td>
                        <td className={`tabular ${financial.tone}`}>
                          {financial.profitText}
                          {financial.qualifier !== 'Realizado' ? (
                            <small>{financial.qualifier}</small>
                          ) : null}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="small"
                            aria-label={`Ver aposta ${bet.selections[0]?.event ?? bet.reference}`}
                            onClick={() => open({ kind: 'detail', id: bet.id })}
                          >
                            Ver ↗
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!compact ? (
              <Pagination page={page} total={query.data.total} size={25} change={setPage} />
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
export function BetDetails({
  id,
  workspace,
  open,
}: {
  id: string;
  workspace: Workspace;
  open: OpenModal;
}) {
  const query = useQuery({
    queryKey: ['product', 'bet', id, workspace.version],
    queryFn: () => request(`/api/v1/bets/${id}`, betDetailSchema),
  });
  if (!query.data || query.isError)
    return (
      <QueryNotice
        error={query.isError}
        loading={query.isPending}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  const { bet, settlements } = query.data;
  const financial = betFinancialDisplay(bet);
  return (
    <div className="bet-detail">
      <div className="detail-heading">
        <span className={`status-badge status-${bet.state}`}>{stateLabels[bet.state]}</span>
        <strong>Bilhete #{bet.ticketNumber}</strong>
        <span>
          {catalogName(workspace, bet.bookmakerId)} · {catalogName(workspace, bet.tipsterId)}
        </span>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Valor apostado</span>
          <strong>
            {formatBRL(bet.stake ?? '0.00')}
            {bet.freebetId ? ' · freebet' : ''}
          </strong>
        </div>
        <div>
          <span>Odd total</span>
          <strong>{bet.odds ?? 'A definir'}</strong>
        </div>
        <div>
          <span>Principal aberto</span>
          <strong>{formatBRL(bet.remaining ?? '0.00')}</strong>
        </div>
        <div>
          <span>Retorno recebido</span>
          <strong className="neutral">{financial.returnText}</strong>
          {financial.qualifier !== 'Realizado' ? <small>{financial.qualifier}</small> : null}
        </div>
        <div>
          <span>Resultado realizado</span>
          <strong className={financial.tone}>{financial.profitText}</strong>
          {financial.qualifier !== 'Realizado' ? <small>{financial.qualifier}</small> : null}
        </div>
        <div>
          <span>Unidade do registro</span>
          <strong>{bet.unitAmount ? formatBRL(bet.unitAmount) : 'A conferir'}</strong>
        </div>
      </div>
      <p className="muted">
        Apostada em {dateLabel(bet.placedAt)} · Cadastrada em {dateLabel(bet.createdAt)}
      </p>
      {!bet.unitAmount || Number(bet.unitAmount) <= 0 ? (
        <div className="notice warning">
          <p>
            Esta aposta ainda não tem unidade histórica. Cadastre a unidade do mês de realização em
            Configurações e depois associe o valor conferido.
          </p>
          <Button
            variant="secondary"
            onClick={() =>
              open({
                kind: 'correction',
                title: 'Associar unidade histórica',
                build: (reason) => ({ type: 'bet.unit.resolve', id: bet.id, reason }),
              })
            }
          >
            Associar unidade histórica
          </Button>
        </div>
      ) : null}
      {bet.reference ? <p>Referência: {bet.reference}</p> : null}
      <BetAttachments id={id} version={workspace.version} open={open} />
      {bet.selections.map((selection, index) => (
        <div className="selection-form" key={index}>
          <strong>
            {index + 1}. {selection.event}
          </strong>
          <p>
            {selection.market} · {selection.selection}
          </p>
          <small>
            {selection.sport ?? 'Esporte não informado'}
            {selection.odds ? ` · Odd ${selection.odds}` : ''}
          </small>
          <p className={selection.dateStatus !== 'confirmed' ? 'pending-label' : 'muted'}>
            {selectionScheduleText(selection)}
          </p>
          {selection.id ? (
            <Button
              variant="ghost"
              size="small"
              onClick={() => open({ kind: 'event', id: selection.id! })}
            >
              Conferir data e fontes
            </Button>
          ) : null}
        </div>
      ))}
      <div className="button-row detail-actions">
        <Button variant="secondary" onClick={() => open({ kind: 'bet', bet })}>
          Corrigir dados
        </Button>
        {bet.state === 'open' ? (
          <Button onClick={() => open({ kind: 'settle', bet })}>Liquidar aposta</Button>
        ) : null}
        {bet.state === 'open' && !settlements.some((item) => !item.reversed) ? (
          <Button
            variant="destructive"
            onClick={() =>
              open({
                kind: 'correction',
                title: 'Cancelar registro da aposta',
                build: (reason, effectiveAt) => ({
                  type: 'bet.cancel',
                  id: bet.id,
                  reason,
                  effectiveAt,
                }),
              })
            }
          >
            Cancelar registro
          </Button>
        ) : null}
      </div>
      <h3>Histórico de liquidações</h3>
      {settlements.length === 0 ? (
        <p className="muted">Nenhuma liquidação registrada.</p>
      ) : (
        settlements.map((settlement) => (
          <div className="history-entry" key={settlement.id}>
            <div>
              <strong>
                {outcomeLabels[settlement.outcome]}
                {settlement.reversed ? ' · estornada' : ''}
              </strong>
              <p>
                Principal {formatBRL(settlement.closedPrincipal)} · Retorno{' '}
                {formatBRL(settlement.returnAmount)}
              </p>
              <small>
                {dateLabel(settlement.settledAt)} · {settlement.reason}
              </small>
            </div>
            {!settlement.reversed ? (
              <Button
                variant="ghost"
                size="small"
                onClick={() =>
                  open({
                    kind: 'correction',
                    title: 'Estornar liquidação',
                    build: (reason, effectiveAt) => ({
                      type: 'settlement.reverse',
                      id: settlement.id,
                      reason,
                      effectiveAt,
                    }),
                  })
                }
              >
                Estornar
              </Button>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
export function FinancePage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  const [page, setPage] = useState(1);
  const journal = useQuery({
    queryKey: ['product', 'journal', workspace.version, page],
    queryFn: () => request(`/api/v1/journal?page=${page}&pageSize=25`, journalPageSchema),
  });
  return (
    <>
      <div className="button-row page-actions">
        {(['deposit', 'withdrawal', 'transfer'] as const).map((kind) => (
          <Button
            key={kind}
            variant={kind === 'deposit' ? 'default' : 'secondary'}
            disabled={!workspace.initialized}
            onClick={() => open({ kind: 'cash', operation: kind })}
          >
            {kind === 'deposit' ? '+ Entrada' : kind === 'withdrawal' ? 'Retirada' : 'Transferir'}
          </Button>
        ))}
      </div>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Contas e saldos</h2>
            <p>Concilie com o valor disponível exibido em cada conta.</p>
          </div>
        </div>
        <div className="account-grid">
          {workspace.accounts.map((account) => (
            <div className="account-card account-vertical" key={account.id}>
              <span>{account.name}</span>
              <strong className={account.balance.startsWith('-') ? 'negative' : ''}>
                {formatBRL(account.balance)}
              </strong>
              <Button
                variant="ghost"
                size="small"
                disabled={!workspace.initialized}
                onClick={() =>
                  open({ kind: 'cash', operation: 'reconcile', accountId: account.id })
                }
              >
                Conciliar saldo ↗
              </Button>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Créditos de freebet</h2>
            <p>Créditos promocionais separados da banca real.</p>
          </div>
          <Button
            variant="secondary"
            size="small"
            disabled={!workspace.initialized}
            onClick={() => open({ kind: 'freebet' })}
          >
            + Freebet
          </Button>
        </div>
        {workspace.freebets.length === 0 ? (
          <Empty
            title="Sem créditos cadastrados"
            detail="Cadastre o valor, a validade e a regra de retorno da promoção."
          />
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Casa</th>
                  <th>Crédito</th>
                  <th>Validade</th>
                  <th>Situação</th>
                  <th>Regra do prêmio</th>
                </tr>
              </thead>
              <tbody>
                {workspace.freebets.map((item) => (
                  <tr key={item.id}>
                    <td>{catalogName(workspace, item.bookmakerId)}</td>
                    <td>{formatBRL(item.amount)}</td>
                    <td>{item.expiresOn.split('-').reverse().join('/')}</td>
                    <td>
                      {item.usedBy
                        ? 'Utilizada'
                        : item.expiresOn < saoPauloDate(new Date())
                          ? 'Expirada'
                          : 'Disponível'}
                    </td>
                    <td>
                      {item.stakeReturned ? 'Inclui valor promocional' : 'Sem valor promocional'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Movimentações</h2>
            <p>O histórico preserva lançamentos originais e estornos.</p>
          </div>
        </div>
        <QueryNotice
          error={journal.isError}
          loading={journal.isPending}
          retry={() => {
            void journal.refetch();
          }}
        />
        {journal.data && !journal.isError ? (
          journal.data.total === 0 ? (
            <Empty
              title="Histórico vazio"
              detail="As movimentações aparecerão após a confirmação dos saldos iniciais."
            />
          ) : (
            <>
              <div className="journal-list">
                {journal.data.items.map((item) => (
                  <div className="history-entry" key={item.id}>
                    <div>
                      <strong>
                        {journalLabels[item.kind] ?? item.kind}
                        {item.reversed ? ' · estornado' : ''}
                      </strong>
                      <small>{dateLabel(item.effectiveAt)}</small>
                      <p>{item.reason}</p>
                      <div className="posting-list">
                        {item.postings.map((posting, index) => (
                          <span key={index}>
                            {posting.accountName}{' '}
                            <b className={posting.amount.startsWith('-') ? 'negative' : ''}>
                              {formatBRL(posting.amount)}
                            </b>
                          </span>
                        ))}
                      </div>
                    </div>
                    {['deposit', 'withdrawal', 'transfer', 'reconcile'].includes(item.kind) &&
                    !item.reversed &&
                    !item.reversalOf ? (
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() =>
                          open({
                            kind: 'correction',
                            title: 'Estornar movimentação',
                            build: (reason, effectiveAt) => ({
                              type: 'journal.reverse',
                              id: item.id,
                              reason,
                              effectiveAt,
                            }),
                          })
                        }
                      >
                        Estornar
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              <Pagination page={page} size={25} total={journal.data.total} change={setPage} />
            </>
          )
        ) : null}
      </section>
    </>
  );
}
export function SettingsPage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  // STK-F1-10: preferências de telemetria (opt-in explícito, por dispositivo).
  const [consent, setConsent] = useState(readConsent());
  return (
    <>
      <div className="settings-grid">
        {(['bookmaker', 'tipster'] as const).map((kind) => (
          <section className="panel" key={kind}>
            <div className="section-heading">
              <h2>{kind === 'bookmaker' ? 'Casas de aposta' : 'Tipsters'}</h2>
              <Button
                variant="secondary"
                size="small"
                onClick={() => open({ kind: 'catalog', catalogKind: kind })}
              >
                Adicionar {kind === 'bookmaker' ? 'casa' : 'tipster'}
              </Button>
            </div>
            {workspace.catalog.filter((item) => item.kind === kind).length === 0 ? (
              <p className="muted">Nenhum cadastro ainda.</p>
            ) : (
              workspace.catalog
                .filter((item) => item.kind === kind)
                .map((item) => (
                  <div className="catalog-entry" key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      {!item.active ? <span className="pending-label">Inativo</span> : null}
                      <small>{item.aliases.join(' · ') || 'Sem nomes alternativos'}</small>
                    </div>
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`Editar ${item.name}`}
                      onClick={() => open({ kind: 'catalog', catalogKind: kind, item })}
                    >
                      Editar
                    </Button>
                  </div>
                ))
            )}
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Unidades mensais</h2>
            <p>Percentual para os próximos meses: {workspace.unitPercent.replace('.', ',')}%.</p>
          </div>
          <div className="button-row">
            <Button variant="secondary" size="small" onClick={() => open({ kind: 'settings' })}>
              Alterar percentual
            </Button>
            <Button
              size="small"
              disabled={!workspace.initialized}
              onClick={() => open({ kind: 'unit' })}
            >
              Conferir mês anterior
            </Button>
          </div>
        </div>
        {workspace.units.length === 0 ? (
          <Empty
            title="Nenhuma unidade congelada"
            detail="A primeira unidade será definida na confirmação dos saldos."
          />
        ) : (
          <div className="table-scroll">
            <table className="product-table">
              <thead>
                <tr>
                  <th>Mês</th>
                  <th>Unidade</th>
                  <th>Base de cálculo</th>
                  <th>Origem</th>
                </tr>
              </thead>
              <tbody>
                {workspace.units.map((unit) => (
                  <tr key={unit.month}>
                    <td>{unit.month.split('-').reverse().join('/')}</td>
                    <td>{formatBRL(unit.amount)}</td>
                    <td>
                      {unit.source === 'manual'
                        ? 'Valor informado pelo proprietário'
                        : formatBRL(unit.base)}
                    </td>
                    <td>
                      {unit.source === 'initial'
                        ? 'Saldos iniciais'
                        : unit.source === 'automatic'
                          ? 'Virada do mês'
                          : 'Conferência histórica'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="panel-footnote">
          A unidade permanece fixa durante o mês. Datas financeiras seguem o horário de São Paulo.
        </p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Privacidade e análises</h2>
            <p>
              Telemetria é opcional e desligada por padrão. Quando ativada, usa apenas
              identificadores pseudônimos — bilhetes, valores, prompts e imagens nunca são enviados.
            </p>
          </div>
        </div>
        <label className="consent-row">
          <input
            type="checkbox"
            checked={consent.analytics}
            onChange={(event) =>
              setConsent(updateTelemetryConsent('analytics', event.target.checked))
            }
          />
          <span>
            <strong>Análises de uso</strong>
            <small>
              Métricas de navegação (PostHog Cloud EU) para melhorar o produto. Sem gravação de
              tela.
            </small>
          </span>
        </label>
        <label className="consent-row">
          <input
            type="checkbox"
            checked={consent.replay}
            onChange={(event) => setConsent(updateTelemetryConsent('replay', event.target.checked))}
          />
          <span>
            <strong>Gravação de sessão</strong>
            <small>
              Replay mascarado (Sentry), nunca nas telas de bilhetes, finanças ou configurações.
            </small>
          </span>
        </label>
      </section>
    </>
  );
}
