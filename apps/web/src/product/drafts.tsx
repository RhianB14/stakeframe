import { useState } from 'react';
import { formatBRL, type ImportDetail } from '@stakeframe/shared';
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
  betOrigin?: 'real' | 'freebet' | null;
  freebetId?: string | null;
  eventAt?: string | null;
};

export function DraftControls({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: DraftBody) => Promise<{
    version: number;
    freebetCleared: boolean;
    automaticPolicy: 'disabled' | 'absent' | 'invalid' | 'approved';
  }>;
  onSaved: () => void;
}) {
  const [origin, setOrigin] = useState<'real' | 'freebet' | null>(detail.betOrigin);
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
        freebetId: origin === 'freebet' ? credit || null : null,
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
        {origin === null ? (
          <p className="notice">Informe a origem para liberar o registro.</p>
        ) : null}
      </fieldset>
      {origin === 'freebet' ? (
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
