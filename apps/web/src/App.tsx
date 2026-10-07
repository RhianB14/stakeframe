import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { systemStatusSchema } from '@stakeframe/shared';
import { OwnerAccess, loadOwner } from './OwnerAccess.js';
import { InviteAccess } from './InviteAccess.js';
import { PasswordResetGate } from './PasswordReset.js';
import { ConsentScreen } from './ConsentScreen.js';
import { ProductApp } from './product/ProductApp.js';
import { MiniAppPage } from './product/MiniApp.js';
import { MiniApp } from './product/MiniAppEntry.js';
import { AdminPanel } from './admin/AdminPanel.js';
import './product/tokens.css';

async function loadStatus() {
  const response = await fetch('/api/v1/system/status', { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Status unavailable');
  return systemStatusSchema.parse(await response.json());
}

export function App() {
  const client = useQueryClient();
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  // The reset token is captured once per page load; the URL is cleaned afterwards so a
  // refresh never replays the form with a consumed link.
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  useEffect(() => {
    if (resetToken) window.history.replaceState(null, '', window.location.pathname);
  }, [resetToken]);
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: loadStatus,
    refetchInterval: 15_000,
  });
  const online = !status.isError && status.data?.database === 'available';
  // STK-F2-12 — o Mini App é autenticado pelo initData, não por cookie: a
  // consulta de sessão do navegador não tem o que resolver ali e só geraria
  // um 401 a cada 30 s. Fica desligada nessa superfície.
  const miniApp =
    window.location.pathname === '/miniapp' || window.location.hash.startsWith('#miniapp');
  const owner = useQuery({
    queryKey: ['owner-session'],
    queryFn: loadOwner,
    enabled: !miniApp && status.data?.authentication === 'google',
    retry: false,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    const expired = () => {
      client.setQueryData(['owner-session'], null);
      client.removeQueries({ queryKey: ['product'] });
    };
    window.addEventListener('stakeframe:session-expired', expired);
    return () => window.removeEventListener('stakeframe:session-expired', expired);
  }, [client]);
  /* STK-F3-04 — um 401 de rota de recurso é SUSPEITA, não prova: a rota pode
     estar bloqueada por produto. A confirmação é o `/me`, que é a fonte de
     identidade — e é o mesmo caminho que já trata a sessão perdida: um 401
     aqui devolve `null` de `loadOwner`, e o efeito logo abaixo já limpa o
     produto nesse caso.

     Por que refetch e não esperar o intervalo: o `refetchInterval` do dono é de
     30 s, e uma sessão que cai no meio da leitura só sairia da tela 30 s depois
     — ou nunca, se a tela já não estiver mais pedindo. Confirmar na hora custa
     UM request por suspeita, não um por segundo: o `/me` só é reconsultado
     quando alguma rota já respondeu 401. */
  useEffect(() => {
    if (miniApp) return;
    const suspected = () => {
      void owner.refetch();
    };
    window.addEventListener('stakeframe:session-suspected', suspected);
    return () => window.removeEventListener('stakeframe:session-suspected', suspected);
  }, [miniApp, owner]);
  // STK-F2-12 — e o cache do produto nunca é descartado por causa da sessão do
  // navegador nessa tela: a identidade vem do vínculo do Telegram, e um 401 de
  // cookie (que não existe ali) não significa sessão de produto perdida.
  useEffect(() => {
    if (miniApp) return;
    if (owner.isError || owner.data === null) client.removeQueries({ queryKey: ['product'] });
  }, [client, miniApp, owner.isError, owner.data]);
  const session = owner.data && owner.data !== 'consent-required' ? owner.data : null;
  // STK-G0-19-R5 — o editor de importação continua no seu endereço: o botão da
  // mensagem do Telegram abre `#miniapp?import=<uuid>`, e essa tela é a de UMA
  // importação específica.
  // STK-F2-12 — o Mini App em si (painel, apostas, pendentes e ajustes) é a web
  // responsiva dentro do Telegram, em `/miniapp`. Os dois cohabitam: o deep link
  // da mensagem continua abrindo o editor pontual, e o menu do bot abre o
  // produto completo.
  //
  // A distinção é feita pelo PARÂMETRO `import`, não pelo prefixo do hash: a
  // rota `/miniapp` sem hash é o produto de bolso, e `#miniapp` sem `import`
  // também — só o deep link da mensagem (que sempre traz `import`) é o editor.
  const deepLink = window.location.hash;
  if (window.location.pathname === '/miniapp' || deepLink.startsWith('#miniapp')) {
    if (deepLink.includes('import=')) return <MiniAppPage />;
    return <MiniApp />;
  }
  // STK-F2-11 — o painel interno é uma superfície separada e só é montada para
  // uma sessão `superadmin`. Qualquer outro papel segue o fluxo normal: sem tela
  // de acesso negado, sem URLs adivinháveis que confirmem a existência do painel.
  if (window.location.pathname === '/admin' && session?.organization.role === 'superadmin')
    return <AdminPanel />;
  if (status.data?.productEnabled && session && !owner.isError) {
    return <ProductApp owner={session.user} release={status.data?.release} />;
  }
  const production = status.data?.stage === 'production-setup';
  const releaseVersion = status.data?.release.version;
  const releaseLabel =
    releaseVersion && releaseVersion !== 'unversioned' ? ` · v${releaseVersion}` : '';
  const connectionLabel = status.isPending
    ? 'Verificando conexão'
    : status.isError
      ? 'Serviço indisponível'
      : online
        ? 'Conexão estabelecida'
        : 'Banco indisponível';
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Stakeframe, início">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 4h19v7H14v4h12v13H6v-7h13v-3H7z" fill="currentColor" />
          </svg>
          <span>
            stakeframe<span className="brand-dot">.</span>
          </span>
        </a>
        <span className="local-label">
          <span className="tiny-dot" /> {production ? 'Acesso privado' : 'Ambiente local'}
        </span>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">CLAREZA PARA CADA MOVIMENTO</p>
          <h1 id="page-title">
            Sua banca,
            <br />
            <span>em perspectiva.</span>
          </h1>
          <p className="lead">
            Um espaço pessoal para organizar suas apostas e acompanhar seus resultados com
            confiança.
          </p>
          <div className="preparation-note">
            <span className="note-line" />
            <p>
              Estamos preparando seu espaço.
              <br />
              <strong>
                {status.data?.authentication === 'google'
                  ? 'Entre com sua conta Google autorizada.'
                  : 'O acesso privado será habilitado em uma próxima etapa.'}
              </strong>
            </p>
          </div>
          <div className="principles">
            <span>Seus registros</span>
            <span>Sua organização</span>
            <span>Seu controle</span>
          </div>
        </section>
        <section className="setup-card" aria-labelledby="setup-title">
          <div className="card-top">
            <span className="card-kicker">STAKEFRAME / SETUP</span>
            <span className="stage-label">M0</span>
          </div>
          <div className="frame-art" aria-hidden="true">
            <div className="frame frame-one" />
            <div className="frame frame-two" />
            <div className="frame frame-three" />
            <span className="frame-center">S</span>
          </div>
          <h2 id="setup-title">A base está tomando forma.</h2>
          <p className="card-description">
            {production
              ? 'Seu acesso está preparado. As funcionalidades estão em construção.'
              : 'Este ambiente é exclusivo para desenvolvimento. Nenhuma aposta ou saldo foi cadastrado.'}
          </p>
          <div className="connection" role="status">
            <span className={`connection-dot ${online ? 'online' : ''}`} />
            <span>{connectionLabel}</span>
            {status.isFetching && !status.isPending ? (
              <span className="updating">Atualizando</span>
            ) : null}
          </div>
          {status.isError ? (
            <button
              className="retry-button"
              disabled={status.isFetching}
              onClick={() => {
                void status.refetch();
              }}
            >
              Tentar novamente <span aria-hidden="true">↗</span>
            </button>
          ) : status.data?.authentication === 'google' ? (
            resetToken ? (
              <PasswordResetGate token={resetToken} />
            ) : inviteToken ? (
              <InviteAccess token={inviteToken} />
            ) : owner.data === 'consent-required' ? (
              <ConsentScreen />
            ) : (
              <OwnerAccess />
            )
          ) : (
            <div className="access-note">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d="M6 9V6a4 4 0 0 1 8 0v3M5 9h10v8H5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              <span>Acesso com Google em preparação</span>
            </div>
          )}
        </section>
      </main>
      <footer>
        <span>Feito para acompanhar, com calma.</span>
        <span>
          Stakeframe <span className="footer-divider">/</span>{' '}
          {production ? 'Seu espaço' : 'Desenvolvimento'}
          {releaseLabel}
        </span>
      </footer>
    </div>
  );
}
