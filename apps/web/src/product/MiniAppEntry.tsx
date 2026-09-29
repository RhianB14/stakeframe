import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { telegramSessionSchema } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { ApiFailure, request } from './api.js';
import { readTelegramInitData } from './miniapp-auth.js';
import { setMiniAppInitData } from './miniapp-session.js';
import { setSensitiveSurface } from '../lib/telemetry.js';
import { ProductApp } from './ProductApp.js';
import './product.css';

/**
 * STK-F2-12 — porta de entrada do Mini App do Telegram.
 *
 * Este arquivo é a INTEGRAÇÃO, não um produto: ele resolve a credencial do
 * Telegram e entrega o `ProductApp` — o MESMO componente da web — na variante
 * `mini`. Toda a regra (quatro fluxos, formulários, confirmação financeira,
 * idempotência, isolamento de organização) continua no componente
 * compartilhado, para que o Telegram e a web nunca divirjam nem tenham duas
 * versões da mesma tela.
 *
 * O SDK do Telegram é carregado como script oficial, e o `initData` é lido de
 * duas fontes: `WebApp.initData` (clientes nativos) e o fragmento
 * `tgWebAppData` (Web Telegram, que entrega o valor no handoff). Ambos são
 * CREDENCIAIS OPACAS — o cliente não decodifica, não confere e não decide
 * nada. O servidor valida o HMAC e resolve o vínculo. Sem o valor, a tela diz
 * para abrir pelo botão do aplicativo, em vez de inventar uma sessão.
 *
 * Nada é persistido: sem service worker, sem cache, sem fila offline (§6.2
 * rejeita) e sem guardar o initData em storage. Sem rede, o usuário recebe um
 * erro com "Tentar novamente" — nunca uma confirmação presumida.
 */
const scriptAttribute = 'data-stakeframe-telegram-webapp';
const scriptSource = 'https://telegram.org/js/telegram-web-app.js';

export function MiniApp() {
  // STK-F1-10: o Mini App manipula bilhetes e saldos — superfície sensível
  // permanente, nunca gravada pelo replay de telemetria.
  useEffect(() => {
    setSensitiveSurface('miniapp', true);
    return () => setSensitiveSurface('miniapp', false);
  }, []);
  const [initData, setInitData] = useState(() => readTelegramInitData());

  useEffect(() => {
    // A credencial vale para TODAS as chamadas da tela, inclusive as dos
    // componentes reutilizados da web, que não sabem que estão no Telegram.
    setMiniAppInitData(initData || null);
    return () => setMiniAppInitData(null);
  }, [initData]);

  useEffect(() => {
    const sync = () => {
      const current = readTelegramInitData();
      if (current) setInitData(current);
    };
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready?.();
      window.Telegram.WebApp.expand?.();
      sync();
      return;
    }
    // O SDK é progressivo: se ele demorar, a primeira requisição autenticada
    // ainda usa o `tgWebAppData` do handoff, e a tela não fica bloqueada.
    let script = document.querySelector<HTMLScriptElement>(`script[${scriptAttribute}]`);
    const onLoad = () => {
      window.Telegram?.WebApp?.ready?.();
      sync();
    };
    if (!script) {
      script = document.createElement('script');
      script.src = scriptSource;
      script.async = true;
      script.setAttribute(scriptAttribute, 'true');
      document.head.appendChild(script);
    }
    script.addEventListener('load', onLoad);
    sync();
    return () => script?.removeEventListener('load', onLoad);
  }, []);

  // Confere o estado do vínculo antes de montar qualquer produto: assim a tela
  // distingue "conta sem vínculo" (orientar para o site) de erro de transporte,
  // e nenhum dado de produto aparece para uma conta ainda não reconhecida.
  const session = useQuery({
    queryKey: ['miniapp', 'session', initData ? 'present' : 'absent'],
    enabled: Boolean(initData),
    queryFn: () =>
      request('/api/v1/telegram/session', telegramSessionSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData }),
      }),
    staleTime: 60_000,
    retry: false,
  });

  if (!initData)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="alert">Abra pelo botão do aplicativo no Telegram para continuar.</p>
      </div>
    );
  if (session.isError)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="alert">
          {session.error instanceof ApiFailure && session.error.status === 403
            ? 'Esta conta do Telegram ainda não está vinculada. Abra o site, entre na sua conta e use "Vincular Telegram" em Configurações.'
            : 'Não foi possível conferir sua conta agora. Tente novamente.'}
        </p>
        <Button onClick={() => void session.refetch()}>Tentar novamente</Button>
      </div>
    );
  if (!session.data)
    return (
      <div className="product-loading">
        <h1>Stakeframe</h1>
        <p role="status">Conferindo sua conta…</p>
      </div>
    );

  // `userId` é o identificador interno do titular resolvido pelo vínculo — o
  // mesmo que a web entrega ao navegador dele. Reutilizá-lo mantém a
  // identificação pseudônima de telemetria e a chave da operação financeira
  // pendente idênticas nas duas superfícies.
  return <ProductApp variant="mini" owner={{ id: session.data.userId, name: 'Sua conta' }} />;
}
