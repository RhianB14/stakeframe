import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ownerSessionSchema } from '@stakeframe/shared';

export async function loadOwner() {
  const response = await fetch('/api/v1/me', {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
  return ownerSessionSchema.parse(await response.json());
}
export async function authAction(path: string) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('AUTH_ACTION_FAILED');
  return response;
}
export function OwnerAccess() {
  const client = useQueryClient();
  const [callbackFailed, setCallbackFailed] = useState(
    () => new URLSearchParams(window.location.search).get('auth') === 'failed',
  );
  useEffect(() => {
    if (callbackFailed) window.history.replaceState(null, '', window.location.pathname);
  }, [callbackFailed]);
  const owner = useQuery({
    queryKey: ['owner-session'],
    queryFn: loadOwner,
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
  });
  const login = useMutation({
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
  const logout = useMutation({
    mutationFn: async () => {
      await authAction('sign-out');
    },
    onSuccess: () => {
      sessionStorage.removeItem('stakeframe.pending-command');
      client.clear();
    },
  });
  if (owner.isPending)
    return (
      <p className="access-note" role="status">
        Verificando acesso privado…
      </p>
    );
  if (owner.isError)
    return (
      <div className="owner-access">
        <p role="alert">Não foi possível verificar sua sessão.</p>
        <button
          className="retry-button"
          onClick={() => {
            void owner.refetch();
          }}
        >
          Verificar acesso novamente
        </button>
      </div>
    );
  if (owner.data)
    return (
      <div className="owner-access">
        <p className="owner-greeting">Olá, {owner.data.user.name}.</p>
        <p>Seu acesso privado está confirmado. As funcionalidades estão em preparação.</p>
        {logout.isError ? <p role="alert">Não foi possível sair. Tente novamente.</p> : null}
        <button
          className="retry-button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          {logout.isPending ? 'Saindo…' : 'Sair da conta'}
        </button>
      </div>
    );
  return (
    <div className="owner-access">
      {callbackFailed || login.isError ? (
        <p role="alert">
          Não foi possível entrar. Use a conta Google autorizada e tente novamente.
        </p>
      ) : null}
      <button
        className="google-button"
        disabled={login.isPending}
        onClick={() => {
          setCallbackFailed(false);
          login.mutate();
        }}
      >
        <span aria-hidden="true" className="google-symbol">
          G
        </span>
        {login.isPending ? 'Abrindo Google…' : 'Entrar com Google'}
      </button>
      <p className="owner-only">Acesso exclusivo do proprietário.</p>
    </div>
  );
}
