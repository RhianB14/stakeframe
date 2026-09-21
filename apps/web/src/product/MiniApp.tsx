import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { importDetailSchema } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import {
  ApiFailure,
  request,
  patchImportDraft,
  confirmImport,
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

// STK-G0-19-R5 — Mini App do Telegram: a mesma fonte canônica, autenticada pelo
// initData validado no servidor (x-telegram-init-data). Nenhum identificador
// Telegram é exibido; a edição viaja pelo backend, nunca direto entre Telegram e web.

declare global {
  interface Window {
    Telegram?: {
      WebApp?: { initData?: string; ready?: () => void; close?: () => void };
    };
  }
}

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
  // Telegram only closes the WebApp after the user has had time to see the
  // success feedback. In a normal browser `close` is absent, so the same
  // flow remains usable during local development and automated tests.
  const onSaved = () => {
    void detail.refetch();
    window.setTimeout(() => window.Telegram?.WebApp?.close?.(), 1_200);
  };
  // A draft save must remain on-screen so the owner can perform the explicit
  // financial confirmation in the same Mini App. Other actions keep the
  // existing close-after-feedback behavior.
  const onDraftSaved = () => {
    void detail.refetch();
  };
  const section = sectionParam();
  return (
    <div className="miniapp-page">
      <h1>
        {section === 'status'
          ? 'Alterar status'
          : section === 'bookmaker'
            ? 'Alterar casa'
            : section === 'tipster'
              ? 'Alterar tipster'
              : section === 'cashout'
                ? 'Cashout'
                : 'Conferir importação'}
      </h1>
      <p className="caption-evidence">{detail.data.item.caption || 'Sem legenda'}</p>
      {section === 'status' ? (
        <StatusSection
          detail={detail.data}
          sender={(body) => setImportStatus(id, body, initData)}
          onSaved={onSaved}
        />
      ) : section === 'bookmaker' ? (
        <BookmakerSection
          detail={detail.data}
          sender={(body) => applyImportBookmaker(id, body, initData)}
          creditsSender={(bookmakerId) =>
            getImportCredits(id, bookmakerId, initData).then((result) => result.credits)
          }
          onSaved={onSaved}
        />
      ) : section === 'tipster' ? (
        <TipsterSection
          detail={detail.data}
          sender={(body) => applyImportTipster(id, body, initData)}
          onSaved={onSaved}
        />
      ) : section === 'cashout' ? (
        <CashoutSection
          detail={detail.data}
          sender={(body) => setImportStatus(id, body, initData)}
          onSaved={onSaved}
        />
      ) : (
        <>
          <DraftControls
            detail={detail.data}
            sender={(body) => patchImportDraft(id, body, initData)}
            originSender={(body) => applyImportOrigin(id, body, initData)}
            eventSender={(body) => applyImportEvent(id, body, initData)}
            creditsSender={(bookmakerId) =>
              getImportCredits(id, bookmakerId, initData).then((result) => result.credits)
            }
            confirmSender={(body) => confirmImport(id, body, initData)}
            onConfirmed={onSaved}
            onSaved={onDraftSaved}
          />
          {detail.data.bet ? (
            <StatusSection
              detail={detail.data}
              sender={(body) => setImportStatus(id, body, initData)}
              onSaved={onSaved}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
