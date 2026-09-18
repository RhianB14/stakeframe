import { useQuery } from '@tanstack/react-query';
import { importDetailSchema } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import {
  request,
  patchImportDraft,
  setImportStatus,
  applyImportBookmaker,
  applyImportOrigin,
  applyImportEvent,
} from './api.js';
import { DraftControls } from './drafts.js';
import { BookmakerSection, StatusSection } from './MiniAppSections.js';

// STK-G0-19-R5 — Mini App do Telegram: a mesma fonte canônica, autenticada pelo
// initData validado no servidor (x-telegram-init-data). Nenhum identificador
// Telegram é exibido; a edição viaja pelo backend, nunca direto entre Telegram e web.

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void } };
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
const sectionParam = (): 'status' | 'bookmaker' | null => {
  const value = hashParam('section');
  return value === 'status' || value === 'bookmaker' ? value : null;
};

export function MiniAppPage() {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const id = importId() ?? '';
  const detail = useQuery({
    queryKey: ['miniapp', id],
    enabled: Boolean(initData && id),
    retry: false,
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
  const section = sectionParam();
  return (
    <div className="miniapp-page">
      <h1>
        {section === 'status'
          ? 'Alterar status'
          : section === 'bookmaker'
            ? 'Alterar casa'
            : 'Conferir importação'}
      </h1>
      <p className="caption-evidence">{detail.data.item.caption || 'Sem legenda'}</p>
      {section === 'status' ? (
        <StatusSection
          detail={detail.data}
          sender={(body) => setImportStatus(id, body, initData)}
          onSaved={() => void detail.refetch()}
        />
      ) : section === 'bookmaker' ? (
        <BookmakerSection
          detail={detail.data}
          sender={(body) => applyImportBookmaker(id, body, initData)}
          onSaved={() => void detail.refetch()}
        />
      ) : (
        <DraftControls
          detail={detail.data}
          sender={(body) => patchImportDraft(id, body, initData)}
          originSender={(body) => applyImportOrigin(id, body, initData)}
          eventSender={(body) => applyImportEvent(id, body, initData)}
          onSaved={() => void detail.refetch()}
        />
      )}
    </div>
  );
}
