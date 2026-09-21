import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { importDetailSchema } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import {
  ApiFailure,
  request,
  patchImportDraft,
  setImportStatus,
  applyImportBookmaker,
  applyImportTipster,
  applyImportOrigin,
  applyImportEvent,
  getImportCredits,
} from './api.js';
import { DraftControls } from './drafts.js';
import {
  BookmakerSection,
  CashoutSection,
  StatusSection,
  TipsterSection,
} from './MiniAppSections.js';
import { readTelegramInitData } from './miniapp-auth.js';
import './product.css';

// STK-G0-19-R5 — Mini App do Telegram: a mesma fonte canônica, autenticada pelo
// initData validado no servidor (x-telegram-init-data). Nenhum identificador
// Telegram é exibido; a edição viaja pelo backend, nunca direto entre Telegram e web.

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        close?: () => void;
        HapticFeedback?: {
          notificationOccurred?: (type: 'success' | 'error' | 'warning') => void;
        };
      };
    };
  }
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

// O identificador e a seção chegam pelo link do botão da mensagem
// (`#miniapp?import=<uuid>&section=status|bookmaker`), dentro do fragmento da
// rota — nunca em window.location.search.
function hashParam(name: string): string | null {
  try {
    const hash = window.location.hash;
    const index = hash.indexOf('?');
    return new URLSearchParams(index >= 0 ? hash.slice(index) : '').get(name);
  } catch {
    return null;
  }
}
const importId = () => hashParam('import');
const sectionParam = (): 'status' | 'bookmaker' | 'tipster' | 'cashout' | null => {
  const value = hashParam('section');
  return value === 'status' || value === 'bookmaker' || value === 'tipster' || value === 'cashout'
    ? value
    : null;
};

export function MiniAppPage() {
  const [initData, setInitData] = useState(() => readTelegramInitData());
  const [feedback, setFeedback] = useState<'syncing' | 'success' | null>(null);
  useEffect(() => {
    const syncInitData = () => setInitData(readTelegramInitData());
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready?.();
      syncInitData();
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(
      'script[data-stakeframe-telegram-webapp="true"]',
    );
    const onLoad = () => {
      window.Telegram?.WebApp?.ready?.();
      syncInitData();
    };
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-web-app.js';
      script.async = true;
      script.dataset.stakeframeTelegramWebapp = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', onLoad);
    // Start immediately from tgWebAppData when available; the SDK remains a
    // progressive enhancement instead of blocking the first authenticated GET.
    syncInitData();
    return () => script?.removeEventListener('load', onLoad);
  }, []);
  const id = importId() ?? '';
  const detail = useQuery({
    queryKey: ['miniapp', id],
    enabled: Boolean(initData && id),
    retry: (_failureCount, failure) => failure instanceof ApiFailure && failure.status === 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      request(`/api/v1/imports/${id}`, importDetailSchema, {
        headers: { 'x-telegram-init-data': initData },
      }),
  });
  const completeSave = async (version: number) => {
    setFeedback('syncing');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const fresh = await request(`/api/v1/imports/${id}`, importDetailSchema, {
        headers: { 'x-telegram-init-data': initData },
      });
      if (
        fresh.telegramSyncState === 'deleted' ||
        (fresh.telegramSyncState === 'synced' && (fresh.telegramSyncedVersion ?? 0) >= version)
      ) {
        setFeedback('success');
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('success');
        await wait(1_350);
        window.Telegram?.WebApp?.close?.();
        await detail.refetch();
        return;
      }
      if (fresh.telegramSyncState === 'failed') {
        setFeedback(null);
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('error');
        throw new Error(
          'Os dados foram salvos, mas o Telegram ainda não conseguiu atualizar a mensagem. Tente novamente.',
        );
      }
      await wait(400);
    }
    setFeedback(null);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.('warning');
    throw new Error(
      'Os dados foram salvos, mas a confirmação do Telegram demorou mais que o esperado. A tela foi mantida aberta.',
    );
  };
  if (!initData)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="status">Abra esta tela pelo Telegram para conferir a importação.</p>
      </div>
    );
  if (!id)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="alert">Link sem identificação da importação. Abra pelo botão da mensagem.</p>
      </div>
    );
  if (detail.isError)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="alert">
          Não foi possível carregar a importação. Confirme que você abriu o link pela mensagem do
          bot.
        </p>
        <Button onClick={() => void detail.refetch()}>Tentar novamente</Button>
      </div>
    );
  if (!detail.data)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="status">Carregando a importação…</p>
      </div>
    );
  const section = sectionParam();
  return (
    <div className="miniapp-page">
      <header className="miniapp-heading">
        <span>Stakeframe · Mini App do Telegram</span>
        <h1>
          {section === 'status'
            ? 'Alterar status'
            : section === 'bookmaker'
              ? 'Alterar casa'
              : section === 'tipster'
                ? 'Alterar tipster'
                : section === 'cashout'
                  ? 'Cashout'
                  : 'Editar aposta'}
        </h1>
        <p>
          {section
            ? 'Confira a operação antes de confirmar.'
            : 'Confira e ajuste os dados antes de salvar.'}
        </p>
      </header>
      {detail.data.item.caption ? (
        <details className="mini-caption-evidence">
          <summary>Legenda original do Telegram</summary>
          <p>{detail.data.item.caption}</p>
        </details>
      ) : null}
      {section === 'status' ? (
        <StatusSection
          detail={detail.data}
          sender={(body) => setImportStatus(id, body, initData)}
          onSaved={completeSave}
        />
      ) : section === 'bookmaker' ? (
        <BookmakerSection
          detail={detail.data}
          sender={(body) => applyImportBookmaker(id, body, initData)}
          creditsSender={(bookmakerId) =>
            getImportCredits(id, bookmakerId, initData).then((result) => result.credits)
          }
          onSaved={completeSave}
        />
      ) : section === 'tipster' ? (
        <TipsterSection
          detail={detail.data}
          sender={(body) => applyImportTipster(id, body, initData)}
          onSaved={completeSave}
        />
      ) : section === 'cashout' ? (
        <CashoutSection
          detail={detail.data}
          sender={(body) => setImportStatus(id, body, initData)}
          onSaved={completeSave}
        />
      ) : (
        <DraftControls
          mini
          detail={detail.data}
          sender={(body) => patchImportDraft(id, body, initData)}
          originSender={(body) => applyImportOrigin(id, body, initData)}
          eventSender={(body) => applyImportEvent(id, body, initData)}
          creditsSender={(bookmakerId) =>
            getImportCredits(id, bookmakerId, initData).then((result) => result.credits)
          }
          onSaved={completeSave}
        />
      )}
      {feedback ? (
        <div className="mini-feedback-layer" role="presentation">
          <div className="mini-feedback" role="alertdialog" aria-live="assertive">
            <span className="mini-feedback-icon" aria-hidden="true">
              {feedback === 'success' ? '✓' : <span className="mini-spinner" />}
            </span>
            <div>
              <h2>{feedback === 'success' ? 'Alterações salvas' : 'Atualizando Telegram…'}</h2>
              <p>
                {feedback === 'success'
                  ? 'A mensagem do Telegram foi atualizada.'
                  : 'Aguarde a confirmação da mensagem antes de fechar.'}
              </p>
              {feedback === 'success' ? <small>Fechando…</small> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
