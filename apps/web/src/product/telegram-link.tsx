import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  telegramLinkRequestResultSchema,
  telegramLinkStateResultSchema,
  telegramLinkStatusSchema,
  type TelegramLinkStatus,
} from '@stakeframe/shared';
import { request, ApiFailure } from './api.js';
import { Button } from '../components/ui/button.js';

/**
 * Vínculo com a conta do Telegram (STK-F2-04).
 *
 * O servidor é a autoridade: o cliente apenas pede um deep link de uso único
 * (cinco minutos), mostra o botão para abrir o Telegram e confirma o token
 * devolvido pelo deep link. A conta nunca é escolhida aqui — quem decide é o
 * Telegram, e a unicidade global é garantida no banco.
 *
 * O token vive na memória do navegador apenas enquanto a tela está aberta: é
 * um segredo de uso único e curta duração, nunca persistido em storage nem
 * enviado para telemetria.
 */
const CONFIRMATION_STORAGE_KEY = 'stakeframe.telegram-link-token';

function message(error: unknown, fallback: string) {
  return error instanceof ApiFailure ? error.message : fallback;
}

export function TelegramLinkPanel() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['product', 'telegram-link'],
    queryFn: () => request('/api/v1/telegram/link', telegramLinkStatusSchema),
  });
  const [pending, setPending] = useState<{ url: string; seconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Token trazido pelo deep link (`#telegram=...` ou querystring) ou guardado
  // nesta aba quando o usuário volta do Telegram pela mesma aba.
  const [token] = useState(() => {
    const search = new URLSearchParams(location.search.slice(1));
    const fromUrl = search.get('telegram');
    if (fromUrl) {
      history.replaceState(null, '', location.pathname + location.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(CONFIRMATION_STORAGE_KEY);
  });

  async function generate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const issued = await request('/api/v1/telegram/link', telegramLinkRequestResultSchema, {
        method: 'POST',
      });
      setPending({ url: issued.deepLink, seconds: issued.expiresInSeconds });
      setNotice('Abra o link no Telegram e, em seguida, confirme aqui.');
    } catch (reason) {
      setError(message(reason, 'Não foi possível gerar o link. Tente novamente.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await request('/api/v1/telegram/link/confirm', telegramLinkStateResultSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      // Uso único: o token deixa de existir no navegador assim que é consumido.
      sessionStorage.removeItem(CONFIRMATION_STORAGE_KEY);
      setPending(null);
      setNotice('Conta do Telegram vinculada. O envio de bilhetes está ativo.');
      await client.invalidateQueries({ queryKey: ['product', 'telegram-link'] });
    } catch (reason) {
      sessionStorage.removeItem(CONFIRMATION_STORAGE_KEY);
      setError(message(reason, 'Não foi possível confirmar o vínculo. Gere um novo link.'));
      setPending(null);
      await client.invalidateQueries({ queryKey: ['product', 'telegram-link'] });
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await request('/api/v1/telegram/link', telegramLinkStateResultSchema, { method: 'DELETE' });
      setNotice('Vínculo revogado. Nenhuma conta do Telegram está conectada.');
      await client.invalidateQueries({ queryKey: ['product', 'telegram-link'] });
    } catch (reason) {
      setError(message(reason, 'Não foi possível revogar o vínculo. Tente novamente.'));
    } finally {
      setBusy(false);
    }
  }

  if (status.isPending)
    return (
      <div className="panel" aria-busy="true">
        <div className="section-heading">
          <h2>Telegram</h2>
        </div>
        <p className="muted" role="status">
          Carregando sua conta conectada…
        </p>
      </div>
    );

  return (
    <section className="panel" aria-labelledby="telegram-link-title">
      <div className="section-heading">
        <div>
          <h2 id="telegram-link-title">Telegram</h2>
          <p className="muted">
            Envie bilhetes pelo Telegram. Uma conta por pessoa, com confirmação aqui no site.
          </p>
        </div>
      </div>
      <TelegramLinkState status={status.data} />
      {status.isError ? (
        <p role="alert" className="form-error">
          Não foi possível consultar sua conta do Telegram.
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="button-row">
          <a className="ui-button ui-button-primary" href={pending.url} rel="noreferrer">
            Abrir no Telegram
          </a>
          <Button variant="secondary" onClick={() => void generate()} disabled={busy}>
            Gerar outro link
          </Button>
        </div>
      ) : null}
      <div className="form-actions">
        {status.data?.linked ? (
          <>
            <Button variant="secondary" onClick={() => void generate()} disabled={busy}>
              {busy ? 'Processando…' : 'Trocar de conta'}
            </Button>
            <Button variant="ghost" onClick={() => void revoke()} disabled={busy}>
              Revogar vínculo
            </Button>
          </>
        ) : token ? (
          <>
            <Button onClick={() => void confirm()} disabled={busy}>
              {busy ? 'Confirmando…' : 'Confirmar vínculo'}
            </Button>
            <Button variant="secondary" onClick={() => void generate()} disabled={busy}>
              Gerar novo link
            </Button>
          </>
        ) : (
          <Button onClick={() => void generate()} disabled={busy}>
            {busy ? 'Gerando…' : 'Conectar Telegram'}
          </Button>
        )}
      </div>
    </section>
  );
}

function TelegramLinkState({ status }: { status: TelegramLinkStatus | undefined }) {
  if (!status) return null;
  if (status.linked)
    return (
      <p className="notice" role="status">
        Conta do Telegram conectada
        {status.linkedAt ? ` em ${new Date(status.linkedAt).toLocaleString('pt-BR')}` : ''}.
      </p>
    );
  return (
    <p className="muted" role="status">
      Nenhuma conta do Telegram conectada. O link vale por cinco minutos e só pode ser usado uma
      vez.
    </p>
  );
}

/** Guarda o token para o caso de o usuário voltar do Telegram pela mesma aba. */
export function rememberTelegramLinkToken(token: string | null) {
  if (token) sessionStorage.setItem(CONFIRMATION_STORAGE_KEY, token);
  else sessionStorage.removeItem(CONFIRMATION_STORAGE_KEY);
}
