import { useQuery } from '@tanstack/react-query';
import { systemStatusSchema } from '@stakeframe/shared';

async function loadStatus() {
  const response = await fetch('/api/v1/system/status', { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Status unavailable');
  return systemStatusSchema.parse(await response.json());
}

export function App() {
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: loadStatus,
    refetchInterval: 15_000,
  });
  const online = !status.isError && status.data?.database === 'available';
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
          <span className="tiny-dot" /> Ambiente local
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
              <strong>O acesso privado será habilitado em uma próxima etapa.</strong>
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
            Este ambiente é exclusivo para desenvolvimento. Nenhuma aposta ou saldo foi cadastrado.
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
          Stakeframe <span className="footer-divider">/</span> Desenvolvimento
        </span>
      </footer>
    </div>
  );
}
