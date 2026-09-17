import { useState } from 'react';
import { formatBRL, type ImportDetail } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';

// STK-G0-19-R7 — seções reais do Mini App abertas pelos botões da mensagem do
// Telegram ("Alterar Status" e "Alterar Casa"). Toda gravação viaja pelo
// backend canônico com initData validado no servidor; o cliente só envia a
// ação — estado, organização e valores vêm do registro.

const stateLabel = (state: string) =>
  state === 'open' ? 'Pendente' : state === 'settled' ? 'Liquidada' : 'Cancelada';

export function StatusSection({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: { version: number; action: 'win' | 'loss' }) => Promise<{
    version: number;
    betState: string;
  }>;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<'win' | 'loss' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const bet = detail.bet;
  if (!bet)
    return (
      <div className="draft-controls">
        <h3>Status da aposta</h3>
        <p className="notice" role="status">
          Esta importação ainda não foi registrada como aposta. Confirme a origem e a data em
          “Editar”; quando a aposta estiver pendente, a liquidação acontece aqui.
        </p>
      </div>
    );
  if (bet.state !== 'open')
    return (
      <div className="draft-controls">
        <h3>Status da aposta</h3>
        <p className="notice" role="status">
          Estado atual: <strong>{stateLabel(bet.state)}</strong> — sem transições disponíveis. A
          mensagem do Telegram reflete este estado.
        </p>
      </div>
    );
  const save = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await sender({ version: detail.item.version, action });
      setSaved(true);
      setConfirming(false);
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível liquidar. Tente novamente.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-controls">
      <h3>Status da aposta</h3>
      <p role="status">
        Estado atual: <strong>{stateLabel(bet.state)}</strong> · Stake {formatBRL(bet.stake)} · Odd{' '}
        {bet.odds} · Em aberto {formatBRL(bet.remaining)}
      </p>
      <fieldset>
        <legend>Nova transição *</legend>
        <label>
          <input
            type="radio"
            name="status-action"
            checked={action === 'win'}
            onChange={() => {
              setAction('win');
              setConfirming(false);
            }}
          />{' '}
          Ganhou (retorno bruto calculado pelo servidor)
        </label>
        <label>
          <input
            type="radio"
            name="status-action"
            checked={action === 'loss'}
            onChange={() => {
              setAction('loss');
              setConfirming(false);
            }}
          />{' '}
          Perdeu (retorno zero)
        </label>
      </fieldset>
      {action && !confirming && !saved ? (
        <Button onClick={() => setConfirming(true)}>Continuar</Button>
      ) : null}
      {action && confirming ? (
        <div>
          <p className="notice warning" role="alert">
            Confirmar {action === 'win' ? '“Ganhou”' : '“Perdeu”'}? A liquidação é financeira e a
            mensagem do Telegram será sincronizada.
          </p>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Liquidando…' : 'Confirmar liquidação'}
          </Button>{' '}
          <Button onClick={() => setConfirming(false)} disabled={busy}>
            Voltar
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="notice warning" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status">
          Liquidação registrada. A mensagem do Telegram foi sincronizada e entrou na limpeza do
          chat.
        </p>
      ) : null}
    </div>
  );
}

export function BookmakerSection({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: { version: number; bookmakerId: string | null }) => Promise<{
    version: number;
    freebetCleared: boolean;
    automaticPolicy: 'disabled' | 'absent' | 'invalid' | 'approved';
  }>;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState(detail.bookmakerOverrideId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [cleared, setCleared] = useState(false);
  const current =
    detail.bookmakers.find((item) => item.id === detail.bookmakerOverrideId)?.name ??
    (detail.bookmakerOverrideId
      ? 'casa declarada'
      : detail.matches.captionBookmakerId || detail.matches.extractedBookmakerId
        ? 'resolvida pela legenda/leitura'
        : 'não resolvida');
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await sender({
        version: detail.item.version,
        bookmakerId: choice ? choice : null,
      });
      setCleared(result.freebetCleared);
      setSaved(true);
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
      <h3>Casa da aposta</h3>
      <p role="status">
        Casa atual: <strong>{current}</strong>
        {detail.bookmakerOverrideId ? ' (escolhida por você)' : ''}
      </p>
      <label>
        Nova casa
        <select value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="">Voltar para a casa da legenda/leitura</option>
          {detail.bookmakers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <p className="notice">
        Trocar a casa revalida o crédito de freebet associado; um crédito incompatível é removido e
        você precisará escolher novamente.
      </p>
      {error ? (
        <p className="notice warning" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status">
          {cleared
            ? 'Casa salva. O crédito anterior não é compatível com a casa nova e foi removido — escolha outro crédito em “Editar”.'
            : 'Casa salva. A mensagem do Telegram será sincronizada.'}
        </p>
      ) : null}
      <Button onClick={() => void save()} disabled={busy}>
        {busy ? 'Salvando…' : 'Salvar casa'}
      </Button>
    </div>
  );
}
