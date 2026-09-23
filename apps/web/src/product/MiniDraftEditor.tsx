import { useEffect, useMemo, useState } from 'react';
import {
  classifyTicketKind,
  deriveBetOrigin,
  formatBRL,
  potentialReturnFor,
  type TicketKind,
} from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { ApiFailure, localInstant } from './api.js';
import {
  partialFailureMessage,
  planConfirmedSave,
  refusalMessage,
  type FormValues,
} from './confirmed-save.js';
import type { DraftControlsProps } from './drafts.js';
import { Field } from './forms.js';
import { MobilePicker } from './MobilePicker.js';
import { COUNTRY_OPTIONS, SPORT_PICKER_OPTIONS, type PickerOption } from './miniapp-options.js';

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

const receivedFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

const inputInstant = (value: string | null) => {
  if (!value) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    time: `${read('hour')}:${read('minute')}`,
  };
};

const formatExpiry = (value: string) =>
  new Intl.DateTimeFormat('pt-BR').format(new Date(`${value}T12:00:00Z`));

export function MiniDraftEditor({
  detail,
  sender,
  confirmSender,
  statusSender,
  originSender,
  eventSender,
  bookmakerSender,
  tipsterSender,
  creditsSender,
  onSaved,
}: DraftControlsProps) {
  // STK-G0-23-R1 — aposta já registrada: origem, crédito e data vêm do
  // REGISTRO, não da inbox. A origem é derivada do par (valor, crédito) e a
  // inbox não acompanha os comandos canônicos, então ler dela envelheceria a
  // tela — e mandar esse valor velho pelo PATCH seria uma divergência que o
  // fail-closed recusaria mesmo sem o usuário ter mexido em nada.
  const canonicalBet = detail.bet?.completionState === 'complete' ? detail.bet : null;
  const canonicalOrigin =
    canonicalBet === null
      ? null
      : canonicalBet.stake === null
        ? 'real'
        : deriveBetOrigin(canonicalBet.stake, canonicalBet.freebetAmount ?? null);
  const canonicalEventAt = canonicalBet?.selections[0]?.eventAt ?? null;

  const [origin, setOrigin] = useState<'real' | 'freebet' | 'hibrida'>(
    canonicalOrigin ?? detail.betOrigin ?? 'real',
  );
  const [credit, setCredit] = useState(
    canonicalBet ? (canonicalBet.freebetId ?? '') : (detail.freebetId ?? ''),
  );
  const initialEvent = inputInstant(canonicalBet ? canonicalEventAt : (detail.eventAt ?? null));
  const [eventDate, setEventDate] = useState(initialEvent.date);
  const [eventTime, setEventTime] = useState(initialEvent.time);
  const extractedSport =
    detail.extraction?.selections.find((item) => item.sport !== null)?.sport ?? null;
  // STK-G0-23 — aposta já registrada: o registro financeiro é a fonte e
  // prevalece sobre os overrides do rascunho. Sem esta precedência a tela
  // reabria mostrando a casa/tipster/valor/odd/seleções ANTIGOS depois que o
  // registro canônico já havia mudado (a mensagem do Telegram mostrava o
  // valor novo, a tela o velho). Esporte fica com o override porque o
  // detalhe canônico não expõe o esporte das seleções.
  const [sport, setSport] = useState(detail.sportOverride ?? extractedSport ?? '');
  const [tournament, setTournament] = useState(detail.tournamentOverride ?? '');
  const [country, setCountry] = useState(detail.countryOverride ?? '');
  const [ticketKind, setTicketKind] = useState<TicketKind>(
    detail.ticketKindOverride ?? classifyTicketKind(detail.extraction?.selections ?? []),
  );
  const [stake, setStake] = useState(
    detail.bet?.stake ?? detail.stakeOverride ?? detail.extraction?.stake ?? '',
  );
  const [odds, setOdds] = useState(
    detail.bet?.odds ?? detail.oddsOverride ?? detail.extraction?.odds ?? '',
  );
  const [bookmaker, setBookmaker] = useState(
    detail.bet?.bookmakerId ??
      detail.bookmakerOverrideId ??
      detail.matches.captionBookmakerId ??
      '',
  );
  const [tipster, setTipster] = useState(
    detail.bet?.tipsterId ?? detail.tipsterOverrideId ?? detail.matches.tipsterId ?? '',
  );
  const [selections, setSelections] = useState(() => {
    const initial = detail.bet?.selections.length
      ? detail.bet.selections.map(({ event, market, selection }) => ({
          event,
          market,
          selection,
        }))
      : detail.selectionOverrides.length
        ? detail.selectionOverrides.map((item) => ({ ...item }))
        : (detail.extraction?.selections ?? []).map(({ event, market, selection }) => ({
            event,
            market,
            selection,
          }));
    return initial.length ? initial : [{ event: null, market: null, selection: null }];
  });

  // STK-G0-23-R1 — linha de base da edição: é com o que a TELA ABRIU que o
  // formulário é comparado, para separar o que o usuário mexeu do que já era
  // assim. Com a aposta completa essa base vem do registro canônico.
  type AppliedStep = { key: string; label: string; target: string };
  type Recovery = { applied: AppliedStep[]; version: number };
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const financialsFixed = detail.bet?.completionState === 'complete';
  const baselineSelections = detail.bet?.selections.length
    ? detail.bet.selections.map(({ event, market, selection }) => ({ event, market, selection }))
    : detail.selectionOverrides.length
      ? detail.selectionOverrides.map((item) => ({ ...item }))
      : (detail.extraction?.selections ?? []).map(({ event, market, selection }) => ({
          event,
          market,
          selection,
        }));
  const baseline: FormValues = {
    origin: canonicalOrigin ?? detail.betOrigin ?? 'real',
    credit: canonicalBet ? (canonicalBet.freebetId ?? '') : (detail.freebetId ?? ''),
    bookmaker:
      detail.bet?.bookmakerId ??
      detail.bookmakerOverrideId ??
      detail.matches.captionBookmakerId ??
      '',
    tipster: detail.bet?.tipsterId ?? detail.tipsterOverrideId ?? detail.matches.tipsterId ?? '',
    eventAt: canonicalBet ? canonicalEventAt : (detail.eventAt ?? null),
    stake: detail.bet?.stake ?? detail.stakeOverride ?? detail.extraction?.stake ?? '',
    odds: detail.bet?.odds ?? detail.oddsOverride ?? detail.extraction?.odds ?? '',
    sport: detail.sportOverride ?? extractedSport ?? '',
    tournament: detail.tournamentOverride ?? '',
    country: detail.countryOverride ?? '',
    ticketKind:
      detail.ticketKindOverride ?? classifyTicketKind(detail.extraction?.selections ?? []),
    selections: baselineSelections.length
      ? baselineSelections
      : [{ event: null, market: null, selection: null }],
  };

  const [credits, setCredits] = useState(detail.credits);
  const [creditsBusy, setCreditsBusy] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type StatusChoice = 'pending' | 'win' | 'loss' | 'half_win' | 'half_loss' | 'void';
  const activeOutcome = detail.bet?.activeOutcome;
  const initialStatus: StatusChoice | '' =
    detail.bet?.state === 'settled'
      ? activeOutcome && ['win', 'loss', 'half_win', 'half_loss', 'void'].includes(activeOutcome)
        ? (activeOutcome as StatusChoice)
        : ''
      : 'pending';
  const [status, setStatus] = useState<StatusChoice | ''>(initialStatus);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const statusChanged = status !== initialStatus;

  useEffect(() => {
    if (!bookmaker || !creditsSender) {
      setCredits(bookmaker ? detail.credits.filter((item) => item.bookmakerId === bookmaker) : []);
      return;
    }
    const initialBookmaker =
      detail.bet?.bookmakerId ??
      detail.bookmakerOverrideId ??
      detail.matches.captionBookmakerId ??
      '';
    if (
      bookmaker === initialBookmaker &&
      detail.credits.every((item) => item.bookmakerId === bookmaker)
    ) {
      setCredits(detail.credits);
      return;
    }
    let active = true;
    setCreditsBusy(true);
    setCreditsError(null);
    creditsSender(bookmaker)
      .then((items) => {
        if (active) setCredits(items.map((item) => ({ ...item, bookmakerId: bookmaker })));
      })
      .catch(() => {
        if (!active) return;
        setCredits([]);
        setCreditsError('Não foi possível carregar as apostas grátis desta casa.');
      })
      .finally(() => {
        if (active) setCreditsBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    bookmaker,
    creditsSender,
    detail.bookmakerOverrideId,
    detail.credits,
    detail.bet?.bookmakerId,
    detail.matches.captionBookmakerId,
  ]);

  const compatibleCredits = useMemo(
    () =>
      credits.filter((item) => {
        if (!MONEY.test(stake)) return true;
        return origin === 'freebet' ? item.amount === stake : item.amount !== stake;
      }),
    [credits, origin, stake],
  );

  useEffect(() => {
    if (!credit || origin === 'real') return;
    if (!compatibleCredits.some((item) => item.id === credit)) setCredit('');
  }, [compatibleCredits, credit, origin]);

  const creditOptions: PickerOption[] = compatibleCredits.map((item) => ({
    value: item.id,
    label: `Aposta grátis ${formatBRL(item.amount)}`,
    description: `Válida até ${formatExpiry(item.expiresOn)}`,
    icon: '🎟️',
  }));
  const selectedCredit = credits.find((item) => item.id === credit);
  const potentialReturn =
    origin && MONEY.test(stake)
      ? potentialReturnFor(origin, stake, odds, selectedCredit?.amount ?? null)
      : null;

  const chooseOrigin = (next: 'real' | 'freebet' | 'hibrida') => {
    setOrigin(next);
    setError(null);
    if (next === 'real') setCredit('');
  };

  const chooseTicketKind = (next: TicketKind) => {
    setTicketKind(next);
    setSelections((current) => {
      const withOne = current.length ? current : [{ event: null, market: null, selection: null }];
      if (next === 'simple') return [withOne[0]!];
      if (next === 'betbuild') {
        const event = withOne[0]!.event;
        return withOne.map((item) => ({ ...item, event, market: 'BetBuild' }));
      }
      return withOne;
    });
  };

  const changeSelection = (index: number, key: 'event' | 'market' | 'selection', value: string) =>
    setSelections((current) =>
      current.map((item, itemIndex) => {
        if (key === 'event' && ticketKind === 'betbuild')
          return { ...item, event: value.trim() ? value : null };
        return itemIndex === index ? { ...item, [key]: value.trim() ? value : null } : item;
      }),
    );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!origin) throw new Error('Escolha a origem da aposta.');
      if (!status) throw new Error('Escolha o status da aposta.');
      if (!bookmaker) throw new Error('Escolha a casa de aposta.');
      if ((eventDate && !eventTime) || (!eventDate && eventTime))
        throw new Error('Informe a data e a hora do jogo juntas.');
      if ((origin === 'freebet' || origin === 'hibrida') && !credit)
        throw new Error('Escolha um crédito de aposta grátis disponível para esta casa.');
      if (!MONEY.test(stake)) throw new Error('Informe um valor apostado válido.');
      if (!/^\d{1,12}(\.\d{1,4})?$/.test(odds)) throw new Error('Informe uma odd válida.');
      if (
        selections.some(
          (item) => !item.event?.trim() || !item.selection?.trim() || !item.market?.trim(),
        )
      )
        throw new Error('Preencha evento, aposta e mercado de todas as seleções.');

      // STK-G0-23-R1 — depois da confirmação o registro financeiro é a fonte.
      // Casa, tipster, origem/crédito e data JÁ têm comando canônico, então o
      // formulário os encaminha por esses comandos (com as versões retornadas
      // em sequência) e o PATCH do rascunho passa a levar só metadados. O
      // PATCH não é capaz de atualizar o registro financeiro: enviá-lo como se
      // fosse capaz era o defeito apontado na revisão.
      const plan = planConfirmedSave({
        completionState: financialsFixed ? 'complete' : 'incomplete',
        selectionIds: (detail.bet?.selections ?? []).map((item) => item.id),
        baseline,
        current: {
          origin,
          credit,
          bookmaker,
          tipster,
          eventAt: eventDate && eventTime ? localInstant(`${eventDate}T${eventTime}`) : null,
          stake,
          odds,
          sport,
          tournament,
          country,
          ticketKind,
          selections,
        },
      });
      // Recusa ANTES de qualquer escrita — nada chega ao rascunho.
      if (plan.blocked.length) throw new Error(refusalMessage(plan.blocked));

      // Recuperação de falha parcial: a nova tentativa reusa a versão já
      // alcançada e não repete ação já persistida, para não duplicar efeito
      // financeiro nem anunciar sucesso falso.
      const applied: AppliedStep[] = recovery ? [...recovery.applied] : [];
      let version = recovery ? recovery.version : detail.item.version;
      const savedLabels = () => applied.map((step) => step.label);
      const runStep = async (
        key: string,
        label: string,
        target: string,
        call: () => Promise<{ version: number }>,
      ) => {
        if (applied.some((step) => step.key === key && step.target === target)) return;
        try {
          const result = await call();
          version = result.version;
          applied.push({ key, label, target });
          setRecovery({ applied: [...applied], version });
        } catch (failure) {
          const reason = failure instanceof Error ? failure.message : 'Tente novamente.';
          if (applied.length) {
            throw new Error(partialFailureMessage(savedLabels(), label, reason), {
              cause: failure,
            });
          }
          throw failure;
        }
      };

      if (plan.origin) {
        if (!originSender) throw new Error('Este Mini App não tem o comando de origem disponível.');
        await runStep(
          'origin',
          `origem ${plan.origin.kind}`,
          `${plan.origin.kind}:${plan.origin.freebetId ?? ''}`,
          () =>
            originSender({
              version,
              kind: plan.origin!.kind,
              freebetId: plan.origin!.freebetId ?? null,
            }),
        );
      }
      if (plan.bookmaker) {
        if (!bookmakerSender)
          throw new Error('Este Mini App não tem o comando de casa disponível.');
        await runStep('bookmaker', 'casa', plan.bookmaker, () =>
          bookmakerSender({ version, bookmakerId: plan.bookmaker! }),
        );
      }
      if (plan.tipster) {
        if (!tipsterSender)
          throw new Error('Este Mini App não tem o comando de tipster disponível.');
        await runStep('tipster', 'tipster', plan.tipster, () =>
          tipsterSender({ version, tipsterId: plan.tipster! }),
        );
      }
      for (const date of plan.dates) {
        if (!eventSender) throw new Error('Este Mini App não tem o comando de data disponível.');
        await runStep(`date:${date.selectionId}`, 'data', date.eventAt ?? '', () =>
          eventSender({ version, selectionId: date.selectionId, eventAt: date.eventAt }),
        );
      }

      let result: Awaited<ReturnType<typeof sender>>;
      try {
        // STK-G0-23-R2 — a versão é a do ENVIO, não a do plano. Cada comando
        // canônico acima já avançou a inbox; mandar a versão capturada na
        // montagem do plano fazia o servidor recusar por VERSION_CONFLICT e
        // deixava o salvamento parcial (a troca de casa já persistida, o
        // rascunho não).
        result = await sender({ ...plan.patch, version });
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : 'Tente novamente.';
        if (applied.length) {
          throw new Error(
            partialFailureMessage(savedLabels(), 'torneio, país e tipo do rascunho', reason),
            {
              cause: failure,
            },
          );
        }
        throw failure;
      }
      version = result.version;

      let confirmed: Awaited<ReturnType<NonNullable<typeof confirmSender>>> | null = null;
      try {
        confirmed = confirmSender ? await confirmSender({ version: result.version }) : null;
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : 'Tente novamente.';
        if (applied.length) {
          throw new Error(partialFailureMessage(savedLabels(), 'confirmação da aposta', reason), {
            cause: failure,
          });
        }
        throw failure;
      }
      version = confirmed?.version ?? result.version;
      if (statusChanged && statusSender) {
        let updated: { version: number; betState: string };
        try {
          updated = await statusSender({ version, action: status });
        } catch (failure) {
          throw new Error(
            `Os dados foram salvos, mas o status não foi alterado. Reabra o Mini App para conferir o registro. ${failure instanceof Error ? failure.message : ''}`,
            { cause: failure },
          );
        }
        version = updated.version;
      }
      // Só agora o fluxo principal está confirmado: o Mini App pode fechar.
      setRecovery(null);
      await onSaved(version);
      setConfirmStatus(false);
    } catch (failure) {
      setConfirmStatus(false);
      // STK-G0-23 — nada é anunciado como salvo se não foi persistido. Uma
      // recusa do servidor sem nenhuma ação já gravada é dita pelo motivo
      // concreto, sem declarar o formulário inteiro imutável.
      const canonicalRefusal =
        failure instanceof ApiFailure && failure.code === 'STATE_CONFLICT'
          ? 'O registro financeiro recusou esta alteração por conflito de estado e NADA foi salvo. Reabra o Mini App: os valores exibidos são os do registro da aposta.'
          : null;
      setError(
        canonicalRefusal ??
          (failure instanceof Error
            ? failure.message
            : 'Não foi possível salvar. Tente novamente.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="draft-controls mini-edit-form">
      <section className="mini-card mini-card-origin">
        <header className="mini-card-heading">
          <div>
            <h2>Origem da aposta</h2>
            <p>Informe como o valor foi composto.</p>
          </div>
        </header>
        <div className="mini-segmented" role="radiogroup" aria-label="Origem da aposta">
          {(
            [
              ['real', 'Dinheiro real'],
              ['freebet', 'Freebet'],
              ['hibrida', 'Híbrida'],
            ] as const
          ).map(([value, label]) => (
            <label className={origin === value ? 'selected' : ''} key={value}>
              <input
                type="radio"
                name="bet-origin"
                checked={origin === value}
                onChange={() => chooseOrigin(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {origin === 'hibrida' ? (
          <p className="mini-helper">Parte com dinheiro real e parte com aposta grátis.</p>
        ) : origin === 'freebet' ? (
          <p className="mini-helper">O valor da aposta grátis não retorna ao apostador.</p>
        ) : origin === null ? (
          <p className="mini-helper">Escolha a origem para continuar.</p>
        ) : null}
        {origin === 'freebet' || origin === 'hibrida' ? (
          <div className="mini-reveal">
            <MobilePicker
              label="Crédito de aposta grátis"
              value={credit}
              placeholder={creditsBusy ? 'Carregando créditos…' : 'Selecione o crédito'}
              options={creditOptions}
              disabled={creditsBusy || !bookmaker}
              onChange={(value) => {
                setCredit(value);
                // Aposta confirmada: o valor já está fixado no registro e não
                // tem comando canônico, então a escolha do crédito não o altera.
                if (origin === 'freebet' && !financialsFixed) {
                  const chosen = credits.find((item) => item.id === value);
                  if (chosen) setStake(chosen.amount);
                }
              }}
            />
            {!bookmaker ? (
              <p className="mini-helper warning">Escolha primeiro a casa de aposta.</p>
            ) : creditsError ? (
              <p className="mini-helper warning" role="alert">
                {creditsError}
              </p>
            ) : !creditsBusy && creditOptions.length === 0 ? (
              <p className="mini-helper warning" role="status">
                Nenhuma aposta grátis compatível e disponível para esta casa.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="mini-card">
        <header className="mini-card-heading">
          <div>
            <h2>Dados do jogo</h2>
            <p>A data de envio do Telegram permanece registrada.</p>
          </div>
        </header>
        {detail.telegramReceivedAt ? (
          <p className="mini-received-at" role="status">
            Enviado em {receivedFormat.format(new Date(detail.telegramReceivedAt))}
          </p>
        ) : null}
        <div className="mini-two-columns">
          <Field label="Data do jogo">
            <input
              type="date"
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
            />
          </Field>
          <Field label="Hora">
            <input
              type="time"
              value={eventTime}
              onChange={(event) => setEventTime(event.target.value)}
            />
          </Field>
        </div>
        <MobilePicker
          label="Esporte"
          value={sport}
          placeholder="Selecione o esporte"
          options={
            sport && !SPORT_PICKER_OPTIONS.some((option) => option.value === sport)
              ? [{ value: sport, label: sport }, ...SPORT_PICKER_OPTIONS]
              : SPORT_PICKER_OPTIONS
          }
          searchable
          onChange={setSport}
        />
        {extractedSport && !detail.sportOverride ? (
          <p className="mini-helper">Sugestão identificada pela IA; você pode editar.</p>
        ) : null}
        <Field label="Torneio">
          <input value={tournament} onChange={(event) => setTournament(event.target.value)} />
        </Field>
        <MobilePicker
          label="País"
          value={country}
          placeholder="Selecione o país ou região"
          options={
            country && !COUNTRY_OPTIONS.some((option) => option.value === country)
              ? [{ value: country, label: country }, ...COUNTRY_OPTIONS]
              : COUNTRY_OPTIONS
          }
          searchable
          onChange={setCountry}
        />
      </section>

      <section className="mini-card">
        <header className="mini-card-heading">
          <div>
            <h2>Detalhes da aposta</h2>
            <p>Edite o tipo, as partidas, apostas e mercados.</p>
          </div>
        </header>
        <span className="mini-field-label">Tipo de aposta</span>
        <div className="mini-segmented" role="radiogroup" aria-label="Tipo de aposta">
          {(
            [
              ['simple', 'Simples'],
              ['multiple', 'Múltipla'],
              ['betbuild', 'BetBuild'],
            ] as const
          ).map(([value, label]) => (
            <label className={ticketKind === value ? 'selected' : ''} key={value}>
              <input
                type="radio"
                name="ticket-kind"
                checked={ticketKind === value}
                onChange={() => chooseTicketKind(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <fieldset className="mini-selections">
          <legend>Partidas, apostas e mercados</legend>
          {selections.map((selection, index) => (
            <div className="draft-selection" key={index}>
              <div className="mini-selection-heading">
                <strong>
                  {ticketKind === 'betbuild' ? `Seleção ${index + 1}` : `Aposta ${index + 1}`}
                </strong>
                {selections.length > 1 && ticketKind !== 'simple' ? (
                  <button
                    type="button"
                    aria-label={`Remover seleção ${index + 1}`}
                    onClick={() =>
                      setSelections((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    Remover
                  </button>
                ) : null}
              </div>
              <Field label={ticketKind === 'betbuild' ? 'Evento' : `Evento ${index + 1}`}>
                <input
                  value={selection.event ?? ''}
                  onChange={(event) => changeSelection(index, 'event', event.target.value)}
                />
              </Field>
              <Field label={`Aposta ${index + 1}`}>
                <textarea
                  rows={2}
                  value={selection.selection ?? ''}
                  onChange={(event) => changeSelection(index, 'selection', event.target.value)}
                />
              </Field>
              <Field label={`Mercado ${index + 1}`}>
                <input
                  value={selection.market ?? ''}
                  disabled={ticketKind === 'betbuild'}
                  onChange={(event) => changeSelection(index, 'market', event.target.value)}
                />
              </Field>
            </div>
          ))}
          {ticketKind !== 'simple' ? (
            <button
              type="button"
              className="mini-add-selection"
              onClick={() =>
                setSelections((current) => [
                  ...current,
                  {
                    event: ticketKind === 'betbuild' ? (current[0]?.event ?? null) : null,
                    market: ticketKind === 'betbuild' ? 'BetBuild' : null,
                    selection: null,
                  },
                ])
              }
            >
              ＋ Adicionar seleção
            </button>
          ) : null}
        </fieldset>
      </section>

      <section className="mini-card">
        <header className="mini-card-heading">
          <div>
            <h2>Origem e identificação</h2>
            <p>As opções vêm dos cadastros ativos na Web.</p>
          </div>
        </header>
        <div className="mini-two-columns">
          <Field label="Casa de aposta">
            <select
              value={bookmaker}
              onChange={(event) => {
                setBookmaker(event.target.value);
                setCredit('');
              }}
            >
              <option value="">Selecione a casa</option>
              {detail.bookmakers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipster">
            <select value={tipster} onChange={(event) => setTipster(event.target.value)}>
              <option value="">Sem tipster</option>
              {detail.tipsters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="mini-card">
        <header className="mini-card-heading">
          <div>
            <h2>Valores e resultado</h2>
            <p>O retorno considera corretamente a origem escolhida.</p>
          </div>
        </header>
        <div className="mini-two-columns">
          <Field
            label={origin === 'hibrida' ? 'Valor em dinheiro real (R$)' : 'Valor apostado (R$)'}
            hint={
              financialsFixed
                ? 'Aposta confirmada: o valor já está fixado no registro financeiro e não tem comando próprio para ser alterado — mexer nele mudaria exposição, liquidação e histórico, o que depende de decisão de produto.'
                : undefined
            }
          >
            <input
              inputMode="decimal"
              value={stake}
              readOnly={financialsFixed}
              onChange={(event) => setStake(event.target.value)}
            />
          </Field>
          <Field
            label="Odd"
            hint={
              financialsFixed
                ? 'Aposta confirmada: a odd total já está fixada no registro financeiro e não tem comando próprio para ser alterada — mexer nela mudaria o retorno e o histórico, o que depende de decisão de produto.'
                : undefined
            }
          >
            <input
              inputMode="decimal"
              value={odds}
              readOnly={financialsFixed}
              onChange={(event) => setOdds(event.target.value)}
            />
          </Field>
        </div>
        <div className="mini-return-preview">
          <span>Retorno potencial</span>
          <strong>{potentialReturn ? formatBRL(potentialReturn) : 'Pendente'}</strong>
        </div>
        <Field label="Status">
          <select
            value={status}
            disabled={busy || detail.bet?.state === 'cancelled'}
            onChange={(event) => setStatus(event.target.value as StatusChoice)}
          >
            {status === '' ? (
              <option value="">
                {activeOutcome === 'cashout' || activeOutcome === 'partial_cashout'
                  ? 'Cashout — escolha um status'
                  : 'Liquidada — escolha um status'}
              </option>
            ) : null}
            <option value="pending">Pendente</option>
            <option value="win">Ganha</option>
            <option value="loss">Perdida</option>
            <option value="half_win">Meio-Ganha</option>
            <option value="half_loss">Meio-Perdida</option>
            <option value="void">Reembolsada</option>
          </select>
        </Field>
      </section>

      <section className="mini-card mini-sync-card" aria-label="Sincronização">
        <h2>Sincronização automática</h2>
        <p>
          <span aria-hidden="true">✓</span> Atualizar mensagem do Telegram
        </p>
        <p>
          <span aria-hidden="true">✓</span> Atualizar dados na Web
        </p>
        <small>As duas superfícies usam o mesmo registro.</small>
      </section>

      {error ? (
        <p className="notice warning mini-save-error" role="alert">
          {error}
        </p>
      ) : null}
      {confirmStatus ? (
        <div className="mini-feedback-layer" role="presentation">
          <div
            className="mini-feedback"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirmar status"
          >
            <h2>Confirmar alteração de status?</h2>
            <p>
              {status === 'pending'
                ? 'Voltar para Pendente estorna o resultado vigente e registra a correção no histórico financeiro.'
                : detail.bet?.state === 'settled'
                  ? 'O resultado vigente será estornado antes da nova liquidação financeira.'
                  : 'Esta ação liquida a aposta e atualiza a mensagem do Telegram.'}
            </p>
            <div className="mini-status-confirm-actions">
              <Button onClick={() => setConfirmStatus(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? 'Salvando…' : 'Confirmar e salvar'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="mini-sticky-action">
        <Button
          onClick={() => {
            if (statusChanged && statusSender) setConfirmStatus(true);
            else void save();
          }}
          disabled={busy}
        >
          {busy
            ? confirmSender
              ? 'Salvando e confirmando…'
              : 'Salvando e sincronizando…'
            : confirmSender
              ? 'Salvar e confirmar aposta'
              : 'Salvar alterações'}
        </Button>
      </div>
    </div>
  );
}
