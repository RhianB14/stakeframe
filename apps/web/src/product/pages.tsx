import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  betPageSchema,
  betDetailSchema,
  journalPageSchema,
  formatBRL,
  saoPauloDate,
  type Workspace,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { request, dateLabel } from './api.js';
import type { OpenModal } from './ProductApp.js';
import { BetAttachments } from './imports.js';

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
  workspace.catalog.find((item) => item.id === id)?.name ?? 'Sem tipster';
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
          <Field label="Apostada desde">
            <input
              type="date"
              value={from}
              onChange={(event) => change(setFrom, event.target.value)}
            />
          </Field>
          <Field label="Apostada até">
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
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Bilhete / evento</th>
                    <th>Casa</th>
                    <th>Valor</th>
                    <th>Odd</th>
                    <th>Situação</th>
                    <th>Resultado realizado</th>
                    <th>
                      <span className="sr-only">Abrir</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((bet) => (
                    <tr key={bet.id}>
                      <td>
                        <button
                          className="table-title"
                          onClick={() => open({ kind: 'detail', id: bet.id })}
                        >
                          {bet.selections[0]?.event ?? 'Bilhete'}
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
                        {formatBRL(bet.stake)}
                        <small>
                          {bet.stakeUnits === null
                            ? 'Unidade a conferir'
                            : `${Number(bet.stakeUnits).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} u`}
                        </small>
                      </td>
                      <td className="tabular">{bet.odds}</td>
                      <td>
                        <span className={`status-badge status-${bet.state}`}>
                          {stateLabels[bet.state]}
                        </span>
                      </td>
                      <td
                        className={`tabular ${bet.profit.startsWith('-') ? 'negative' : 'positive'}`}
                      >
                        {formatBRL(bet.profit)}
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
                  ))}
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
  return (
    <div className="bet-detail">
      <div className="detail-heading">
        <span className={`status-badge status-${bet.state}`}>{stateLabels[bet.state]}</span>
        <span>
          {catalogName(workspace, bet.bookmakerId)} · {catalogName(workspace, bet.tipsterId)}
        </span>
      </div>
      <div className="detail-metrics">
        <div>
          <span>Valor apostado</span>
          <strong>
            {formatBRL(bet.stake)}
            {bet.freebetId ? ' · freebet' : ''}
          </strong>
        </div>
        <div>
          <span>Odd total</span>
          <strong>{bet.odds}</strong>
        </div>
        <div>
          <span>Principal aberto</span>
          <strong>{formatBRL(bet.remaining)}</strong>
        </div>
        <div>
          <span>Retorno recebido</span>
          <strong>{formatBRL(bet.returnAmount)}</strong>
        </div>
        <div>
          <span>Resultado realizado</span>
          <strong>{formatBRL(bet.profit)}</strong>
        </div>
        <div>
          <span>Unidade do registro</span>
          <strong>{bet.unitAmount ? formatBRL(bet.unitAmount) : 'A conferir'}</strong>
        </div>
      </div>
      <p className="muted">
        Apostada em {dateLabel(bet.placedAt)} · Cadastrada em {dateLabel(bet.createdAt)}
      </p>
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
            {selection.eventAt
              ? dateLabel(selection.eventAt)
              : selection.eventDate
                ? `${selection.eventDate.split('-').reverse().join('/')} · horário não informado`
                : 'Data do evento pendente'}
            {selection.dateStatus === 'estimated' ? ' · estimada' : ''}
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
    </>
  );
}
