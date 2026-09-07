import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workspaceSchema,
  formatBRL,
  saoPauloDate,
  type Workspace,
  type Bet,
  type CatalogItem,
} from '@stakeframe/shared';
import { authAction } from '../OwnerAccess.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { ActionProvider, PendingOperation, useFinanceActions } from './actions.js';
import { request, type CommandInput } from './api.js';
import {
  InitializeForm,
  CashForm,
  CatalogForm,
  FreebetForm,
  UnitForm,
  SettingsForm,
  CorrectionForm,
  BetForm,
  SettleForm,
} from './forms.js';
import { BetsPage, BetDetails, FinancePage, SettingsPage } from './pages.js';
import { ImportsPage, ImportReview, UploadForm } from './imports.js';
import { savePendingUpload } from './upload-storage.js';
import { CalendarPage, EventReview } from './events.js';
import './product.css';

export type Modal =
  | { kind: 'initialize' | 'freebet' | 'unit' | 'settings' | 'upload' }
  | { kind: 'import'; id: string }
  | { kind: 'event'; id: string }
  | {
      kind: 'cash';
      operation: 'deposit' | 'withdrawal' | 'transfer' | 'reconcile';
      accountId?: string;
    }
  | { kind: 'catalog'; catalogKind: 'bookmaker' | 'tipster'; item?: CatalogItem }
  | { kind: 'bet'; bet?: Bet }
  | { kind: 'detail'; id: string }
  | { kind: 'settle'; bet: Bet }
  | { kind: 'correction'; title: string; build: (reason: string, at: string) => CommandInput };
export type OpenModal = (modal: Modal) => void;
type Owner = { id: string; name: string };
const navigation = [
  { id: 'overview', title: 'Visão geral', icon: '◫' },
  { id: 'bets', title: 'Apostas', icon: '▤' },
  { id: 'imports', title: 'Importações', icon: '⇧' },
  { id: 'calendar', title: 'Calendário', icon: '▦' },
  { id: 'finance', title: 'Financeiro', icon: '⇄' },
  { id: 'settings', title: 'Configurações', icon: '⚙' },
] as const;
type Page = (typeof navigation)[number]['id'];
function currentPage(): Page {
  const id = location.hash.slice(1);
  return navigation.find((item) => item.id === id)?.id ?? 'overview';
}

export function ProductApp({ owner }: { owner: Owner }) {
  const workspace = useQuery({
    queryKey: ['product', 'workspace'],
    queryFn: () => request('/api/v1/workspace', workspaceSchema),
    refetchInterval: 30_000,
  });
  if (!workspace.data || workspace.isError)
    return (
      <div className="product-loading">
        <h1>Seu espaço</h1>
        <p role={workspace.isError ? 'alert' : 'status'}>
          {workspace.isError
            ? 'Não foi possível carregar seus registros.'
            : 'Carregando seus registros…'}
        </p>
        {workspace.isError ? (
          <Button
            onClick={() => {
              void workspace.refetch();
            }}
          >
            Tentar novamente
          </Button>
        ) : null}
      </div>
    );
  return (
    <ActionProvider key={owner.id} owner={owner.id} version={workspace.data.version}>
      <ProductShell owner={owner} workspace={workspace.data} />
    </ActionProvider>
  );
}
function ProductShell({ owner, workspace }: { owner: Owner; workspace: Workspace }) {
  const [page, setPage] = useState(currentPage);
  const [modal, setModal] = useState<Modal | null>(null);
  const actions = useFinanceActions();
  const client = useQueryClient();
  const logout = useMutation({
    mutationFn: () => authAction('sign-out'),
    onSuccess: async () => {
      sessionStorage.removeItem('stakeframe.pending-command');
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith('stakeframe.pending-event-search:')) sessionStorage.removeItem(key);
      await savePendingUpload(null, true).catch(() => undefined);
      client.clear();
    },
  });
  useEffect(() => {
    const changed = () => setPage(currentPage());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const open: OpenModal = (value) => {
    actions.clearError();
    setModal(value);
  };
  const close = () => setModal(null);
  return (
    <div className="product-shell">
      <aside className="product-sidebar">
        <a href="#overview" className="product-brand">
          stakeframe<span>.</span>
        </a>
        <p className="sidebar-caption">SEU ESPAÇO PESSOAL</p>
        <nav aria-label="Navegação principal">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.title}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="private-dot" /> Acesso privado<p>Horário de São Paulo</p>
        </div>
      </aside>
      <div className="product-content">
        <header className="product-topbar">
          <span>
            Olá, {owner.name.split(' ')[0]}
            <span className="greeting-dot">.</span>
          </span>
          <div className="button-row">
            <Button
              variant="ghost"
              size="small"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sair da conta
            </Button>
            <Button
              disabled={!workspace.initialized || !!actions.pending}
              onClick={() => open({ kind: 'bet' })}
            >
              + Nova aposta
            </Button>
          </div>
        </header>
        <main className="product-main" id="product-main">
          <div className="page-heading">
            <div>
              <p className="product-eyebrow">
                STAKEFRAME /{' '}
                {new Intl.DateTimeFormat('pt-BR', {
                  timeZone: 'America/Sao_Paulo',
                  month: 'long',
                  year: 'numeric',
                }).format(new Date())}
              </p>
              <h1>{navigation.find((item) => item.id === page)!.title}</h1>
            </div>
            <span className="live-label">
              <span className="private-dot" /> Registros pessoais
            </span>
          </div>
          {logout.isError ? (
            <p role="alert" className="notice warning">
              Não foi possível sair. Tente novamente.
            </p>
          ) : null}
          <PendingOperation />
          {workspace.warnings.map((warning) => (
            <div key={warning} role="status" className="notice warning">
              {warning === 'NEGATIVE_BALANCE'
                ? 'Há saldo negativo. Confira os lançamentos e a conciliação da casa.'
                : 'Não há unidade positiva para este mês. Confira o histórico em Configurações; apostas podem ser registradas com a pendência identificada.'}
            </div>
          ))}
          {!workspace.initialized ? (
            <div className="initial-card">
              <div>
                <span className="product-eyebrow">PRIMEIRO PASSO</span>
                <h2>Uma banca que começa com seus números.</h2>
                <p>
                  Confira sua reserva e o saldo disponível em cada casa para iniciar os registros.
                </p>
              </div>
              <Button onClick={() => open({ kind: 'initialize' })}>Conferir saldos iniciais</Button>
            </div>
          ) : null}
          {page === 'overview' ? (
            <Overview workspace={workspace} open={open} />
          ) : page === 'bets' ? (
            <BetsPage workspace={workspace} open={open} />
          ) : page === 'finance' ? (
            <FinancePage workspace={workspace} open={open} />
          ) : page === 'imports' ? (
            <ImportsPage workspace={workspace} open={open} />
          ) : page === 'calendar' ? (
            <CalendarPage workspace={workspace} open={open} />
          ) : (
            <SettingsPage workspace={workspace} open={open} />
          )}
        </main>
        <div className="product-footer">
          Seus movimentos, com contexto.<span>BRL · America/Sao_Paulo</span>
        </div>
      </div>
      {modal ? (
        <ModalContent
          key={JSON.stringify(modal, (key, value: unknown) => (key === 'build' ? null : value))}
          modal={modal}
          owner={owner.id}
          workspace={workspace}
          close={close}
          open={open}
        />
      ) : null}
    </div>
  );
}
function Overview({ workspace, open }: { workspace: Workspace; open: OpenModal }) {
  const unit = workspace.units.find(
    (value) => value.month === saoPauloDate(new Date()).slice(0, 7),
  );
  return (
    <>
      <div className="metric-grid">
        <Metric
          label="Banca real"
          value={formatBRL(workspace.bankroll)}
          detail="Disponível + principal em aberto"
          featured
        />
        <Metric
          label="Disponível"
          value={formatBRL(workspace.available)}
          detail="Reserva e saldo nas casas"
        />
        <Metric
          label="Em apostas abertas"
          value={formatBRL(workspace.exposure)}
          detail="Somente dinheiro real"
        />
        <Metric
          label="Unidade do mês"
          value={unit ? formatBRL(unit.amount) : 'A conferir'}
          detail={unit ? 'Valor congelado durante o mês' : 'Cadastre os saldos para começar'}
        />
      </div>
      <div className="panel">
        <div className="section-heading">
          <div>
            <h2>Onde está sua banca</h2>
            <p>Saldo disponível por conta</p>
          </div>
          <a className="text-link" href="#finance">
            Ver movimentações ↗
          </a>
        </div>
        <div className="account-grid">
          {workspace.accounts.map((account) => (
            <div className="account-card" key={account.id}>
              <span className="account-icon" aria-hidden="true">
                {account.kind === 'reserve' ? '↗' : account.name.slice(0, 1)}
              </span>
              <div>
                <span>{account.name}</span>
                <strong className={account.balance.startsWith('-') ? 'negative' : ''}>
                  {formatBRL(account.balance)}
                </strong>
              </div>
            </div>
          ))}
        </div>
      </div>
      <BetsPage workspace={workspace} open={open} compact />
    </>
  );
}
export function Metric({
  label,
  value,
  detail,
  featured = false,
}: {
  label: string;
  value: string;
  detail: string;
  featured?: boolean;
}) {
  return (
    <div className={`metric-card ${featured ? 'featured' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function ModalContent({
  modal,
  owner,
  workspace,
  close,
  open,
}: {
  modal: Modal;
  owner: string;
  workspace: Workspace;
  close: () => void;
  open: OpenModal;
}) {
  let title: string;
  let content: ReactNode;
  switch (modal.kind) {
    case 'event':
      title = 'Conferir programação do evento';
      content = <EventReview id={modal.id} owner={owner} workspace={workspace} onDone={close} />;
      break;
    case 'upload':
      title = 'Enviar comprovante';
      content = <UploadForm owner={owner} onDone={close} open={open} />;
      break;
    case 'import':
      title = 'Revisar importação';
      content = <ImportReview id={modal.id} workspace={workspace} open={open} onDone={close} />;
      break;
    case 'initialize':
      title = 'Saldos iniciais';
      content = <InitializeForm workspace={workspace} onDone={close} />;
      break;
    case 'cash':
      title = {
        deposit: 'Entrada de dinheiro',
        withdrawal: 'Retirada de dinheiro',
        transfer: 'Transferir entre contas',
        reconcile: 'Conciliar saldo',
      }[modal.operation];
      content = (
        <CashForm
          workspace={workspace}
          kind={modal.operation}
          {...(modal.accountId ? { accountId: modal.accountId } : {})}
          onDone={close}
        />
      );
      break;
    case 'catalog':
      title = `${modal.item ? 'Editar' : 'Adicionar'} ${modal.catalogKind === 'bookmaker' ? 'casa' : 'tipster'}`;
      content = (
        <CatalogForm
          kind={modal.catalogKind}
          {...(modal.item ? { item: modal.item } : {})}
          onDone={close}
        />
      );
      break;
    case 'bet':
      title = modal.bet ? 'Corrigir dados da aposta' : 'Nova aposta';
      content = (
        <BetForm workspace={workspace} {...(modal.bet ? { bet: modal.bet } : {})} onDone={close} />
      );
      break;
    case 'detail':
      title = 'Detalhes da aposta';
      content = <BetDetails id={modal.id} workspace={workspace} open={open} />;
      break;
    case 'settle':
      title = 'Liquidar aposta';
      content = <SettleForm bet={modal.bet} onDone={close} />;
      break;
    case 'freebet':
      title = 'Novo crédito de freebet';
      content = <FreebetForm workspace={workspace} onDone={close} />;
      break;
    case 'unit':
      title = 'Conferir unidade histórica';
      content = <UnitForm onDone={close} />;
      break;
    case 'settings':
      title = 'Unidade dos próximos meses';
      content = <SettingsForm workspace={workspace} onDone={close} />;
      break;
    case 'correction':
      title = modal.title;
      content = <CorrectionForm build={modal.build} onDone={close} />;
      break;
  }
  return (
    <Dialog title={title} open onClose={close}>
      {content}
    </Dialog>
  );
}
