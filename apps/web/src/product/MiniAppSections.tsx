import { useEffect, useState } from 'react';
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
  creditsSender,
  onSaved,
}: {
  detail: ImportDetail;
  // R8 — rota canônica: rascunho (inbox) OU aposta importada (comando
  // financeiro com journal de reclassificação). Freebet exige crédito
  // compatível NA MESMA operação.
  sender: (body: { version: number; bookmakerId: string; freebetId?: string | null }) => Promise<{
    version: number;
    betState: string | null;
    bookmakerId: string;
    bookmakerName: string | null;
    freebetCleared: boolean;
  }>;
  // R9 — créditos válidos PARA A CASA DE DESTINO (nunca da casa anterior);
  // falha de leitura bloqueia a gravação.
  creditsSender: (
    bookmakerId: string,
  ) => Promise<{ id: string; amount: string; expiresOn: string; stakeReturned: boolean }[]>;
  onSaved: () => void;
}) {
  const imported = detail.bet !== null;
  const [choice, setChoice] = useState(
    imported ? (detail.bet?.bookmakerId ?? '') : (detail.bookmakerOverrideId ?? ''),
  );
  const [credit, setCredit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [credits, setCredits] = useState<
    { id: string; amount: string; expiresOn: string; stakeReturned: boolean }[] | null
  >(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const needsCredit = imported && !!detail.bet?.freebetId;
  // R9 — ao trocar a casa de destino, carrega SOMENTE os créditos compatíveis
  // com ela; a lista anterior nunca é reutilizada.
  useEffect(() => {
    if (!needsCredit || !choice) {
      setCredits(null);
      setCreditsError(null);
      return;
    }
    let active = true;
    setCredits(null);
    setCreditsError(null);
    creditsSender(choice)
      .then((list) => {
        if (active) setCredits(list);
      })
      .catch(() => {
        if (active)
          setCreditsError(
            'Não foi possível carregar os créditos da casa escolhida — a gravação está bloqueada até recarregar.',
          );
      });
    return () => {
      active = false;
    };
  }, [choice, needsCredit]);
  const current = imported
    ? (detail.bet?.bookmakerName ?? 'casa da aposta registrada')
    : (detail.bookmakers.find((item) => item.id === detail.bookmakerOverrideId)?.name ??
      (detail.bookmakerOverrideId
        ? 'casa declarada'
        : detail.matches.captionBookmakerId || detail.matches.extractedBookmakerId
          ? 'resolvida pela legenda/leitura'
          : 'não resolvida'));
  const save = async () => {
    if (!choice) {
      setError('Escolha a nova casa.');
      return;
    }
    if (needsCredit && (creditsError || credits === null)) {
      setError('Créditos da casa escolhida não carregados — tente novamente antes de salvar.');
      return;
    }
    if (needsCredit && !credit) {
      setError('Escolha um crédito compatível com a casa nova.');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await sender({
        version: detail.item.version,
        bookmakerId: choice,
        ...(needsCredit ? { freebetId: credit || null } : {}),
      });
      setSaved(
        [
          `Casa salva${result.bookmakerName ? `: ${result.bookmakerName}` : ''}.`,
          result.freebetCleared
            ? ' O crédito anterior não é compatível com a casa nova e foi removido — escolha outro crédito em “Editar”.'
            : '',
          ' A mensagem do Telegram será sincronizada.',
        ].join(''),
      );
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Não foi possível salvar a casa. Tente novamente.',
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
        {!imported && detail.bookmakerOverrideId ? ' (escolhida por você)' : ''}
        {imported ? ' (aposta registrada)' : ''}
      </p>
      <label>
        Nova casa
        <select value={choice} onChange={(event) => setChoice(event.target.value)}>
          {!imported ? <option value="">Voltar para a casa da legenda/leitura</option> : null}
          {detail.bookmakers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {needsCredit ? (
        <label>
          Crédito de freebet para a nova casa
          <select value={credit} onChange={(event) => setCredit(event.target.value)}>
            <option value="">
              {creditsError
                ? 'Créditos indisponíveis'
                : credits === null
                  ? 'Carregando créditos…'
                  : 'Selecione o crédito'}
            </option>
            {(credits ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {`${formatBRL(item.amount)} · expira ${item.expiresOn}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {needsCredit && credits !== null && credits.length === 0 && !creditsError ? (
        <p className="notice warning" role="status">
          Nenhum crédito compatível com a casa escolhida — a confirmação fica desabilitada.
        </p>
      ) : null}
      {creditsError ? (
        <p className="notice warning" role="alert">
          {creditsError}
        </p>
      ) : null}
      <p className="notice">
        {imported
          ? 'A troca de casa reclassifica a exposição entre as casas e sincroniza a mensagem do Telegram. Aposta com freebet exige um crédito da casa nova na mesma operação.'
          : 'Trocar a casa revalida o crédito de freebet associado; um crédito incompatível é removido e você precisará escolher novamente.'}
      </p>
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
      <Button
        onClick={() => void save()}
        disabled={busy || (needsCredit && (credits === null || credits.length === 0 || !credit))}
      >
        {busy ? 'Salvando…' : 'Salvar casa'}
      </Button>
    </div>
  );
}
