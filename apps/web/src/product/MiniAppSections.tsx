import { useEffect, useState } from 'react';
import { formatBRL, type ImportDetail } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';

// STK-G0-19-R7 — seções reais do Mini App abertas pelos botões da mensagem do
// Telegram ("Alterar Status" e "Alterar Casa"). Toda gravação viaja pelo
// backend canônico com initData validado no servidor; o cliente só envia a
// ação — estado, organização e valores vêm do registro.

const stateLabel = (state: string) =>
  state === 'open' ? 'Pendente' : state === 'settled' ? 'Liquidada' : 'Cancelada';

// STK-G0-20 B4/B5 — as seis transições do produto (o cashout tem seção
// própria: valor recebido informado pelo usuário, nunca derivado).
const STATUS_ACTIONS = [
  { value: 'win', label: 'Ganhou (retorno bruto calculado pelo servidor)' },
  { value: 'loss', label: 'Perdeu (retorno zero)' },
  { value: 'half_win', label: 'Meio-Ganha (metade ganha, metade devolvida)' },
  { value: 'half_loss', label: 'Meio-Perdida (metade perdida, metade devolvida)' },
  { value: 'void', label: 'Reembolsada (anulada — devolve o valor apostado)' },
  { value: 'pending', label: 'Manter pendente (sem liquidação)' },
] as const;
const STATUS_LABEL: Record<string, string> = {
  win: '“Ganhou”',
  loss: '“Perdeu”',
  half_win: '“Meio-Ganha”',
  half_loss: '“Meio-Perdida”',
  void: '“Reembolsada”',
  pending: '“Manter pendente”',
};
type StatusAction = (typeof STATUS_ACTIONS)[number]['value'];

export function StatusSection({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: { version: number; action: StatusAction }) => Promise<{
    version: number;
    betState: string;
  }>;
  onSaved: (version: number) => void | Promise<void>;
}) {
  const [action, setAction] = useState<StatusAction | null>(null);
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
  if (bet.completionState !== 'complete')
    return (
      <div className="draft-controls">
        <h3>Status da aposta</h3>
        <p className="notice warning" role="status">
          Complete os campos obrigatórios em “Editar” para liberar a alteração de status. A aposta
          já foi criada e permanece Pendente.
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
      const result = await sender({ version: detail.item.version, action });
      setSaved(true);
      setConfirming(false);
      await onSaved(result.version);
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
        Estado atual: <strong>{stateLabel(bet.state)}</strong> · Stake{' '}
        {formatBRL(bet.stake ?? '0.00')} · Odd {bet.odds ?? 'A definir'} · Em aberto{' '}
        {formatBRL(bet.remaining ?? '0.00')}
      </p>
      <fieldset>
        <legend>Nova transição *</legend>
        {STATUS_ACTIONS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="status-action"
              checked={action === option.value}
              onChange={() => {
                setAction(option.value);
                setConfirming(false);
              }}
            />{' '}
            {option.label}
          </label>
        ))}
      </fieldset>
      {action && !confirming && !saved ? (
        <Button onClick={() => setConfirming(true)}>Continuar</Button>
      ) : null}
      {action && confirming ? (
        <div>
          <p className="notice warning" role="alert">
            {action === 'pending'
              ? 'Manter a aposta pendente (sem liquidação)? Nenhum efeito financeiro é aplicado.'
              : `Confirmar ${STATUS_LABEL[action] ?? 'a transição'}? A liquidação é financeira e a mensagem do Telegram será sincronizada.`}
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
          {action === 'pending'
            ? 'A aposta permanece pendente — nenhuma liquidação foi registrada.'
            : 'Liquidação registrada. A mensagem do Telegram foi sincronizada e entrou na limpeza do chat.'}
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
  onSaved: (version: number) => void | Promise<void>;
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
      await onSaved(result.version);
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

// STK-G0-20 B5 — seção do Tipster: SOMENTE os cadastros ATIVOS da organização
// (nunca misturados às casas); a seleção grava no registro canônico com versão
// otimista e o Telegram é sincronizado pela outbox.
export function TipsterSection({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: { version: number; tipsterId: string }) => Promise<{
    version: number;
    betState: string | null;
    tipsterId: string;
    tipsterName: string | null;
  }>;
  onSaved: (version: number) => void | Promise<void>;
}) {
  const imported = detail.bet !== null;
  const [choice, setChoice] = useState(
    imported ? (detail.bet?.tipsterId ?? '') : (detail.tipsterOverrideId ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const current = imported
    ? (detail.bet?.tipsterName ?? 'sem tipster')
    : (detail.tipsters.find((item) => item.id === detail.tipsterOverrideId)?.name ?? 'sem tipster');
  const save = async () => {
    if (!choice) {
      setError('Escolha o tipster.');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await sender({ version: detail.item.version, tipsterId: choice });
      setSaved(
        `Tipster salvo${result.tipsterName ? `: ${result.tipsterName}` : ''}. A mensagem do Telegram será sincronizada.`,
      );
      await onSaved(result.version);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível salvar o tipster.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-controls">
      <h3>Tipster da aposta</h3>
      <p role="status">
        Tipster atual: <strong>{current}</strong>
        {imported ? ' (aposta registrada)' : ''}
      </p>
      <label>
        Novo tipster
        <select value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="">Selecione o tipster</option>
          {detail.tipsters.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {detail.tipsters.length === 0 ? (
        <p className="notice" role="status">
          Nenhum tipster ativo cadastrado — cadastre na Web para escolher aqui.
        </p>
      ) : null}
      {!imported ? (
        <p className="notice">
          Em rascunhos, a escolha fica salva na importação e será levada para a aposta quando ela
          for registrada.
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
      <Button onClick={() => void save()} disabled={busy || !choice}>
        {busy ? 'Salvando…' : 'Salvar tipster'}
      </Button>
    </div>
  );
}

// STK-G0-20 B4/B5 — seção do Cashout: o valor recebido é INFORMADO pelo
// usuário (nunca derivado); o total encerra todo o valor aberto e o parcial,
// apenas a parte declarada. O servidor revalida tudo pelo comando canônico.
export function CashoutSection({
  detail,
  sender,
  onSaved,
}: {
  detail: ImportDetail;
  sender: (body: {
    version: number;
    action: 'cashout' | 'partial_cashout';
    returnAmount: string;
    closedPrincipal?: string;
  }) => Promise<{ version: number; betState: string }>;
  onSaved: (version: number) => void | Promise<void>;
}) {
  const bet = detail.bet;
  const [mode, setMode] = useState<'cashout' | 'partial_cashout'>('cashout');
  const [returnAmount, setReturnAmount] = useState('');
  const [closedPrincipal, setClosedPrincipal] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
  if (!bet)
    return (
      <div className="draft-controls">
        <h3>Cashout</h3>
        <p className="notice" role="status">
          Esta importação ainda não foi registrada como aposta. Confirme a origem e a data em
          “Editar”; o cashout acontece aqui quando a aposta estiver pendente.
        </p>
      </div>
    );
  if (bet.state !== 'open')
    return (
      <div className="draft-controls">
        <h3>Cashout</h3>
        <p className="notice" role="status">
          Estado atual: <strong>{stateLabel(bet.state)}</strong> — o cashout só se aplica a aposta
          pendente.
        </p>
      </div>
    );
  const validate = (): string | null => {
    if (!MONEY.test(returnAmount)) return 'Informe o valor recebido (ex.: 150.00).';
    if (mode === 'partial_cashout') {
      if (!MONEY.test(closedPrincipal))
        return 'Informe quanto do valor aberto foi encerrado (ex.: 50.00).';
    }
    return null;
  };
  const save = async () => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await sender({
        version: detail.item.version,
        action: mode,
        returnAmount,
        ...(mode === 'partial_cashout' ? { closedPrincipal } : {}),
      });
      setSaved(true);
      setConfirming(false);
      await onSaved(result.version);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Não foi possível registrar o cashout.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="draft-controls">
      <h3>Cashout</h3>
      <p role="status">
        Em aberto {formatBRL(bet.remaining ?? '0.00')} · Stake {formatBRL(bet.stake ?? '0.00')} ·
        Odd {bet.odds ?? 'A definir'}
      </p>
      <fieldset>
        <legend>Tipo de cashout *</legend>
        <label>
          <input
            type="radio"
            name="cashout-mode"
            checked={mode === 'cashout'}
            onChange={() => {
              setMode('cashout');
              setConfirming(false);
            }}
          />{' '}
          Cashout total (encerra todo o valor aberto)
        </label>
        <label>
          <input
            type="radio"
            name="cashout-mode"
            checked={mode === 'partial_cashout'}
            onChange={() => {
              setMode('partial_cashout');
              setConfirming(false);
            }}
          />{' '}
          Cashout parcial (encerra parte do valor aberto)
        </label>
      </fieldset>
      <label>
        Valor recebido (R$) *
        <input
          inputMode="decimal"
          value={returnAmount}
          onChange={(event) => {
            setReturnAmount(event.target.value);
            setConfirming(false);
          }}
        />
      </label>
      {mode === 'partial_cashout' ? (
        <label>
          Valor encerrado (R$) *
          <input
            inputMode="decimal"
            value={closedPrincipal}
            onChange={(event) => {
              setClosedPrincipal(event.target.value);
              setConfirming(false);
            }}
          />
        </label>
      ) : null}
      {!confirming ? (
        <Button onClick={() => setConfirming(true)} disabled={busy}>
          Continuar
        </Button>
      ) : (
        <div>
          <p className="notice warning" role="alert">
            Confirmar o cashout? A operação é financeira, encerra o valor declarado e sincroniza a
            mensagem do Telegram.
          </p>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Registrando…' : 'Confirmar cashout'}
          </Button>{' '}
          <Button onClick={() => setConfirming(false)} disabled={busy}>
            Voltar
          </Button>
        </div>
      )}
      {error ? (
        <p className="notice warning" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="notice" role="status">
          Cashout registrado. A mensagem do Telegram foi sincronizada e entrou na limpeza do chat.
        </p>
      ) : null}
    </div>
  );
}
