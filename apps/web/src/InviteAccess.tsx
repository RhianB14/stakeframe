import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { authAction } from './OwnerAccess.js';
import { authPost } from './auth-actions.js';
import { ForgotPasswordPanel } from './PasswordReset.js';

type Phase = 'opening' | 'ready' | 'rejected';
type Mode = 'sign-up' | 'sign-in' | 'forgot';

async function openInvite(token: string) {
  const response = await fetch('/api/v1/beta-invite/open', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('INVITE_REJECTED');
  return response.json() as Promise<{ ok: true }>;
}

/**
 * Minimal beta-invite entry: opens the invitation link (pinning the token to this
 * browser through the server-set HttpOnly cookie) and offers the allowed paths — Google,
 * e-mail/password sign-up or sign-in, verification resend and password recovery.
 */
export function InviteAccess({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('opening');
  const [mode, setMode] = useState<Mode>('sign-up');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const open = useMutation({
    mutationFn: () => openInvite(token),
    onSuccess: () => setPhase('ready'),
    onError: () => setPhase('rejected'),
  });
  useEffect(() => {
    open.mutate();
    // The invitation is opened once per page load with the token from the URL.
  }, [token]);
  useEffect(() => {
    if (phase !== 'opening') window.history.replaceState(null, '', window.location.pathname);
  }, [phase]);
  const google = useMutation({
    mutationFn: async () => {
      const response = await authAction('sign-in/google');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('url' in data) || typeof data.url !== 'string')
        throw new Error('INVALID_AUTH_RESPONSE');
      const target = new URL(data.url);
      if (target.origin !== 'https://accounts.google.com') throw new Error('INVALID_AUTH_REDIRECT');
      window.location.assign(target.href);
    },
  });
  const emailSubmit = useMutation({
    mutationFn: async () => {
      const result = await authPost(
        mode === 'sign-up' ? 'sign-up/email' : 'sign-in/email',
        mode === 'sign-up' ? { name, email, password } : { email, password },
      );
      return result;
    },
    onSuccess: (result) => {
      if (result.ok) {
        if (mode === 'sign-up') {
          setNeedsVerification(true);
          setResendState('idle');
          setNotice('Cadastro recebido. Confira seu e-mail para confirmar o endereço.');
        } else {
          setNotice('Sessão iniciada. Recarregando…');
          window.setTimeout(() => window.location.assign('/'), 400);
        }
        return;
      }
      if (result.code === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerification(true);
        setResendState('idle');
        setNotice(result.message);
        return;
      }
      setNeedsVerification(false);
      setNotice(result.message);
    },
  });
  const resend = useMutation({
    mutationFn: async () => {
      const result = await authPost('send-verification-email', { email });
      return result;
    },
    onSuccess: (result) => {
      setResendState('sent');
      setNotice(
        result.ok
          ? 'Se este endereço precisar de confirmação, o e-mail será reenviado em instantes.'
          : result.message,
      );
    },
  });
  if (phase === 'opening')
    return (
      <p className="access-note" role="status">
        Verificando seu convite…
      </p>
    );
  if (phase === 'rejected')
    return (
      <div className="owner-access">
        <p role="alert">
          Este convite beta não está disponível. Confira o link ou solicite um novo convite.
        </p>
        <button className="retry-button" onClick={() => window.location.assign('/')}>
          Voltar para o início
        </button>
      </div>
    );
  if (mode === 'forgot')
    return <ForgotPasswordPanel initialEmail={email} onBack={() => setMode('sign-in')} />;
  return (
    <div className="owner-access">
      <p className="owner-greeting">Convite confirmado.</p>
      <p>Continue com sua conta Google ou use seu acesso por e-mail e senha.</p>
      {emailSubmit.isError || resend.isError ? (
        <p role="alert">Não foi possível concluir. Confira os dados e tente novamente.</p>
      ) : notice ? (
        <p role="status">{notice}</p>
      ) : null}
      {needsVerification ? (
        <button
          className="link-button"
          disabled={resendState === 'sending' || email.length === 0 || !email.includes('@')}
          onClick={() => {
            setResendState('sending');
            resend.mutate();
          }}
        >
          {resendState === 'sending'
            ? 'Reenviando…'
            : resendState === 'sent'
              ? 'Reenviar novamente'
              : 'Reenviar e-mail de confirmação'}
        </button>
      ) : null}
      <button className="google-button" disabled={google.isPending} onClick={() => google.mutate()}>
        <span aria-hidden="true" className="google-symbol">
          G
        </span>
        {google.isPending ? 'Abrindo Google…' : 'Continuar com Google'}
      </button>
      <div className="invite-tabs">
        <button
          className={mode === 'sign-up' ? 'retry-button' : 'google-button'}
          onClick={() => {
            setMode('sign-up');
            setNotice(null);
            setNeedsVerification(false);
          }}
        >
          Criar conta
        </button>
        <button
          className={mode === 'sign-in' ? 'retry-button' : 'google-button'}
          onClick={() => {
            setMode('sign-in');
            setNotice(null);
            setNeedsVerification(false);
          }}
        >
          Já tenho conta
        </button>
      </div>
      <form
        className="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          setNotice(null);
          emailSubmit.mutate();
        }}
      >
        {mode === 'sign-up' ? (
          <label>
            Nome
            <input
              type="text"
              value={name}
              maxLength={120}
              required
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}
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
        <label>
          Senha
          <input
            type="password"
            value={password}
            minLength={8}
            maxLength={128}
            required
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="retry-button" type="submit" disabled={emailSubmit.isPending}>
          {emailSubmit.isPending
            ? 'Enviando…'
            : mode === 'sign-up'
              ? 'Criar acesso'
              : 'Entrar com e-mail'}
        </button>
      </form>
      {mode === 'sign-in' ? (
        <button className="link-button" onClick={() => setMode('forgot')}>
          Esqueci minha senha
        </button>
      ) : null}
    </div>
  );
}
