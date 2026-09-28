// STK-F2-11 — painel interno mínimo do superadmin (Plano Master §7.2).
//
// Página isolada em `/admin`, FORA do shell de produto: nada do dashboard, das
// apostas, das finanças ou do calendário é montado aqui, e a página nunca
// recebe sessão — quem não tem papel `superadmin` recebe 404 do servidor, não
// uma tela de "acesso negado". Uma tela de erro existiria e confirmaria a
// existência da superfície interna.
//
// Conteúdo estritamente de METADADOS: rótulo da conta, papel, estado de
// onboarding/consentimento/exclusão, contagens de fila, cota de IA, flags e
// códigos de erro. Nenhum valor financeiro, aposta, nome de usuário, e-mail,
// imagem ou texto de erro. O painel é de leitura — não há botão que mude
// qualquer dado, e não existe impersonação (Plano §7.2).

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  adminAccountsSchema,
  adminAuditTrailSchema,
  adminErrorsSchema,
  adminFlagsSchema,
  adminUsageSchema,
  type AdminPanelView,
} from '@stakeframe/shared';
import { request } from '../product/api.js';
import '../product/product.css';

const VIEWS: { id: AdminPanelView; title: string; hint: string }[] = [
  { id: 'accounts', title: 'Contas', hint: 'Metadados de cada organização e seu membro' },
  { id: 'usage', title: 'Uso', hint: 'Cotas do provedor e contagens de fila' },
  { id: 'flags', title: 'Flags', hint: 'Rollout e toggles configurados no processo' },
  { id: 'errors', title: 'Erros', hint: 'Falhas recentes por código, sem mensagem' },
  { id: 'audit', title: 'Auditoria', hint: 'Acessos permitidos e recusados a este painel' },
];

const instant = (value: string | null) =>
  value === null
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value));
const day = (value: string | null) => (value === null ? '—' : value.slice(0, 10));
const stateLabels: Record<string, string> = {
  ready: 'Dentro do limite',
  warning: 'Perto do limite',
  exhausted: 'Limite atingido',
  pending: 'Exclusão solicitada',
  cancelled: 'Exclusão cancelada',
  purged: 'Conta eliminada',
};

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="admin-panel" aria-label={title}>
      <div className="admin-panel-head">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Accounts() {
  const accounts = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: () => request('/api/v1/admin/accounts?limit=50', adminAccountsSchema),
  });
  if (accounts.isError)
    return (
      <p role="alert" className="muted">
        Não foi possível carregar as contas.
      </p>
    );
  if (!accounts.data) return <p role="status">Carregando contas…</p>;
  return (
    <>
      <p className="muted">
        {accounts.data.total} organização(ões)
        {accounts.data.truncated ? ' · lista truncada' : ''}
      </p>
      {accounts.data.accounts.length === 0 ? (
        <p className="muted">Nenhuma conta registrada.</p>
      ) : (
        <div className="table-scroll">
          <table className="product-table">
            <caption className="sr-only">Metadados das contas</caption>
            <thead>
              <tr>
                <th>Conta</th>
                <th>Papel</th>
                <th>Onboarding</th>
                <th>Consentimentos</th>
                <th>Exclusão</th>
                <th>Sessões ativas</th>
                <th>Último acesso</th>
              </tr>
            </thead>
            <tbody>
              {accounts.data.accounts.map((account) => (
                <tr key={account.organizationId}>
                  <td>
                    {account.organizationName}
                    <small className="muted"> · desde {day(account.organizationCreatedAt)}</small>
                  </td>
                  <td>{account.role === 'superadmin' ? 'Superadmin' : 'Titular'}</td>
                  <td>
                    {account.onboardingCompletedAt === null
                      ? account.firstBetDeferredAt === null
                        ? 'Em andamento'
                        : 'Concluído sem aposta'
                      : 'Concluído'}
                  </td>
                  <td>{account.consentsAccepted}</td>
                  <td>
                    {account.deletionState ? (stateLabels[account.deletionState] ?? '—') : '—'}
                  </td>
                  <td>{account.activeSessions}</td>
                  <td>{instant(account.lastSessionAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Usage() {
  const usage = useQuery({
    queryKey: ['admin', 'usage'],
    queryFn: () => request('/api/v1/admin/usage', adminUsageSchema),
  });
  if (usage.isError)
    return (
      <p role="alert" className="muted">
        Não foi possível carregar o uso.
      </p>
    );
  if (!usage.data) return <p role="status">Carregando uso…</p>;
  const ai = usage.data.ai;
  return (
    <>
      <p className="muted">
        Cota de IA: {ai.requestsToday}/{ai.dailyLimit} hoje · {ai.requestsMonth}/{ai.monthlyLimit}{' '}
        no mês · {stateLabels[ai.state]} · {usage.data.organizations} organização(ões)
      </p>
      {usage.data.queues.length === 0 ? (
        <p className="muted">Nenhuma fila ativa.</p>
      ) : (
        <div className="table-scroll">
          <table className="product-table">
            <caption className="sr-only">Contagens de fila por organização</caption>
            <thead>
              <tr>
                <th>Organização</th>
                <th>Importação pendente</th>
                <th>Em revisão</th>
                <th>Falhas</th>
                <th>Eventos pendentes</th>
                <th>Saída pendente</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.queues.map((queue) => (
                <tr key={queue.organizationId}>
                  <td>{queue.organizationName}</td>
                  <td>{queue.importPending + queue.importProcessing}</td>
                  <td>{queue.importReview}</td>
                  <td>{queue.importFailed + queue.eventFailed + queue.outboxFailed}</td>
                  <td>{queue.eventPending + queue.eventProcessing}</td>
                  <td>{queue.outboxPending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Flags() {
  const flags = useQuery({
    queryKey: ['admin', 'flags'],
    queryFn: () => request('/api/v1/admin/flags', adminFlagsSchema),
  });
  if (flags.isError)
    return (
      <p role="alert" className="muted">
        Não foi possível carregar as flags.
      </p>
    );
  if (!flags.data) return <p role="status">Carregando flags…</p>;
  return (
    <>
      <p className="muted">
        Rollout: {flags.data.rollout.source === 'posthog' ? 'PostHog' : 'nenhum'}.
        {flags.data.rollout.keys.length === 0
          ? ' Nenhuma chave de rollout é consultada pelo produto hoje.'
          : ` Chaves: ${flags.data.rollout.keys.join(', ')}`}
      </p>
      <ul className="admin-list">
        {flags.data.toggles.map((toggle) => (
          <li key={toggle.key}>
            <span>{toggle.key}</span>
            <strong>{toggle.enabled ? 'Ligado' : 'Desligado'}</strong>
          </li>
        ))}
      </ul>
    </>
  );
}

function Errors() {
  const errors = useQuery({
    queryKey: ['admin', 'errors'],
    queryFn: () => request('/api/v1/admin/errors', adminErrorsSchema),
  });
  if (errors.isError)
    return (
      <p role="alert" className="muted">
        Não foi possível carregar os erros.
      </p>
    );
  if (!errors.data) return <p role="status">Carregando erros…</p>;
  return (
    <>
      <p className="muted">
        Sentry {errors.data.telemetry.sentry.enabled ? 'ativo' : 'inativo'} (
        {errors.data.telemetry.sentry.environment}) · PostHog{' '}
        {errors.data.telemetry.posthog.enabled ? 'ativo' : 'inativo'} · registros{' '}
        {errors.data.telemetry.betterStack.enabled ? 'ativos' : 'inativos'}.
      </p>
      {errors.data.kinds.length === 0 ? (
        <p className="muted">Nenhuma falha registrada.</p>
      ) : (
        <div className="table-scroll">
          <table className="product-table">
            <caption className="sr-only">Erros recentes por código e origem</caption>
            <thead>
              <tr>
                <th>Origem</th>
                <th>Código</th>
                <th>Ocorrências</th>
                <th>Última vez</th>
              </tr>
            </thead>
            <tbody>
              {errors.data.kinds.map((kind) => (
                <tr key={`${kind.source}:${kind.code}`}>
                  <td>{kind.source}</td>
                  <td>
                    <code>{kind.code}</code>
                  </td>
                  <td>{kind.occurrences}</td>
                  <td>{instant(kind.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Audit() {
  const audit = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () => request('/api/v1/admin/audit', adminAuditTrailSchema),
  });
  if (audit.isError)
    return (
      <p role="alert" className="muted">
        Não foi possível carregar a auditoria.
      </p>
    );
  if (!audit.data) return <p role="status">Carregando auditoria…</p>;
  return (
    <>
      <p className="muted">
        Cada abertura deste painel é registrada, permitida ou recusada. A trilha é somente-adição:
        não pode ser alterada nem apagada.
      </p>
      <div className="table-scroll">
        <table className="product-table">
          <caption className="sr-only">Acessos ao painel interno</caption>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Visão</th>
              <th>Desfecho</th>
              <th>Identificador</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{instant(entry.createdAt)}</td>
                <td>{entry.view}</td>
                <td>{entry.outcome === 'allowed' ? 'Permitido' : 'Recusado'}</td>
                <td>
                  <code>{entry.actorUserId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function AdminPanel() {
  const [view, setView] = useState<AdminPanelView>('accounts');
  const current = VIEWS.find((item) => item.id === view)!;
  return (
    <div className="product-shell">
      <aside className="product-sidebar">
        <a href="#overview" className="product-brand">
          stakeframe<span>.</span>
        </a>
        <p className="sidebar-caption">ADMINISTRAÇÃO INTERNA</p>
        <nav aria-label="Visões do painel interno">
          {VIEWS.map((item) => (
            <a
              key={item.id}
              href={`#admin-${item.id}`}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                setView(item.id);
              }}
            >
              <span className="nav-label">{item.title}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="private-dot" /> Somente leitura
          <p>Sem acesso ao conteúdo das contas</p>
        </div>
      </aside>
      <div className="product-content">
        <header className="product-topbar">
          <span>
            Painel interno<span className="greeting-dot">.</span>
          </span>
        </header>
        <main className="product-main" id="product-main">
          <div className="page-heading">
            <div>
              <p className="product-eyebrow">STAKEFRAME / ADMINISTRAÇÃO</p>
              <h1>{current.title}</h1>
            </div>
            <span className="live-label">
              <span className="private-dot" /> Metadados
            </span>
          </div>
          <p className="report-intro">
            {current.hint}. Esta visão mostra apenas metadados operacionais: nenhum valor, aposta,
            imagem, mensagem de erro ou identificação de usuário é exibido. Cada abertura fica
            registrada na auditoria.
          </p>
          <Panel title={current.title}>
            {view === 'accounts' ? <Accounts /> : null}
            {view === 'usage' ? <Usage /> : null}
            {view === 'flags' ? <Flags /> : null}
            {view === 'errors' ? <Errors /> : null}
            {view === 'audit' ? <Audit /> : null}
          </Panel>
        </main>
        <div className="product-footer">
          Painel interno, somente leitura.
          <span>Metadados · sem conteúdo</span>
        </div>
      </div>
    </div>
  );
}
