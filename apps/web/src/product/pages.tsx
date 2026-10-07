import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  betPageSchema,
  betDetailSchema,
  journalPageSchema,
  formatBRL,
  formatBRLWhenPresent,
  saoPauloDate,
  type Bet,
  type Workspace,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request, dateLabel } from './api.js';
import { TelegramLinkPanel } from './telegram-link.js';
import type { OpenModal } from './ProductApp.js';
import { BetAttachments } from './imports.js';
import { betFinancialDisplay, journalNetEffect, centsLabel } from './financial-display.js';
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
import { BetColumnsPanel, loadBetColumns } from './bet-columns-panel.js';
import { betStatusLabel, betStatusNeedsReview, betStatusTone } from './bet-status.js';

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

function betScheduledDate(bet: Bet) {
  const dates = bet.selections.flatMap((selection) => {
    if (selection.dateStatus !== 'confirmed') return [];
    if (selection.eventAt) return [saoPauloDate(new Date(selection.eventAt))];
    return selection.eventDate ? [selection.eventDate] : [];
  });
  return dates.sort()[0] ?? null;
}

function outcomeLabel(outcome: string) {
  return (
    {
      open: 'EM ABERTO',
      won: 'GANHOU',
      lost: 'PERDEU',
      void: 'ANULADA',
      cashout: 'RESGATE',
    }[outcome] ?? outcome.toUpperCase()
  );
}

function unitsValue(amount: string, unitAmount: string | null) {
  if (/^-?0+(?:\.0{1,2})?$/.test(amount)) return '0.00U';
  if (!unitAmount || !/^\d+(?:\.\d{1,2})?$/.test(unitAmount)) return null;
  const cents = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  };
  const divisor = cents(unitAmount);
  if (divisor <= 0n) return null;
  const negative = amount.startsWith('-');
  const raw = cents(negative ? amount.slice(1) : amount);
  const hundredths = (raw * 100n + divisor / 2n) / divisor;
  const whole = hundredths / 100n;
  const fraction = String(hundredths % 100n).padStart(2, '0');
  return `${negative && hundredths > 0n ? '-' : ''}${whole}.${fraction}U`;
}

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

/**
 * STK-F3-02 — a etiqueta de situação da aposta.
 *
 * A cor vem de `betStatusTone`, que lê o RESULTADO e não o `state`: os três
 * estados da aposta (aberta, liquidada, cancelada) e os resultados possíveis
 * não são a mesma coisa, e uma etiqueta que pinte "aberta" de verde está
 * afirmando um resultado que ainda não existe.
 */
function BetStatusTag({ bet }: { bet: Bet }) {
  const tone = betStatusTone(bet);
  return (
    <span className={`status-badge bet-status-${tone}`}>
      {betStatusLabel(bet)}
      {betStatusNeedsReview(bet) ? <span className="bet-status-review"> · a conferir</span> : null}
    </span>
  );
}

function BetTableCell({ row, column }: { row: BetTableRow; column: BetTableColumnKey }) {
  const { bet, details, tipster, bookmaker } = row;
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
          <BetStatusTag bet={bet} />
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
      <span aria-hidden="true" className="empty-mark" />
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
  owner,
  compact = false,
}: {
  workspace: Workspace;
  open: OpenModal;
  owner: string;
  compact?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [house, setHouse] = useState('');
  const [tipster, setTipster] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amountMode, setAmountMode] = useState<'money' | 'units'>('units');
  const [hideAmounts, setHideAmounts] = useState(false);
  const [historyOutcome, setHistoryOutcome] = useState('all');
  const [dateDescending, setDateDescending] = useState(true);
  // STK-F2-18 (Fase 3): as 14 colunas aprovadas não cabem na largura útil.
  // O painel escolhe quais aparecem; a ordem continua sendo a do produto.
  const [visibleColumns, setVisibleColumns] = useState<BetTableColumnKey[]>(() =>
    loadBetColumns(owner),
  );
  const columns = useMemo(
    () => betTableColumns.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns],
  );
  const [sort, setSort] = useState<{
    column: BetTableColumnKey;
    direction: BetTableSortDirection;
  } | null>(null);
  const params = new URLSearchParams({ page: String(page), pageSize: compact ? '5' : '100' });
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
  const advancedFilterCount = [house, tipster, from, to].filter(Boolean).length;
  // STK-F2-18 (PR-3): a dica de rolagem passa a ser medida, não estimada.
  // Antes ela dependia de `columns.length > 8`, um proxy que mentia: oito
  // colunas cabem na largura útil em algumas janelas e não cabem em outras,
  // e o piso de largura do CSS não era consultado por ninguém. Agora o aviso
  // aparece quando `scrollWidth` realmente passa de `clientWidth`, que é a
  // condição de fato. Redimensionar a janela ou trocar colunas reavalia.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || compact) {
      setOverflows(false);
      return;
    }
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, columns.length, sortedRows.length]);

  if (!compact) {
    const today = saoPauloDate(new Date());
    const scheduledRows = rows.filter((row) => {
      const scheduled = betScheduledDate(row.bet);
      return scheduled !== null && scheduled >= today;
    });
    const historyRows = rows.filter((row) => {
      const scheduled = betScheduledDate(row.bet);
      return scheduled === null || scheduled < today;
    });
    const outcomeFor = (bet: Bet) => {
      if (bet.state === 'cancelled' || bet.latestOutcome === 'void') return 'void';
      if (bet.latestOutcome === 'cashout' || bet.latestOutcome === 'partial_cashout')
        return 'cashout';
      if (bet.latestOutcome === 'win' || bet.latestOutcome === 'half_win') return 'won';
      if (bet.latestOutcome === 'loss' || bet.latestOutcome === 'half_loss') return 'lost';
      return 'open';
    };
    const filteredHistory = historyRows
      .filter((row) => historyOutcome === 'all' || outcomeFor(row.bet) === historyOutcome)
      .sort((left, right) => {
        const compared = left.bet.placedAt.localeCompare(right.bet.placedAt);
        return dateDescending ? -compared : compared;
      });
    const currentMonth = today.slice(0, 7);
    const currentUnit = workspace.units.find((unit) => unit.month === currentMonth)?.amount ?? null;
    const amountText = (money: string | null, units: string | null) => {
      if (hideAmounts) return '••••';
      return amountMode === 'money' ? formatBRLWhenPresent(money) : (units ?? '—');
    };
    const exposure =
      amountMode === 'money'
        ? formatBRL(workspace.exposure)
        : (unitsValue(workspace.exposure, currentUnit) ?? '—');
    return (
      <section className="bets-reference-page" aria-label="Apostas">
        <header className="bets-reference-heading">
          <h2>APOSTAS</h2>
          <div className="bets-reference-actions">
            <div
              className="bets-mode-toggle"
              role="group"
              aria-label="Exibir valores em dinheiro ou unidades"
            >
              <button
                type="button"
                className={amountMode === 'money' ? 'is-active' : ''}
                aria-pressed={amountMode === 'money'}
                onClick={() => setAmountMode('money')}
              >
                $
              </button>
              <button
                type="button"
                className={amountMode === 'units' ? 'is-active' : ''}
                aria-pressed={amountMode === 'units'}
                onClick={() => setAmountMode('units')}
              >
                U
              </button>
            </div>
            <button
              className="bets-visibility-toggle"
              type="button"
              aria-label={hideAmounts ? 'Mostrar valores' : 'Ocultar valores'}
              aria-pressed={hideAmounts}
              onClick={() => setHideAmounts((hidden) => !hidden)}
            >
              <span aria-hidden="true">◉</span>
            </button>
            <Button
              className="bet-new-action"
              disabled={!workspace.initialized}
              onClick={() => open({ kind: 'bet' })}
            >
              ＋ NOVA APOSTA
            </Button>
          </div>
        </header>

        <div className="bets-reference-section-heading">
          <h3>
            APOSTAS DE HOJE <span>{scheduledRows.length}</span>
          </h3>
          <p>
            <span>EM RISCO</span> <strong>{hideAmounts ? '••••' : exposure}</strong>
          </p>
        </div>
        {scheduledRows.length === 0 ? (
          <div className="bets-reference-empty">
            <svg className="bets-reference-pitch" viewBox="0 0 100 100" aria-hidden="true">
              <g transform="rotate(42 50 50)" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="20" y="9" width="60" height="82" />
                <path d="M20 50h60M34 9v16h32V9M34 91V75h32v16M41 9v5h18V9M41 91v-5h18v5" />
                <circle cx="50" cy="50" r="8" />
                <circle cx="50" cy="50" r=".8" fill="currentColor" />
                <path d="M43 9a7 7 0 0 0 14 0M43 91a7 7 0 0 1 14 0M20 14a5 5 0 0 0 5-5M75 9a5 5 0 0 0 5 5M20 86a5 5 0 0 1 5 5M75 91a5 5 0 0 1 5-5" />
              </g>
            </svg>
            <h3>NENHUMA APOSTA PARA HOJE</h3>
            <p>
              As apostas com data de hoje ou futura aparecem aqui — abertas ou já encerradas, cada
              uma com seu resultado. As anteriores ficam no histórico.
            </p>
            <Button
              variant="secondary"
              disabled={!workspace.initialized}
              onClick={() => open({ kind: 'bet' })}
            >
              REGISTRAR A PRIMEIRA APOSTA
            </Button>
          </div>
        ) : (
          <div className="bets-reference-table-wrap">
            <table className="product-table bets-reference-table">
              <thead>
                <tr>
                  <th>ESPORTE</th>
                  <th>SELEÇÃO</th>
                  <th>ODD</th>
                  <th>VALOR</th>
                  <th>SITUAÇÃO</th>
                  <th>RESULTADO</th>
                </tr>
              </thead>
              <tbody>
                {scheduledRows.map(({ bet }) => {
                  const row = rows.find((item) => item.bet.id === bet.id)!;
                  const financial = betFinancialDisplay(bet);
                  return (
                    <tr key={bet.id} data-outcome={bet.latestOutcome ?? undefined}>
                      <td className="bets-sport-cell">
                        {bet.selections[0]?.sport?.slice(0, 3).toUpperCase() ||
                          bet.ticketKind.slice(0, 3).toUpperCase()}
                      </td>
                      <td>
                        <button
                          className="table-title"
                          onClick={() => open({ kind: 'detail', id: bet.id })}
                        >
                          {bet.selections[0]?.event ?? bet.reference ?? `Bet #${bet.ticketNumber}`}
                        </button>
                        <small>{bet.selections[0]?.selection ?? row.details.selection}</small>
                      </td>
                      <td className="tabular">{bet.odds ?? '—'}</td>
                      <td className="tabular">
                        {amountText(
                          bet.stake,
                          bet.stakeUnits ? `${Number(bet.stakeUnits).toFixed(2)}U` : null,
                        )}
                      </td>
                      <td>
                        <span className={`bets-result-tag is-${outcomeFor(bet)}`}>
                          {outcomeLabel(outcomeFor(bet))}
                        </span>
                      </td>
                      <td className={`tabular ${financial.tone}`}>
                        {hideAmounts
                          ? '••••'
                          : amountMode === 'money'
                            ? financial.profitText
                            : (unitsValue(bet.profit, bet.unitAmount) ?? '—')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="bets-reference-section-heading bets-history-heading">
          <h3>
            HISTÓRICO <span>{filteredHistory.length}</span>
          </h3>
        </div>
        <div className="bets-reference-toolbar">
          <div className="bet-state-tabs" role="group" aria-label="Filtrar histórico por resultado">
            {[
              ['all', 'TODAS'],
              ['won', 'GANHAS'],
              ['lost', 'PERDIDAS'],
              ['void', 'ANULADAS'],
              ['cashout', 'RESGATE'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={historyOutcome === value ? 'is-active' : ''}
                aria-pressed={historyOutcome === value}
                onClick={() => setHistoryOutcome(value!)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="bets-date-sort"
            type="button"
            onClick={() => setDateDescending((descending) => !descending)}
            aria-label={`Ordenar por data, ${dateDescending ? 'mais recentes primeiro' : 'mais antigas primeiro'}`}
          >
            DATA <span aria-hidden="true">{dateDescending ? '▼' : '▲'}</span>
          </button>
        </div>
        {historyRows.length === 0 ? (
          <div className="bets-reference-history-empty">
            Seu histórico de apostas aparecerá aqui.
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="bets-reference-history-empty">
            Nenhuma aposta encontrada para este resultado.
          </div>
        ) : (
          <>
            <div className="bets-reference-table-wrap">
              <table className="product-table bets-reference-table bets-history-table">
                <thead>
                  <tr>
                    <th>ESPORTE</th>
                    <th>SELEÇÃO</th>
                    <th>ODD</th>
                    <th>VALOR</th>
                    <th>SITUAÇÃO</th>
                    <th>RESULTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map(({ bet, details }) => {
                    const financial = betFinancialDisplay(bet);
                    const outcome = outcomeFor(bet);
                    return (
                      <tr key={bet.id} data-outcome={bet.latestOutcome ?? undefined}>
                        <td className="bets-sport-cell">
                          {bet.selections[0]?.sport?.slice(0, 3).toUpperCase() ||
                            bet.ticketKind.slice(0, 3).toUpperCase()}
                        </td>
                        <td>
                          <button
                            className="table-title"
                            onClick={() => open({ kind: 'detail', id: bet.id })}
                          >
                            {details.event}
                            {bet.selections.length > 1
                              ? ` · ${bet.selections.length} seleções`
                              : ''}
                          </button>
                          <small>
                            {bet.selections[0]?.selection ?? details.selection} ·{' '}
                            {dateLabel(bet.placedAt)}
                          </small>
                        </td>
                        <td className="tabular">{bet.odds ?? '—'}</td>
                        <td className="tabular">
                          {amountText(
                            bet.stake,
                            bet.stakeUnits ? `${Number(bet.stakeUnits).toFixed(2)}U` : null,
                          )}
                        </td>
                        <td>
                          <span className={`bets-result-tag is-${outcome}`}>
                            {outcomeLabel(outcome)}
                          </span>
                        </td>
                        <td className={`tabular ${financial.tone}`}>
                          {hideAmounts
                            ? '••••'
                            : amountMode === 'money'
                              ? financial.profitText
                              : (unitsValue(bet.profit, bet.unitAmount) ?? '—')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {query.data && query.data.total > query.data.items.length ? (
          <Pagination page={page} total={query.data.total} size={100} change={setPage} />
        ) : null}
        <QueryNotice
          error={query.isError}
          loading={query.isPending}
          retry={() => {
            void query.refetch();
          }}
        />
      </section>
    );
  }
  return (
    <section className={`panel bets-page-panel${compact ? ' is-compact' : ''}`}>
      <div className="section-heading">
        <div>
          <h2>{compact ? 'Últimas apostas' : 'Suas apostas'}</h2>
          <p>
            {compact
              ? 'Valores e datas conforme seus registros'
              : 'Bilhetes, estado e resultado financeiro'}
          </p>
        </div>
        {compact ? (
          <a className="text-link" href="#bets">
            Ver todas
          </a>
        ) : (
          <div className="bets-heading-actions">
            <div className="bets-exposure">
              <span>EM JOGO</span>
              <strong>{formatBRL(workspace.exposure)}</strong>
            </div>
            <Button
              variant="secondary"
              className="bet-new-action"
              disabled={!workspace.initialized}
              onClick={() => open({ kind: 'bet' })}
            >
              Nova aposta
            </Button>
            <BetColumnsPanel owner={owner} columns={visibleColumns} onChange={setVisibleColumns} />
          </div>
        )}
      </div>
      {!compact ? (
        <>
          <div className="bet-state-tabs" role="group" aria-label="Filtrar apostas por situação">
            {[
              { value: '', label: 'Todas' },
              { value: 'open', label: 'Em aberto' },
              { value: 'settled', label: 'Liquidadas' },
              { value: 'cancelled', label: 'Canceladas' },
            ].map((option) => (
              <button
                key={option.value || 'all'}
                type="button"
                className={state === option.value ? 'is-active' : undefined}
                aria-pressed={state === option.value}
                onClick={() => change(setState, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <details className="bet-advanced-filters" open={advancedFilterCount > 0}>
            <summary>
              Filtros avançados
              {advancedFilterCount > 0 ? <span>{advancedFilterCount} ativos</span> : null}
            </summary>
            <div className="filter-grid">
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
                <select
                  value={tipster}
                  onChange={(event) => change(setTipster, event.target.value)}
                >
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
                <input
                  type="date"
                  value={to}
                  onChange={(event) => change(setTo, event.target.value)}
                />
              </Field>
            </div>
          </details>
        </>
      ) : null}
      <QueryNotice
        error={query.isError}
        loading={query.isPending}
        retry={() => {
          void query.refetch();
        }}
      />
      {!compact && query.data && !query.isError && query.data.total > 0 ? (
        <div className="bet-results-heading">
          <h3>Lista de apostas</h3>
          <span>{query.data.total}</span>
        </div>
      ) : null}
      {query.data && !query.isError ? (
        query.data.total === 0 ? (
          <div className="bet-empty-state">
            <Empty
              title="Nenhuma aposta por aqui"
              detail={
                compact
                  ? 'Seus bilhetes aparecerão aqui depois do primeiro registro.'
                  : 'Registre uma aposta ou ajuste os filtros para consultar seu histórico.'
              }
            />
            {!compact ? (
              <Button variant="secondary" onClick={() => open({ kind: 'bet' })}>
                Registrar a primeira aposta
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            {!compact ? (
              /* STK-F2-18 (PR-3): a condição era `columns.length > 8`, um
                 proxy que mentia em duas direções — oito colunas cabem numa
                 janela larga e não cabem numa estreita, e o proxy não sabia
                 de nada disso. A dica agora depende da geometria real
                 (`scrollWidth > clientWidth`), que é o que o usuário
                 sente. `aria-hidden` porque a região rolável já é focável e
                 anuncia o seu próprio alcance. */
              overflows ? (
                <p className="bet-table-scroll-hint">
                  A tabela é mais larga que a tela. Deslize horizontalmente para ver as demais
                  colunas, ou use o painel de colunas para escolher quais exibir.
                </p>
              ) : null
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
              ref={scrollRef}
              className={`table-scroll${compact ? '' : ' bet-table-desktop'}`}
              role="region"
              aria-label="Tabela de apostas"
              tabIndex={0}
            >
              <table
                className={`product-table${compact ? '' : ' bet-detail-table'}`}
                // O CSS dimensiona o piso da tabela a partir desta contagem.
                style={
                  compact
                    ? undefined
                    : ({ '--bet-columns': String(columns.length) } as CSSProperties)
                }
              >
                <caption className="sr-only">
                  Apostas com jogo, mercado, tipo, valores e resultado
                </caption>
                <thead>
                  <tr>
                    {compact ? (
                      <>
                        <th data-column="ticket">Nº / bilhete / evento</th>
                        <th data-column="bookmaker">Casa</th>
                        <th data-column="stake">Valor</th>
                        <th data-column="odds">Odd</th>
                        <th data-column="result">Situação</th>
                        <th data-column="return">Resultado realizado</th>
                      </>
                    ) : (
                      columns.map((column) => (
                        <th
                          key={column.key}
                          data-column={column.key}
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
                    <th data-column="open">
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
                        <tr
                          key={bet.id}
                          data-state={bet.state}
                          data-outcome={bet.latestOutcome ?? undefined}
                        >
                          {columns.map((column) => (
                            <td
                              key={column.key}
                              // STK-F2-18: a coluna precisa de identidade no
                              // DOM. Com o painel de colunas, a posição
                              // deixou de ser fixa — um `td` por índice
                              // passou a apontar para outra coluna quando
                              // alguém esconde uma. `data-column` é o que
                              // permite ao teste (e a quem depurar no
                              // inspector) dizer qual coluna é qual.
                              data-column={column.key}
                              className={
                                column.key === 'return'
                                  ? `tabular ${financial.tone}`
                                  : columnClassNames[column.key]
                              }
                            >
                              <BetTableCell row={row} column={column.key} />
                            </td>
                          ))}
                          <td data-column="open" className="bet-actions-cell">
                            {/* STK-F3-02: as duas ações de linha. "ver" abre
                                o BetDrawer (o detalhe ao lado da lista, que
                                é onde a comparação entre linhas continua
                                possível) e "editar" abre o editor da aposta —
                                o mesmo `{ kind: 'bet' }` que o detalhe já
                                usa, e que portanto corrige dados em vez de
                                criar outro.

                                Os dois têm `aria-label` com o TÍTULO da
                                aposta, não com a palavra da ação: numa lista
                                de 25 linhas, "Editar" repetido 25 vezes não
                                diz a ninguém qual aposta será corrigida. O
                                rótulo visível é curto e o nome acessível é
                                completo — é a divisão que o leitor de tela
                                precisa.

                                O alvo de toque de 44px é CSS (`.bet-row-action`),
                                não atributo: o botão cresce por baixo em vez
                                de empurrar as linhas vizinhas. */}
                            <div className="bet-row-actions">
                              <Button
                                variant="ghost"
                                size="small"
                                className="bet-row-action"
                                aria-label={`Ver aposta ${betAccessibleTitle(bet)}`}
                                onClick={() => open({ kind: 'detail', id: bet.id })}
                              >
                                Ver
                              </Button>
                              <Button
                                variant="ghost"
                                size="small"
                                className="bet-row-action"
                                aria-label={`Editar aposta ${betAccessibleTitle(bet)}`}
                                onClick={() => open({ kind: 'bet', bet })}
                              >
                                Editar
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={bet.id}>
                        <td data-column="ticket">
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
                        <td data-column="bookmaker">{catalogName(workspace, bet.bookmakerId)}</td>
                        {/* STK-F3-02: `tabular` sozinho dá a FIGURA fixa (dígitos
                            do mesmo peso) e nada mais: sem `align-end` a coluna
                            continuaria com o texto grudado à esquerda, e a régua
                            de centavos não se formaria. `bet-number-cell` faz as
                            duas coisas. */}
                        <td data-column="stake" className="tabular bet-number-cell">
                          {formatBRLWhenPresent(bet.stake)}
                          <small>
                            {bet.stakeUnits === null
                              ? 'Unidade a conferir'
                              : `${Number(bet.stakeUnits).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} u`}
                          </small>
                        </td>
                        <td data-column="odds" className="tabular">
                          {bet.odds ?? 'A definir'}
                        </td>
                        <td data-column="result">
                          <BetStatusTag bet={bet} />
                        </td>
                        <td data-column="return" className={`tabular ${financial.tone}`}>
                          {financial.profitText}
                          {financial.qualifier !== 'Realizado' ? (
                            <small>{financial.qualifier}</small>
                          ) : null}
                        </td>
                        <td data-column="open">
                          <Button
                            variant="ghost"
                            size="small"
                            aria-label={`Ver aposta ${bet.selections[0]?.event ?? bet.reference}`}
                            onClick={() => open({ kind: 'detail', id: bet.id })}
                          >
                            Ver
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
            {formatBRLWhenPresent(bet.stake)}
            {bet.freebetId ? ' · freebet' : ''}
          </strong>
        </div>
        <div>
          <span>Odd total</span>
          <strong>{bet.odds ?? 'A definir'}</strong>
        </div>
        <div>
          <span>Principal aberto</span>
          <strong>{formatBRLWhenPresent(bet.remaining)}</strong>
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
  const [moveKind, setMoveKind] = useState<'deposit' | 'withdrawal'>('deposit');
  const [moveAmount, setMoveAmount] = useState('');
  const currentMonth = saoPauloDate(new Date()).slice(0, 7);
  const currentUnit = workspace.units.find((unit) => unit.month === currentMonth) ?? null;
  const unitPercent =
    currentUnit && Number(workspace.bankroll) > 0
      ? ((Number(currentUnit.amount) / Number(workspace.bankroll)) * 100)
          .toFixed(2)
          .replace('.', ',')
      : null;
  const journal = useQuery({
    queryKey: ['product', 'journal', workspace.version, page],
    queryFn: async () => {
      const current = await request(`/api/v1/journal?page=${page}&pageSize=25`, journalPageSchema);
      if (page === 1) return { ...current, newerNet: 0n };
      const newerPages = await Promise.all(
        Array.from({ length: page - 1 }, (_, index) =>
          request(`/api/v1/journal?page=${index + 1}&pageSize=25`, journalPageSchema),
        ),
      );
      const newerNet = newerPages
        .flatMap((result) => result.items)
        .reduce((total, item) => total + journalNetEffect(item.postings), 0n);
      return { ...current, newerNet };
    },
  });
  const historyRows = (() => {
    if (!journal.data?.items) return [];
    let balance = BigInt(workspace.bankroll.replace('.', '')) - journal.data.newerNet;
    return journal.data.items.map((item) => {
      const after = balance;
      balance -= journalNetEffect(item.postings);
      return { item, after };
    });
  })();
  return (
    <div className="bankroll-reference-page">
      <header className="bankroll-reference-heading">
        <div>
          <h1>Banca</h1>
          <p>SUA BANCA, SUAS MOVIMENTAÇÕES E AS REGRAS QUE A ORIENTAM</p>
        </div>
      </header>

      <div className="bankroll-overview-grid">
        <section className="bankroll-reference-card bankroll-current-card">
          <span className="bankroll-kicker">BANCA ATUAL</span>
          <strong className="bankroll-current-value">{formatBRL(workspace.bankroll)}</strong>
          <div className="bankroll-card-divider" />
          <span className="bankroll-kicker">COMPOSIÇÃO DA BANCA</span>
          <div className="bankroll-composition-row">
            <span>Disponível</span>
            <b>{formatBRL(workspace.available)}</b>
          </div>
          <div className="bankroll-composition-row">
            <span>Em apostas abertas</span>
            <b>{formatBRL(workspace.exposure)}</b>
          </div>
        </section>
        <section className="bankroll-reference-card bankroll-move-card">
          <span className="bankroll-kicker">MOVIMENTAR DINHEIRO</span>
          <p>
            Registre o que entrou ou saiu da sua banca. Os lançamentos ficam no histórico para você
            acompanhar a origem de cada valor.
          </p>
          <div className="bankroll-move-tabs" role="group" aria-label="Tipo de movimentação">
            <button
              type="button"
              className={moveKind === 'deposit' ? 'is-active' : ''}
              onClick={() => setMoveKind('deposit')}
            >
              Depósito
            </button>
            <button
              type="button"
              className={moveKind === 'withdrawal' ? 'is-active' : ''}
              onClick={() => setMoveKind('withdrawal')}
            >
              Retirada
            </button>
          </div>
          <div className="bankroll-move-controls">
            <label>
              <span>R$</span>
              <input
                aria-label="Valor da movimentação"
                inputMode="decimal"
                placeholder="0,00"
                value={moveAmount}
                onChange={(event) => setMoveAmount(event.target.value)}
              />
            </label>
            <Button
              disabled={
                !workspace.initialized || workspace.accounts.length === 0 || !moveAmount.trim()
              }
              onClick={() => open({ kind: 'cash', operation: moveKind, amount: moveAmount })}
            >
              Registrar
            </Button>
          </div>
        </section>
      </div>

      <section className="bankroll-reference-rules">
        <div className="bankroll-reference-section-title">
          <h2>Regras da banca</h2>
          <p>
            O limite diário é um percentual da banca e se recalcula quando ela muda. A unidade é um
            valor fixo e não muda sozinha: você não aumenta a unidade apenas porque a banca cresceu.
            Aqui você vê que percentual ela representa hoje e se saiu da faixa; aumentá-la é uma
            decisão sua, não um efeito automático.
          </p>
        </div>
        <div className="bankroll-rules-grid">
          <article className="bankroll-reference-card bankroll-rule-card">
            <div className="bankroll-rule-card-top">
              <span className="bankroll-kicker">TAMANHO DA UNIDADE</span>
              <span className="bankroll-kicker">DA BANCA</span>
            </div>
            <div className="bankroll-rule-card-values">
              <strong>{currentUnit ? formatBRL(currentUnit.amount) : 'A definir'}</strong>
              <b>{unitPercent ? `${unitPercent}%` : '—'}</b>
            </div>
            <div className="bankroll-unit-track" aria-hidden="true">
              <span className={currentUnit ? 'has-unit' : ''} />
            </div>
            <div className="bankroll-rule-card-bottom">
              <span>
                {currentUnit
                  ? `UNIDADE DE ${currentMonth.split('-').reverse().join('/')}`
                  : 'NENHUMA UNIDADE DEFINIDA'}
              </span>
              <Button variant="secondary" size="small" onClick={() => open({ kind: 'settings' })}>
                Alterar
              </Button>
            </div>
          </article>
          <article className="bankroll-reference-card bankroll-rule-card">
            <div className="bankroll-rule-card-top">
              <span className="bankroll-kicker">LIMITE DIÁRIO</span>
              <span className="bankroll-kicker">DA BANCA</span>
            </div>
            <div className="bankroll-rule-card-values">
              <strong>Não configurado</strong>
              <b>—</b>
            </div>
            <div className="bankroll-rule-card-bottom">
              <span>O STAKEFRAME NÃO POSSUI LIMITE DIÁRIO</span>
            </div>
          </article>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Contas e saldos</h2>
            <p>
              O saldo que cada casa mostra contra o valor confirmado aqui. A diferença entre as duas
              colunas é a conciliação que ainda não foi feita.
            </p>
          </div>
          <Button
            variant="secondary"
            size="small"
            disabled={!workspace.initialized}
            onClick={() => open({ kind: 'cash', operation: 'transfer' })}
          >
            Transferir
          </Button>
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
                Conciliar saldo
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
      <section className="bankroll-transactions" aria-labelledby="bankroll-transactions-title">
        <div className="bankroll-transactions-heading">
          <h2 id="bankroll-transactions-title">Movimentações da banca</h2>
          <span>Mais recentes primeiro</span>
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
              <div className="table-scroll">
                <table className="product-table journal-table bankroll-transactions-table">
                  <caption className="sr-only">
                    Movimentações do razão, da mais recente para a mais antiga
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Movimentação</th>
                      <th scope="col" className="num">
                        Valor
                      </th>
                      <th scope="col" className="num">
                        Banca após
                      </th>
                      <th scope="col">Quando</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map(({ item, after }) => {
                      const net = journalNetEffect(item.postings);
                      const reversible =
                        ['deposit', 'withdrawal', 'transfer', 'reconcile'].includes(item.kind) &&
                        !item.reversed &&
                        !item.reversalOf;
                      return (
                        <tr
                          key={item.id}
                          className={item.reversed ? 'journal-reversed' : undefined}
                        >
                          <td>
                            <strong>
                              {journalLabels[item.kind] ?? item.kind}
                              {item.reversed ? ' · estornado' : ''}
                            </strong>
                            <small className="bankroll-history-reason">{item.reason}</small>
                            {reversible ? (
                              <Button
                                variant="ghost"
                                size="small"
                                className="bankroll-reverse-action"
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
                          </td>
                          <td className="num">
                            <b
                              className={net < 0n ? 'negative' : net > 0n ? 'positive' : undefined}
                            >
                              {centsLabel(net)}
                            </b>
                          </td>
                          <td className="num">
                            <b>{centsLabel(after)}</b>
                          </td>
                          <td className="journal-date">{dateLabel(item.effectiveAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} size={25} total={journal.data.total} change={setPage} />
            </>
          )
        ) : null}
      </section>
      <p className="bankroll-history-note">
        O histórico mostra os lançamentos registrados no Stakeframe. Movimentações feitas fora do
        aplicativo não aparecem aqui.
      </p>
    </div>
  );
}
export function SettingsPage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  return (
    <>
      <TelegramLinkPanel />
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
    </>
  );
}
