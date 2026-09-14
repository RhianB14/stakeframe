import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { authAction } from './OwnerAccess.js';

type Phase = 'opening' | 'ready' | 'rejected';

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

async function emailAction(path: 'sign-up/email' | 'sign-in/email', payload: object) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('AUTH_ACTION_FAILED');
  return response.json() as Promise<unknown>;
}

/**
 * Minimal beta-invite entry: opens the invitation link (pinning the token to this
 * browser through the server-set HttpOnly cookie) and offers the two allowed paths —
 * Google or e-mail/password. No full onboarding in this step.
 */
export function InviteAccess({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('opening');
  const [mode, setMode] = useState<'sign-up' | 'sign-in'>('sign-up');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
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
    mutationFn: () =>
      emailAction(
        mode === 'sign-up' ? 'sign-up/email' : 'sign-in/email',
        mode === 'sign-up' ? { name, email, password } : { email, password },
      ),
    onSuccess: () => {
      if (mode === 'sign-up') {
        setNotice('Cadastro recebido. Confira seu e-mail para confirmar o endereço.');
      } else {
        setNotice('Sessão iniciada. Recarregando…');
        window.setTimeout(() => window.location.assign('/'), 400);
      }
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
  return (
    <div className="owner-access">
      <p className="owner-greeting">Convite confirmado.</p>
      <p>Continue com sua conta Google ou crie o acesso por e-mail e senha.</p>
      {google.isError || emailSubmit.isError ? (
        <p role="alert">
          {notice ?? 'Não foi possível concluir. Confira os dados e tente novamente.'}
        </p>
      ) : notice ? (
        <p role="status">{notice}</p>
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
          onClick={() => setMode('sign-up')}
        >
          Criar conta
        </button>
        <button
          className={mode === 'sign-in' ? 'retry-button' : 'google-button'}
          onClick={() => setMode('sign-in')}
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
    </div>
  );
}
