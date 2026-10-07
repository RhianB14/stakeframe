import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  calendarPageSchema,
  calendarItemSchema,
  eventSearchSchema,
  eventSearchStatusSchema,
  formatBRL,
  eventSearchInputSchema,
  saoPauloDate,
  type Workspace,
  type CalendarItem,
  type EventCandidate,
  type EventSearchInput,
  type EventProvider,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { CommandForm } from './actions.js';
import { Field } from './forms.js';
import { request, localInstant, ApiFailure, dateLabel } from './api.js';
import type { OpenModal } from './ProductApp.js';

const providerNames = { thesportsdb: 'TheSportsDB', tavily: 'Tavily' };
const certaintyNames = {
  pending: 'Data pendente',
  estimated: 'Data estimada',
  confirmed: 'Data confirmada',
};
function dayLabel(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`),
  );
}
function formatUnits(value: string) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} U`
    : `${value} U`;
}
/**
 * STK-F2-18 (Fase 4): a grade usava `['D','S','T','Q','Q','S','S']` — duas
 * quartas e dois sábados idênticos, e o leitor de tela anunciava "Q" duas
 * vezes sem distinguir qual era. A sigla continua curta; o nome inteiro
 * vai em `title`, que é o que o leitor de tela e o hover anunciam.
 */
const weekdayNames = [
  { short: 'D', long: 'Domingo' },
  { short: 'S', long: 'Segunda' },
  { short: 'T', long: 'Terça' },
  { short: 'Q', long: 'Quarta' },
  { short: 'Q', long: 'Quinta' },
  { short: 'S', long: 'Sexta' },
  { short: 'S', long: 'Sábado' },
] as const;

function timeValue(instant: string | null) {
  return instant
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(instant))
    : '';
}
export function CalendarPage({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  const [month, setMonth] = useState(() => saoPauloDate(new Date()).slice(0, 7));
  const [day, setDay] = useState('');
  const [view, setView] = useState<'scheduled' | 'pending'>('scheduled');
  const [state, setState] = useState('open');
  const [resultMode, setResultMode] = useState<'money' | 'units'>('units');
  const [page, setPage] = useState(1);
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const startWeekday = new Date(`${month}-01T12:00:00Z`).getUTCDay();
  const from = day || `${month}-01`;
  const to = day || `${month}-${days}`;
  const query = useQuery({
    queryKey: ['product', 'calendar', from, to, view, state, page, workspace.version],
    queryFn: () =>
      request(
        `/api/v1/calendar?from=${from}&to=${to}&view=${view}&page=${page}&pageSize=25${state ? `&betState=${state}` : ''}`,
        calendarPageSchema,
      ),
  });
  function changeView(value: 'scheduled' | 'pending') {
    setView(value);
    setPage(1);
  }
  // STK-F2-18 (Fase 4): a grade do mês deixa de ser só um seletor de dia e
  // passa a mostrar o que existe em cada dia. Antes ela respondia "que dia
  // eu escolho" e a resposta de "o que tem neste dia" exigia clicar duas
  // vezes. O recorte de dados é o mesmo da agenda: quando há dia escolhido a
  // grade continua inteira e só o destaque muda, porque o mês é a unidade de
  // leitura do calendário.
  const monthQuery = useQuery({
    queryKey: ['product', 'calendar-month', month, workspace.version],
    queryFn: () =>
      request(
        `/api/v1/calendar?from=${month}-01&to=${month}-${days}&view=scheduled&page=1&pageSize=100`,
        calendarPageSchema,
      ),
    enabled: month !== '',
  });
  const byDay = useMemo(() => {
    const grouped = new Map<string, CalendarItem[]>();
    for (const item of monthQuery.data?.items ?? []) {
      const date = item.selection.eventDate;
      if (!date) continue;
      const list = grouped.get(date) ?? [];
      list.push(item);
      grouped.set(date, list);
    }
    return grouped;
  }, [monthQuery.data]);
  const resultsByDay = useMemo(
    () => new Map((monthQuery.data?.dailyResults ?? []).map((result) => [result.date, result])),
    [monthQuery.data],
  );
  return (
    <div className="calendar-layout">
      <section className="panel calendar-picker" aria-label="Escolher período">
        <div className="calendar-picker-toolbar">
          <Field label="Mês do calendário">
            <input
              type="month"
              value={month}
              min="2000-01"
              max="2100-12"
              onChange={(event) => {
                if (/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(event.target.value)) {
                  setMonth(event.target.value);
                  setDay('');
                  setPage(1);
                }
              }}
            />
          </Field>
          <Field label="Resultado do dia">
            <select
              value={resultMode}
              onChange={(event) => setResultMode(event.target.value as typeof resultMode)}
            >
              <option value="units">Unidades ganhas</option>
              <option value="money">Valor em R$</option>
            </select>
          </Field>
        </div>
        <div className="calendar-grid" aria-label="Dias do mês">
          {weekdayNames.map((label) => (
            <span className="calendar-weekday" aria-hidden="true" key={label.long}>
              <abbr title={label.long}>{label.short}</abbr>
            </span>
          ))}
          {Array.from({ length: startWeekday }, (_, index) => (
            <span key={`blank-${index}`} />
          ))}
          {Array.from({ length: days }, (_, index) => {
            const value = `${month}-${String(index + 1).padStart(2, '0')}`;
            const items = byDay.get(value) ?? [];
            const dailyResult = resultsByDay.get(value);
            const displayedResult = dailyResult
              ? resultMode === 'money'
                ? formatBRL(dailyResult.profit)
                : dailyResult.profitUnits === null
                  ? 'Unid. —'
                  : formatUnits(dailyResult.profitUnits)
              : null;
            const resultIsNegative =
              resultMode === 'money'
                ? (dailyResult?.profit.startsWith('-') ?? false)
                : (dailyResult?.profitUnits?.startsWith('-') ?? false);
            // A agenda não soma valor por SELEÇÃO: um mesmo bilhete pode ter
            // duas seleções no mesmo dia e continuaria sendo uma aposta. A
            // contagem de chips é de seleções e a legenda diz isso.
            const selected = day === value;
            return (
              <button
                type="button"
                key={value}
                aria-label={[
                  dayLabel(value),
                  items.length > 0
                    ? `${items.length} ${items.length === 1 ? 'seleção' : 'seleções'}`
                    : '',
                  displayedResult ? `resultado ${displayedResult}` : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
                aria-pressed={selected}
                className={[
                  'calendar-day',
                  value === saoPauloDate(new Date()) ? 'calendar-today' : '',
                  selected ? 'calendar-selected' : '',
                  items.length > 0 ? 'has-events' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  setDay(selected ? '' : value);
                  setView('scheduled');
                  setPage(1);
                }}
              >
                <span className="calendar-daynum">{index + 1}</span>
                {displayedResult ? (
                  <span className={`calendar-day-result${resultIsNegative ? ' is-negative' : ''}`}>
                    {displayedResult}
                  </span>
                ) : null}
                {items.length > 0 ? (
                  <span className="calendar-chips" aria-hidden="true">
                    {items.slice(0, 3).map((item) => (
                      <span
                        key={item.selection.id}
                        className={`calendar-chip chip-${item.betState}`}
                      />
                    ))}
                    {items.length > 3 ? (
                      <span className="calendar-chip chip-more">+{items.length - 3}</span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="calendar-legend" aria-hidden="true">
          <span>
            <i className="chip-open" /> Em aberto
          </span>
          <span>
            <i className="chip-settled" /> Liquidada
          </span>
          <span>
            <i className="chip-cancelled" /> Cancelada
          </span>
        </div>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setDay('');
            setView('scheduled');
            setPage(1);
          }}
        >
          Ver o mês inteiro
        </Button>
        <p className="muted">
          Resultados pela data da liquidação, no horário de São Paulo. Datas sem horário de evento
          permanecem sem hora definida.
        </p>
      </section>
      <section className="panel calendar-agenda" aria-label="Agenda de eventos">
        <div className="section-heading">
          <div>
            <h2>
              {view === 'pending' ? 'Datas a conferir' : day ? dayLabel(day) : 'Agenda do mês'}
            </h2>
            <p>Cada seleção mantém seu vínculo com o bilhete.</p>
          </div>
        </div>
        {/* STK-F2-18 (Fase 4): as duas abas eram ambas `default`, ou seja dois
            botões sólidos no mesmo viewport. A visão ativa vira segmentado —
            estado de onde se está, não ação — e o e2e continua encontra o
            botão pelo nome acessível. */}
        <div className="button-row calendar-tabs" role="group" aria-label="Fonte da agenda">
          <Button
            type="button"
            variant="ghost"
            aria-pressed={view === 'scheduled'}
            className={view === 'scheduled' ? 'segment-selected' : undefined}
            onClick={() => changeView('scheduled')}
          >
            Programação
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={view === 'pending'}
            className={view === 'pending' ? 'segment-selected' : undefined}
            onClick={() => changeView('pending')}
          >
            Pendências{query.data ? ` (${query.data.pendingSelections})` : ''}
          </Button>
        </div>
        <Field label="Situação das apostas no calendário">
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setPage(1);
            }}
          >
            <option value="open">Em aberto</option>
            <option value="settled">Liquidadas</option>
            <option value="cancelled">Canceladas</option>
            <option value="">Todas</option>
          </select>
        </Field>
        {view === 'pending' ? (
          <p className="notice warning">
            Eventos sem data ou adiados, de todos os meses. A aposta pode ser liquidada manualmente
            enquanto a data é conferida.
          </p>
        ) : null}
        {query.isError ? (
          <p role="alert">
            Não foi possível carregar o calendário.{' '}
            <Button
              variant="ghost"
              onClick={() => {
                void query.refetch();
              }}
            >
              Tentar novamente
            </Button>
          </p>
        ) : !query.data ? (
          <p role="status">Carregando agenda…</p>
        ) : (
          <>
            <p className="calendar-summary">
              {query.data.total} {query.data.total === 1 ? 'seleção' : 'seleções'} ·{' '}
              {query.data.distinctBets}{' '}
              {query.data.distinctBets === 1 ? 'aposta distinta' : 'apostas distintas'}
            </p>
            {query.data.items.length === 0 ? (
              <div className="empty-state">
                <h3>Nenhum evento nesta lista</h3>
                <p>Confira as pendências ou selecione outro período.</p>
              </div>
            ) : (
              <div className="event-list">
                {query.data.items.map((item) => (
                  <article className="event-card" key={item.selection.id}>
                    <div className="event-timing">
                      <strong>
                        {item.selection.eventDate
                          ? item.selection.eventDate.split('-').reverse().join('/')
                          : 'Sem data'}
                      </strong>
                      <span>
                        {item.selection.eventAt
                          ? timeValue(item.selection.eventAt).slice(0, 5)
                          : 'Hora a definir'}
                      </span>
                    </div>
                    <div className="event-description">
                      <h3>{item.selection.event}</h3>
                      <p>
                        {item.selection.market} · {item.selection.selection}
                      </p>
                      <small>
                        {item.bookmaker}
                        {item.betReference ? ` · ${item.betReference}` : ''}
                      </small>
                      <div className="button-row">
                        <span
                          className={`status-badge ${item.selection.dateStatus === 'confirmed' ? '' : 'warning'}`}
                        >
                          {certaintyNames[item.selection.dateStatus]}
                        </span>
                        {item.scheduleStatus !== 'scheduled' ? (
                          <span className="status-badge warning">
                            {item.scheduleStatus === 'postponed' ? 'Adiado' : 'Evento cancelado'}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="event-actions">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => open({ kind: 'event', id: item.selection.id })}
                      >
                        Conferir data
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => open({ kind: 'detail', id: item.betId })}
                      >
                        Ver aposta
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="pagination">
              <span>Página {page}</span>
              <div className="button-row">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  Anterior
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={page * 25 >= query.data.total}
                  onClick={() => setPage(page + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          </>
        )}
        <p className="muted">
          O resultado diário soma o lucro líquido das liquidações. As seleções da agenda continuam
          vinculadas às datas dos eventos.
        </p>
      </section>
    </div>
  );
}
export function EventReview({
  id,
  owner,
  workspace,
  onDone,
}: {
  id: string;
  owner: string;
  workspace: Workspace;
  onDone: () => void;
}) {
  const query = useQuery({
    queryKey: ['product', 'event', id, workspace.version],
    queryFn: () => request(`/api/v1/events/${id}`, calendarItemSchema),
  });
  if (query.isError)
    return (
      <p role="alert">
        Não foi possível carregar o evento.{' '}
        <Button
          onClick={() => {
            void query.refetch();
          }}
        >
          Tentar novamente
        </Button>
      </p>
    );
  if (!query.data) return <p role="status">Carregando evento…</p>;
  return <EventEditor item={query.data} owner={owner} onDone={onDone} />;
}
function EventEditor({
  item,
  owner,
  onDone,
}: {
  item: CalendarItem;
  owner: string;
  onDone: () => void;
}) {
  const [date, setDate] = useState(item.selection.eventDate ?? '');
  const [time, setTime] = useState(timeValue(item.selection.eventAt));
  const [certainty, setCertainty] = useState(
    item.selection.dateStatus === 'confirmed' ? 'confirmed' : 'estimated',
  );
  const [schedule, setSchedule] = useState(item.scheduleStatus);
  const [candidate, setCandidate] = useState<EventCandidate | null>(item.dateEvidence);
  const [reason, setReason] = useState('');
  function selectCandidate(value: EventCandidate) {
    setCandidate(value);
    if (value.postponed) {
      setDate('');
      setTime('');
      setSchedule('postponed');
    } else if (value.suggestedAt) {
      setDate(saoPauloDate(new Date(value.suggestedAt)));
      setTime(timeValue(value.suggestedAt));
      setCertainty('estimated');
      setSchedule('scheduled');
    }
  }
  return (
    <div className="event-review">
      <h3>{item.selection.event}</h3>
      <p className="muted">
        {item.selection.market} · {item.selection.selection} · {item.bookmaker}
      </p>
      <div className="notice">
        Registro atual:{' '}
        {item.selection.eventAt
          ? dateLabel(item.selection.eventAt)
          : item.selection.eventDate
            ? `${item.selection.eventDate.split('-').reverse().join('/')} · sem horário`
            : 'Data pendente'}{' '}
        · {certaintyNames[item.selection.dateStatus]}. Origem:{' '}
        {item.dateSource === 'manual' ? 'informação manual' : providerNames[item.dateSource]}.
      </div>
      <EventSearchPanel item={item} owner={owner} select={selectCandidate} />
      <CommandForm
        onDone={onDone}
        submitLabel="Salvar data conferida"
        onSubmit={() => {
          if (time && !date) throw new Error('Informe a data antes do horário.');
          return {
            type: 'event.update',
            selectionId: item.selection.id,
            eventDate: date || null,
            eventAt: time ? localInstant(`${date}T${time}`) : null,
            dateStatus: date ? (certainty as 'confirmed' | 'estimated') : 'pending',
            scheduleStatus: schedule,
            candidateId: candidate?.id ?? null,
            reason,
          };
        }}
      >
        <h3>Data para este registro</h3>
        <p className="form-intro">
          Preencha em horário de São Paulo. A alteração será registrada no histórico da aposta.
        </p>
        {candidate ? (
          <div className="notice">
            Fonte selecionada: {providerNames[candidate.provider]} — {candidate.title}.
            {!candidate.suggestedAt && !candidate.postponed
              ? ' A fonte não informa um instante com fuso explícito; confira e preencha os campos abaixo.'
              : ''}
            <Button type="button" variant="ghost" size="small" onClick={() => setCandidate(null)}>
              Usar informação manual
            </Button>
          </div>
        ) : null}
        <Field label="Programação do evento">
          <select
            value={schedule}
            onChange={(event) => {
              const value = event.target.value as CalendarItem['scheduleStatus'];
              setSchedule(value);
              setCandidate(null);
              if (value === 'postponed') {
                setDate('');
                setTime('');
              }
            }}
          >
            <option value="scheduled">Programado</option>
            <option value="postponed">Adiado, nova data pendente</option>
            <option value="cancelled">Evento cancelado</option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Data do evento">
            <input
              type="date"
              disabled={schedule === 'postponed'}
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                if (!event.target.value) setTime('');
              }}
            />
          </Field>
          <Field label="Horário em São Paulo (opcional)">
            <input
              type="time"
              step="1"
              disabled={schedule === 'postponed' || !date}
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Confiança na data">
          <select
            disabled={!date}
            value={certainty}
            onChange={(event) => setCertainty(event.target.value)}
          >
            <option value="confirmed">Conferida e confirmada</option>
            <option value="estimated">Estimada, ainda a conferir</option>
          </select>
        </Field>
        <Field label="Motivo da atualização">
          <textarea
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <label className="checkbox-field">
          <input type="checkbox" required />
          Conferi o evento, a data e o fuso. Entendo que a liquidação da aposta continua manual.
        </label>
      </CommandForm>
    </div>
  );
}
type PendingSearch = { owner: string; key: string; input: EventSearchInput };
function readPendingSearch(slot: string, owner: string): PendingSearch | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(slot) ?? 'null') as PendingSearch | null;
    if (
      !value ||
      value.owner !== owner ||
      typeof value.key !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(value.key)
    )
      return null;
    return { ...value, input: eventSearchInputSchema.parse(value.input) };
  } catch {
    return null;
  }
}
function EventSearchPanel({
  item,
  owner,
  select,
}: {
  item: CalendarItem;
  owner: string;
  select: (value: EventCandidate) => void;
}) {
  const client = useQueryClient();
  const slot = `stakeframe.pending-event-search:${item.selection.id}`;
  const [pending, setPending] = useState(() => readPendingSearch(slot, owner));
  const [provider, setProvider] = useState<EventProvider>('thesportsdb');
  const [dateHint, setHint] = useState(item.selection.eventDate ?? '');
  const [refresh, setRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['product', 'event-search-status'],
    queryFn: () => request('/api/v1/event-search/status', eventSearchStatusSchema),
    refetchInterval: 30_000,
  });
  const searches = useQuery({
    queryKey: ['product', 'event-search', item.selection.id],
    queryFn: () =>
      request(`/api/v1/event-search?selectionId=${item.selection.id}`, eventSearchSchema.array()),
    refetchInterval: (query) =>
      query.state.data?.some((row) => ['pending', 'processing'].includes(row.state)) ? 3000 : false,
  });
  const available = status.data?.providers.find((value) => value.provider === provider);
  async function submit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const operation = pending ?? {
        owner,
        key: crypto.randomUUID(),
        input: { selectionId: item.selection.id, provider, dateHint: dateHint || null, refresh },
      };
      sessionStorage.setItem(slot, JSON.stringify(operation));
      setPending(operation);
      await request('/api/v1/event-search', eventSearchSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': operation.key },
        body: JSON.stringify(operation.input),
      });
      sessionStorage.removeItem(slot);
      setPending(null);
      await client.invalidateQueries({ queryKey: ['product', 'event-search', item.selection.id] });
      await client.invalidateQueries({ queryKey: ['product', 'event-search-status'] });
    } catch (reason) {
      if (
        reason instanceof ApiFailure &&
        reason.status >= 400 &&
        reason.status < 500 &&
        ![401, 403, 408, 429].includes(reason.status)
      ) {
        sessionStorage.removeItem(slot);
        setPending(null);
      }
      setError(reason instanceof Error ? reason.message : 'Não foi possível solicitar a busca.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="event-search-panel" aria-label="Buscar fontes de programação">
      <h3>Conferir em fontes externas</h3>
      <p>Uma busca limitada pode não encontrar o evento. Nenhuma consulta altera a data salva.</p>
      <div className="form-grid">
        <Field label="Fonte da busca">
          <select
            disabled={!!pending || busy}
            value={provider}
            onChange={(event) => setProvider(event.target.value as EventProvider)}
          >
            <option value="thesportsdb">TheSportsDB</option>
            <option value="tavily">Tavily</option>
          </select>
        </Field>
        <Field label="Data aproximada para buscar (opcional)">
          <input
            type="date"
            disabled={!!pending || busy}
            value={dateHint}
            onChange={(event) => setHint(event.target.value)}
          />
        </Field>
      </div>
      {status.isError ? (
        <p role="alert">
          Não foi possível verificar as fontes.{' '}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void status.refetch();
            }}
          >
            Tentar novamente
          </Button>
        </p>
      ) : available ? (
        <p className="muted">
          {available.enabled
            ? `${available.dailyUsed}/${available.dailyLimit} consultas hoje · ${available.monthlyUsed}/${available.monthlyLimit} neste mês (UTC).`
            : 'Fonte desativada neste ambiente. O preenchimento manual está disponível.'}
        </p>
      ) : (
        <p role="status">Conferindo disponibilidade…</p>
      )}
      <label className="checkbox-field">
        <input
          type="checkbox"
          disabled={!!pending || busy}
          checked={refresh}
          onChange={(event) => setRefresh(event.target.checked)}
        />
        Consultar novamente a fonte, sem usar o cache de 24 horas. Consome uma consulta.
      </label>
      {pending ? (
        <p className="notice warning">
          A solicitação anterior precisa ser verificada. A verificação reutiliza a mesma consulta.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Button
        type="button"
        variant="secondary"
        disabled={busy || (!pending && !available?.enabled)}
        onClick={() => {
          void submit();
        }}
      >
        {busy ? 'Solicitando…' : pending ? 'Verificar consulta' : 'Buscar programação'}
      </Button>
      {searches.isError ? (
        <p role="alert">
          Não foi possível carregar as buscas.{' '}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void searches.refetch();
            }}
          >
            Tentar novamente
          </Button>
        </p>
      ) : searches.data?.length ? (
        <div className="search-history">
          <p className="muted">
            Até 20 consultas recentes. Confira nomes, competição, data, fuso e possíveis adiamentos.
          </p>
          {searches.data.map((search) => (
            <details key={search.id} open={search === searches.data[0]}>
              <summary>
                {providerNames[search.provider]} · {dateLabel(search.createdAt)} ·{' '}
                {search.cached
                  ? 'Resultado em cache'
                  : search.state === 'complete'
                    ? 'Consulta concluída'
                    : search.state === 'failed'
                      ? 'Requer atenção'
                      : 'Consultando…'}
              </summary>
              <p>
                {search.query}
                {search.dateHint ? ` · data aproximada ${search.dateHint}` : ''}
              </p>
              {search.errorCode ? (
                <p className="notice warning">
                  {search.errorCode === 'EVENT_QUOTA_REACHED'
                    ? 'O limite de consultas foi atingido.'
                    : search.errorCode === 'EVENT_OUTCOME_UNCERTAIN'
                      ? 'A consulta foi interrompida e não será repetida automaticamente.'
                      : 'Não foi possível concluir a consulta. Você pode solicitar outra busca ou conferir a data manualmente.'}
                </p>
              ) : null}
              {search.state === 'complete' && search.candidates.length === 0 ? (
                <p>Nenhum candidato retornado nesta consulta limitada.</p>
              ) : null}
              {search.candidates.map((candidate) => (
                <article key={candidate.id} className="event-candidate">
                  <a href={candidate.url} target="_blank" rel="noreferrer">
                    {candidate.title}
                  </a>
                  <p>{candidate.excerpt}</p>
                  {candidate.rawDate || candidate.rawTime ? (
                    <p>
                      Informação original: {candidate.rawDate} {candidate.rawTime}
                    </p>
                  ) : null}
                  {candidate.postponed ? (
                    <p className="notice warning">A fonte informa adiamento.</p>
                  ) : !candidate.suggestedAt ? (
                    <p className="muted">
                      Sem horário com fuso explícito. Confira antes de preencher.
                    </p>
                  ) : (
                    <p>Horário convertido: {dateLabel(candidate.suggestedAt)}</p>
                  )}
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    onClick={() => select(candidate)}
                  >
                    Usar esta fonte na conferência
                  </Button>
                </article>
              ))}
            </details>
          ))}
        </div>
      ) : null}
    </section>
  );
}
