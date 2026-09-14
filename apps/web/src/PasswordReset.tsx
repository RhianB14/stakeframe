import { useState } from 'react';
import { authPost } from './auth-actions.js';

/**
 * Standalone gate for password recovery: renders the reset form when the URL carries a
 * token (`/?reset=<token>`) and the request form otherwise. Tokens are single-use; an
 * expired or replayed link falls back to a fresh request.
 */
export function PasswordResetGate({ token }: { token: string | null }) {
  return token ? <ResetPasswordPanel token={token} /> : <ForgotPasswordPanel />;
}

export function ForgotPasswordPanel({
  initialEmail = '',
  onBack,
}: {
  initialEmail?: string;
  onBack?: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [phase, setPhase] = useState<'form' | 'sending' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPhase('sending');
    setError(null);
    const result = await authPost('request-password-reset', { email });
    if (result.ok) {
      setPhase('sent');
    } else {
      setPhase('form');
      setError(result.message);
    }
  }
  if (phase === 'sent')
    return (
      <div className="owner-access">
        <p className="owner-greeting">Confira seu e-mail.</p>
        <p>
          Se este endereço tiver uma conta no Stakeframe, você receberá um link para definir uma
          nova senha. O link expira em 30 minutos e só pode ser usado uma vez.
        </p>
        {onBack ? (
          <button className="retry-button" onClick={onBack}>
            Voltar para o login
          </button>
        ) : null}
      </div>
    );
  return (
    <div className="owner-access">
      <p className="owner-greeting">Recuperar senha.</p>
      <p>Informe o e-mail da sua conta. Enviaremos um link seguro para criar uma nova senha.</p>
      {error ? <p role="alert">{error}</p> : null}
      <form
        className="invite-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          E-mail
          <input
            type="email"
            value={email}
            required
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="retry-button" type="submit" disabled={phase === 'sending'}>
          {phase === 'sending' ? 'Enviando…' : 'Enviar link de redefinição'}
        </button>
      </form>
      {onBack ? (
        <button className="link-button" onClick={onBack}>
          Voltar para o login
        </button>
      ) : null}
    </div>
  );
}

export function ResetPasswordPanel({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'invalid'>('form');
  const [showRequest, setShowRequest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError('As senhas não conferem. Digite a mesma senha nos dois campos.');
      return;
    }
    setPhase('submitting');
    setError(null);
    const result = await authPost('reset-password', { token, newPassword: password });
    if (result.ok) {
      setPhase('done');
    } else if (result.code === 'RESET_REJECTED') {
      setPhase('invalid');
    } else {
      setPhase('form');
      setError(result.message);
    }
  }
  if (phase === 'done')
    return (
      <div className="owner-access">
        <p className="owner-greeting">Senha redefinida.</p>
        <p>Suas sessões antigas foram encerradas. Entre novamente com a nova senha.</p>
        <button className="retry-button" onClick={() => window.location.assign('/')}>
          Ir para o login
        </button>
      </div>
    );
  if (phase === 'invalid' && showRequest) return <ForgotPasswordPanel />;
  if (phase === 'invalid')
    return (
      <div className="owner-access">
        <p role="alert">
          Este link de redefinição não é mais válido. Solicite um novo link e tente novamente.
        </p>
        <button className="retry-button" onClick={() => setShowRequest(true)}>
          Solicitar novo link
        </button>
      </div>
    );
  return (
    <div className="owner-access">
      <p className="owner-greeting">Definir nova senha.</p>
      <p>Escolha uma nova senha para sua conta. Use pelo menos 8 caracteres.</p>
      {error ? <p role="alert">{error}</p> : null}
      <form
        className="invite-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Nova senha
          <input
            type="password"
            value={password}
            minLength={8}
            maxLength={128}
            required
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Confirmar nova senha
          <input
            type="password"
            value={confirm}
            minLength={8}
            maxLength={128}
            required
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        <button className="retry-button" type="submit" disabled={phase === 'submitting'}>
          {phase === 'submitting' ? 'Salvando…' : 'Salvar nova senha'}
        </button>
      </form>
    </div>
  );
}
