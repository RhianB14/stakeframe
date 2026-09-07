import { cloneElement, useId, useState, type ReactElement } from 'react';
import {
  formatBRL,
  suggestedReturn,
  type Workspace,
  type CatalogItem,
  type Bet,
  type SelectionInput,
  type ImportDetail,
} from '@stakeframe/shared';
import { CommandForm } from './actions.js';
import { decimalInput, localNow, localInstant, type CommandInput } from './api.js';
import { Button } from '../components/ui/button.js';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) })}
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}
export function InitializeForm({
  workspace,
  onDone,
}: {
  workspace: Workspace;
  onDone: () => void;
}) {
  const [reserve, setReserve] = useState('');
  const [percent, setPercent] = useState('1,00');
  const [balances, setBalances] = useState<Record<string, string>>({});
  const houses = workspace.catalog.filter((item) => item.kind === 'bookmaker' && item.active);
  return (
    <CommandForm
      onDone={onDone}
      submitLabel="Confirmar saldos iniciais"
      onSubmit={() => ({
        type: 'bankroll.initialize',
        reserve: decimalInput(reserve || '0'),
        unitPercent: decimalInput(percent),
        balances: houses.map((house) => ({
          bookmakerId: house.id,
          amount: decimalInput(balances[house.id] || '0'),
        })),
      })}
    >
      <p className="form-intro">
        Comece com os saldos disponíveis que você conferiu. A unidade deste mês será calculada sobre
        essa banca inicial.
      </p>
      <div className="form-grid">
        <Field label="Reserva (R$)">
          <input
            inputMode="decimal"
            placeholder="0,00"
            value={reserve}
            onChange={(event) => setReserve(event.target.value)}
          />
        </Field>
        {houses.map((house) => (
          <Field key={house.id} label={`${house.name} (R$)`}>
            <input
              inputMode="decimal"
              placeholder="0,00"
              value={balances[house.id] ?? ''}
              onChange={(event) => setBalances({ ...balances, [house.id]: event.target.value })}
            />
          </Field>
        ))}
        <Field label="Unidade mensal (%)" hint="Fica congelada durante o mês.">
          <input
            required
            inputMode="decimal"
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
          />
        </Field>
      </div>
      <label className="checkbox-field">
        <input type="checkbox" required />
        Conferi os saldos reais e quero iniciar minha banca.
      </label>
    </CommandForm>
  );
}
export function CashForm({
  workspace,
  kind,
  accountId,
  onDone,
}: {
  workspace: Workspace;
  kind: 'deposit' | 'withdrawal' | 'transfer' | 'reconcile';
  accountId?: string;
  onDone: () => void;
}) {
  const [account, setAccount] = useState(accountId ?? workspace.accounts[0]?.id ?? '');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [at, setAt] = useState(localNow);
  const [reason, setReason] = useState('');
  return (
    <CommandForm
      onDone={onDone}
      submitLabel="Registrar movimentação"
      onSubmit={() => ({
        type: 'money.move',
        kind,
        accountId: account,
        targetAccountId: kind === 'transfer' ? target : null,
        amount: decimalInput(amount),
        effectiveAt: localInstant(at),
        reason,
      })}
    >
      <div className="form-grid">
        <Field label={kind === 'transfer' ? 'Conta de origem' : 'Conta'}>
          <select required value={account} onChange={(event) => setAccount(event.target.value)}>
            {workspace.accounts.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {formatBRL(item.balance)}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'transfer' ? (
          <Field label="Conta de destino">
            <select required value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Selecione</option>
              {workspace.accounts
                .filter((item) => item.id !== account)
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        <Field
          label={kind === 'reconcile' ? 'Saldo real conferido (R$)' : 'Valor (R$)'}
          hint={
            kind === 'reconcile'
              ? 'O ajuste será registrado separadamente do resultado das apostas.'
              : undefined
          }
        >
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0,00"
          />
        </Field>
        <Field label="Data e hora da movimentação" hint="Horário de São Paulo.">
          <input
            required
            type="datetime-local"
            step="1"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Motivo / observação">
        <textarea
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
        />
      </Field>
    </CommandForm>
  );
}
export function CatalogForm({
  kind,
  item,
  onDone,
}: {
  kind: 'bookmaker' | 'tipster';
  item?: CatalogItem;
  onDone: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [aliases, setAliases] = useState(item?.aliases.join('\n') ?? '');
  const [active, setActive] = useState(item?.active ?? true);
  return (
    <CommandForm
      onDone={onDone}
      onSubmit={() => {
        const values = {
          name,
          aliases: aliases
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        };
        return item
          ? { type: 'catalog.update', id: item.id, active, ...values }
          : { type: 'catalog.create', kind, ...values };
      }}
    >
      <Field label="Nome">
        <input
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Outros nomes / aliases"
        hint="Um por linha. Usados para reconhecer as legendas dos bilhetes."
      >
        <textarea rows={4} value={aliases} onChange={(event) => setAliases(event.target.value)} />
      </Field>
      {item ? (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Cadastro ativo
        </label>
      ) : null}
    </CommandForm>
  );
}
export function FreebetForm({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [bookmakerId, setBookmaker] = useState('');
  const [amount, setAmount] = useState('');
  const [expiresOn, setExpiry] = useState('');
  const [stakeReturned, setReturned] = useState(false);
  const [note, setNote] = useState('');
  return (
    <CommandForm
      onDone={onDone}
      onSubmit={() => ({
        type: 'freebet.create',
        bookmakerId,
        amount: decimalInput(amount),
        expiresOn,
        stakeReturned,
        note,
      })}
    >
      <div className="form-grid">
        <Field label="Casa da freebet">
          <select
            required
            value={bookmakerId}
            onChange={(event) => setBookmaker(event.target.value)}
          >
            <option value="">Selecione</option>
            {workspace.catalog
              .filter((item) => item.kind === 'bookmaker' && item.active)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Crédito promocional (R$)">
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Válida até">
          <input
            required
            type="date"
            value={expiresOn}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </Field>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={stakeReturned}
          onChange={(event) => setReturned(event.target.checked)}
        />
        A casa devolve o valor promocional junto ao prêmio em dinheiro.
      </label>
      <Field label="Observação">
        <textarea
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <p className="form-intro">Esse crédito não será somado à banca real.</p>
    </CommandForm>
  );
}
export function UnitForm({ onDone }: { onDone: () => void }) {
  const [month, setMonth] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <CommandForm
      onDone={onDone}
      onSubmit={() => ({ type: 'unit.set', month, amount: decimalInput(amount), reason })}
    >
      <Field label="Mês da unidade">
        <input
          type="month"
          required
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
      </Field>
      <Field label="Valor da unidade histórica (R$)">
        <input
          required
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </Field>
      <Field label="Como o valor foi conferido">
        <textarea
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <p className="form-intro">
        Uma unidade já congelada não será substituída. Registros anteriores sem unidade continuam
        identificados para revisão.
      </p>
    </CommandForm>
  );
}
export function SettingsForm({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [percent, setPercent] = useState(workspace.unitPercent);
  return (
    <CommandForm
      onDone={onDone}
      onSubmit={() => ({ type: 'settings.update', unitPercent: decimalInput(percent) })}
    >
      <Field label="Percentual para os próximos meses">
        <input
          required
          inputMode="decimal"
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
        />
      </Field>
      <p className="form-intro">
        A unidade do mês atual e as unidades históricas permanecem congeladas.
      </p>
    </CommandForm>
  );
}
export function CorrectionForm({
  onDone,
  build,
}: {
  onDone: () => void;
  build: (reason: string, effectiveAt: string) => CommandInput;
}) {
  const [reason, setReason] = useState('');
  const [at, setAt] = useState(localNow);
  return (
    <CommandForm
      onDone={onDone}
      submitLabel="Confirmar estorno"
      onSubmit={() => build(reason, localInstant(at))}
    >
      <p className="form-intro">
        O lançamento original será preservado. O estorno terá sua própria data e justificativa.
      </p>
      <Field label="Motivo do estorno">
        <textarea
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Field label="Data e hora do estorno">
        <input
          required
          type="datetime-local"
          step="1"
          value={at}
          onChange={(event) => setAt(event.target.value)}
        />
      </Field>
    </CommandForm>
  );
}

type SelectionForm = SelectionInput & { key: string; time: string };
const newSelection = (): SelectionForm => ({
  key: crypto.randomUUID(),
  event: '',
  sport: 'Futebol',
  market: '',
  selection: '',
  odds: null,
  eventDate: null,
  eventAt: null,
  dateStatus: 'confirmed',
  time: '',
});
export function BetForm({
  workspace,
  bet,
  review,
  onDone,
}: {
  workspace: Workspace;
  bet?: Bet;
  review?: ImportDetail;
  onDone: () => void;
}) {
  const [bookmakerId, setBookmaker] = useState(
    bet?.bookmakerId ??
      (review?.matches.conflict
        ? ''
        : (review?.matches.captionBookmakerId ?? review?.matches.extractedBookmakerId ?? '')),
  );
  const [tipsterId, setTipster] = useState(bet?.tipsterId ?? review?.matches.tipsterId ?? '');
  const [stake, setStake] = useState(bet?.stake ?? review?.extraction?.stake ?? '');
  const [odds, setOdds] = useState(bet?.odds ?? review?.extraction?.odds ?? '');
  const [placedAt, setPlaced] = useState(() => (review ? '' : localNow()));
  const [freebetId, setFreebet] = useState(bet?.freebetId ?? (review ? 'unconfirmed' : ''));
  const [reference, setReference] = useState(bet?.reference ?? review?.extraction?.reference ?? '');
  const [duplicateReason, setDuplicateReason] = useState('');
  const [selections, setSelections] = useState<SelectionForm[]>(() =>
    bet
      ? bet.selections.map((value) => ({
          ...value,
          key: crypto.randomUUID(),
          time: value.eventAt
            ? new Intl.DateTimeFormat('en-GB', {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23',
              }).format(new Date(value.eventAt))
            : '',
        }))
      : review?.extraction
        ? review.extraction.selections.map((value) => ({
            ...newSelection(),
            event: value.event ?? '',
            sport: value.sport,
            market: value.market ?? '',
            selection: value.selection ?? '',
            odds: value.odds,
            dateStatus: 'pending',
          }))
        : review
          ? [{ ...newSelection(), sport: null, dateStatus: 'pending' }]
          : [newSelection()],
  );
  const [allowMissingUnit, setMissing] = useState(false);
  const [reason, setReason] = useState('');
  const houses = workspace.catalog.filter(
    (item) => item.kind === 'bookmaker' && (item.active || item.id === bookmakerId),
  );
  const tipsters = workspace.catalog.filter(
    (item) => item.kind === 'tipster' && (item.active || item.id === tipsterId),
  );
  const updateSelection = (index: number, values: Partial<SelectionForm>) =>
    setSelections((current) =>
      current.map((item, i) => (i === index ? { ...item, ...values } : item)),
    );
  const built = () =>
    selections.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      event: item.event,
      sport: item.sport || null,
      market: item.market,
      selection: item.selection,
      odds: item.odds ? item.odds.replace(',', '.') : null,
      eventDate: item.eventDate || null,
      eventAt: item.time ? localInstant(`${item.eventDate ?? ''}T${item.time}`) : null,
      dateStatus: item.eventDate
        ? item.dateStatus === 'estimated'
          ? ('estimated' as const)
          : ('confirmed' as const)
        : ('pending' as const),
    }));
  return (
    <CommandForm
      onDone={onDone}
      submitLabel={
        bet
          ? 'Salvar correção'
          : review
            ? 'Confirmar importação e registrar aposta'
            : 'Registrar aposta'
      }
      onSubmit={() => {
        if (review && freebetId === 'unconfirmed')
          throw new Error('Confirme se a aposta usa dinheiro real ou freebet.');
        return bet
          ? {
              type: 'bet.update',
              id: bet.id,
              tipsterId: tipsterId || null,
              reference,
              selections: built(),
              reason,
            }
          : review
            ? {
                type: 'import.confirm',
                importId: review.item.id,
                expectedInboxVersion: review.item.version,
                decision: {
                  kind: 'create',
                  duplicateReason,
                  bet: {
                    bookmakerId,
                    tipsterId: tipsterId || null,
                    stake: decimalInput(stake),
                    odds: odds.replace(',', '.'),
                    placedAt: localInstant(placedAt),
                    freebetId: freebetId || null,
                    reference,
                    selections: built(),
                    allowMissingUnit,
                  },
                },
              }
            : {
                type: 'bet.create',
                bookmakerId,
                tipsterId: tipsterId || null,
                stake: decimalInput(stake),
                odds: odds.replace(',', '.'),
                placedAt: localInstant(placedAt),
                freebetId: freebetId || null,
                reference,
                selections: built(),
                allowMissingUnit,
              };
      }}
    >
      <div className="form-grid">
        <Field label="Casa de aposta">
          <select
            required
            disabled={!!bet}
            value={bookmakerId}
            onChange={(event) => {
              setBookmaker(event.target.value);
              setFreebet(review ? 'unconfirmed' : '');
            }}
          >
            <option value="">Selecione</option>
            {houses.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipster">
          <select value={tipsterId} onChange={(event) => setTipster(event.target.value)}>
            <option value="">Sem tipster</option>
            {tipsters.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {!bet ? (
          <>
            <Field label="Origem da aposta">
              <select
                value={freebetId}
                onChange={(event) => {
                  setFreebet(event.target.value);
                  const credit = workspace.freebets.find((item) => item.id === event.target.value);
                  if (credit) setStake(credit.amount);
                }}
              >
                {review ? (
                  <option value="unconfirmed" disabled>
                    Confirme dinheiro real ou freebet
                  </option>
                ) : null}
                <option value="">Dinheiro real</option>
                {workspace.freebets
                  .filter((item) => item.bookmakerId === bookmakerId && !item.usedBy)
                  .map((item) => (
                    <option value={item.id} key={item.id}>
                      Freebet {formatBRL(item.amount)} · até {item.expiresOn}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Valor apostado (R$)">
              <input
                required
                disabled={!!freebetId && freebetId !== 'unconfirmed'}
                inputMode="decimal"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
              />
            </Field>
            <Field label="Odd total">
              <input
                required
                inputMode="decimal"
                placeholder="1,85"
                value={odds}
                onChange={(event) => setOdds(event.target.value)}
              />
            </Field>
            <Field
              label="Data e hora da aposta"
              hint="Horário de São Paulo. É diferente da data do evento."
            >
              <input
                required
                type="datetime-local"
                step="1"
                value={placedAt}
                onChange={(event) => setPlaced(event.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field label="Referência do bilhete (opcional)">
          <input
            maxLength={150}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
      </div>
      <div className="section-heading">
        <h3>Seleções</h3>
        <Button
          variant="secondary"
          size="small"
          disabled={selections.length >= 40}
          onClick={() => setSelections([...selections, newSelection()])}
        >
          Adicionar seleção
        </Button>
      </div>
      {selections.map((item, index) => (
        <section className="selection-form" key={item.key}>
          <div className="selection-heading">
            <strong>Seleção {index + 1}</strong>
            {selections.length > 1 ? (
              <Button
                variant="ghost"
                size="small"
                onClick={() => setSelections(selections.filter((_, i) => i !== index))}
                aria-label={`Remover seleção ${index + 1}`}
              >
                Remover
              </Button>
            ) : null}
          </div>
          <div className="form-grid">
            <Field label={`Evento ${index + 1}`}>
              <input
                required
                maxLength={300}
                value={item.event}
                onChange={(event) => updateSelection(index, { event: event.target.value })}
                placeholder="Time A × Time B"
              />
            </Field>
            <Field label={`Esporte ${index + 1}`}>
              <input
                maxLength={100}
                value={item.sport ?? ''}
                onChange={(event) => updateSelection(index, { sport: event.target.value })}
              />
            </Field>
            <Field label={`Mercado ${index + 1}`}>
              <input
                required
                maxLength={300}
                value={item.market}
                onChange={(event) => updateSelection(index, { market: event.target.value })}
              />
            </Field>
            <Field label={`Palpite ${index + 1}`}>
              <input
                required
                maxLength={300}
                value={item.selection}
                onChange={(event) => updateSelection(index, { selection: event.target.value })}
              />
            </Field>
            <Field label={`Data do evento ${index + 1}`} hint="Pode ficar pendente.">
              <input
                type="date"
                value={item.eventDate ?? ''}
                onChange={(event) =>
                  updateSelection(index, { eventDate: event.target.value || null })
                }
              />
            </Field>
            <Field
              label={`Horário do evento ${index + 1}`}
              hint="Deixe vazio quando não for conhecido."
            >
              <input
                type="time"
                step="1"
                value={item.time}
                onChange={(event) => updateSelection(index, { time: event.target.value })}
              />
            </Field>
            <Field label={`Confirmação da data ${index + 1}`}>
              <select
                value={item.dateStatus === 'estimated' ? 'estimated' : 'confirmed'}
                onChange={(event) =>
                  updateSelection(index, {
                    dateStatus: event.target.value === 'estimated' ? 'estimated' : 'confirmed',
                  })
                }
              >
                <option value="confirmed">Confirmada pelo proprietário</option>
                <option value="estimated">Estimada, requer conferência</option>
              </select>
            </Field>
            <Field label={`Odd da seleção ${index + 1} (opcional)`}>
              <input
                inputMode="decimal"
                value={item.odds ?? ''}
                onChange={(event) => updateSelection(index, { odds: event.target.value || null })}
              />
            </Field>
          </div>
        </section>
      ))}
      {bet ? (
        <Field label="Motivo da correção">
          <textarea
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      ) : (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allowMissingUnit}
            onChange={(event) => setMissing(event.target.checked)}
          />
          Se faltar unidade histórica, registrar com essa pendência identificada para revisão.
        </label>
      )}
      {review ? (
        <>
          <Field
            label="Justificativa para registrar separadamente"
            hint={
              review.duplicates.length
                ? 'Existe possível duplicação. Explique por que este é outro bilhete.'
                : 'Preencha se houver bilhete semelhante já cadastrado.'
            }
          >
            <textarea
              required={review.duplicates.length > 0}
              minLength={3}
              maxLength={500}
              value={duplicateReason}
              onChange={(event) => setDuplicateReason(event.target.value)}
            />
          </Field>
          <label className="checkbox-field">
            <input type="checkbox" required />
            Conferi casa, valor, odd, origem do dinheiro, seleções e data da aposta no comprovante.
          </label>
        </>
      ) : null}
    </CommandForm>
  );
}
export function SettleForm({ bet, onDone }: { bet: Bet; onDone: () => void }) {
  const [outcome, setOutcome] = useState<
    'win' | 'loss' | 'void' | 'half_win' | 'half_loss' | 'cashout' | 'partial_cashout'
  >('win');
  const [principal, setPrincipal] = useState(bet.remaining);
  const suggested = (value: typeof outcome) =>
    value === 'cashout' || value === 'partial_cashout'
      ? ''
      : suggestedReturn(
          bet.remaining,
          bet.odds,
          value,
          !!bet.freebetId,
          bet.freebetStakeReturned ?? false,
        );
  const [amount, setAmount] = useState(() => suggested('win'));
  const [at, setAt] = useState(localNow);
  const [reason, setReason] = useState('');
  return (
    <CommandForm
      onDone={onDone}
      submitLabel="Confirmar liquidação"
      onSubmit={() => ({
        type: 'bet.settle',
        id: bet.id,
        outcome,
        closedPrincipal: decimalInput(principal),
        returnAmount: decimalInput(amount),
        settledAt: localInstant(at),
        reason,
      })}
    >
      <p className="form-intro">
        Principal ainda aberto: <strong>{formatBRL(bet.remaining)}</strong>. Confira o valor
        efetivamente recebido na casa.
      </p>
      <div className="form-grid">
        <Field label="Resultado">
          <select
            value={outcome}
            onChange={(event) => {
              const value = event.target.value as typeof outcome;
              setOutcome(value);
              setAmount(suggested(value));
              setPrincipal(bet.remaining);
            }}
          >
            <option value="win">Vitória</option>
            <option value="loss">Derrota</option>
            <option value="void">Anulação</option>
            <option value="half_win">Meia vitória</option>
            <option value="half_loss">Meia derrota</option>
            <option value="cashout">Cashout total</option>
            <option value="partial_cashout">Cashout parcial</option>
          </select>
        </Field>
        <Field
          label="Principal encerrado (R$)"
          hint="No cashout parcial, informe quanto do valor original foi encerrado."
        >
          <input
            required
            disabled={outcome !== 'partial_cashout'}
            inputMode="decimal"
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
          />
        </Field>
        <Field
          label="Valor recebido (R$)"
          hint="A sugestão pode ser corrigida conforme o comprovante."
        >
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Data e hora da liquidação">
          <input
            required
            type="datetime-local"
            step="1"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Conferência / justificativa">
        <textarea
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Resultado e retorno conferidos na casa"
        />
      </Field>
    </CommandForm>
  );
}
