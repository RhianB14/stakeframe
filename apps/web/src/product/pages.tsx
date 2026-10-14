import {
  displayLocale,
  displayTimeZone,
  formatDisplayDate,
  formatDisplayMoney,
  formatDisplayOdds,
} from './preferences.js';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  betPageSchema,
  betDetailSchema,
  journalPageSchema,
  cents,
  saoPauloDate,
  suggestedReturn,
  type Bet,
  type Workspace,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { ProductErrorIcon } from './product-error-icon.js';
import { BetForm, Field } from './forms.js';
import { request, dateLabel, localInstant, localNow } from './api.js';
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
import { ticketSportLabel } from './sports.js';
import { BET_MARKET_TYPES, betMarketTypesForSelections } from './bet-types.js';
import { useFinanceActions } from './actions.js';
import { dailyLimitStateSchema } from './daily-limit.js';

const stateLabels = { open: 'Em aberto', settled: 'Liquidada', cancelled: 'Cancelada' };
const betTrackPreferencesKey = 'bettrack.preview.preferences';
const betTrackBooksKey = 'bettrack.preview.books';
const outcomeLabels: Record<string, string> = {
  win: 'Vitória',
  loss: 'Derrota',
  void: 'Anulação',
  half_win: 'Meia vitória',
  half_loss: 'Meia derrota',
  cashout: 'Cashout total',
  partial_cashout: 'Cashout parcial',
};
const BET_HISTORY_COLUMNS = [
  { key: 'id', label: 'ID', width: 108 },
  { key: 'dateTime', label: 'DATE / TIME', width: 180 },
  { key: 'selection', label: 'SELECTION', width: 260 },
  { key: 'bookmaker', label: 'BOOKMAKER', width: 125 },
  { key: 'sport', label: 'SPORT / LEAGUE', width: 125 },
  { key: 'event', label: 'EVENT', width: 210 },
  { key: 'betType', label: 'BET TYPE', width: 150 },
  { key: 'tipster', label: 'TIPSTER', width: 108 },
  { key: 'stake', label: 'STAKE', width: 110 },
  { key: 'odds', label: 'ODDS', width: 82 },
  { key: 'status', label: 'STATUS', width: 116 },
  { key: 'result', label: 'RESULT', width: 116 },
] as const;
type BetHistoryColumnKey = (typeof BET_HISTORY_COLUMNS)[number]['key'];
const BET_HISTORY_COLUMN_KEYS = BET_HISTORY_COLUMNS.map((column) => column.key);
const BET_HISTORY_COLUMN_KEY_SET = new Set<string>(BET_HISTORY_COLUMN_KEYS);
const betHistoryColumnsStorageKey = (owner: string) => `stakeframe.bet-history-columns.v1.${owner}`;
const BET_HISTORY_OUTCOMES = [
  ['all', 'ALL'],
  ['open', 'OPEN'],
  ['settled', 'SETTLED'],
  ['won', 'WON'],
  ['lost', 'LOST'],
  ['void', 'VOID'],
  ['cashout', 'CASH OUT'],
] as const;
function readBetHistoryColumns(owner: string): BetHistoryColumnKey[] {
  const fallback = [...BET_HISTORY_COLUMN_KEYS];
  try {
    const raw = window.localStorage.getItem(betHistoryColumnsStorageKey(owner));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some((key) => typeof key !== 'string' || !BET_HISTORY_COLUMN_KEY_SET.has(key))
    )
      return fallback;
    const selected = new Set(parsed as BetHistoryColumnKey[]);
    return BET_HISTORY_COLUMNS.filter((column) => selected.has(column.key)).map(
      (column) => column.key,
    );
  } catch {
    return fallback;
  }
}
function writeBetHistoryColumns(owner: string, columns: readonly BetHistoryColumnKey[]) {
  try {
    window.localStorage.setItem(betHistoryColumnsStorageKey(owner), JSON.stringify(columns));
  } catch {
    // A private browsing session can reject storage; the current choice still applies in memory.
  }
}
const betTrackOutcomeLabels: Record<NonNullable<Bet['latestOutcome']>, string> = {
  win: 'WON',
  loss: 'LOST',
  void: 'VOID',
  half_win: 'HALF WON',
  half_loss: 'HALF LOST',
  cashout: 'CASH OUT',
  partial_cashout: 'CASH OUT',
};
const journalLabels: Record<string, string> = {
  opening: 'Saldo inicial',
  deposit: 'Entrada',
  withdrawal: 'Retirada',
  transfer: 'Transferência',
  reconcile: 'Conciliação',
  bet_stake: 'Aposta registrada',
  bet_stake_correction: 'Correção da aposta',
  bet_cancel: 'Aposta anulada',
  settlement: 'Liquidação',
  freebet_return: 'Retorno de freebet',
  reversal: 'Estorno',
};
const catalogName = (workspace: Workspace, id: string | null) =>
  id ? (workspace.catalog.find((item) => item.id === id)?.name ?? '—') : '—';

function presentBetRows(items: Bet[], workspace: Workspace): BetTableRow[] {
  return items.map((bet) => ({
    bet,
    details: betTablePresentation(
      bet,
      workspace.freebets.find((freebet) => freebet.id === bet.freebetId)?.amount ?? null,
    ),
    result: betResultLabel(bet),
    tipster: catalogName(workspace, bet.tipsterId),
    bookmaker: catalogName(workspace, bet.bookmakerId),
  }));
}

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

function moneyFromCents(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function unitHundredths(amount: string | null | undefined, unitAmount: string | null | undefined) {
  if (!amount || !unitAmount) return null;
  const amountCents = cents(amount);
  const unitCents = cents(unitAmount);
  if (unitCents <= 0n) return null;
  const sign = amountCents < 0n ? -1n : 1n;
  const absolute = amountCents * sign;
  return sign * ((absolute * 100n + unitCents / 2n) / unitCents);
}

function formatUnitHundredths(value: bigint) {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '−' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}U`;
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

function BetTableCell({
  row,
  column,
  amountMode,
  hideAmounts,
}: {
  row: BetTableRow;
  column: BetTableColumnKey;
  amountMode: 'money' | 'units';
  hideAmounts: boolean;
}) {
  const { bet, details, tipster, bookmaker } = row;
  switch (column) {
    case 'ticket':
      return (
        <>
          <strong>#{bet.reference?.trim() || String(bet.ticketNumber).padStart(6, '0')}</strong>
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
    case 'stake': {
      if (hideAmounts) return <>••••</>;
      if (bet.stake === null) return <>A definir</>;
      return amountMode === 'money' ? (
        <>{formatDisplayMoney(bet.stake)}</>
      ) : (
        <>{unitsValue(bet.stake, bet.unitAmount) ?? '—'}</>
      );
    }
    case 'odds':
      return <>{formatDisplayOdds(bet.odds)}</>;
    case 'return': {
      const financial = betFinancialDisplay(bet);
      const value =
        financial.returnText === '—' || amountMode === 'money'
          ? financial.returnText
          : (unitsValue(bet.returnAmount, bet.unitAmount) ?? '—');
      return (
        <>
          {hideAmounts ? '••••' : value}
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
    {
      label: 'Valor apostado',
      value: bet.stake === null ? 'A definir' : formatDisplayMoney(bet.stake),
    },
    { label: 'Odd', value: formatDisplayOdds(bet.odds) },
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

function BetTrackTicketCard({
  row,
  amountMode,
  hideAmounts,
  unitAmount,
}: {
  row: BetTableRow;
  amountMode: 'money' | 'units';
  hideAmounts: boolean;
  unitAmount: string | null;
  open: OpenModal;
}) {
  const { bet, details } = row;
  const firstSelection = bet.selections[0];
  const outcome =
    bet.state === 'cancelled' || bet.latestOutcome === 'void'
      ? 'void'
      : bet.latestOutcome === 'cashout' || bet.latestOutcome === 'partial_cashout'
        ? 'cashout'
        : bet.latestOutcome === 'win' || bet.latestOutcome === 'half_win'
          ? 'won'
          : bet.latestOutcome === 'loss' || bet.latestOutcome === 'half_loss'
            ? 'lost'
            : 'open';
  const outcomeLabel = {
    won: 'WON',
    lost: 'LOST',
    void: 'VOID',
    cashout: 'CASH OUT',
    open: 'OPEN',
  }[outcome];
  const sports = [...new Set(bet.selections.map((selection) => ticketSportLabel(selection.sport)))];
  const typeLabel =
    bet.ticketKind === 'multiple'
      ? 'PARLAY'
      : bet.ticketKind === 'betbuild'
        ? 'BET BUILDER'
        : 'STRAIGHT';
  const cardSport = sports.length > 1 ? 'multi' : (sports[0] ?? 'oth').toLowerCase();
  const accessibleTitle =
    bet.ticketKind === 'multiple'
      ? `${bet.selections.length}-Leg Multi-Sport Parlay`
      : (firstSelection?.selection ?? details.selection);
  const financial = betFinancialDisplay(bet);
  const isPotentialReturn = bet.state === 'open' && financial.qualifier === 'Não liquidado';
  const displayedReturn = isPotentialReturn ? details.potentialReturn : bet.returnAmount;
  const amountText = (value: string | null) => {
    if (hideAmounts) return '••••';
    if (value === null) return '—';
    if (amountMode === 'money') return formatDisplayMoney(value);
    const units = unitsValue(value, unitAmount);
    if (!units || units === '—') return '—';
    const numeric = Number(units.replace(/U$/, '').replace('−', '-').replace(',', '.'));
    return Number.isFinite(numeric) ? `${numeric.toFixed(2).replace('-', '−')}U` : units;
  };
  const resultText = amountText(bet.profit);

  return (
    <a
      className="bet-list-card bettrack-ticket-card"
      data-outcome={outcome}
      data-sport={cardSport}
      href={`#bets/${bet.id}`}
      aria-label={`Open ${accessibleTitle} — ${outcome === 'open' ? 'Open' : outcomeLabel}`}
      onClick={() => {
        window.sessionStorage.setItem('bettrack:bet-edit-amount-mode', amountMode);
        window.sessionStorage.removeItem('bettrack:bet-edit-return');
        window.scrollTo(0, 0);
      }}
    >
      <header className="bettrack-ticket-head">
        <strong>{row.bookmaker === '—' ? 'NO BOOK' : row.bookmaker.toUpperCase()}</strong>
        <span>#{bet.reference?.trim() || String(bet.ticketNumber).padStart(6, '0')}</span>
      </header>
      <div className="bettrack-ticket-meta">
        {bet.ticketKind === 'multiple' || bet.ticketKind === 'betbuild' ? (
          <>
            <span className="bettrack-ticket-kind-label">{typeLabel}</span>
            <span className="bettrack-ticket-sports">
              {sports.map((sport, index) => (
                <span key={sport} data-sport={sport.toLowerCase()}>
                  {index > 0 ? <i>·</i> : null}
                  {sport}
                </span>
              ))}
            </span>
          </>
        ) : (
          <>
            <span className="bettrack-ticket-sports">
              <span data-sport={(sports[0] ?? 'oth').toLowerCase()}>{sports[0] ?? 'OTH'}</span>
            </span>
            <span className="bettrack-ticket-kind-label">{typeLabel}</span>
          </>
        )}
        <b>{formatDisplayOdds(bet.odds)}</b>
      </div>
      <div className="bettrack-ticket-content">
        <span className="bettrack-ticket-title">
          {bet.ticketKind !== 'simple' && bet.selections.length > 1
            ? `${bet.selections.length} SELECTIONS`
            : (firstSelection?.selection ?? details.selection)}
        </span>
        {bet.selections.length > 1 ? (
          <div className="bettrack-ticket-selections">
            {bet.selections.slice(0, 2).map((selection, index) => (
              <div key={selection.id ?? `${bet.id}-${index}`}>
                <span data-sport={ticketSportLabel(selection.sport).toLowerCase()}>
                  {ticketSportLabel(selection.sport)}
                </span>
                <p>
                  <strong>{selection.selection}</strong>
                </p>
                <b>{formatDisplayOdds(selection.odds)}</b>
              </div>
            ))}
            {bet.selections.length > 2 ? (
              <small className="bettrack-ticket-more">
                +{bet.selections.length - 2} SELECCIONES
              </small>
            ) : null}
          </div>
        ) : (
          <small className="bettrack-ticket-event">{firstSelection?.event ?? details.event}</small>
        )}
        {outcome !== 'open' ? (
          <span className={`bettrack-ticket-stamp is-${outcome}`}>{outcomeLabel}</span>
        ) : null}
      </div>
      <div className="bettrack-ticket-amounts">
        <div>
          <small>AMOUNT</small>
          <strong>{amountText(bet.stake)}</strong>
        </div>
        <div>
          <small>{isPotentialReturn ? 'TO WIN' : 'PAID'}</small>
          <strong>{amountText(displayedReturn)}</strong>
        </div>
      </div>
      <footer
        className={`bettrack-ticket-result ${financial.tone}${outcome === 'open' ? ' is-open' : ''}`}
      >
        {outcome === 'open' ? (
          <span className="bettrack-ticket-open-label">OPEN</span>
        ) : (
          <>
            <span>RESULT</span>
            <strong>{resultText}</strong>
          </>
        )}
      </footer>
    </a>
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
    <div className="notice warning product-error-alert" role="alert">
      <ProductErrorIcon />
      <div>
        <p>Não foi possível carregar os registros.</p>
        <Button variant="secondary" onClick={retry}>
          Tentar novamente
        </Button>
      </div>
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
  type HistoryFilters = {
    search: string;
    bookmakerId: string;
    tipsterId: string;
    from: string;
    to: string;
    sport: string;
    ticketKind: string;
    marketType: string;
    outcome: 'all' | 'open' | 'settled' | 'won' | 'lost' | 'void' | 'cashout';
  };
  const emptyHistoryFilters: HistoryFilters = {
    search: '',
    bookmakerId: '',
    tipsterId: '',
    from: '',
    to: '',
    sport: '',
    ticketKind: '',
    marketType: '',
    outcome: 'all',
  };
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [house, setHouse] = useState('');
  const [tipster, setTipster] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amountMode, setAmountMode] = useState<'money' | 'units'>('units');
  const [hideAmounts, setHideAmounts] = useState(false);
  const [draftHistoryFilters, setDraftHistoryFilters] = useState(emptyHistoryFilters);
  const [activeHistoryFilters, setActiveHistoryFilters] = useState(emptyHistoryFilters);
  const [visibleHistoryColumns, setVisibleHistoryColumns] = useState<BetHistoryColumnKey[]>(() =>
    readBetHistoryColumns(owner),
  );
  const [dateDescending, setDateDescending] = useState(true);
  const [historySort, setHistorySort] = useState<'date' | 'odds' | 'amount' | 'result'>('date');
  const [expandedHistorySelections, setExpandedHistorySelections] = useState<Set<string>>(
    () => new Set(),
  );
  // STK-F2-18 (Fase 3): as 14 colunas aprovadas não cabem na largura útil.
  // O painel escolhe quais aparecem; a ordem continua sendo a do produto.
  const [visibleColumns, setVisibleColumns] = useState<BetTableColumnKey[]>(() =>
    loadBetColumns(owner),
  );
  const columns = useMemo(
    () => betTableColumns.filter((column) => visibleColumns.includes(column.key)),
    [visibleColumns],
  );
  const historyColumns = BET_HISTORY_COLUMNS.filter((column) =>
    visibleHistoryColumns.includes(column.key),
  );
  const historyTableWidth = historyColumns.reduce((total, column) => total + column.width, 0);
  const toggleHistoryColumn = (key: BetHistoryColumnKey) => {
    setVisibleHistoryColumns((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(key) && nextSet.size > 1) nextSet.delete(key);
      else nextSet.add(key);
      const next = BET_HISTORY_COLUMNS.filter((column) => nextSet.has(column.key)).map(
        (column) => column.key,
      );
      writeBetHistoryColumns(owner, next);
      return next;
    });
  };
  const resetHistoryColumns = () => {
    const next = [...BET_HISTORY_COLUMN_KEYS];
    writeBetHistoryColumns(owner, next);
    setVisibleHistoryColumns(next);
  };
  const [sort, setSort] = useState<{
    column: BetTableColumnKey;
    direction: BetTableSortDirection;
  } | null>(null);

  useEffect(() => {
    setVisibleHistoryColumns(readBetHistoryColumns(owner));
  }, [owner]);
  const params = new URLSearchParams({
    page: String(compact ? page : 1),
    pageSize: compact ? '5' : '100',
  });
  if (compact && state) params.set('state', state);
  if (compact && house) params.set('bookmakerId', house);
  if (compact && tipster) params.set('tipsterId', tipster);
  if (compact && from) params.set('from', from);
  if (compact && to) params.set('to', to);
  const query = useQuery({
    queryKey: ['product', 'bets', workspace.version, params.toString()],
    queryFn: () => request(`/api/v1/bets?${params}`, betPageSchema),
  });
  const historyParams = new URLSearchParams({
    page: String(page),
    pageSize: '100',
    historyBefore: saoPauloDate(new Date()),
  });
  if (activeHistoryFilters.search.trim())
    historyParams.set('search', activeHistoryFilters.search.trim());
  if (activeHistoryFilters.bookmakerId)
    historyParams.set('bookmakerId', activeHistoryFilters.bookmakerId);
  if (activeHistoryFilters.sport) historyParams.set('sport', activeHistoryFilters.sport);
  if (activeHistoryFilters.ticketKind)
    historyParams.set('ticketKind', activeHistoryFilters.ticketKind);
  if (activeHistoryFilters.marketType)
    historyParams.set('marketType', activeHistoryFilters.marketType);
  if (activeHistoryFilters.tipsterId)
    historyParams.set('tipsterId', activeHistoryFilters.tipsterId);
  if (activeHistoryFilters.from) historyParams.set('from', activeHistoryFilters.from);
  if (activeHistoryFilters.to) historyParams.set('to', activeHistoryFilters.to);
  if (activeHistoryFilters.outcome !== 'all')
    historyParams.set('historyOutcome', activeHistoryFilters.outcome);
  const historyQuery = useQuery({
    queryKey: ['product', 'bets', 'history', workspace.version, historyParams.toString()],
    queryFn: () => request(`/api/v1/bets?${historyParams}`, betPageSchema),
    enabled: !compact,
  });
  const rows = useMemo(
    () => presentBetRows(query.data?.items ?? [], workspace),
    [query.data, workspace],
  );
  const historyQueryRows = useMemo(
    () => presentBetRows(historyQuery.data?.items ?? [], workspace),
    [historyQuery.data, workspace],
  );
  const historyMarketTypeOptions = [
    ...new Set([
      ...BET_MARKET_TYPES,
      ...historyQueryRows.flatMap((row) => betMarketTypesForSelections(row.bet.selections)),
    ]),
  ];
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
  const changeHistoryDraft = <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) =>
    setDraftHistoryFilters((current) => ({ ...current, [key]: value }));
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };
  const applyHistoryFilters = () => {
    setActiveHistoryFilters({ ...draftHistoryFilters });
    setPage(1);
  };
  const clearHistoryFilters = () => {
    setDraftHistoryFilters(emptyHistoryFilters);
    setActiveHistoryFilters(emptyHistoryFilters);
    setPage(1);
  };
  const advancedFilterCount = Object.entries(activeHistoryFilters).filter(([key, value]) =>
    key === 'outcome' ? value !== 'all' : Boolean(value),
  ).length;
  const compactAdvancedFilterCount = [house, tipster, from, to].filter(Boolean).length;
  const historyFiltersDirty = Object.keys(emptyHistoryFilters).some(
    (key) =>
      draftHistoryFilters[key as keyof HistoryFilters] !==
      activeHistoryFilters[key as keyof HistoryFilters],
  );
  // STK-F2-18 (PR-3): a dica de rolagem passa a ser medida, não estimada.
  // Antes ela dependia de `columns.length > 8`, um proxy que mentia: oito
  // colunas cabem na largura útil em algumas janelas e não cabem em outras,
  // e o piso de largura do CSS não era consultado por ninguém. Agora o aviso
  // aparece quando `scrollWidth` realmente passa de `clientWidth`, que é a
  // condição de fato. Redimensionar a janela ou trocar colunas reavalia.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [historyOverflows, setHistoryOverflows] = useState(false);
  useEffect(() => {
    const elements = [scrollRef.current, historyScrollRef.current].filter(
      (element): element is HTMLDivElement => element !== null,
    );
    if (elements.length === 0 || compact) {
      setOverflows(false);
      setHistoryOverflows(false);
      return;
    }
    const measure = () => {
      const todayTable = scrollRef.current;
      const historyTable = historyScrollRef.current;
      setOverflows(!!todayTable && todayTable.scrollWidth > todayTable.clientWidth);
      setHistoryOverflows(!!historyTable && historyTable.scrollWidth > historyTable.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [
    compact,
    columns.length,
    historyColumns.length,
    sortedRows.length,
    historyQueryRows.length,
    activeHistoryFilters,
  ]);

  if (!compact) {
    const today = saoPauloDate(new Date());
    const scheduledRows = rows.filter((row) => {
      const scheduled = betScheduledDate(row.bet);
      return scheduled !== null && scheduled >= today;
    });
    const outcomeFor = (bet: Bet) => {
      if (bet.state === 'cancelled' || bet.latestOutcome === 'void') return 'void';
      if (bet.latestOutcome === 'cashout' || bet.latestOutcome === 'partial_cashout')
        return 'cashout';
      if (bet.latestOutcome === 'win' || bet.latestOutcome === 'half_win') return 'won';
      if (bet.latestOutcome === 'loss' || bet.latestOutcome === 'half_loss') return 'lost';
      return bet.state === 'settled' ? 'settled' : 'open';
    };
    const displayedScheduledRows = sort
      ? sortBetRows(scheduledRows, sort.column, sort.direction)
      : scheduledRows;
    const todayOpenRows = scheduledRows.filter((row) => row.bet.state === 'open');
    const todayExposureCents = todayOpenRows.reduce(
      (total, row) => total + cents(row.bet.remaining ?? row.bet.stake ?? '0'),
      0n,
    );
    const todayProfitCents = scheduledRows
      .filter((row) => row.bet.state !== 'cancelled')
      .reduce((total, row) => total + cents(row.bet.profit ?? '0'), 0n);
    const todayExposureUnitValues = todayOpenRows.map((row) =>
      unitHundredths(row.bet.remaining ?? row.bet.stake, row.bet.unitAmount),
    );
    const todayExposureUnits = todayExposureUnitValues.every((value) => value !== null)
      ? todayExposureUnitValues.reduce<bigint>((total, value) => total + (value ?? 0n), 0n)
      : null;
    const todayProfitUnitValues = scheduledRows
      .filter((row) => row.bet.state !== 'cancelled')
      .map((row) => unitHundredths(row.bet.profit ?? '0.00', row.bet.unitAmount));
    const todayProfitUnits = todayProfitUnitValues.every((value) => value !== null)
      ? todayProfitUnitValues.reduce<bigint>((total, value) => total + (value ?? 0n), 0n)
      : null;
    const exposure =
      amountMode === 'money'
        ? formatDisplayMoney(moneyFromCents(todayExposureCents))
        : todayExposureUnits === null
          ? '—'
          : formatUnitHundredths(todayExposureUnits);
    const dayNet = hideAmounts
      ? '••••'
      : amountMode === 'money'
        ? `${todayProfitCents > 0n ? '+' : ''}${formatDisplayMoney(moneyFromCents(todayProfitCents))}`
        : todayProfitUnits === null
          ? '—'
          : `${todayProfitUnits > 0n ? '+' : ''}${formatUnitHundredths(todayProfitUnits)}`;
    const dayNetTone =
      todayProfitCents > 0n ? 'is-positive' : todayProfitCents < 0n ? 'is-negative' : '';
    const statusText = (bet: Bet) =>
      bet.state === 'cancelled' || bet.latestOutcome === 'void'
        ? 'VOID'
        : bet.latestOutcome === 'win' || bet.latestOutcome === 'half_win'
          ? 'WON'
          : bet.latestOutcome === 'loss' || bet.latestOutcome === 'half_loss'
            ? 'LOST'
            : bet.latestOutcome === 'cashout' || bet.latestOutcome === 'partial_cashout'
              ? 'CASH OUT'
              : bet.state === 'settled'
                ? 'SETTLED'
                : 'OPEN';
    const ticketTypeLabelFor = (bet: Bet) =>
      bet.ticketKind === 'multiple'
        ? 'PARLAY'
        : bet.ticketKind === 'betbuild'
          ? 'BET BUILDER'
          : 'STRAIGHT';
    const marketTypesFor = (bet: Bet) => betMarketTypesForSelections(bet.selections);
    const typeLabelFor = (bet: Bet) => {
      const marketTypes = marketTypesFor(bet);
      if (marketTypes.length > 1) return `${marketTypes[0]} +${marketTypes.length - 1}`;
      return marketTypes[0] ?? '—';
    };
    const typeTitleFor = (bet: Bet) => marketTypesFor(bet).join(' · ') || '—';
    const sportTag = (bet: Bet) => {
      if (bet.ticketKind !== 'simple') return 'MULTI';
      const sport = bet.selections[0]?.sport ?? '';
      return sport.trim() ? ticketSportLabel(sport) : '—';
    };
    const sportsLabel = (bet: Bet) => {
      const sports = [
        ...new Set(bet.selections.map((selection) => ticketSportLabel(selection.sport))),
      ];
      return sports.filter((sport) => sport !== 'OTH').join(' · ') || '—';
    };
    const placedTime = (value: string) =>
      new Intl.DateTimeFormat(displayLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: displayTimeZone(),
      }).format(new Date(value));
    const selectionLabel = (bet: Bet) => {
      const selections = bet.selections.map((selection) => {
        const market = selection.market.trim();
        const pick = selection.selection.trim();
        const normalizedMarket = market.toLocaleLowerCase('en-US');
        if (
          !market ||
          normalizedMarket === pick.toLocaleLowerCase('en-US') ||
          [
            'simple',
            'straight',
            'multiple',
            'parlay',
            'betbuild',
            'bet builder',
            'multi-sport parlay',
            'a definir',
          ].includes(normalizedMarket)
        ) {
          return pick;
        }
        if (bet.ticketKind !== 'simple' && /parlay|builder/i.test(pick)) return pick;
        return `${market}: ${pick}`;
      });
      return [...new Set(selections.filter(Boolean))].join(' · ') || '—';
    };
    const searchTerm = activeHistoryFilters.search.trim().toLocaleLowerCase(displayLocale());
    const historyRows = historyQueryRows.filter((row) => {
      const scheduled = betScheduledDate(row.bet);
      if (scheduled !== null && scheduled >= today) return false;
      const placedDate = saoPauloDate(new Date(row.bet.placedAt));
      if (
        activeHistoryFilters.bookmakerId &&
        row.bet.bookmakerId !== activeHistoryFilters.bookmakerId
      )
        return false;
      if (activeHistoryFilters.tipsterId && row.bet.tipsterId !== activeHistoryFilters.tipsterId)
        return false;
      if (activeHistoryFilters.from && placedDate < activeHistoryFilters.from) return false;
      if (activeHistoryFilters.to && placedDate > activeHistoryFilters.to) return false;
      if (
        activeHistoryFilters.sport &&
        !row.bet.selections.some(
          (selection) =>
            selection.sport?.trim().toLocaleLowerCase() ===
            activeHistoryFilters.sport.toLocaleLowerCase(),
        )
      )
        return false;
      if (activeHistoryFilters.ticketKind && row.bet.ticketKind !== activeHistoryFilters.ticketKind)
        return false;
      if (
        activeHistoryFilters.marketType &&
        !marketTypesFor(row.bet).some(
          (marketType) => marketType === activeHistoryFilters.marketType,
        )
      )
        return false;
      if (
        activeHistoryFilters.outcome !== 'all' &&
        outcomeFor(row.bet) !== activeHistoryFilters.outcome
      )
        return false;
      if (searchTerm) {
        const searchable = [
          row.bet.reference,
          String(row.bet.ticketNumber),
          row.bookmaker,
          row.tipster,
          ticketTypeLabelFor(row.bet),
          typeLabelFor(row.bet),
          typeTitleFor(row.bet),
          sportsLabel(row.bet),
          row.details.event,
          selectionLabel(row.bet),
        ]
          .join(' ')
          .toLocaleLowerCase(displayLocale());
        if (!searchable.includes(searchTerm)) return false;
      }
      return true;
    });
    const filteredHistory = historyRows;
    const displayedHistoryRows = [...filteredHistory].sort((left, right) => {
      const compared =
        historySort === 'date'
          ? left.bet.placedAt.localeCompare(right.bet.placedAt)
          : historySort === 'odds'
            ? Number(left.bet.odds ?? 0) - Number(right.bet.odds ?? 0)
            : historySort === 'amount'
              ? Number(left.bet.stake ?? 0) - Number(right.bet.stake ?? 0)
              : outcomeFor(left.bet).localeCompare(outcomeFor(right.bet));
      return dateDescending ? -compared : compared;
    });
    const completeHistoryPage =
      historyQuery.data !== undefined && historyQuery.data.items.length === historyQuery.data.total;
    const historySummaryFallback = {
      count: completeHistoryPage
        ? filteredHistory.length
        : (historyQuery.data?.total ?? filteredHistory.length),
      stake: moneyFromCents(
        filteredHistory.reduce((total, row) => total + cents(row.bet.stake ?? '0'), 0n),
      ),
      profit: moneyFromCents(
        filteredHistory.reduce((total, row) => total + cents(row.bet.profit ?? '0'), 0n),
      ),
      stakeUnits: (() => {
        if (!completeHistoryPage) return null;
        const values = filteredHistory.map((row) =>
          unitHundredths(row.bet.stake, row.bet.unitAmount),
        );
        return values.every((value) => value !== null)
          ? moneyFromCents(values.reduce<bigint>((total, value) => total + (value ?? 0n), 0n))
          : null;
      })(),
      profitUnits: (() => {
        if (!completeHistoryPage) return null;
        const values = filteredHistory.map((row) =>
          unitHundredths(row.bet.profit ?? '0.00', row.bet.unitAmount),
        );
        return values.every((value) => value !== null)
          ? moneyFromCents(values.reduce<bigint>((total, value) => total + (value ?? 0n), 0n))
          : null;
      })(),
      missingUnitBets: completeHistoryPage
        ? filteredHistory.filter((row) => !row.bet.unitAmount || cents(row.bet.unitAmount) <= 0n)
            .length
        : (historyQuery.data?.summary?.missingUnitBets ?? null),
    };
    const historySummary = completeHistoryPage
      ? historySummaryFallback
      : (historyQuery.data?.summary ?? historySummaryFallback);
    const historyTotal = completeHistoryPage
      ? filteredHistory.length
      : (historyQuery.data?.total ?? filteredHistory.length);
    const historyNetValue = Number(
      amountMode === 'money' ? historySummary.profit : (historySummary.profitUnits ?? '0'),
    );
    const historyNetTone =
      historyNetValue > 0 ? 'is-positive' : historyNetValue < 0 ? 'is-negative' : '';
    const historyNetText = hideAmounts
      ? '••••'
      : amountMode === 'money'
        ? `${historyNetValue > 0 ? '+' : ''}${formatDisplayMoney(historySummary.profit)}`
        : historySummary.profitUnits === null
          ? '—'
          : `${historyNetValue > 0 ? '+' : ''}${historySummary.profitUnits.replace('-', '−')}U`;
    const historyStakeText = hideAmounts
      ? '••••'
      : amountMode === 'money'
        ? formatDisplayMoney(historySummary.stake)
        : historySummary.stakeUnits === null
          ? '—'
          : `${historySummary.stakeUnits}U`;
    const activeHistoryChips = (
      Object.entries(activeHistoryFilters) as [keyof HistoryFilters, string][]
    )
      .filter(([key, value]) => (key === 'outcome' ? value !== 'all' : Boolean(value)))
      .map(([key, value]) => {
        const label = {
          search: 'SEARCH',
          bookmakerId: 'BOOKMAKER',
          tipsterId: 'TIPSTER',
          from: 'FROM',
          to: 'TO',
          sport: 'SPORT',
          ticketKind: 'TICKET TYPE',
          marketType: 'BET TYPE',
          outcome: 'RESULT',
        }[key];
        const displayValue =
          key === 'bookmakerId' || key === 'tipsterId'
            ? (workspace.catalog.find((item) => item.id === value)?.name ?? value)
            : key === 'outcome'
              ? (BET_HISTORY_OUTCOMES.find(([outcome]) => outcome === value)?.[1] ?? value)
              : value;
        return { key, label, value, displayValue, clearedValue: key === 'outcome' ? 'all' : '' };
      });
    const sportsByLabel = new Map<string, string>();
    rows.forEach((row) =>
      row.bet.selections.forEach((selection) => {
        const sport = selection.sport?.trim() ?? '';
        const label = ticketSportLabel(sport);
        if (sport && !sportsByLabel.has(label)) sportsByLabel.set(label, sport);
      }),
    );
    const historySportOptions = [...sportsByLabel]
      .map(([label, value]) => ({ label, value }))
      .sort((left, right) => left.label.localeCompare(right.label));
    const renderBetTable = (tableRows: BetTableRow[], history = false) => {
      if (!history) {
        const sortedTableRows = sort
          ? sortBetRows(tableRows, sort.column, sort.direction)
          : tableRows;
        return (
          <div
            ref={scrollRef}
            className="bets-reference-table-wrap table-scroll bet-table-desktop"
            role="region"
            aria-label="Today’s bets table"
            tabIndex={0}
          >
            <table
              className="product-table bet-detail-table bets-reference-table"
              style={{ '--bet-columns': String(columns.length + 1) } as CSSProperties}
            >
              <caption className="sr-only">Bets with event, selection, amount, and result</caption>
              <thead>
                <tr>
                  {columns.map((column) => (
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
                  ))}
                  <th data-column="open">
                    <span className="sr-only">Abrir</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedTableRows.map((row) => {
                  const financial = betFinancialDisplay(row.bet);
                  return (
                    <tr
                      key={row.bet.id}
                      data-state={row.bet.state}
                      data-outcome={row.bet.latestOutcome ?? undefined}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          data-column={column.key}
                          className={
                            column.key === 'return'
                              ? 'tabular ' + financial.tone
                              : columnClassNames[column.key]
                          }
                        >
                          <BetTableCell
                            row={row}
                            column={column.key}
                            amountMode={amountMode}
                            hideAmounts={hideAmounts}
                          />
                        </td>
                      ))}
                      <td data-column="open" className="bet-actions-cell">
                        <div className="bet-row-actions">
                          <Button
                            variant="ghost"
                            size="small"
                            className="bet-row-action"
                            aria-label={'Ver aposta ' + betAccessibleTitle(row.bet)}
                            onClick={() => open({ kind: 'detail', id: row.bet.id })}
                          >
                            Ver
                          </Button>
                          <Button
                            variant="ghost"
                            size="small"
                            className="bet-row-action"
                            aria-label={'Editar aposta ' + betAccessibleTitle(row.bet)}
                            onClick={() => open({ kind: 'bet', bet: row.bet })}
                          >
                            Editar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      }
      return (
        <div
          ref={history ? historyScrollRef : scrollRef}
          className={`bets-reference-table-wrap bet-table-desktop${history ? ' bets-history-table-wrap' : ''}`}
          role="region"
          aria-label={history ? 'Bet history table' : 'Today’s bets table'}
          tabIndex={0}
        >
          <table
            className={`product-table bet-detail-table bets-reference-table${history ? ' bets-history-table' : ''}`}
            style={
              history
                ? ({
                    '--bet-columns': String(historyColumns.length),
                    minWidth: `${historyTableWidth}px`,
                  } as CSSProperties)
                : ({ '--bet-columns': '6' } as CSSProperties)
            }
          >
            {history ? (
              <colgroup>
                {historyColumns.map((column) => (
                  <col key={column.key} style={{ width: `${column.width}px` }} />
                ))}
              </colgroup>
            ) : null}
            <thead>
              <tr>
                {history ? (
                  historyColumns.map((column) => (
                    <th
                      key={column.key}
                      className={`bets-history-column-${column.key}`}
                      scope="col"
                    >
                      {column.label}
                    </th>
                  ))
                ) : (
                  <>
                    <th>SP</th>
                    <th>SELECTION</th>
                    <th>ODDS</th>
                    <th>AMOUNT</th>
                    <th>STATUS</th>
                    <th>RESULT</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => {
                const expandable =
                  history && row.bet.ticketKind !== 'simple' && row.bet.selections.length > 1;
                const expanded = expandedHistorySelections.has(row.bet.id);
                const displayId =
                  row.bet.reference?.trim() || String(row.bet.ticketNumber).padStart(6, '0');
                const eventDate = row.bet.selections.find(
                  (selection) => selection.eventDate,
                )?.eventDate;
                const eventDateLabel = eventDate
                  ? new Intl.DateTimeFormat(displayLocale(), {
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    }).format(new Date(`${eventDate}T12:00:00.000Z`))
                  : null;
                return (
                  <Fragment key={row.bet.id}>
                    <tr
                      data-state={row.bet.state}
                      data-outcome={row.bet.latestOutcome ?? undefined}
                      data-sport={sportTag(row.bet).toLowerCase()}
                    >
                      {history ? (
                        historyColumns.map((column) => {
                          const historyColumnClass = `bets-history-column-${column.key}`;
                          switch (column.key) {
                            case 'dateTime':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} bets-history-date-time tabular`}
                                >
                                  {`${formatDisplayDate(row.bet.placedAt, { year: 'numeric', month: 'short', day: 'numeric' })} · ${placedTime(row.bet.placedAt)}`}
                                </td>
                              );
                            case 'selection':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} bets-history-selection`}
                                  title={selectionLabel(row.bet)}
                                >
                                  <div className="bets-history-selection-content">
                                    {expandable ? (
                                      <button
                                        className="bets-history-expand"
                                        type="button"
                                        aria-label={`${expanded ? 'Hide' : 'Show'} the ${row.bet.selections.length} selections`}
                                        aria-expanded={expanded}
                                        onClick={() =>
                                          setExpandedHistorySelections((current) => {
                                            const next = new Set(current);
                                            if (next.has(row.bet.id)) next.delete(row.bet.id);
                                            else next.add(row.bet.id);
                                            return next;
                                          })
                                        }
                                      >
                                        {expanded ? '⌄' : '›'}
                                      </button>
                                    ) : null}
                                    <span>{selectionLabel(row.bet)}</span>
                                  </div>
                                </td>
                              );
                            case 'id':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} bets-history-id`}
                                  title={`#${displayId}`}
                                >
                                  #{displayId}
                                </td>
                              );
                            case 'bookmaker':
                              return (
                                <td
                                  key={column.key}
                                  className={historyColumnClass}
                                  title={row.bookmaker}
                                >
                                  {row.bookmaker}
                                </td>
                              );
                            case 'sport':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} bets-history-sport`}
                                  title={sportsLabel(row.bet)}
                                >
                                  {sportsLabel(row.bet)}
                                </td>
                              );
                            case 'betType':
                              return (
                                <td
                                  key={column.key}
                                  className={historyColumnClass}
                                  title={typeTitleFor(row.bet)}
                                >
                                  {typeLabelFor(row.bet)}
                                </td>
                              );
                            case 'tipster':
                              return (
                                <td
                                  key={column.key}
                                  className={historyColumnClass}
                                  title={row.tipster}
                                >
                                  {row.tipster}
                                </td>
                              );
                            case 'event':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} bets-history-event`}
                                  title={row.details.event}
                                >
                                  {row.details.event}
                                </td>
                              );
                            case 'stake':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} tabular`}
                                  title={row.bet.stake ?? '—'}
                                >
                                  {hideAmounts
                                    ? '••••'
                                    : amountMode === 'money'
                                      ? formatDisplayMoney(row.bet.stake)
                                      : row.bet.stakeUnits === null
                                        ? '—'
                                        : `${Number(row.bet.stakeUnits).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}U`}
                                </td>
                              );
                            case 'odds':
                              return (
                                <td key={column.key} className={`${historyColumnClass} tabular`}>
                                  {formatDisplayOdds(row.bet.odds)}
                                </td>
                              );
                            case 'status':
                              return (
                                <td key={column.key} className={historyColumnClass}>
                                  <span
                                    className={`bets-reference-status is-${statusText(row.bet).toLowerCase().replace(/\s+/g, '-')}`}
                                  >
                                    {statusText(row.bet)}
                                  </span>
                                </td>
                              );
                            case 'result':
                              return (
                                <td
                                  key={column.key}
                                  className={`${historyColumnClass} tabular ${betFinancialDisplay(row.bet).tone}`}
                                >
                                  {hideAmounts
                                    ? '••••'
                                    : amountMode === 'money'
                                      ? betFinancialDisplay(row.bet).profitText
                                      : (() => {
                                          const result = unitsValue(
                                            row.bet.profit,
                                            row.bet.unitAmount,
                                          );
                                          return result &&
                                            result !== '—' &&
                                            !result.startsWith('-') &&
                                            row.bet.profit !== '0.00'
                                            ? `+${result}`
                                            : (result?.replace('-', '−') ?? '—');
                                        })()}
                                </td>
                              );
                          }
                        })
                      ) : (
                        <>
                          <td
                            className={`bets-reference-sport is-${sportTag(row.bet).toLowerCase()}`}
                          >
                            {expandable ? (
                              <button
                                className="bets-history-expand"
                                type="button"
                                aria-label={`${expanded ? 'Hide' : 'Show'} the ${row.bet.selections.length} selections`}
                                aria-expanded={expanded}
                                onClick={() =>
                                  setExpandedHistorySelections((current) => {
                                    const next = new Set(current);
                                    if (next.has(row.bet.id)) next.delete(row.bet.id);
                                    else next.add(row.bet.id);
                                    return next;
                                  })
                                }
                              >
                                {expanded ? '⌄' : '›'}
                              </button>
                            ) : null}
                            <span>{sportTag(row.bet)}</span>
                          </td>
                          <td className="bets-reference-selection">
                            <button
                              className="bets-row-open"
                              type="button"
                              onClick={() => open({ kind: 'detail', id: row.bet.id })}
                            >
                              {row.bet.ticketKind === 'multiple' && row.bet.selections.length > 1
                                ? `Parlay · ${row.bet.selections.length} legs`
                                : row.details.selection}
                            </button>
                            <small>
                              {row.details.event.trim()}
                              {eventDateLabel ? ` · ${eventDateLabel}` : ''}
                            </small>
                          </td>
                          <td className="tabular">{formatDisplayOdds(row.bet.odds)}</td>
                          <td className="tabular">
                            {hideAmounts
                              ? '••••'
                              : amountMode === 'money'
                                ? formatDisplayMoney(row.bet.stake)
                                : row.bet.stakeUnits === null
                                  ? '—'
                                  : `${Number(row.bet.stakeUnits).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}U`}
                          </td>
                          <td>
                            <span
                              className={`bets-reference-status is-${statusText(row.bet).toLowerCase().replace(/\s+/g, '-')}`}
                            >
                              {statusText(row.bet)}
                            </span>
                          </td>
                          <td className={`tabular ${betFinancialDisplay(row.bet).tone}`}>
                            {hideAmounts
                              ? '••••'
                              : amountMode === 'money'
                                ? betFinancialDisplay(row.bet).profitText
                                : (() => {
                                    const result = unitsValue(row.bet.profit, row.bet.unitAmount);
                                    return result &&
                                      result !== '—' &&
                                      !result.startsWith('-') &&
                                      row.bet.profit !== '0.00'
                                      ? `+${result}`
                                      : (result?.replace('-', '−') ?? '—');
                                  })()}
                          </td>
                        </>
                      )}
                    </tr>
                    {expandable && expanded ? (
                      <tr
                        className="bets-history-selections-row"
                        data-sport={sportTag(row.bet).toLowerCase()}
                      >
                        <td colSpan={history ? historyColumns.length : 6}>
                          <div className="bets-history-selections">
                            {row.bet.selections.map((selection) => (
                              <div key={selection.id ?? `${row.bet.id}-${selection.selection}`}>
                                <strong>{ticketSportLabel(selection.sport)}</strong>
                                <span>{selection.selection}</span>
                                <small>
                                  {selection.market} · {selection.event}
                                </small>
                                <b>{formatDisplayOdds(selection.odds)}</b>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    };
    return (
      <section className="bets-reference-page" aria-label="Bets">
        <header className="bets-reference-heading">
          <h2>BETS</h2>
          <div className="bets-reference-actions">
            <div
              className="bets-mode-toggle"
              role="group"
              aria-label="Show amounts in currency or units"
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
            <BetColumnsPanel owner={owner} columns={visibleColumns} onChange={setVisibleColumns} />
            <button
              className="bets-visibility-toggle"
              type="button"
              aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
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
              + NEW BET
            </Button>
          </div>
        </header>

        <div className="bets-reference-section-heading" id="bets-today">
          <h3>
            TODAY'S BETS <span>{scheduledRows.length}</span>
          </h3>
          <div className="bettrack-bets-summary" aria-label="Resumen de apuestas de hoy">
            <p>
              <span>AT RISK</span> <strong>{hideAmounts ? '••••' : exposure}</strong>
            </p>
            {scheduledRows.length > 0 ? (
              <p>
                <span>DAY'S NET</span> <strong className={dayNetTone}>{dayNet}</strong>
              </p>
            ) : null}
          </div>
        </div>
        {scheduledRows.length > 0 && overflows ? (
          <p className="bet-table-scroll-hint">
            A tabela é mais larga que a tela. Deslize horizontalmente para ver as demais colunas.
          </p>
        ) : null}
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
            <h3>NO BETS FOR TODAY YET</h3>
            <p>
              Bets scheduled for today will show here, with their status and result. Earlier bets
              appear in history.
            </p>
            <Button
              variant="secondary"
              disabled={!workspace.initialized}
              onClick={() => open({ kind: 'bet' })}
            >
              LOG THE FIRST ONE
            </Button>
          </div>
        ) : (
          <>
            <div className="bet-list-cards">
              {displayedScheduledRows.map((row) => (
                <BetTrackTicketCard
                  key={row.bet.id}
                  row={row}
                  amountMode={amountMode}
                  hideAmounts={hideAmounts}
                  unitAmount={row.bet.unitAmount}
                  open={open}
                />
              ))}
            </div>
            {renderBetTable(displayedScheduledRows)}
          </>
        )}

        <div className="bets-reference-section-heading bets-history-heading" id="bets-history">
          <h3>
            HISTORY <span>{historyTotal}</span>
          </h3>
        </div>
        <div className="bets-history-controls">
          <label className="bets-history-search">
            <span>SEARCH</span>
            <input
              type="search"
              value={draftHistoryFilters.search}
              placeholder="Bet, event, bookmaker or ID"
              aria-label="Search bet history"
              onChange={(event) => {
                changeHistoryDraft('search', event.target.value);
              }}
            />
          </label>
          <label>
            <span>BOOKMAKER</span>
            <select
              value={draftHistoryFilters.bookmakerId}
              onChange={(event) => changeHistoryDraft('bookmakerId', event.target.value)}
            >
              <option value="">ALL BOOKMAKERS</option>
              {workspace.catalog
                .filter((item) => item.kind === 'bookmaker')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>SPORT / LEAGUE</span>
            <select
              value={draftHistoryFilters.sport}
              onChange={(event) => changeHistoryDraft('sport', event.target.value)}
            >
              <option value="">ALL SPORTS</option>
              {historySportOptions.map((sport) => (
                <option key={sport.label} value={sport.value}>
                  {sport.label}
                </option>
              ))}
              {draftHistoryFilters.sport &&
              !historySportOptions.some((sport) => sport.value === draftHistoryFilters.sport) ? (
                <option value={draftHistoryFilters.sport}>
                  {ticketSportLabel(draftHistoryFilters.sport)}
                </option>
              ) : null}
            </select>
          </label>
          <label>
            <span>MARKET TYPE</span>
            <input
              type="text"
              list="bets-history-market-type-options"
              maxLength={120}
              autoComplete="off"
              aria-label="MARKET TYPE"
              value={draftHistoryFilters.marketType}
              onChange={(event) => changeHistoryDraft('marketType', event.target.value)}
            />
            <datalist id="bets-history-market-type-options">
              {historyMarketTypeOptions.map((marketType) => (
                <option key={marketType} value={marketType}>
                  {marketType}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            <span>TICKET TYPE</span>
            <select
              value={draftHistoryFilters.ticketKind}
              onChange={(event) => changeHistoryDraft('ticketKind', event.target.value)}
            >
              <option value="">ALL TYPES</option>
              <option value="simple">STRAIGHT</option>
              <option value="multiple">PARLAY</option>
              <option value="betbuild">BET BUILDER</option>
            </select>
          </label>
          <label>
            <span>TIPSTER</span>
            <select
              value={draftHistoryFilters.tipsterId}
              onChange={(event) => changeHistoryDraft('tipsterId', event.target.value)}
            >
              <option value="">ALL TIPSTERS</option>
              {workspace.catalog
                .filter((item) => item.kind === 'tipster')
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>FROM</span>
            <input
              type="date"
              value={draftHistoryFilters.from}
              onChange={(event) => changeHistoryDraft('from', event.target.value)}
            />
          </label>
          <label>
            <span>TO</span>
            <input
              type="date"
              value={draftHistoryFilters.to}
              onChange={(event) => changeHistoryDraft('to', event.target.value)}
            />
          </label>
          <details className="bets-history-columns">
            <summary>
              COLUMNS{' '}
              <strong>
                {visibleHistoryColumns.length}/{BET_HISTORY_COLUMNS.length}
              </strong>
            </summary>
            <div
              className="bets-history-columns-popover"
              role="group"
              aria-label="Choose visible history columns"
            >
              <p>Choose which fields appear in the history table.</p>
              {BET_HISTORY_COLUMNS.map((column) => (
                <label key={column.key}>
                  <input
                    type="checkbox"
                    aria-label={`Show ${column.label.toLocaleLowerCase(displayLocale())} column`}
                    checked={visibleHistoryColumns.includes(column.key)}
                    disabled={
                      visibleHistoryColumns.length === 1 && visibleHistoryColumns[0] === column.key
                    }
                    onChange={() => toggleHistoryColumn(column.key)}
                  />
                  <span>{column.label}</span>
                </label>
              ))}
              <button
                type="button"
                onClick={resetHistoryColumns}
                disabled={visibleHistoryColumns.length === BET_HISTORY_COLUMNS.length}
              >
                RESET COLUMNS
              </button>
            </div>
          </details>
          <button
            className="bets-history-apply"
            type="button"
            onClick={applyHistoryFilters}
            disabled={!historyFiltersDirty}
          >
            APPLY FILTERS
          </button>
          {advancedFilterCount > 0 || historyFiltersDirty ? (
            <button className="bets-history-clear" type="button" onClick={clearHistoryFilters}>
              CLEAR FILTERS
            </button>
          ) : null}
        </div>
        {activeHistoryChips.length > 0 ? (
          <div className="bets-history-active-filters" role="group" aria-label="Active filters">
            {activeHistoryChips.map((chip) => (
              <button
                key={chip.key}
                className="bets-history-chip"
                type="button"
                aria-label={`Remove ${chip.label.toLocaleLowerCase(displayLocale())} filter ${chip.displayValue}`}
                onClick={() => {
                  const next = {
                    ...activeHistoryFilters,
                    [chip.key]: chip.clearedValue,
                  } as HistoryFilters;
                  setActiveHistoryFilters(next);
                  setDraftHistoryFilters(
                    (current) =>
                      ({
                        ...current,
                        [chip.key]: chip.clearedValue,
                      }) as HistoryFilters,
                  );
                  setPage(1);
                }}
              >
                <span>
                  {chip.label}: {chip.displayValue}
                </span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        ) : null}
        <div
          className="bets-history-summary"
          role="group"
          aria-label="Summary for the filtered period"
        >
          <div>
            <span>FILTERED PERIOD</span>
            <strong>
              {historySummary.count} {historySummary.count === 1 ? 'BET' : 'BETS'}
            </strong>
          </div>
          <p>
            <span>STAKE</span>
            <strong>{historyStakeText}</strong>
          </p>
          <p>
            <span>NET RESULT</span>
            <strong className={historyNetTone}>{historyNetText}</strong>
          </p>
        </div>
        <div className="bets-reference-toolbar">
          <div className="bet-state-tabs" role="group" aria-label="Filter history by result">
            {BET_HISTORY_OUTCOMES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={draftHistoryFilters.outcome === value ? 'is-active' : ''}
                aria-pressed={draftHistoryFilters.outcome === value}
                onClick={() => {
                  changeHistoryDraft('outcome', value);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="bets-history-sort-control">
            <label className="sr-only" htmlFor="bets-history-sort">
              Sort history by
            </label>
            <select
              id="bets-history-sort"
              className="bets-date-sort"
              value={historySort}
              onChange={(event) => setHistorySort(event.target.value as typeof historySort)}
            >
              <option value="date">DATE</option>
              <option value="odds">ODDS</option>
              <option value="amount">AMOUNT</option>
              <option value="result">RESULT</option>
            </select>
            <button
              className="bets-sort-direction"
              type="button"
              onClick={() => setDateDescending((descending) => !descending)}
              aria-label={`Sort ${dateDescending ? 'descending' : 'ascending'}`}
              title={dateDescending ? 'Newest or highest first' : 'Oldest or lowest first'}
            >
              <span aria-hidden="true">{dateDescending ? '▼' : '▲'}</span>
            </button>
          </div>
        </div>
        {historyOverflows ? (
          <p className="bet-table-scroll-hint">
            The history table is wider than the screen. Scroll horizontally to see every visible
            column.
          </p>
        ) : null}
        {historyQuery.isError ? null : historyQuery.isPending ? (
          <p className="bets-history-loading" role="status">
            Loading bet history…
          </p>
        ) : historyRows.length === 0 ? (
          <div className="bets-reference-history-empty">Your bet history will show here.</div>
        ) : (
          renderBetTable(displayedHistoryRows, true)
        )}
        {historyQuery.data && historyQuery.data.total > historyQuery.data.items.length ? (
          <Pagination page={page} total={historyQuery.data.total} size={100} change={setPage} />
        ) : null}
        <QueryNotice
          error={query.isError || historyQuery.isError}
          loading={query.isPending || historyQuery.isPending}
          retry={() => {
            void query.refetch();
            void historyQuery.refetch();
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
              <strong>{formatDisplayMoney(workspace.exposure)}</strong>
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
          <details className="bet-advanced-filters" open={compactAdvancedFilterCount > 0}>
            <summary>
              Filtros avançados
              {compactAdvancedFilterCount > 0 ? (
                <span>{compactAdvancedFilterCount} ativos</span>
              ) : null}
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
                              <BetTableCell
                                row={row}
                                column={column.key}
                                amountMode={amountMode}
                                hideAmounts={hideAmounts}
                              />
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
                          {formatDisplayMoney(bet.stake)}
                          <small>
                            {bet.stakeUnits === null
                              ? 'Unidade a conferir'
                              : `${Number(bet.stakeUnits).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} u`}
                          </small>
                        </td>
                        <td data-column="odds" className="tabular">
                          {formatDisplayOdds(bet.odds)}
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
export function BetEditPage({
  id,
  workspace,
  amountMode,
}: {
  id: string;
  workspace: Workspace;
  amountMode: 'money' | 'units';
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
  const firstSelection = bet.selections[0];
  const heading =
    bet.ticketKind === 'multiple'
      ? `PARLAY · ${bet.selections.length} SELECTIONS`
      : bet.ticketKind === 'betbuild'
        ? 'BET BUILDER'
        : (firstSelection?.selection?.toUpperCase() ?? 'BET');
  const kindLabel =
    bet.ticketKind === 'multiple'
      ? `${bet.selections.length}-LEG MULTI-SPORT PARLAY`
      : bet.ticketKind === 'betbuild'
        ? 'BET BUILDER'
        : 'STRAIGHT';
  const placedOn = formatDisplayDate(bet.placedAt, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).toUpperCase();
  const backToBets = () => {
    const returnToDetail = window.sessionStorage.getItem('bettrack:bet-edit-return') === 'detail';
    window.sessionStorage.removeItem('bettrack:bet-edit-return');
    window.location.hash = returnToDetail ? `#bets/${bet.id}` : '#bets';
  };
  return (
    <section className="bettrack-edit-page">
      <a className="bettrack-edit-back" href="#bets">
        ‹ BETS
      </a>
      <header className="bettrack-edit-page-heading">
        <div>
          <h2>{heading}</h2>
          <p>
            {kindLabel} · {placedOn}
          </p>
        </div>
        <span className="bettrack-edit-state">
          {bet.state === 'open' ? 'OPEN' : bet.state === 'settled' ? 'SETTLED' : 'VOID'}
        </span>
      </header>
      <BetForm
        workspace={workspace}
        bet={bet}
        amountMode={amountMode}
        referenceLayout
        financialEditAllowed={bet.state === 'open' && settlements.length === 0}
        onCancel={backToBets}
        onDone={backToBets}
      />
    </section>
  );
}

function BetTrackActionIcon({ name }: { name: 'eye' | 'share' | 'edit' | 'delete' }) {
  if (name === 'eye')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.7" />
      </svg>
    );
  if (name === 'share')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="18" cy="5" r="2.4" />
        <circle cx="6" cy="12" r="2.4" />
        <circle cx="18" cy="19" r="2.4" />
        <path d="m8.2 10.8 7.5-4.4M8.2 13.2l7.5 4.4" />
      </svg>
    );
  if (name === 'edit')
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 16.8-.8 4 4-.8L20 7.2 16.8 4 4 16.8Z" />
        <path d="m14.9 5.9 3.2 3.2M3.5 21h17" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m4 3v7m4-7v7" />
    </svg>
  );
}

export function BetTrackBetDetailPage({
  id,
  workspace,
  amountMode,
  open,
}: {
  id: string;
  workspace: Workspace;
  amountMode: 'money' | 'units';
  open: OpenModal;
}) {
  const query = useQuery({
    queryKey: ['product', 'bet', id, workspace.version],
    queryFn: () => request(`/api/v1/bets/${id}`, betDetailSchema),
  });
  const actions = useFinanceActions();
  const [hideAmounts, setHideAmounts] = useState(false);
  const [shareFeedback, setShareFeedback] = useState('');
  const [cashoutOpen, setCashoutOpen] = useState(false);
  const [cashoutAmount, setCashoutAmount] = useState('');
  const [settlementFeedback, setSettlementFeedback] = useState('');
  const [recordFeedback, setRecordFeedback] = useState('');
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
  const firstSelection = bet.selections[0];
  const bookmaker = catalogName(workspace, bet.bookmakerId);
  const tipster = catalogName(workspace, bet.tipsterId);
  const heading =
    bet.ticketKind === 'multiple'
      ? `PARLAY · ${bet.selections.length} SELECTIONS`
      : bet.ticketKind === 'betbuild'
        ? `BET BUILDER · ${bet.selections.length} SELECTIONS`
        : (firstSelection?.selection?.toUpperCase() ?? 'STRAIGHT BET');
  const kindLabel =
    bet.ticketKind === 'multiple'
      ? `${bet.selections.length}-LEG MULTI-SPORT PARLAY`
      : bet.ticketKind === 'betbuild'
        ? 'BET BUILDER'
        : 'STRAIGHT';
  const placedOn = formatDisplayDate(bet.placedAt, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).toUpperCase();
  const loggedOn = formatDisplayDate(bet.createdAt, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).toUpperCase();
  const sports = [...new Set(bet.selections.map((selection) => ticketSportLabel(selection.sport)))];
  const cardSport = sports.length > 1 ? 'multi' : (sports[0] ?? 'oth').toLowerCase();
  const typeLabel =
    bet.ticketKind === 'multiple'
      ? 'PARLAY'
      : bet.ticketKind === 'betbuild'
        ? 'BET BUILDER'
        : 'STRAIGHT';
  const potentialWinReturn =
    bet.state === 'open' && bet.remaining !== null && bet.odds
      ? suggestedReturn(
          bet.remaining,
          bet.odds,
          'win',
          !!bet.freebetId,
          bet.freebetStakeReturned ?? false,
        )
      : null;
  const potentialProfit =
    bet.state === 'open' && bet.stake && bet.odds
      ? (Number(bet.stake) * (Number(bet.odds) - 1)).toFixed(2)
      : null;
  const displayAmount = (amount: string | null) => {
    if (hideAmounts) return '••••';
    if (amount === null) return '—';
    if (amountMode === 'money') return formatDisplayMoney(amount);
    const units = unitsValue(amount, bet.unitAmount);
    return units ?? formatDisplayMoney(amount);
  };
  const shareBet = async () => {
    const url = window.location.href;
    const text = `${heading} · ${kindLabel} · ${bet.odds ?? '—'}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'StakeFrame', text, url });
        setShareFeedback('Shared');
      } catch {
        // Fechar o seletor do navegador não deve exibir erro nem copiar sem pedir.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareFeedback('Link copied');
      window.setTimeout(() => setShareFeedback(''), 1800);
    } catch {
      setShareFeedback('Unable to share');
      window.setTimeout(() => setShareFeedback(''), 1800);
    }
  };
  const canCancel = bet.state === 'open' && !settlements.some((item) => !item.reversed);
  const activeSettlement = [...settlements].reverse().find((item) => !item.reversed) ?? null;
  const openEditor = () => {
    window.sessionStorage.setItem('bettrack:bet-edit-amount-mode', amountMode);
    window.sessionStorage.setItem('bettrack:bet-edit-return', 'detail');
    window.location.hash = `#bets/edit/${bet.id}`;
  };
  const updateRecord = async (field: 'tipster' | 'bookmaker', value: string) => {
    setRecordFeedback('');
    try {
      const common = {
        type: 'bet.update' as const,
        id: bet.id,
        tipsterId: field === 'tipster' ? value || null : bet.tipsterId,
        reference: bet.reference ?? '',
        selections: bet.selections,
        reason:
          field === 'tipster'
            ? 'Tipster atualizado no detalhe do bilhete.'
            : 'Casa atualizada no detalhe do bilhete.',
      };
      await actions.execute(field === 'bookmaker' ? { ...common, bookmakerId: value } : common);
      setRecordFeedback('Saved');
    } catch (error) {
      setRecordFeedback(error instanceof Error ? error.message : 'Could not save this change.');
    }
  };
  const cancelBet = () =>
    open({
      kind: 'correction',
      title: 'Delete bet',
      build: (reason, effectiveAt) => ({ type: 'bet.cancel', id: bet.id, reason, effectiveAt }),
    });
  const settle = async (outcome: 'win' | 'loss' | 'void' | 'cashout') => {
    setSettlementFeedback('');
    if (bet.remaining === null) {
      setSettlementFeedback('Complete o valor da aposta antes de registrar o resultado.');
      return;
    }
    if (outcome === 'cashout') {
      setCashoutOpen(true);
      return;
    }
    try {
      const returnAmount =
        outcome === 'win'
          ? bet.odds
            ? suggestedReturn(
                bet.remaining,
                bet.odds,
                'win',
                !!bet.freebetId,
                bet.freebetStakeReturned ?? false,
              )
            : null
          : outcome === 'void'
            ? bet.remaining
            : '0.00';
      if (returnAmount === null) {
        setSettlementFeedback('Informe a odd total antes de registrar uma vitória.');
        return;
      }
      await actions.execute({
        type: 'bet.settle',
        id: bet.id,
        outcome,
        closedPrincipal: bet.remaining,
        returnAmount,
        settledAt: localInstant(localNow()),
        reason: 'Resultado registrado pela tela de detalhes do bilhete.',
      });
    } catch (error) {
      setSettlementFeedback(
        error instanceof Error ? error.message : 'Não foi possível registrar o resultado.',
      );
    }
  };
  const confirmCashout = async () => {
    setSettlementFeedback('');
    if (
      bet.remaining === null ||
      !/^\d+(?:[.,]\d{1,2})?$/.test(cashoutAmount) ||
      cents(cashoutAmount.replace(',', '.')) <= 0n
    ) {
      setSettlementFeedback('Informe quanto foi recebido no cash out.');
      return;
    }
    try {
      await actions.execute({
        type: 'bet.settle',
        id: bet.id,
        outcome: 'cashout',
        closedPrincipal: bet.remaining,
        returnAmount: cashoutAmount.replace(',', '.'),
        settledAt: localInstant(localNow()),
        reason: 'Cash out registrado pela tela de detalhes do bilhete.',
      });
      setCashoutOpen(false);
      setCashoutAmount('');
    } catch (error) {
      setSettlementFeedback(
        error instanceof Error ? error.message : 'Não foi possível registrar o cash out.',
      );
    }
  };

  return (
    <section className="bettrack-detail-page">
      <a className="bettrack-detail-back" href="#bets">
        ‹ BETS
      </a>
      <header className="bettrack-detail-heading">
        <div>
          <h2>{heading}</h2>
          <p>
            {kindLabel} · {placedOn}
          </p>
        </div>
        <div className="bettrack-detail-actions" aria-label="Bet actions">
          <button
            type="button"
            aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
            aria-pressed={hideAmounts}
            title={hideAmounts ? 'Show amounts' : 'Hide amounts'}
            onClick={() => setHideAmounts((hidden) => !hidden)}
          >
            <BetTrackActionIcon name="eye" />
          </button>
          <button
            type="button"
            aria-label="Share bet"
            title="Share bet"
            onClick={() => void shareBet()}
          >
            <BetTrackActionIcon name="share" />
          </button>
          {bet.state === 'open' ? (
            <button type="button" aria-label="Edit bet" title="Edit bet" onClick={openEditor}>
              <BetTrackActionIcon name="edit" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Delete bet"
            title={
              canCancel ? 'Delete bet' : 'This bet cannot be deleted while it has a settlement'
            }
            disabled={!canCancel}
            onClick={cancelBet}
          >
            <BetTrackActionIcon name="delete" />
          </button>
          {shareFeedback ? <span role="status">{shareFeedback}</span> : null}
        </div>
      </header>

      <div className="bettrack-detail-grid">
        <div className="bettrack-detail-left">
          <article className="bettrack-detail-ticket" data-sport={cardSport} data-state={bet.state}>
            <header>
              <strong>{bookmaker === '—' ? 'NO BOOK' : bookmaker.toUpperCase()}</strong>
              <span>#{bet.reference?.trim() || String(bet.ticketNumber).padStart(6, '0')}</span>
            </header>
            <div className="bettrack-detail-ticket-type">
              <strong>{typeLabel}</strong>
              <span>{sports.map((sport) => sport.toUpperCase()).join(' · ')}</span>
              <b>{formatDisplayOdds(bet.odds)}</b>
            </div>
            {bet.selections.length > 1 ? (
              <>
                <h3>{bet.selections.length} SELECTIONS</h3>
                <div className="bettrack-detail-ticket-selections">
                  {bet.selections.map((selection, index) => (
                    <div
                      key={selection.id ?? `${bet.id}-detail-${index}`}
                      data-sport={ticketSportLabel(selection.sport).toLowerCase()}
                    >
                      <b>{ticketSportLabel(selection.sport).toUpperCase()}</b>
                      <span>{selection.selection}</span>
                      <strong>{formatDisplayOdds(selection.odds)}</strong>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="bettrack-detail-ticket-single">
                <h3>{firstSelection?.selection ?? '—'}</h3>
                <p>{firstSelection?.event ?? '—'}</p>
              </div>
            )}
            <div className="bettrack-detail-ticket-values">
              <div>
                <small>AMOUNT</small>
                <strong>{displayAmount(bet.stake)}</strong>
              </div>
              <div>
                <small>{bet.state === 'open' ? 'TO WIN' : 'PAID'}</small>
                <strong>
                  {displayAmount(bet.state === 'open' ? potentialWinReturn : bet.returnAmount)}
                </strong>
              </div>
            </div>
            <footer>
              {bet.state === 'open'
                ? 'OPEN'
                : bet.state === 'cancelled'
                  ? 'VOID'
                  : bet.latestOutcome
                    ? betTrackOutcomeLabels[bet.latestOutcome]
                    : 'SETTLED'}
            </footer>
          </article>

          {bet.state === 'open' ? (
            <section className="bettrack-settle-card" aria-labelledby="bettrack-settle-title">
              <h3 id="bettrack-settle-title">SETTLE THIS BET</h3>
              <button
                type="button"
                className="is-cashout"
                aria-label="Liquidar aposta"
                disabled={actions.busy || !!actions.pending}
                onClick={() => open({ kind: 'settle', bet })}
              >
                <span className="bettrack-settle-icon" aria-hidden="true">
                  ⇄
                </span>
                <strong>LIQUIDAR APOSTA</strong>
                <small>Registre uma liquidação parcial ou integral</small>
              </button>
              <button
                type="button"
                className="is-won"
                disabled={actions.busy || !!actions.pending}
                onClick={() => void settle('win')}
              >
                <span className="bettrack-settle-icon">✓</span>
                <strong>WON</strong>
                <small>Pays {displayAmount(potentialWinReturn)}</small>
              </button>
              <button
                type="button"
                className="is-lost"
                disabled={actions.busy || !!actions.pending}
                onClick={() => void settle('loss')}
              >
                <span className="bettrack-settle-icon">×</span>
                <strong>LOST</strong>
                <small>You lose the amount</small>
              </button>
              <button
                type="button"
                className="is-void"
                disabled={actions.busy || !!actions.pending}
                onClick={() => void settle('void')}
              >
                <span className="bettrack-settle-icon">↶</span>
                <strong>VOID</strong>
                <small>Returns the full amount</small>
              </button>
              <button
                type="button"
                className="is-cashout"
                disabled={actions.busy || !!actions.pending}
                onClick={() => {
                  setCashoutOpen((value) => !value);
                  setSettlementFeedback('');
                }}
              >
                <span className="bettrack-settle-icon">♧</span>
                <strong>CASH OUT</strong>
                <small>Asks what you took out</small>
              </button>
              {cashoutOpen ? (
                <div className="bettrack-cashout-inline">
                  <label htmlFor="bettrack-cashout-amount">AMOUNT RECEIVED (R$)</label>
                  <input
                    id="bettrack-cashout-amount"
                    inputMode="decimal"
                    value={cashoutAmount}
                    onChange={(event) => setCashoutAmount(event.target.value)}
                    placeholder="0,00"
                  />
                  <div>
                    <button
                      type="button"
                      disabled={actions.busy}
                      onClick={() => {
                        setCashoutOpen(false);
                        setSettlementFeedback('');
                      }}
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      disabled={actions.busy}
                      onClick={() => void confirmCashout()}
                    >
                      {actions.busy ? 'SAVING…' : 'CONFIRM CASH OUT'}
                    </button>
                  </div>
                </div>
              ) : null}
              {settlementFeedback ? (
                <p className="bettrack-settlement-feedback" role="alert">
                  {settlementFeedback}
                </p>
              ) : null}
            </section>
          ) : null}
          <a className="bettrack-hedge-card" href={`#hedge?betId=${encodeURIComponent(bet.id)}`}>
            <h3>HEDGE THIS BET</h3>
            <p>
              Bet the other side so you collect something whichever way it lands. We’ll tell you
              what it costs before you decide.
            </p>
          </a>
        </div>

        <div className="bettrack-detail-right">
          <section className="bettrack-detail-panel bettrack-detail-selections">
            <h3>SELECTIONS</h3>
            {bet.selections.map((selection, index) => (
              <div
                className="bettrack-detail-selection"
                key={selection.id ?? `${bet.id}-selection-${index}`}
                data-sport={ticketSportLabel(selection.sport).toLowerCase()}
              >
                <b>{ticketSportLabel(selection.sport).toUpperCase()}</b>
                <div>
                  <strong>{selection.selection}</strong>
                  <small>{selection.event}</small>
                </div>
                <span>{formatDisplayOdds(selection.odds)}</span>
              </div>
            ))}
          </section>
          <section className="bettrack-detail-panel bettrack-detail-profit">
            <h3>{bet.state === 'open' ? 'POTENTIAL PROFIT' : 'RESULT'}</h3>
            {bet.state === 'open' ? (
              <div>
                <strong>
                  {potentialProfit === null
                    ? '—'
                    : `${Number(potentialProfit) >= 0 ? '+' : ''}${displayAmount(potentialProfit)}`}
                </strong>
                {potentialProfit === null ? null : (
                  <span>
                    {Number(potentialProfit) >= 0 ? '+' : ''}
                    {displayAmount(potentialProfit)}
                  </span>
                )}
              </div>
            ) : (
              <div>
                <strong className={Number(bet.profit) >= 0 ? 'is-positive' : 'is-negative'}>
                  {Number(bet.profit) >= 0 ? '+' : ''}
                  {displayAmount(bet.profit)}
                </strong>
                <span>
                  {bet.stake && Number(bet.stake) > 0
                    ? `${((Number(bet.profit) / Number(bet.stake)) * 100).toFixed(1)}%`
                    : '—'}
                </span>
              </div>
            )}
            <p>
              {bet.state === 'open'
                ? potentialProfit === null || !bet.odds
                  ? 'Potential return is unavailable for this bet.'
                  : `Potential return ${(Math.max(0, Number(bet.odds) - 1) * 100).toFixed(1)}% on the amount`
                : `Return ${displayAmount(bet.returnAmount)}${activeSettlement ? ` · Settled ${formatDisplayDate(activeSettlement.settledAt, { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()}` : ''}`}
            </p>
          </section>
          <section className="bettrack-detail-panel bettrack-detail-record">
            <h3>RECORD</h3>
            {bet.state === 'open' ? (
              <>
                <label>
                  Tipster
                  <select
                    className="bettrack-record-value"
                    aria-label="Tipster"
                    value={bet.tipsterId ?? ''}
                    disabled={actions.busy || !!actions.pending}
                    onChange={(event) => void updateRecord('tipster', event.target.value)}
                  >
                    <option value="">Pick tipsters...</option>
                    {workspace.catalog
                      .filter(
                        (item) =>
                          item.kind === 'tipster' && (item.active || item.id === bet.tipsterId),
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Sportsbook
                  <select
                    className="bettrack-record-value"
                    aria-label="Sportsbook"
                    value={bet.bookmakerId ?? ''}
                    disabled={actions.busy || !!actions.pending}
                    onChange={(event) => void updateRecord('bookmaker', event.target.value)}
                  >
                    {workspace.catalog
                      .filter(
                        (item) =>
                          item.kind === 'bookmaker' && (item.active || item.id === bet.bookmakerId),
                      )
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                {recordFeedback ? (
                  <p className="bettrack-record-feedback" role="status">
                    {recordFeedback}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <label>
                  Tipster
                  <span className="bettrack-record-value">{tipster === '—' ? '—' : tipster}</span>
                </label>
                <label>
                  Sportsbook<span className="bettrack-record-value">{bookmaker}</span>
                </label>
              </>
            )}
            <div className="bettrack-record-logged">
              <span>Logged</span>
              <strong>{loggedOn}</strong>
            </div>
          </section>
        </div>
      </div>
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
            {formatDisplayMoney(bet.stake)}
            {bet.freebetId ? ' · freebet' : ''}
          </strong>
        </div>
        <div>
          <span>Odd total</span>
          <strong>{formatDisplayOdds(bet.odds)}</strong>
        </div>
        <div>
          <span>Principal aberto</span>
          <strong>{formatDisplayMoney(bet.remaining)}</strong>
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
          <strong>{bet.unitAmount ? formatDisplayMoney(bet.unitAmount) : 'A conferir'}</strong>
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
            {selection.odds ? ` · Odd ${formatDisplayOdds(selection.odds)}` : ''}
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
        <Button
          variant="secondary"
          onClick={() =>
            open({
              kind: 'bet',
              bet,
              financialEditAllowed: bet.state === 'open' && settlements.length === 0,
            })
          }
        >
          Edit bet
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
                Principal {formatDisplayMoney(settlement.closedPrincipal)} · Retorno{' '}
                {formatDisplayMoney(settlement.returnAmount)}
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
  const [moveFeedback, setMoveFeedback] = useState('');
  const [dailyLimitEditing, setDailyLimitEditing] = useState(false);
  const [dailyLimitPercent, setDailyLimitPercent] = useState('');
  const [dailyLimitFeedback, setDailyLimitFeedback] = useState('');
  const [dailyLimitSaving, setDailyLimitSaving] = useState(false);
  const client = useQueryClient();
  const actions = useFinanceActions();
  const dailyLimitQuery = useQuery({
    queryKey: ['product', 'daily-limit', workspace.version],
    queryFn: () => request('/api/v1/bankroll/rules', dailyLimitStateSchema),
  });
  useEffect(() => {
    if (dailyLimitQuery.data) setDailyLimitPercent(dailyLimitQuery.data.dailyLimitPercent ?? '');
  }, [dailyLimitQuery.data]);
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
  const saveDailyLimit = async () => {
    const normalized = dailyLimitPercent.trim().replace(',', '.');
    if (
      normalized &&
      (!/^\d+(?:\.\d{1,2})?$/.test(normalized) ||
        Number(normalized) <= 0 ||
        Number(normalized) > 100)
    ) {
      setDailyLimitFeedback('Informe um percentual entre 0,01% e 100%.');
      return;
    }
    setDailyLimitSaving(true);
    setDailyLimitFeedback('');
    try {
      await request('/api/v1/bankroll/rules', dailyLimitStateSchema, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dailyLimitPercent: normalized || null }),
      });
      await client.invalidateQueries({ queryKey: ['product', 'workspace'] });
      await dailyLimitQuery.refetch();
      setDailyLimitEditing(false);
      setDailyLimitFeedback('Saved');
    } catch (error) {
      setDailyLimitFeedback(
        error instanceof Error ? error.message : 'Could not save the daily limit.',
      );
    } finally {
      setDailyLimitSaving(false);
    }
  };
  const registerMove = async () => {
    const account =
      workspace.accounts.find((item) => item.kind === 'reserve') ?? workspace.accounts[0];
    if (
      !account ||
      !/^\d+(?:[.,]\d{1,2})?$/.test(moveAmount.trim()) ||
      Number(moveAmount.replace(',', '.')) <= 0
    ) {
      setMoveFeedback('Informe um valor válido para movimentação.');
      return;
    }
    setMoveFeedback('');
    try {
      await actions.execute({
        type: 'money.move',
        kind: moveKind,
        accountId: account.id,
        targetAccountId: null,
        amount: moveAmount.trim().replace(',', '.'),
        effectiveAt: localInstant(localNow()),
        reason:
          moveKind === 'deposit'
            ? 'Depósito registrado na tela da banca.'
            : 'Retirada registrada na tela da banca.',
      });
      setMoveAmount('');
      setMoveFeedback('Saved');
    } catch (error) {
      setMoveFeedback(error instanceof Error ? error.message : 'Could not save this movement.');
    }
  };
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
          <strong className="bankroll-current-value">
            {formatDisplayMoney(workspace.bankroll)}
          </strong>
          <div className="bankroll-card-divider" />
          <span className="bankroll-kicker">COMPOSIÇÃO DA BANCA</span>
          <div className="bankroll-composition-row">
            <span>Disponível</span>
            <b>{formatDisplayMoney(workspace.available)}</b>
          </div>
          <div className="bankroll-composition-row">
            <span>Em apostas abertas</span>
            <b>{formatDisplayMoney(workspace.exposure)}</b>
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
                !workspace.initialized ||
                workspace.accounts.length === 0 ||
                !moveAmount.trim() ||
                actions.busy ||
                !!actions.pending
              }
              onClick={() => void registerMove()}
            >
              {actions.busy ? 'Salvando…' : 'Registrar'}
            </Button>
          </div>
          {moveFeedback ? (
            <p className="bankroll-move-feedback" role="status">
              {moveFeedback}
            </p>
          ) : null}
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
              <strong>{currentUnit ? formatDisplayMoney(currentUnit.amount) : 'A definir'}</strong>
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
              <strong>
                {dailyLimitQuery.data?.dailyLimit
                  ? formatDisplayMoney(dailyLimitQuery.data.dailyLimit)
                  : 'Não configurado'}
              </strong>
              <b>
                {dailyLimitQuery.data?.dailyLimitPercent
                  ? `${dailyLimitQuery.data.dailyLimitPercent.replace('.', ',')}%`
                  : '—'}
              </b>
            </div>
            <div className="bankroll-rule-card-bottom">
              {dailyLimitEditing ? (
                <label className="bankroll-daily-limit-edit">
                  <span>Percentual da banca</span>
                  <input
                    aria-label="Percentual do limite diário"
                    inputMode="decimal"
                    value={dailyLimitPercent}
                    onChange={(event) => setDailyLimitPercent(event.target.value)}
                    placeholder="1,00"
                  />
                </label>
              ) : (
                <span>
                  {dailyLimitQuery.data?.dailyLimitPercent
                    ? `USADO HOJE ${formatDisplayMoney(dailyLimitQuery.data.usedToday)} · RESTANTE ${formatDisplayMoney(dailyLimitQuery.data.remainingToday ?? '0.00')}`
                    : dailyLimitQuery.isError
                      ? 'LIMITE DIÁRIO INDISPONÍVEL'
                      : 'DEFINA UM PERCENTUAL DA BANCA'}
                </span>
              )}
              {dailyLimitEditing ? (
                <div className="bankroll-daily-limit-actions">
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={dailyLimitSaving}
                    onClick={() => {
                      setDailyLimitPercent(dailyLimitQuery.data?.dailyLimitPercent ?? '');
                      setDailyLimitEditing(false);
                      setDailyLimitFeedback('');
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button
                    size="small"
                    disabled={dailyLimitSaving}
                    onClick={() => void saveDailyLimit()}
                  >
                    {dailyLimitSaving ? 'Salvando…' : 'Salvar'}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    setDailyLimitEditing(true);
                    setDailyLimitFeedback('');
                  }}
                >
                  Alterar
                </Button>
              )}
            </div>
            {dailyLimitFeedback ? (
              <p className="bankroll-daily-limit-feedback" role="status">
                {dailyLimitFeedback}
              </p>
            ) : null}
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
                {formatDisplayMoney(account.balance)}
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
                    <td>{formatDisplayMoney(item.amount)}</td>
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
export function BetTrackSettingsPage({
  workspace,
  open,
}: {
  workspace: Workspace;
  open: OpenModal;
}) {
  const [preferences, setPreferences] = useState<{
    language: string;
    currency: string;
    odds: string;
    timezone: string;
  }>(() => {
    const defaults = {
      language: 'pt-BR',
      currency: 'USD',
      odds: 'decimal',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
    };
    try {
      return {
        ...defaults,
        ...JSON.parse(window.localStorage.getItem(betTrackPreferencesKey) ?? '{}'),
      };
    } catch {
      return defaults;
    }
  });
  const [selectedBooks, setSelectedBooks] = useState<string[]>(() => {
    try {
      const saved = window.localStorage.getItem(betTrackBooksKey);
      return saved === null
        ? workspace.catalog
            .filter((item) => item.kind === 'bookmaker' && item.active)
            .map((item) => item.id)
        : (JSON.parse(saved) as string[]);
    } catch {
      return workspace.catalog
        .filter((item) => item.kind === 'bookmaker' && item.active)
        .map((item) => item.id);
    }
  });
  const [showAllBooks, setShowAllBooks] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(betTrackPreferencesKey, JSON.stringify(preferences));
      window.dispatchEvent(new Event('bettrack:preferences'));
    } catch {
      // Browser storage can be disabled; preferences still work for this visit.
    }
  }, [preferences]);
  useEffect(() => {
    try {
      window.localStorage.setItem(betTrackBooksKey, JSON.stringify(selectedBooks));
    } catch {
      // The selection remains usable in the current page when storage is unavailable.
    }
  }, [selectedBooks]);
  const books = workspace.catalog.filter((item) => item.kind === 'bookmaker');
  const visibleBooks = showAllBooks ? books : books.slice(0, 11);
  const updatePreference = (key: keyof typeof preferences, value: string) =>
    setPreferences((current) => ({ ...current, [key]: value }));
  const toggleBook = (id: string) =>
    setSelectedBooks((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  return (
    <div className="bettrack-settings">
      <section className="bettrack-settings-section bettrack-preferences">
        <header className="bettrack-settings-heading">
          <div>
            <h2>PREFERENCES</h2>
          </div>
        </header>
        <div className="bettrack-preference-grid">
          <div className="bettrack-preference-item">
            <label>
              <span>LANGUAGE</span>
              <select
                aria-label="Language"
                value={preferences.language}
                onChange={(event) => updatePreference('language', event.target.value)}
              >
                <option value="en">English</option>
                <option value="pt-BR">Português (Brasil)</option>
              </select>
            </label>
            <p>
              {preferences.language === 'pt-BR'
                ? 'FULL INTERFACE IN PORTUGUÊS (BRASIL)'
                : 'FULL INTERFACE LANGUAGE'}
            </p>
          </div>
          <div className="bettrack-preference-item">
            <label>
              <span>CURRENCY</span>
              <select
                aria-label="Currency"
                value={preferences.currency}
                onChange={(event) => updatePreference('currency', event.target.value)}
              >
                <option value="USD">USD · $</option>
                <option value="BRL">BRL · R$</option>
                <option value="EUR">EUR · €</option>
                <option value="MXN">MXN · $</option>
              </select>
            </label>
            <p>DISPLAY CONVERSION ONLY · BRL REMAINS THE ACCOUNTING CURRENCY</p>
          </div>
          <div className="bettrack-preference-item">
            <label>
              <span>ODDS FORMAT</span>
              <select
                aria-label="Odds format"
                value={preferences.odds}
                onChange={(event) => updatePreference('odds', event.target.value)}
              >
                <option value="decimal">Decimal · 1.42 · 2.50</option>
                <option value="fractional">Fractional · 2/5 · 3/2</option>
                <option value="american">American · −250 · +150</option>
              </select>
            </label>
            <p>HOW THEY’RE SHOWN · ENTRY ACCEPTS ALL THREE</p>
          </div>
          <div className="bettrack-preference-item">
            <label>
              <span>TIME ZONE</span>
              <select
                aria-label="Time zone"
                value={preferences.timezone}
                onChange={(event) => updatePreference('timezone', event.target.value)}
              >
                <option value="America/Sao_Paulo">America/Sao Paulo</option>
                <option value="America/Mexico_City">America/Mexico City</option>
                <option value="America/New_York">America/New York</option>
                <option value="Europe/London">Europe/London</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
            <p>DECIDES WHERE YOUR DAY ENDS</p>
          </div>
        </div>
      </section>

      <section className="bettrack-settings-section bettrack-sportsbooks">
        <header className="bettrack-settings-heading">
          <div>
            <h2>MY SPORTSBOOKS</h2>
          </div>
          <button type="button" onClick={() => open({ kind: 'catalog', catalogKind: 'bookmaker' })}>
            + ADD SPORTSBOOK
          </button>
        </header>
        <p className="bettrack-sportsbooks-copy">
          {preferences.language === 'pt-BR'
            ? `O catálogo tem ${books.length} ${books.length === 1 ? 'casa' : 'casas'}. Selecione as que você usa; elas aparecerão no menu de captura.`
            : `The catalogue has ${books.length} ${books.length === 1 ? 'book' : 'books'}. Pick the ones you use and the capture dropdown shows only those.`}
        </p>
        {books.length ? (
          <div className="bettrack-book-list">
            {visibleBooks.map((book) => (
              <button
                type="button"
                key={book.id}
                className={selectedBooks.includes(book.id) ? 'is-selected' : ''}
                aria-pressed={selectedBooks.includes(book.id)}
                onClick={() => toggleBook(book.id)}
              >
                <span className="bettrack-book-check">
                  {selectedBooks.includes(book.id) ? '✓' : '+'}
                </span>
                <strong>{book.name.toUpperCase()}</strong>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            className="bettrack-settings-empty"
            onClick={() => open({ kind: 'catalog', catalogKind: 'bookmaker' })}
          >
            <span>+</span>
            <strong>ADD YOUR FIRST SPORTSBOOK</strong>
            <small>Your bet history stays yours. Add the books you use to get started.</small>
          </button>
        )}
        {books.length > 11 ? (
          <button
            type="button"
            className="bettrack-see-books"
            onClick={() => setShowAllBooks((value) => !value)}
          >
            {showAllBooks ? 'SHOW LESS' : `SEE ALL ${books.length}`}
          </button>
        ) : null}
      </section>

      <section className="bettrack-settings-section bettrack-responsible">
        <header className="bettrack-settings-heading">
          <div>
            <h2>RESPONSIBLE GAMBLING</h2>
          </div>
        </header>
        <div className="bettrack-responsible-grid">
          <article className="is-limit">
            <span>DAILY LIMIT</span>
            <h3>REVIEW OR SET YOUR DAILY LIMIT</h3>
            <p>
              The limit is configured from your bankroll and recalculates when your bankroll
              changes.
            </p>
            <a href="#finance">
              OPEN BANKROLL <b>↗</b>
            </a>
          </article>
          <article className="is-alert">
            <span>ALERTS</span>
            <h3>YOUR BETS STAY IN YOUR CONTROL</h3>
            <p>
              This workspace records bets and results. It does not place bets, hold funds, or block
              a sportsbook account.
            </p>
            <small>STAKEFRAME DOES NOT PLACE BETS</small>
          </article>
          <article className="bettrack-responsible-wide">
            <span>IF IT FEELS LIKE IT GOT AWAY FROM YOU</span>
            <h3>Take a pause and talk to someone you trust.</h3>
            <p>
              For confidential help, contact a gambling support service in your country. Support
              availability and phone numbers vary by location.
            </p>
          </article>
        </div>
      </section>

      <section className="bettrack-settings-export">
        <div>
          <p>Your bets are yours. The file has one row per bet, with amounts, odds and results.</p>
        </div>
        <a
          href={`/api/v1/exports/csv?from=${saoPauloDate(new Date()).slice(0, 7)}-01&to=${saoPauloDate(new Date())}&kind=all&includeEstimated=false`}
        >
          DOWNLOAD MY BETS AS CSV
        </a>
      </section>

      <details className="bettrack-workspace-settings">
        <summary>
          STAKEFRAME WORKSPACE SETTINGS <span>CATALOG · UNITS · TELEGRAM</span>
        </summary>
        <div>
          <SettingsPage workspace={workspace} open={open} />
        </div>
      </details>
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
                    <td>{formatDisplayMoney(unit.amount)}</td>
                    <td>
                      {unit.source === 'manual'
                        ? 'Valor informado pelo proprietário'
                        : formatDisplayMoney(unit.base)}
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
