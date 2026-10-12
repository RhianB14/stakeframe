import { formatDisplayMoney } from './preferences.js';
import { cloneElement, useEffect, useId, useState, type ReactElement } from 'react';
import {
  cents,
  suggestedReturn,
  type Workspace,
  type CatalogItem,
  type Bet,
  type SelectionInput,
  type ImportDetail,
} from '@stakeframe/shared';
import { CommandForm } from './actions.js';
import {
  decimalInput,
  decimalInputOdds,
  localNow,
  localDateTime,
  localInstant,
  type CommandInput,
} from './api.js';
import { Button } from '../components/ui/button.js';
import { ticketSportLabel } from './sports.js';
import { BET_MARKET_TYPES } from './bet-types.js';

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
  const hintId = `${id}-hint`;
  const existing = children.props['aria-describedby'];
  // O hint nunca sobrescreve referências de erro do filho: mescla e deduplica os IDs.
  const describedBy = hint
    ? Array.from(
        new Set([existing, hintId].filter((value): value is string => typeof value === 'string')),
      ).join(' ')
    : existing;
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {hint ? <small id={hintId}>{hint}</small> : null}
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
        // STK-UX-DADOS — R2 com exceção legítima: aqui o zero é o ESTADO
        // INICIAL real da conta (saldo em aberto no cadastro), não a ausência
        // de um dado apurado. Fica o '0' explícito.
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
  initialAmount,
  onDone,
}: {
  workspace: Workspace;
  kind: 'deposit' | 'withdrawal' | 'transfer' | 'reconcile';
  accountId?: string;
  initialAmount?: string;
  onDone: () => void;
}) {
  const [account, setAccount] = useState(accountId ?? workspace.accounts[0]?.id ?? '');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState(initialAmount ?? '');
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
                {item.name} · {formatDisplayMoney(item.balance)}
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
      className="catalog-form"
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
      <Field label="Nome da casa" hint="Esse nome será exibido nos bilhetes e no histórico.">
        <input
          required
          maxLength={100}
          placeholder="Ex.: Bet365"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Nomes alternativos"
        hint="Um por linha. Eles ajudam a reconhecer a casa nas legendas dos bilhetes."
      >
        <textarea
          rows={4}
          placeholder="Um nome alternativo por linha"
          value={aliases}
          onChange={(event) => setAliases(event.target.value)}
        />
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
      <div className="unit-settings-form">
        <div className="unit-settings-field">
          <span className="unit-settings-kicker">PERCENTUAL DA BANCA</span>
          <Field label="Percentual para os próximos meses">
            <div className="unit-settings-input-wrap">
              <input
                required
                inputMode="decimal"
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
              />
              <span>%</span>
            </div>
          </Field>
        </div>
        <aside className="unit-settings-note">
          <span className="unit-settings-kicker">O QUE MUDA</span>
          <strong>Somente os próximos meses</strong>
          <p>
            O percentual atualizado orienta as novas unidades. A unidade do mês atual e o histórico
            permanecem congelados.
          </p>
        </aside>
      </div>
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
  initialStake,
  initialOdds,
  referenceLayout = false,
  amountMode = 'money',
  financialEditAllowed = true,
  onCancel,
  onStepChange,
  onDone,
}: {
  workspace: Workspace;
  bet?: Bet;
  review?: ImportDetail;
  initialStake?: string;
  initialOdds?: string;
  referenceLayout?: boolean;
  amountMode?: 'money' | 'units';
  financialEditAllowed?: boolean;
  onCancel?: () => void;
  onStepChange?: (step: number) => void;
  onDone: () => void;
}) {
  const [bookmakerId, setBookmaker] = useState(
    bet?.bookmakerId ??
      review?.bookmakerOverrideId ??
      (review?.matches.conflict
        ? ''
        : (review?.matches.captionBookmakerId ?? review?.matches.extractedBookmakerId ?? '')),
  );
  const [tipsterId, setTipster] = useState(
    bet?.tipsterId ?? review?.tipsterOverrideId ?? review?.matches.tipsterId ?? '',
  );
  const [stake, setStake] = useState(
    bet?.stake ?? review?.stakeOverride ?? review?.extraction?.stake ?? initialStake ?? '',
  );
  const [stakeUnitsDraft, setStakeUnitsDraft] = useState<string | null>(null);
  const [odds, setOdds] = useState(
    bet?.odds ?? review?.oddsOverride ?? review?.extraction?.odds ?? initialOdds ?? '',
  );
  const [boostEnabled, setBoostEnabled] = useState(false);
  const [boostedOdds, setBoostedOdds] = useState('');
  const [placedAt, setPlaced] = useState(() =>
    bet ? localDateTime(bet.placedAt) : review ? '' : localNow(),
  );
  const [reviewOrigin, setReviewOrigin] = useState<'real' | 'freebet' | 'hibrida' | 'unconfirmed'>(
    () => (review ? (review.betOrigin ?? 'unconfirmed') : 'real'),
  );
  const [freebetId, setFreebet] = useState(bet?.freebetId ?? review?.freebetId ?? '');
  const [reference, setReference] = useState(bet?.reference ?? review?.extraction?.reference ?? '');
  const [duplicateReason, setDuplicateReason] = useState('');
  const [manualBetStep, setManualBetStep] = useState(0);
  const [manualBetType, setManualBetType] = useState<'single' | 'parlay'>(() =>
    bet?.ticketKind === 'multiple' || bet?.ticketKind === 'betbuild' ? 'parlay' : 'single',
  );
  const [manualBetTypeSelected, setManualBetTypeSelected] = useState(!!bet);
  useEffect(() => {
    if (!referenceLayout || manualBetStep !== 2 || stake) return;
    const unit = workspace.units.find((item) => item.month === placedAt.slice(0, 7));
    if (unit) setStake(unit.amount);
  }, [manualBetStep, placedAt, referenceLayout, stake, workspace.units]);
  const reviewSelections = review?.selectionOverrides.length
    ? review.selectionOverrides
    : (review?.extraction?.selections ?? []).map(({ event, market, selection }) => ({
        event,
        market,
        selection,
      }));
  const [selections, setSelections] = useState<SelectionForm[]>(() => {
    if (bet) {
      return bet.selections.map((value) => ({
        ...value,
        key: crypto.randomUUID(),
        time: value.eventAt ? localDateTime(value.eventAt).slice(11) : '',
      }));
    }
    if (!review) return [referenceLayout ? { ...newSelection(), sport: null } : newSelection()];
    if (!reviewSelections.length)
      return [{ ...newSelection(), sport: review.sportOverride ?? null, dateStatus: 'pending' }];
    return reviewSelections.map((value) => ({
      ...newSelection(),
      event: value.event ?? '',
      sport: review.sportOverride ?? null,
      market: value.market ?? '',
      selection: value.selection ?? '',
      odds: null,
      dateStatus: 'pending',
    }));
  });
  const [allowMissingUnit, setMissing] = useState(false);
  const [reason, setReason] = useState('');
  const preferredBooks = (() => {
    if (!referenceLayout) return null;
    try {
      const stored = window.localStorage.getItem('bettrack.preview.books');
      return stored === null ? null : new Set(JSON.parse(stored) as string[]);
    } catch {
      return null;
    }
  })();
  const houses = workspace.catalog.filter(
    (item) =>
      item.kind === 'bookmaker' &&
      (item.active || item.id === bookmakerId) &&
      (!preferredBooks || preferredBooks.has(item.id)),
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
      market: referenceLayout && !item.market ? item.selection : item.market,
      selection: item.selection,
      odds: item.odds ? item.odds.replace(',', '.') : null,
      eventDate: item.eventDate || null,
      eventAt: item.eventDate && item.time ? localInstant(`${item.eventDate}T${item.time}`) : null,
      dateStatus: item.eventDate
        ? item.dateStatus === 'estimated'
          ? ('estimated' as const)
          : ('confirmed' as const)
        : ('pending' as const),
    }));
  const stakeNumber = Number(stake.replace(',', '.'));
  const legOdds = selections.map((item) => Number((item.odds ?? '').replace(',', '.')));
  const computedParlayOdds =
    legOdds.length >= 2 && legOdds.every((value) => Number.isFinite(value) && value > 1)
      ? legOdds.reduce((total, value) => total * value, 1)
      : Number.NaN;
  const rawOddsNumber = Number(odds.replace(',', '.'));
  const oddsNumber =
    manualBetType === 'parlay'
      ? boostEnabled && Number(boostedOdds.replace(',', '.')) > 1
        ? Number(boostedOdds.replace(',', '.'))
        : boostEnabled
          ? Number.NaN
          : Number.isFinite(computedParlayOdds)
            ? computedParlayOdds
            : rawOddsNumber
      : rawOddsNumber;
  const effectiveOdds =
    Number.isFinite(oddsNumber) && oddsNumber > 1
      ? oddsNumber.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
      : '';
  const stakeUnit =
    workspace.units.find(
      (unit) => unit.month === placedAt.slice(0, 7) && Number(unit.amount) > 0,
    ) ??
    (bet?.unitMonth === placedAt.slice(0, 7) && bet.unitAmount ? { amount: bet.unitAmount } : null);
  const stakeUnitNumber = stakeUnit ? Number(stakeUnit.amount) : null;
  const stakeUnitsValue =
    stakeUnitNumber && stakeUnitNumber > 0 && stakeNumber > 0
      ? stakeNumber / stakeUnitNumber
      : null;
  const potentialPayout =
    Number.isFinite(stakeNumber) && stakeNumber > 0 && Number.isFinite(oddsNumber) && oddsNumber > 1
      ? formatDisplayMoney((stakeNumber * oddsNumber).toFixed(2))
      : '—';
  const previewAmount =
    amountMode === 'units'
      ? stakeUnitsValue === null
        ? '—'
        : `${stakeUnitsValue.toFixed(2)}U`
      : stake
        ? formatDisplayMoney((Number(stake.replace(',', '.')) || 0).toFixed(2))
        : 'R$ 0,00';
  const previewReturn =
    amountMode === 'units'
      ? stakeUnitNumber && stakeUnitNumber > 0 && Number.isFinite(stakeNumber * oddsNumber)
        ? `${((stakeNumber * oddsNumber) / stakeUnitNumber).toFixed(2)}U`
        : '—'
      : potentialPayout === '—'
        ? 'R$ 0,00'
        : potentialPayout;
  const previewSelection = selections[0];
  const previewOdds = Number.isFinite(oddsNumber) && oddsNumber > 1 ? oddsNumber.toFixed(2) : '';
  const previewIsParlay = manualBetType === 'parlay' && selections.length > 1;
  const sportSuggestions = referenceLayout
    ? [
        'Football / Soccer',
        'Basketball / NBA',
        'American Football / NFL',
        'College Football / NCAAF',
        'College Basketball / NCAAB',
        'NCAABB',
        'Baseball / MLB',
        'Ice Hockey / NHL',
        'Tennis',
        'MMA / UFC',
        'Volleyball',
        'Esports',
        'Formula 1',
        'Golf',
        'Rugby',
      ]
    : [
        'Futebol',
        'Basquete / NBA',
        'Futebol americano / NFL',
        'Basquete universitário / NCAAB',
        'Beisebol / MLB',
        'Hóquei no gelo / NHL',
        'Tênis',
        'MMA / UFC',
        'Vôlei',
        'E-sports',
        'Fórmula 1',
        'Golfe',
        'Rugby',
      ];
  const quickSportOptions = [
    { label: 'NFL', value: 'American Football / NFL', tag: 'NFL' },
    { label: 'NBA', value: 'Basketball / NBA', tag: 'NBA' },
    { label: 'MLB', value: 'Baseball / MLB', tag: 'MLB' },
    { label: 'NHL', value: 'Ice Hockey / NHL', tag: 'NHL' },
    { label: 'NCAAF', value: 'College Football / NCAAF', tag: 'NCAAF' },
    { label: 'NCAAB', value: 'College Basketball / NCAAB', tag: 'NCAAB' },
    { label: 'NCAABB', value: 'NCAABB', tag: 'NCAABB' },
    { label: 'Soccer', value: 'Football / Soccer', tag: 'FUT' },
    { label: 'Other', value: 'Other', tag: 'OTH' },
  ];
  const additionalSportOptions = [
    { label: 'Tennis', value: 'Tennis' },
    { label: 'MMA', value: 'MMA / UFC' },
    { label: 'Volleyball', value: 'Volleyball' },
    { label: 'Esports', value: 'Esports' },
    { label: 'Formula 1', value: 'Formula 1' },
    { label: 'Golf', value: 'Golf' },
    { label: 'Rugby', value: 'Rugby' },
  ];
  const knownSportValues = [...quickSportOptions, ...additionalSportOptions].map(
    (option) => option.value,
  );
  const sportSuggestionsId = referenceLayout
    ? 'bettrack-sports-suggestions'
    : 'stakeframe-sports-suggestions';
  const marketTypeSuggestionsId = referenceLayout
    ? 'bettrack-market-suggestions'
    : 'stakeframe-market-suggestions';
  const ticketMarket = (() => {
    const market = previewSelection?.market?.trim() ?? '';
    const marketText = market.toLowerCase();
    if (/spread|handicap/.test(marketText) || /[+-]\s?\d+(?:[.,]\d+)?/.test(marketText))
      return 'SPREAD';
    if (/total|over|under|more than|less than/.test(marketText)) return 'TOTAL';
    if (/moneyline|winner|to win/.test(marketText)) return 'MONEYLINE';
    return manualBetType === 'single' ? 'STRAIGHT' : 'PARLAY';
  })();
  return (
    <CommandForm
      {...(referenceLayout
        ? {
            className: bet
              ? 'bettrack-bet-edit-form'
              : `bettrack-new-bet-form bet-step-${manualBetStep}`,
          }
        : {})}
      onDone={onDone}
      submitLabel={
        !bet && !review && manualBetStep < 2
          ? referenceLayout
            ? 'CONTINUE'
            : manualBetStep === 0
              ? 'Continuar para seleções'
              : 'Continuar para valor'
          : bet
            ? referenceLayout
              ? 'SAVE CHANGES'
              : 'Salvar correção'
            : review
              ? 'Confirmar importação e registrar aposta'
              : referenceLayout
                ? 'SAVE BET'
                : 'Registrar aposta'
      }
      {...(!bet && !review && manualBetStep < 2
        ? {
            onAdvance: () => {
              if (referenceLayout && manualBetType === 'parlay' && manualBetStep === 1) {
                if (selections.length < 2)
                  throw new Error('A parlay needs at least two selections.');
                if (!Number.isFinite(computedParlayOdds))
                  throw new Error('Enter decimal odds for every selection.');
              }
              const next = manualBetStep + 1;
              setManualBetStep(next);
              onStepChange?.(next);
            },
          }
        : {})}
      footer={
        referenceLayout && manualBetStep > 0 ? (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const previous = manualBetStep - 1;
                setManualBetStep(previous);
                onStepChange?.(previous);
              }}
            >
              BACK
            </Button>
            <Button type="submit">{manualBetStep === 2 ? 'SAVE BET' : 'CONTINUE'}</Button>
          </>
        ) : referenceLayout && bet ? (
          <>
            <Button type="button" variant="secondary" onClick={onCancel ?? onDone}>
              CANCEL
            </Button>
            <Button type="submit">SAVE CHANGES</Button>
          </>
        ) : undefined
      }
      onSubmit={() => {
        if (manualBetType === 'parlay') {
          if (selections.length < 2 || !Number.isFinite(computedParlayOdds))
            throw new Error('A parlay needs at least two selections with valid decimal odds.');
          if (boostEnabled && (!Number.isFinite(oddsNumber) || oddsNumber <= 1))
            throw new Error('Enter valid boosted total odds.');
        }
        const confirmedReviewOrigin =
          reviewOrigin === 'real' || reviewOrigin === 'freebet' || reviewOrigin === 'hibrida'
            ? reviewOrigin
            : null;
        if (review && !confirmedReviewOrigin)
          throw new Error('Confirme se a aposta usa dinheiro real, freebet ou híbrida.');
        if (review && confirmedReviewOrigin !== 'real' && !freebetId)
          throw new Error('Escolha o crédito freebet usado nesta aposta.');
        const effectiveOrigin = review
          ? (confirmedReviewOrigin ?? 'real')
          : freebetId
            ? 'freebet'
            : 'real';
        return bet
          ? {
              type: 'bet.update',
              id: bet.id,
              bookmakerId,
              tipsterId: tipsterId || null,
              reference,
              selections: built(),
              stake: decimalInput(stake),
              odds: decimalInputOdds(effectiveOdds || odds),
              placedAt: localInstant(placedAt),
              allowMissingUnit,
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
                  betOrigin: effectiveOrigin,
                  bet: {
                    bookmakerId,
                    tipsterId: tipsterId || null,
                    stake: decimalInput(stake),
                    odds: decimalInputOdds(effectiveOdds || odds),
                    placedAt: localInstant(placedAt),
                    freebetId: effectiveOrigin === 'real' ? null : freebetId || null,
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
                odds: decimalInputOdds(effectiveOdds || odds),
                placedAt: localInstant(placedAt),
                freebetId: freebetId || null,
                reference,
                selections: built(),
                allowMissingUnit,
              };
      }}
    >
      <datalist id={sportSuggestionsId}>
        {sportSuggestions.map((sport) => (
          <option key={sport} value={sport} />
        ))}
      </datalist>
      <datalist id={marketTypeSuggestionsId}>
        {BET_MARKET_TYPES.map((marketType) => (
          <option key={marketType} value={marketType} />
        ))}
      </datalist>
      {!bet && !review ? (
        <div className="bet-wizard-progress" aria-label="Etapas do cadastro">
          {(referenceLayout
            ? ['TYPE', 'DETAIL', 'AMOUNT']
            : ['Tipo', 'Seleções', 'Valor e origem']
          ).map((label, index) => (
            <button
              className={
                manualBetStep === index ? 'is-current' : manualBetStep > index ? 'is-complete' : ''
              }
              key={label}
              type="button"
              onClick={() => {
                if (index < manualBetStep) {
                  setManualBetStep(index);
                  onStepChange?.(index);
                }
              }}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {!bet && !review && manualBetStep === 0 ? (
        <div className="bet-wizard-type">
          <p>{referenceLayout ? 'What are you logging?' : 'Como este bilhete foi feito?'}</p>
          <div className="bet-wizard-type-options">
            <button
              className={manualBetTypeSelected && manualBetType === 'single' ? 'is-selected' : ''}
              type="button"
              onClick={() => {
                setManualBetType('single');
                setManualBetTypeSelected(true);
                setSelections((current) => [current[0] ?? newSelection()]);
                if (referenceLayout) {
                  setManualBetStep(1);
                  onStepChange?.(1);
                }
              }}
            >
              {referenceLayout ? (
                <i className="bettrack-bet-type-icon" aria-hidden="true">
                  ▱
                </i>
              ) : null}
              <strong>{referenceLayout ? 'Straight' : 'Simples'}</strong>
              <span>
                {referenceLayout ? 'One selection, one price.' : 'Uma seleção em um único evento.'}
              </span>
              {referenceLayout ? (
                <b className="bettrack-bet-type-arrow" aria-hidden="true">
                  ›
                </b>
              ) : null}
            </button>
            <button
              className={manualBetTypeSelected && manualBetType === 'parlay' ? 'is-selected' : ''}
              type="button"
              onClick={() => {
                setManualBetType('parlay');
                setManualBetTypeSelected(true);
                setSelections((current) =>
                  current.length > 1
                    ? current
                    : [
                        ...current,
                        referenceLayout ? { ...newSelection(), sport: null } : newSelection(),
                      ],
                );
                if (referenceLayout) {
                  setManualBetStep(1);
                  onStepChange?.(1);
                }
              }}
            >
              {referenceLayout ? (
                <i className="bettrack-bet-type-icon" aria-hidden="true">
                  ▦
                </i>
              ) : null}
              <strong>{referenceLayout ? 'Parlay' : 'Múltipla'}</strong>
              <span>
                {referenceLayout
                  ? 'Two or more selections on the same ticket.'
                  : 'Duas ou mais seleções no mesmo bilhete.'}
              </span>
              {referenceLayout ? (
                <b className="bettrack-bet-type-arrow" aria-hidden="true">
                  ›
                </b>
              ) : null}
            </button>
          </div>
          {referenceLayout ? (
            <button className="bettrack-ai-coming-soon" type="button" disabled>
              <i className="bettrack-bet-type-icon" aria-hidden="true">
                ▧
              </i>
              <strong>Analise seu bilhete com a IA StakeFrame</strong>
              <small>EM BREVE</small>
              <span>
                A IA StakeFrame estará disponível em breve. Por enquanto, registre sua aposta
                manualmente.
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {(!bet && !review && manualBetStep === 1) || bet || review ? (
        <>
          {bet || review ? (
            referenceLayout && bet ? null : (
              <div className="form-grid">
                <Field label={referenceLayout ? 'Sportsbook' : 'Casa de aposta'}>
                  <select
                    required
                    disabled={!!bet && (!financialEditAllowed || !!freebetId)}
                    value={bookmakerId}
                    onChange={(event) => {
                      setBookmaker(event.target.value);
                      setFreebet('');
                      if (review) setReviewOrigin('unconfirmed');
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
                <Field label={referenceLayout ? 'Tipsters' : 'Tipster'}>
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
                    {review ? (
                      <>
                        <Field label="Origem da aposta">
                          <select
                            value={reviewOrigin}
                            onChange={(event) => {
                              const value = event.target.value as typeof reviewOrigin;
                              setReviewOrigin(value);
                              if (value === 'real') setFreebet('');
                            }}
                          >
                            <option value="unconfirmed" disabled>
                              Confirme a modalidade
                            </option>
                            <option value="real">Dinheiro real</option>
                            <option value="freebet">Freebet</option>
                            <option value="hibrida">Híbrida (real + freebet)</option>
                          </select>
                        </Field>
                        {reviewOrigin === 'freebet' || reviewOrigin === 'hibrida' ? (
                          <Field label="Crédito de freebet">
                            <select
                              value={freebetId}
                              onChange={(event) => setFreebet(event.target.value)}
                            >
                              <option value="">Selecione o crédito</option>
                              {workspace.freebets
                                .filter((item) => item.bookmakerId === bookmakerId && !item.usedBy)
                                .map((item) => (
                                  <option value={item.id} key={item.id}>
                                    {`${formatDisplayMoney(item.amount)} · até ${item.expiresOn}`}
                                  </option>
                                ))}
                            </select>
                          </Field>
                        ) : null}
                      </>
                    ) : (
                      <Field label="Origem da aposta">
                        <select
                          value={freebetId}
                          onChange={(event) => {
                            setFreebet(event.target.value);
                            const credit = workspace.freebets.find(
                              (item) => item.id === event.target.value,
                            );
                            if (credit) setStake(credit.amount);
                          }}
                        >
                          <option value="">Dinheiro real</option>
                          {workspace.freebets
                            .filter((item) => item.bookmakerId === bookmakerId && !item.usedBy)
                            .map((item) => (
                              <option value={item.id} key={item.id}>
                                Freebet {formatDisplayMoney(item.amount)} · até {item.expiresOn}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                    <Field label="Valor apostado (R$)">
                      <input
                        required
                        disabled={!!freebetId && (!review || reviewOrigin === 'freebet')}
                        inputMode="decimal"
                        value={stake}
                        onChange={(event) => setStake(event.target.value)}
                      />
                    </Field>
                    {manualBetType === 'parlay' ? (
                      <>
                        <Field
                          label="Combined odds"
                          hint="Calculated from the odds of every selection."
                        >
                          <input
                            readOnly
                            value={
                              Number.isFinite(computedParlayOdds)
                                ? computedParlayOdds.toFixed(2)
                                : '—'
                            }
                          />
                        </Field>
                        <label className="checkbox-field bettrack-boost-toggle">
                          <input
                            type="checkbox"
                            checked={boostEnabled}
                            onChange={(event) => setBoostEnabled(event.target.checked)}
                          />
                          Apply boosted odds
                        </label>
                        {boostEnabled ? (
                          <Field label="Boosted total odds">
                            <input
                              required
                              inputMode="decimal"
                              placeholder={
                                Number.isFinite(computedParlayOdds)
                                  ? computedParlayOdds.toFixed(2)
                                  : '3.42'
                              }
                              value={boostedOdds}
                              onChange={(event) => setBoostedOdds(event.target.value)}
                            />
                          </Field>
                        ) : null}
                      </>
                    ) : (
                      <Field label="Total odds">
                        <input
                          required
                          inputMode="decimal"
                          placeholder="1.91"
                          value={odds}
                          onChange={(event) => setOdds(event.target.value)}
                        />
                      </Field>
                    )}
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
                <Field
                  label={
                    referenceLayout
                      ? 'Ticket reference (optional)'
                      : 'Referência do bilhete (opcional)'
                  }
                >
                  <input
                    maxLength={150}
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </Field>
              </div>
            )
          ) : null}
          {referenceLayout ? (
            <>
              <div className="bettrack-details-intro">
                <div>
                  <h2>{bet ? 'Edit bet' : 'Bet details'}</h2>
                  <p>Sport, event, your selection, odds and date.</p>
                </div>
                {manualBetType === 'parlay' ? (
                  <button
                    type="button"
                    disabled={selections.length >= 40}
                    onClick={() =>
                      setSelections([...selections, { ...newSelection(), sport: null }])
                    }
                  >
                    + ADD SELECTION
                  </button>
                ) : null}
              </div>
              {selections.map((item, index) => (
                <section className="selection-form bettrack-reference-selection" key={item.key}>
                  <div className="form-grid bettrack-reference-detail-fields">
                    <Field label="Sport">
                      <div className="bettrack-sport-picker">
                        <div
                          className="bettrack-sport-options"
                          role="group"
                          aria-label="Choose a sport"
                        >
                          {quickSportOptions.map((option) => (
                            <button
                              type="button"
                              key={option.value}
                              aria-pressed={
                                option.tag === 'OTH'
                                  ? item.sport?.trim().toLowerCase() === 'other' ||
                                    (!!item.sport && !knownSportValues.includes(item.sport))
                                  : ticketSportLabel(item.sport) === option.tag
                              }
                              className={
                                option.tag === 'OTH'
                                  ? item.sport?.trim().toLowerCase() === 'other' ||
                                    (!!item.sport && !knownSportValues.includes(item.sport))
                                    ? 'is-selected'
                                    : ''
                                  : ticketSportLabel(item.sport) === option.tag
                                    ? 'is-selected'
                                    : ''
                              }
                              onClick={() => updateSelection(index, { sport: option.value })}
                            >
                              {option.label}
                            </button>
                          ))}
                          <details className="bettrack-more-sports">
                            <summary>MORE</summary>
                            <div>
                              {additionalSportOptions.map((option) => (
                                <button
                                  type="button"
                                  key={option.value}
                                  aria-pressed={item.sport === option.value}
                                  className={item.sport === option.value ? 'is-selected' : ''}
                                  onClick={() => updateSelection(index, { sport: option.value })}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </details>
                        </div>
                        {item.sport?.trim().toLowerCase() === 'other' ||
                        (!!item.sport && !knownSportValues.includes(item.sport)) ? (
                          <input
                            aria-label="Other sport"
                            list={sportSuggestionsId}
                            maxLength={100}
                            value={
                              item.sport?.trim().toLowerCase() === 'other' ? '' : (item.sport ?? '')
                            }
                            onChange={(event) =>
                              updateSelection(index, { sport: event.target.value })
                            }
                            placeholder="Type another sport"
                          />
                        ) : null}
                      </div>
                    </Field>
                    <Field label="Event" hint="The game or matchup this bet is on">
                      <input
                        required
                        maxLength={300}
                        value={item.event}
                        onChange={(event) => updateSelection(index, { event: event.target.value })}
                        placeholder="Chiefs vs Bills"
                      />
                    </Field>
                    <Field label="Bet Type" hint="Choose a market type or enter a custom one">
                      <input
                        required
                        maxLength={300}
                        list={marketTypeSuggestionsId}
                        value={item.market}
                        onChange={(event) => updateSelection(index, { market: event.target.value })}
                        placeholder="Full Time Result"
                      />
                    </Field>
                    <Field label="Selection" hint="Describe your pick and line">
                      <input
                        required
                        maxLength={300}
                        value={item.selection}
                        onChange={(event) =>
                          updateSelection(index, { selection: event.target.value })
                        }
                        placeholder="Team A to win"
                      />
                    </Field>
                    {manualBetType === 'parlay' ? (
                      <Field label={`Odds ${index + 1}`}>
                        <input
                          required
                          disabled={!!bet && !financialEditAllowed}
                          inputMode="decimal"
                          placeholder="1.91"
                          value={item.odds ?? ''}
                          onChange={(event) =>
                            updateSelection(index, { odds: event.target.value || null })
                          }
                        />
                      </Field>
                    ) : index === 0 ? (
                      <Field label="Odds">
                        <input
                          required
                          disabled={!!bet && !financialEditAllowed}
                          inputMode="decimal"
                          placeholder="1.91"
                          value={odds}
                          onChange={(event) => setOdds(event.target.value)}
                        />
                      </Field>
                    ) : null}
                    {manualBetType !== 'parlay' && index === 0 ? (
                      <div className="bettrack-odds-suggestions" aria-label="Common odds">
                        <button type="button" onClick={() => setOdds('1.91')}>
                          1.91
                        </button>
                        <button type="button" onClick={() => setOdds('2.50')}>
                          2.50
                        </button>
                        <button type="button" onClick={() => setOdds('2.00')}>
                          2.00
                        </button>
                      </div>
                    ) : null}
                    <Field label="Event date">
                      <input
                        type="date"
                        value={item.eventDate ?? ''}
                        onChange={(event) =>
                          updateSelection(index, {
                            eventDate: event.target.value || null,
                            dateStatus: 'confirmed',
                          })
                        }
                      />
                    </Field>
                    <details className="bettrack-bet-extra-fields" open={!!bet}>
                      <summary>TIME AND DATE CONFIDENCE</summary>
                      <div className="bettrack-extra-fields-grid">
                        <Field label="Event time">
                          <input
                            type="time"
                            step="1"
                            value={item.time}
                            onChange={(event) =>
                              updateSelection(index, { time: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Date status">
                          <select
                            value={item.dateStatus === 'estimated' ? 'estimated' : 'confirmed'}
                            onChange={(event) =>
                              updateSelection(index, {
                                dateStatus:
                                  event.target.value === 'estimated' ? 'estimated' : 'confirmed',
                              })
                            }
                          >
                            <option value="confirmed">Confirmed</option>
                            <option value="estimated">Estimated · review needed</option>
                          </select>
                        </Field>
                      </div>
                    </details>
                    {selections.length > 1 ? (
                      <button
                        className="bettrack-remove-selection"
                        type="button"
                        onClick={() => setSelections(selections.filter((_, i) => i !== index))}
                      >
                        REMOVE SELECTION
                      </button>
                    ) : null}
                  </div>
                </section>
              ))}
              {bet ? (
                <div className="bettrack-edit-amount-step">
                  <div className="bettrack-details-intro">
                    <div>
                      <h2>Amount and time</h2>
                      <p>Correct the ticket value and when it was placed.</p>
                    </div>
                  </div>
                  {!financialEditAllowed ? (
                    <p className="bettrack-edit-lock-note" role="status">
                      Settlement history locks the amount, odds and placed time. Event details and
                      tipster can still be corrected.
                    </p>
                  ) : null}
                  <div className="bettrack-edit-financial-fields">
                    <Field label="Amount (R$)">
                      <input
                        required
                        disabled={!financialEditAllowed}
                        inputMode="decimal"
                        value={stake.replace('.', ',')}
                        onChange={(event) => {
                          setStake(event.target.value.replace(',', '.'));
                          setStakeUnitsDraft(null);
                        }}
                      />
                    </Field>
                    <Field label="Units">
                      <input
                        aria-label="Stake in units"
                        type="number"
                        min="0.01"
                        step="0.01"
                        disabled={!financialEditAllowed || !stakeUnitNumber}
                        value={
                          stakeUnitsDraft ??
                          (stakeUnitsValue === null ? '' : stakeUnitsValue.toFixed(2))
                        }
                        onChange={(event) => {
                          if (!stakeUnitNumber) return;
                          const raw = event.target.value;
                          setStakeUnitsDraft(raw);
                          const units = Number(raw);
                          if (Number.isFinite(units) && units > 0)
                            setStake((units * stakeUnitNumber).toFixed(2));
                          else if (raw === '') setStake('');
                        }}
                        onBlur={() => setStakeUnitsDraft(null)}
                      />
                    </Field>
                    <Field
                      label="Date and time placed"
                      hint="São Paulo time. This is when the ticket was placed, not the event start."
                    >
                      <input
                        required
                        disabled={!financialEditAllowed}
                        type="datetime-local"
                        step="1"
                        value={placedAt}
                        onChange={(event) => {
                          setPlaced(event.target.value);
                          setStakeUnitsDraft(null);
                        }}
                      />
                    </Field>
                  </div>
                  <div
                    className="bettrack-unit-presets"
                    role="group"
                    aria-label="Set stake in units"
                  >
                    {[1, 2, 3, 5].map((count) => (
                      <button
                        key={count}
                        type="button"
                        disabled={!financialEditAllowed || !stakeUnitNumber}
                        className={
                          stakeUnitsValue !== null && Math.abs(stakeUnitsValue - count) < 0.005
                            ? 'is-active'
                            : ''
                        }
                        onClick={() => {
                          if (stakeUnitNumber) {
                            setStake((stakeUnitNumber * count).toFixed(2));
                            setStakeUnitsDraft(null);
                          }
                        }}
                      >
                        {count} U
                      </button>
                    ))}
                  </div>
                  <p className="bettrack-unit-note">
                    {stakeUnit
                      ? `Monthly unit ${formatDisplayMoney(stakeUnit.amount)} · ${stakeUnitsValue === null ? '—' : `${stakeUnitsValue.toFixed(2)} U`}`
                      : 'No monthly unit is set for this date. Correct the date or save with the unit pending.'}
                  </p>
                  {financialEditAllowed && !stakeUnit ? (
                    <label className="checkbox-field bettrack-missing-unit-choice">
                      <input
                        type="checkbox"
                        checked={allowMissingUnit}
                        onChange={(event) => setMissing(event.target.checked)}
                      />
                      Save without linking a monthly unit
                    </label>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="section-heading">
                <h3>Seleções</h3>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={
                    selections.length >= 40 || (!bet && !review && manualBetType === 'single')
                  }
                  onClick={() => setSelections([...selections, newSelection()])}
                >
                  Adicionar seleção
                </Button>
              </div>
              {selections.map((item, index) => (
                <section className="selection-form" key={item.key}>
                  <div className="selection-heading">
                    <strong>{`Seleção ${index + 1}`}</strong>
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
                    <Field label={`${referenceLayout ? 'Event' : 'Evento'} ${index + 1}`}>
                      <input
                        required
                        maxLength={300}
                        value={item.event}
                        onChange={(event) => updateSelection(index, { event: event.target.value })}
                        placeholder="Time A × Time B"
                      />
                    </Field>
                    <Field label={`${referenceLayout ? 'Sport' : 'Esporte'} ${index + 1}`}>
                      <input
                        list={sportSuggestionsId}
                        maxLength={100}
                        value={item.sport ?? ''}
                        onChange={(event) => updateSelection(index, { sport: event.target.value })}
                      />
                    </Field>
                    <Field
                      label={`${referenceLayout ? 'Bet Type' : 'Tipo de aposta'} ${index + 1}`}
                      hint={
                        referenceLayout
                          ? 'Choose a market type or enter a custom one.'
                          : 'Escolha um tipo ou informe um mercado personalizado.'
                      }
                    >
                      <input
                        required
                        maxLength={300}
                        list={marketTypeSuggestionsId}
                        value={item.market}
                        onChange={(event) => updateSelection(index, { market: event.target.value })}
                      />
                    </Field>
                    <Field label={`${referenceLayout ? 'Selection' : 'Palpite'} ${index + 1}`}>
                      <input
                        required
                        maxLength={300}
                        value={item.selection}
                        onChange={(event) =>
                          updateSelection(index, { selection: event.target.value })
                        }
                      />
                    </Field>
                    <Field
                      label={`${referenceLayout ? 'Event date' : 'Data do evento'} ${index + 1}`}
                      hint={referenceLayout ? 'Can be left blank.' : 'Pode ficar pendente.'}
                    >
                      <input
                        type="date"
                        value={item.eventDate ?? ''}
                        onChange={(event) =>
                          updateSelection(index, { eventDate: event.target.value || null })
                        }
                      />
                    </Field>
                    <Field
                      label={`${referenceLayout ? 'Event time' : 'Horário do evento'} ${index + 1}`}
                      hint={
                        referenceLayout
                          ? 'Leave blank if unknown.'
                          : 'Deixe vazio quando não for conhecido.'
                      }
                    >
                      <input
                        type="time"
                        step="1"
                        value={item.time}
                        onChange={(event) => updateSelection(index, { time: event.target.value })}
                      />
                    </Field>
                    <Field
                      label={`${referenceLayout ? 'Date status' : 'Confirmação da data'} ${index + 1}`}
                    >
                      <select
                        value={item.dateStatus === 'estimated' ? 'estimated' : 'confirmed'}
                        onChange={(event) =>
                          updateSelection(index, {
                            dateStatus:
                              event.target.value === 'estimated' ? 'estimated' : 'confirmed',
                          })
                        }
                      >
                        <option value="confirmed">
                          {referenceLayout ? 'Confirmed' : 'Confirmada pelo proprietário'}
                        </option>
                        <option value="estimated">
                          {referenceLayout
                            ? 'Estimated, review needed'
                            : 'Estimada, requer conferência'}
                        </option>
                      </select>
                    </Field>
                    <Field
                      label={`${referenceLayout ? 'Selection odds' : 'Odd da seleção'} ${index + 1} (${referenceLayout ? 'optional' : 'opcional'})`}
                    >
                      <input
                        inputMode="decimal"
                        value={item.odds ?? ''}
                        onChange={(event) =>
                          updateSelection(index, { odds: event.target.value || null })
                        }
                      />
                    </Field>
                  </div>
                </section>
              ))}
              {bet ? (
                <div className="form-grid bettrack-edit-catalog-fields">
                  <Field label="Sportsbook">
                    <select
                      required
                      disabled={!financialEditAllowed || !!freebetId}
                      value={bookmakerId}
                      onChange={(event) => {
                        setBookmaker(event.target.value);
                        setFreebet('');
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
                  <Field label="Tipsters">
                    <select value={tipsterId} onChange={(event) => setTipster(event.target.value)}>
                      <option value="">Sem tipster</option>
                      {tipsters.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Ticket reference (optional)">
                    <input
                      maxLength={150}
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                    />
                  </Field>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {!bet && !review && manualBetStep === 2 ? (
        referenceLayout ? (
          <div className="bettrack-amount-step">
            <div className="bettrack-details-intro">
              <div>
                <h2>How much are you risking?</h2>
                <p>The amount closes the capture. Check it against your ticket.</p>
              </div>
            </div>
            <div className="bettrack-amount-control">
              <label htmlFor="bettrack-stake-amount">Amount</label>
              <div>
                <span>R$</span>
                <input
                  id="bettrack-stake-amount"
                  required
                  disabled={!!freebetId}
                  inputMode="decimal"
                  value={stake.replace('.', ',')}
                  onChange={(event) => setStake(event.target.value.replace(',', '.'))}
                />
                <b>
                  {stakeUnitNumber && stakeNumber > 0
                    ? `${(stakeNumber / stakeUnitNumber).toFixed(1)} U`
                    : '— U'}
                </b>
              </div>
            </div>
            <div className="bettrack-unit-presets" role="group" aria-label="Choose amount in units">
              {[1, 2, 3, 5].map((count) => (
                <button
                  key={count}
                  type="button"
                  disabled={!stakeUnitNumber}
                  className={
                    stakeUnitNumber && Math.abs(stakeNumber - stakeUnitNumber * count) < 0.005
                      ? 'is-active'
                      : ''
                  }
                  onClick={() => {
                    if (stakeUnitNumber) setStake((stakeUnitNumber * count).toFixed(2));
                  }}
                >
                  {count} U
                </button>
              ))}
            </div>
            <p className="bettrack-unit-note">
              {stakeUnit
                ? `Your unit is ${formatDisplayMoney(stakeUnit.amount)} · 1 U = ${formatDisplayMoney(stakeUnit.amount)}`
                : 'No monthly unit is set for this date. You can record the amount and review the unit later.'}
            </p>
            <div className="bettrack-payout-block">
              <label>
                Total payout (R$) <small>Calculated from odds: {potentialPayout}</small>
              </label>
              <output>
                {potentialPayout === '—' ? '0,00' : potentialPayout.replace(/^R\$\s*/, '')}
              </output>
            </div>
            <div className="bettrack-source-fields">
              <Field label="Tipsters">
                <select value={tipsterId} onChange={(event) => setTipster(event.target.value)}>
                  <option value="">Add tipsters…</option>
                  {tipsters.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sportsbook">
                <select
                  required
                  value={bookmakerId}
                  onChange={(event) => {
                    setBookmaker(event.target.value);
                    setFreebet('');
                  }}
                >
                  <option value="">Choose the book…</option>
                  {houses.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="bettrack-book-actions">
              <a className="bettrack-book-help" href="#settings">
                {houses.length
                  ? `MY BOOK ISN'T HERE · SEE ALL ${houses.length}`
                  : 'ADD YOUR FIRST SPORTSBOOK IN SETTINGS'}
              </a>
              <details className="bettrack-amount-more">
                <summary>MORE DETAILS</summary>
                <div>
                  <Field label="Bet type">
                    <select
                      value={freebetId}
                      onChange={(event) => {
                        setFreebet(event.target.value);
                        const credit = workspace.freebets.find(
                          (item) => item.id === event.target.value,
                        );
                        if (credit) setStake(credit.amount);
                      }}
                    >
                      <option value="">Cash</option>
                      {workspace.freebets
                        .filter((item) => item.bookmakerId === bookmakerId && !item.usedBy)
                        .map((item) => (
                          <option
                            value={item.id}
                            key={item.id}
                          >{`Freebet ${formatDisplayMoney(item.amount)} · until ${item.expiresOn}`}</option>
                        ))}
                    </select>
                  </Field>
                  <Field
                    label="Date and time placed"
                    hint="Your local time. Separate from the event date."
                  >
                    <input
                      required
                      type="datetime-local"
                      step="1"
                      value={placedAt}
                      onChange={(event) => setPlaced(event.target.value)}
                    />
                  </Field>
                  <Field label="Ticket reference (optional)">
                    <input
                      maxLength={150}
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                    />
                  </Field>
                </div>
              </details>
            </div>
          </div>
        ) : (
          <>
            <div className="form-grid">
              <Field label={referenceLayout ? 'Bookmaker' : 'Casa de aposta'}>
                <select
                  required
                  value={bookmakerId}
                  onChange={(event) => {
                    setBookmaker(event.target.value);
                    setFreebet('');
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
              <Field label={referenceLayout ? 'Bet type' : 'Origem da aposta'}>
                <select
                  value={freebetId}
                  onChange={(event) => {
                    setFreebet(event.target.value);
                    const credit = workspace.freebets.find(
                      (item) => item.id === event.target.value,
                    );
                    if (credit) setStake(credit.amount);
                  }}
                >
                  <option value="">{referenceLayout ? 'Cash' : 'Dinheiro real'}</option>
                  {workspace.freebets
                    .filter((item) => item.bookmakerId === bookmakerId && !item.usedBy)
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        Freebet {formatDisplayMoney(item.amount)} · até {item.expiresOn}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={referenceLayout ? 'Amount' : 'Valor apostado (R$)'}>
                <input
                  required
                  disabled={!!freebetId}
                  inputMode="decimal"
                  value={stake}
                  onChange={(event) => setStake(event.target.value)}
                />
              </Field>
              {!referenceLayout ? (
                <Field label="Odd total">
                  <input
                    required
                    inputMode="decimal"
                    placeholder="1,85"
                    value={odds}
                    onChange={(event) => setOdds(event.target.value)}
                  />
                </Field>
              ) : null}
              <Field
                label={referenceLayout ? 'Date and time placed' : 'Data e hora da aposta'}
                hint={
                  referenceLayout
                    ? 'Your local time. Separate from the event date.'
                    : 'Horário de São Paulo. É diferente da data do evento.'
                }
              >
                <input
                  required
                  type="datetime-local"
                  step="1"
                  value={placedAt}
                  onChange={(event) => setPlaced(event.target.value)}
                />
              </Field>
              <Field
                label={
                  referenceLayout
                    ? 'Ticket reference (optional)'
                    : 'Referência do bilhete (opcional)'
                }
              >
                <input
                  maxLength={150}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
            </div>
            <div className="bet-wizard-payout">
              <span>{referenceLayout ? 'To win' : 'Retorno potencial'}</span>
              <strong>{potentialPayout}</strong>
            </div>
            <p className="bet-wizard-note">
              Confira o valor, a odd total e a casa antes de registrar. O bilhete será lançado como
              aberto.
            </p>
          </>
        )
      ) : null}
      {bet ? (
        <Field label={referenceLayout ? 'Reason for correction' : 'Motivo da correção'}>
          <textarea
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      ) : review || (manualBetStep === 2 && (!referenceLayout || !stakeUnit)) ? (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allowMissingUnit}
            onChange={(event) => setMissing(event.target.checked)}
          />
          Se faltar unidade histórica, registrar com essa pendência identificada para revisão.
        </label>
      ) : null}
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
      {referenceLayout ? (
        <aside className="bettrack-ticket-preview" aria-label="Ticket preview">
          <div className="bettrack-ticket-preview-heading">
            <span>YOUR TICKET</span>
            <b>
              <i /> UPDATES AS YOU TYPE
            </b>
          </div>
          <div
            className="bettrack-ticket-paper"
            data-sport={
              previewIsParlay || bet?.ticketKind === 'multiple'
                ? 'multi'
                : ticketSportLabel(previewSelection?.sport ?? null).toLowerCase()
            }
          >
            <header>
              <strong>
                {houses.find((house) => house.id === bookmakerId)?.name.toUpperCase() ?? 'NO BOOK'}
              </strong>
              <span>
                #
                {bet ? bet.reference?.trim() || String(bet.ticketNumber).padStart(6, '0') : 'DRAFT'}
              </span>
            </header>
            <div className="bettrack-ticket-kind">
              <span>{ticketSportLabel(previewSelection?.sport ?? null)}</span>
              <small>{ticketMarket}</small>
              <b>{previewOdds || previewSelection?.odds || '—'}</b>
            </div>
            <strong className="bettrack-ticket-selection">
              {previewIsParlay || (bet && bet.ticketKind !== 'simple' && selections.length > 1)
                ? `${selections.length} SELECTIONS`
                : previewSelection?.selection || '—'}
            </strong>
            {previewIsParlay || (bet && bet.ticketKind !== 'simple' && selections.length > 1) ? (
              <div className="bettrack-ticket-selections bettrack-edit-ticket-selections">
                {selections.map((item) => (
                  <div key={item.key}>
                    <span data-sport={ticketSportLabel(item.sport).toLowerCase()}>
                      {ticketSportLabel(item.sport)}
                    </span>
                    <p>
                      <strong>{item.selection || '—'}</strong>
                      <small>{item.event}</small>
                    </p>
                    <b>{item.odds || '—'}</b>
                  </div>
                ))}
              </div>
            ) : previewSelection?.event ? (
              <small className="bettrack-ticket-event">{previewSelection.event}</small>
            ) : null}
            <div className="bettrack-ticket-value-grid">
              <div>
                <small>AMOUNT</small>
                <span>{previewAmount}</span>
              </div>
              <div>
                <small>TO WIN</small>
                <span>{previewReturn}</span>
              </div>
            </div>
            <footer>OPEN</footer>
          </div>
          <p>It fills in as you capture. This is how it looks when you share it.</p>
        </aside>
      ) : null}
    </CommandForm>
  );
}
export function SettleForm({
  bet,
  onDone,
  initialOutcome = 'win',
}: {
  bet: Bet;
  onDone: () => void;
  initialOutcome?: 'win' | 'loss' | 'void' | 'cashout';
}) {
  const [outcome, setOutcome] = useState<
    'win' | 'loss' | 'void' | 'half_win' | 'half_loss' | 'cashout' | 'partial_cashout'
  >(initialOutcome);
  const [principal, setPrincipal] = useState(bet.remaining);
  const suggested = (value: typeof outcome) =>
    // STK-UX-DADOS (R2) — sem principal aberto ou sem odd não há base para
    // sugerir: devolvemos vazio em vez de calcular sobre '0.00'/'1.00' (o
    // `suggestedReturn` ainda lançaria INVALID_STAKE com principal zero).
    value === 'cashout' ||
    value === 'partial_cashout' ||
    bet.remaining === null ||
    bet.odds === null
      ? ''
      : suggestedReturn(
          bet.remaining,
          bet.odds,
          value,
          !!bet.freebetId,
          bet.freebetStakeReturned ?? false,
        );
  const [amount, setAmount] = useState(() => suggested(initialOutcome));
  const [at, setAt] = useState(localNow);
  const [reason, setReason] = useState('');
  // STK-UX-DADOS — R2 no ponto que mais dói: o DADO GRAVADO.
  //
  // O domínio é explícito e NÃO admite 0 como "principal encerrado":
  // `closedPrincipal` é `positiveMoneySchema` (recusa zero) e o servidor exige
  // `principal === remaining` em toda liquidação que não seja cashout parcial
  // (packages/db/src/finance-commands.ts). Ou seja: o valor NÃO é livre — para
  // win/loss/void/half_*/cashout total ele É o principal ainda aberto, e para
  // cashout parcial ele é a fração declarada, obrigatoriamente > 0 e < total.
  //
  // A decisão aqui é "usar o padrão do domínio", com o padrão escrito e
  // documentado: `bet.remaining`. Um cashout parcial não tem padrão legítimo
  // (a fração é informação do usuário, não derivável), então o campo é
  // obrigatório e o formulário recusa com a mesma mensagem do Cashout. O
  // `?? '0.00'` que existia gravava R$ 0,00 a partir de dado ausente — e, por
  // `positiveMoneySchema`, esse R$ 0,00 era recusado pelo servidor: o usuário
  // recebia "Informe..." sem entender por quê, e qualquer afrouxá-lo passaria
  // a escrever zero no registro financeiro.
  const remaining = bet.remaining;
  const needsDeclaredPrincipal = outcome === 'partial_cashout';
  const principalValue = needsDeclaredPrincipal ? principal : remaining;
  return (
    <CommandForm
      onDone={onDone}
      submitLabel="Confirmar liquidação"
      onSubmit={() => {
        if (remaining === null)
          throw new Error(
            'Esta aposta ainda não tem valor registrado. Complete o valor apostado antes de liquidar.',
          );
        if (principalValue === null || principalValue.trim() === '')
          throw new Error('Informe quanto do valor aberto foi encerrado.');
        const closedPrincipal = decimalInput(principalValue);
        if (cents(closedPrincipal) <= 0n)
          throw new Error('Informe quanto do valor aberto foi encerrado.');
        return {
          type: 'bet.settle',
          id: bet.id,
          outcome,
          closedPrincipal,
          returnAmount: decimalInput(amount),
          settledAt: localInstant(at),
          reason,
        };
      }}
    >
      <p className="form-intro">
        Principal ainda aberto: <strong>{formatDisplayMoney(remaining)}</strong>. Confira o valor
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
            value={principal ?? ''}
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
