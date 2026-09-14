import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorSchema, consentStatusSchema } from '@stakeframe/shared';
import { authAction } from './OwnerAccess.js';

async function loadConsentStatus() {
  const response = await fetch('/api/v1/consents/status', {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) throw new Error('SESSION_EXPIRED');
  if (!response.ok) throw new Error('CONSENT_STATUS_UNAVAILABLE');
  return consentStatusSchema.parse(await response.json());
}

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch {
    return value;
  }
}

/**
 * Consent gate screen: shown while the versioned documents (Terms of Use, Privacy
 * Policy and minimum-age declaration) for the current user are not yet accepted. No
 * checkbox starts checked and the acceptance only happens through the explicit button
 * action, after a successful API response.
 */
export function ConsentScreen() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['consent-status'],
    queryFn: loadConsentStatus,
    retry: false,
  });
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const documents = status.data?.documents ?? [];
  const allChecked = documents.length > 0 && documents.every((document) => checked[document.type]);
  const sessionExpired = status.isError && (status.error as Error).message === 'SESSION_EXPIRED';
  async function submit() {
    if (!allChecked) return;
    setPhase('saving');
    setError(null);
    const response = await fetch('/api/v1/consents/accept', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documents: documents.map((document) => ({ type: document.type })) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    setPhase('idle');
    if (!response) {
      setError('Não foi possível conectar. Verifique sua conexão e tente novamente.');
      return;
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setError('Sua sessão expirou. Saia e entre novamente para continuar.');
        return;
      }
      const parsed = apiErrorSchema.safeParse(body);
      setError(
        parsed.success
          ? parsed.data.error.message
          : 'Não foi possível registrar o aceite. Tente novamente.',
      );
      return;
    }
    // Success: the session query is revalidated and the private app loads.
    await client.invalidateQueries({ queryKey: ['owner-session'] });
  }
  async function signOut() {
    setSigningOut(true);
    try {
      await authAction('sign-out');
    } catch {
      // Signing out is best-effort here; the local state is cleared regardless.
    }
    client.clear();
    window.location.assign('/');
  }
  if (status.isPending)
    return (
      <p className="access-note" role="status">
        Carregando documentos…
      </p>
    );
  if (status.isError)
    return (
      <div className="owner-access">
        <p role="alert">
          {sessionExpired
            ? 'Sua sessão expirou. Saia e entre novamente para continuar.'
            : 'Não foi possível carregar os documentos. Tente novamente.'}
        </p>
        {sessionExpired ? (
          <button className="retry-button" disabled={signingOut} onClick={() => void signOut()}>
            {signingOut ? 'Saindo…' : 'Sair e entrar novamente'}
          </button>
        ) : (
          <button
            className="retry-button"
            onClick={() => {
              void status.refetch();
            }}
          >
            Tentar novamente
          </button>
        )}
      </div>
    );
  return (
    <div className="owner-access">
      <p className="owner-greeting">Antes de continuar.</p>
      <p>
        Para acessar sua conta e seus dados, leia e aceite os documentos abaixo. O acesso fica
        bloqueado até o aceite de todas as versões vigentes.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <form
        className="consent-form"
        aria-busy={phase === 'saving'}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="consent-fieldset">
          <legend>Documentos obrigatórios</legend>
          {documents.map((document) => (
            <div className="consent-document" key={document.type}>
              <label className="consent-check">
                <input
                  type="checkbox"
                  checked={checked[document.type] ?? false}
                  onChange={(event) =>
                    setChecked((current) => ({
                      ...current,
                      [document.type]: event.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>{document.title}</strong>
                  <span className="consent-meta">
                    Versão {document.version} · Vigência {formatDate(document.effectiveAt)}
                  </span>
                </span>
              </label>
              <p className="consent-summary">{document.summary}</p>
              {document.stale ? (
                <p className="consent-warning">
                  Você aceitou uma versão anterior deste documento. É necessário aceitar a versão
                  vigente.
                </p>
              ) : null}
              {document.integrity === 'changed' ? (
                <p className="consent-warning">
                  Este documento foi alterado e precisa de uma nova publicação antes do aceite.
                  Contate o suporte do beta.
                </p>
              ) : null}
              <a
                className="consent-link"
                href={document.textUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Ler na íntegra
              </a>
            </div>
          ))}
        </fieldset>
        <button className="retry-button" type="submit" disabled={!allChecked || phase === 'saving'}>
          {phase === 'saving' ? 'Registrando…' : 'Aceitar e continuar'}
        </button>
      </form>
      <button className="link-button" disabled={signingOut} onClick={() => void signOut()}>
        {signingOut ? 'Saindo…' : 'Recusar e sair'}
      </button>
    </div>
  );
}
