import { useEffect, useState } from 'react';
import { deriveBetOrigin, formatBRL, type ImportDetail } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { Field } from './forms.js';
import { localInstant } from './api.js';

// STK-G0-19-R5 — controles canônicos de origem e data, compartilhados entre o
// formulário de revisão web e o Mini App do Telegram. Nenhuma opção de origem
// vem marcada por padrão e nada é inferido da imagem/IA.

const instantFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

export type DraftBody = {
  version: number;
  betOrigin?: 'real' | 'freebet' | 'hibrida' | null;
  freebetId?: string | null;
  eventAt?: string | null;
};

export function DraftControls({
  detail,
  sender,
  originSender,
  eventSender,
  creditsSender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: DraftBody) => Promise<{
    version: number;
    freebetCleared: boolean;
    automaticPolicy: 'disabled' | 'absent' | 'invalid' | 'approved';
  }>;
  /** R8: presente no Mini App — origem canônica (rascunho ou aposta). */
  originSender?: (body: {
    version: number;
    kind: 'real' | 'freebet' | 'hibrida';
    freebetId?: string | null;
  }) => Promise<{
    version: number;
    betState: string | null;
    kind: 'real' | 'freebet' | 'hibrida';
    freebetCleared: boolean;
  }>;
  /** R8: presente no Mini App — data por seleção (aposta importada). */
  eventSender?: (body: {
    version: number;
    selectionId: string;
    eventAt: string | null;
  }) => Promise<{ version: number; betState: string | null }>;
  /** R9: presente no Mini App — créditos por casa de destino. */
  creditsSender?: (
    bookmakerId: string,
  ) => Promise<{ id: string; amount: string; expiresOn: string; stakeReturned: boolean }[]>;
  onSaved: () => void;
}) {
  // R8 — depois da importação a fonte é a aposta financeira: nada de PATCH
  // de rascunho; origem e datas seguem as rotas canônicas.
  if (detail.bet && originSender && eventSender)
    return (
      <ImportedControls
        detail={detail}
        originSender={originSender}
        eventSender={eventSender}
        {...(creditsSender ? { creditsSender } : {})}
        onSaved={onSaved}
      />
    );
  const [origin, setOrigin] = useState<'real' | 'freebet' | 'hibrida' | null>(detail.betOrigin);
  const [credit, setCredit] = useState(detail.freebetId ?? '');
  const [eventDate, setEventDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const provisional = detail.eventDateStatus === 'pending';
  const [automaticHold, setAutomaticHold] = useState(false);
  const [cleared, setCleared] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setCleared(false);
    try {
      const result = await sender({
        version: detail.item.version,
        betOrigin: origin,
        freebetId: origin === 'freebet' || origin === 'hibrida' ? credit || null : null,
        ...(eventDate ? { eventAt: localInstant(eventDate) } : {}),
      });
      setSaved(true);
      setCleared(result.freebetCleared);
      setAutomaticHold(result.automaticPolicy !== 'approved');
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível salvar. Tente novamente.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-controls">
      <h3>Origem da aposta e data do jogo</h3>
      <fieldset>
        <legend>Origem da aposta *</legend>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'real'}
            onChange={() => setOrigin('real')}
          />{' '}
          Dinheiro real
        </label>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'freebet'}
            onChange={() => setOrigin('freebet')}
          />{' '}
          Freebet
        </label>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'hibrida'}
            onChange={() => setOrigin('hibrida')}
          />{' '}
          Híbrida (valor real + freebet)
        </label>
        {origin === null ? (
          <p className="notice">Informe a origem para liberar o registro.</p>
        ) : null}
      </fieldset>
      {origin === 'freebet' || origin === 'hibrida' ? (
        <Field label="Crédito de freebet">
          <select value={credit} onChange={(event) => setCredit(event.target.value)}>
            <option value="">Selecione o crédito</option>
            {detail.credits.map((item) => (
              <option key={item.id} value={item.id}>
                {`${formatBRL(item.amount)} · expira ${item.expiresOn}${
                  item.stakeReturned ? ' · devolve principal' : ''
                }`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <p className="notice" role="status">
        {provisional
          ? detail.telegramReceivedAt
            ? `Data provisória (envio no Telegram): ${instantFormat.format(new Date(detail.telegramReceivedAt))} — ajuste para a data/hora real do jogo.`
            : 'Este registro nasce sem data de evento; informe a data/hora real do jogo quando souber.'
          : `Data do jogo confirmada: ${instantFormat.format(new Date(detail.eventAt!))}.`}
      </p>
      <Field
        label="Data/hora real do jogo"
        hint="Horário de São Paulo; fica pendente até você confirmar."
      >
        <input
          type="datetime-local"
          value={eventDate}
          onChange={(event) => setEventDate(event.target.value)}
        />
      </Field>
      {error ? (
        <p className="notice warning" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status">
          Rascunho atualizado. A mensagem do Telegram será sincronizada.
          {automaticHold
            ? ' Sem política automática ativa, a importação automática permanece desligada e este bilhete seguirá em revisão.'
            : ''}
          {cleared
            ? ' O crédito anterior não era compatível com a casa atual e foi removido — escolha outro crédito.'
            : ''}
        </p>
      ) : null}
      <Button onClick={() => void save()} disabled={busy}>
        {busy ? 'Salvando…' : 'Salvar origem e data'}
      </Button>
    </div>
  );
}

// STK-G0-19-R8 — edição de aposta REGISTRADA (pós-importação): origem e datas
// gravam nos comandos financeiros canônicos por seleção; nunca só na inbox.
function ImportedControls({
  detail,
  originSender,
  eventSender,
  creditsSender,
  onSaved,
}: {
  detail: ImportDetail;
  originSender: (body: {
    version: number;
    kind: 'real' | 'freebet' | 'hibrida';
    freebetId?: string | null;
  }) => Promise<{
    version: number;
    betState: string | null;
    kind: 'real' | 'freebet' | 'hibrida';
    freebetCleared: boolean;
  }>;
  eventSender: (body: {
    version: number;
    selectionId: string;
    eventAt: string | null;
  }) => Promise<{ version: number; betState: string | null }>;
  creditsSender?: (
    bookmakerId: string,
  ) => Promise<{ id: string; amount: string; expiresOn: string; stakeReturned: boolean }[]>;
  onSaved: () => void;
}) {
  const bet = detail.bet!;
  const currentOrigin =
    detail.betOrigin ??
    (bet.freebetId
      ? bet.freebetAmount
        ? deriveBetOrigin(bet.stake, bet.freebetAmount)
        : 'freebet'
      : 'real');
  const [origin, setOrigin] = useState<'real' | 'freebet' | 'hibrida'>(currentOrigin);
  const [credit, setCredit] = useState('');
  const [credits, setCredits] = useState<
    { id: string; amount: string; expiresOn: string; stakeReturned: boolean }[] | null
  >(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});
  // R9 — créditos válidos PARA A CASA DA APOSTA (rota autenticada por casa de
  // destino); o crédito consumido nunca aparece; falha de leitura bloqueia o
  // envio de um crédito NOVO (manter o atual continua possível).
  useEffect(() => {
    if (!creditsSender) {
      setCredits(
        detail.credits.map((item) => ({
          id: item.id,
          amount: item.amount,
          expiresOn: item.expiresOn,
          stakeReturned: item.stakeReturned,
        })),
      );
      return;
    }
    let active = true;
    setCredits(null);
    setCreditsError(null);
    creditsSender(bet.bookmakerId)
      .then((list) => {
        if (active) setCredits(list);
      })
      .catch(() => {
        if (active)
          setCreditsError(
            'Não foi possível carregar os créditos desta casa — escolher um crédito novo está bloqueado até recarregar.',
          );
      });
    return () => {
      active = false;
    };
  }, [bet.bookmakerId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const saveOrigin = async () => {
    const usesCredit = origin === 'freebet' || origin === 'hibrida';
    if (usesCredit && credit && creditsError) {
      setError('Créditos desta casa não carregados — tente novamente antes de salvar.');
      return;
    }
    if (usesCredit && !credit && bet.freebetId === null) {
      setError(
        origin === 'hibrida'
          ? 'Escolha o crédito da parte freebet.'
          : 'Escolha o crédito da freebet.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await originSender({
        version: detail.item.version,
        kind: origin,
        ...(origin === 'freebet' || origin === 'hibrida'
          ? { freebetId: credit || bet.freebetId }
          : {}),
      });
      setSaved(
        `Origem salva para ${origin === 'freebet' ? 'Freebet' : origin === 'hibrida' ? 'Híbrida (valor real + freebet)' : 'Dinheiro real'}. A mensagem do Telegram será sincronizada.`,
      );
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a origem.');
    } finally {
      setBusy(false);
    }
  };
  const saveDate = async (selectionId: string) => {
    const value = dates[selectionId];
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await eventSender({
        version: detail.item.version,
        selectionId,
        eventAt: value ? localInstant(value) : null,
      });
      setSaved('Data da seleção salva. A mensagem do Telegram será sincronizada.');
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a data.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-controls">
      <h3>Origem da aposta registrada</h3>
      <fieldset>
        <legend>Origem *</legend>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'real'}
            onChange={() => setOrigin('real')}
          />{' '}
          Dinheiro real
        </label>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'freebet'}
            onChange={() => setOrigin('freebet')}
          />{' '}
          Freebet
        </label>
        <label>
          <input
            type="radio"
            name="bet-origin"
            checked={origin === 'hibrida'}
            onChange={() => setOrigin('hibrida')}
          />{' '}
          Híbrida (valor real + freebet)
        </label>
      </fieldset>
      {origin === 'freebet' || origin === 'hibrida' ? (
        <Field label="Crédito de freebet">
          <select value={credit} onChange={(event) => setCredit(event.target.value)}>
            <option value="">
              {bet.freebetId ? 'Manter o crédito atual' : 'Selecione o crédito'}
            </option>
            {(credits ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {`${formatBRL(item.amount)} · expira ${item.expiresOn}${
                  item.stakeReturned ? ' · devolve principal' : ''
                }`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {origin === 'freebet' && creditsError ? (
        <p className="notice warning" role="alert">
          {creditsError}
        </p>
      ) : null}
      <p className="notice">
        A troca de origem gera journal compensatório no servidor (nunca reescreve o passado);
        crédito é consumido/liberado atomicamente.
      </p>
      <Button onClick={() => void saveOrigin()} disabled={busy}>
        {busy ? 'Salvando…' : 'Salvar origem'}
      </Button>
      <h3>Data dos jogos</h3>
      {bet.selections.map((item) => (
        <div key={item.id} className="selection-date-row">
          <span>
            {item.event} — {item.selection}{' '}
            {item.eventAt
              ? `· ${instantFormat.format(new Date(item.eventAt))} (confirmada)`
              : '· data pendente'}
          </span>
          <input
            type="datetime-local"
            aria-label={`Data de ${item.event}`}
            value={dates[item.id] ?? ''}
            onChange={(event) => setDates({ ...dates, [item.id]: event.target.value })}
          />
          <Button onClick={() => void saveDate(item.id)} disabled={busy}>
            Salvar data
          </Button>
        </div>
      ))}
      {bet.selections.length > 1 ? (
        <p className="notice">
          Múltipla: cada seleção tem a própria data — nenhuma data global é aplicada.
        </p>
      ) : null}
      {error ? (
        <p className="notice warning" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status">
          {saved}
        </p>
      ) : null}
    </div>
  );
}
