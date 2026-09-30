import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { capturePageView, identifyOwner, setSensitiveSurface } from '../lib/telemetry.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workspaceSchema,
  onboardingStatusSchema,
  formatBRL,
  saoPauloDate,
  type Workspace,
  type Bet,
  type CatalogItem,
  type ReleaseInfo,
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
import { BetDrawer } from './bet-drawer.js';
import { ImportsPage, ImportReview, UploadForm } from './imports.js';
import { ImportBatchForm } from './import-batch.js';
import { savePendingUpload } from './upload-storage.js';
import { CalendarPage, EventReview } from './events.js';
import { ReportsPage } from './reports.js';
import { OverviewReport } from './overview-report.js';
import { OnboardingPage } from './onboarding.js';
import { PolymarketRankingPage } from './polymarket-ranking.js';
import { NavGlyph, type NavIcon } from './nav-icons.js';
import './tokens.css';
import './product.css';
const AnalyticsPage = lazy(() => import('./analytics.js'));

export type Modal =
  | { kind: 'initialize' | 'freebet' | 'unit' | 'settings' | 'upload' | 'import-batch' }
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
/**
 * STK-F2-18: `Page` é declarado explicitamente, não derivado de
 * `navigation`. Derivar quebrava: `navigation` satisfaz `Page`, e `Page`
 * dependia de `navigation` — referência circular, que o compilador recusa.
 * A lista abaixo e a constante precisam concordar; o teste
 * tests/unit/design-tokens.test.ts confere as duas.
 */
type Page =
  | 'overview'
  | 'bets'
  | 'calendar'
  | 'analytics'
  | 'reports'
  | 'ranking'
  | 'finance'
  | 'settings'
  | 'imports';
// STK-F2-18: `icon` é um identificador do traçado em nav-icons.tsx, não um
// glifo. Um caractere Unicode como ícone varia entre plataformas, não aceita
// `currentColor` e some em algumas fontes — e o desenho passava a ser a única
// pista visual do destino quando o rótulo é truncado.
const navigation = [
  { id: 'overview', title: 'Visão geral', icon: 'overview' },
  { id: 'bets', title: 'Apostas', icon: 'bets' },
  { id: 'calendar', title: 'Calendário', icon: 'calendar' },
  { id: 'analytics', title: 'Análises', icon: 'analytics' },
  { id: 'reports', title: 'Relatórios', icon: 'reports' },
  // STK-F2-15: o ranking oficial Polymarket. Entra na navegação da web (não do
  // Mini App), e a coluna da barra inferior no mobile é explícita por causa
  // dele — o teste de navegador exige que a barra não role e que cada destino
  // mantenha 44px de altura, e um `auto-fit` faria a contagem depender da
  // largura em vez de ser verificada.
  { id: 'ranking', title: 'Ranking', icon: 'ranking' },
  { id: 'finance', title: 'Financeiro', icon: 'finance' },
  { id: 'settings', title: 'Configurações', icon: 'settings' },
] as const satisfies ReadonlyArray<{ id: Page; title: string; icon: NavIcon }>;
/**
 * STK-F2-12 — os MESMOS quatro destinos dentro do Mini App, sobre as mesmas
 * telas e os mesmos modais. O Telegram entrega um menu inferior, não uma
 * barra lateral, e não faz sentido oferecer calendário/análises/financeiro
 * numa tela de bolso: as quatro rotas escolhidas são as do escopo (painel,
 * apostas, pendentes e ajustes).
 */
const miniAppNavigation = [
  { id: 'overview', title: 'Painel', icon: 'overview' },
  { id: 'bets', title: 'Apostas', icon: 'bets' },
  { id: 'imports', title: 'Pendentes', icon: 'inbox' },
  { id: 'settings', title: 'Ajustes', icon: 'settings' },
] as const satisfies ReadonlyArray<{ id: Page; title: string; icon: NavIcon }>;
function currentPage(): Page {
  const id = location.hash.slice(1);
  if (id === 'imports') return 'imports';
  return navigation.find((item) => item.id === id)?.id ?? 'overview';
}

export function ProductApp({
  owner,
  release,
  variant = 'web',
}: {
  owner: Owner;
  release?: ReleaseInfo | undefined;
  /** STK-F2-12: `mini` é o mesmo produto dentro do Telegram, com navegação própria. */
  variant?: 'web' | 'mini';
}) {
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
      <ProductShell owner={owner} workspace={workspace.data} release={release} variant={variant} />
    </ActionProvider>
  );
}
function ProductShell({
  owner,
  workspace,
  release,
  variant,
}: {
  owner: Owner;
  workspace: Workspace;
  release?: ReleaseInfo | undefined;
  variant: 'web' | 'mini';
}) {
  const releaseLabel = release && release.version !== 'unversioned' ? ` · v${release.version}` : '';
  const [page, setPage] = useState(currentPage);
  const [modal, setModal] = useState<Modal | null>(null);
  const actions = useFinanceActions();
  const client = useQueryClient();
  const onboarding = useQuery({
    queryKey: ['product', 'onboarding'],
    queryFn: () => request('/api/v1/onboarding', onboardingStatusSchema),
    refetchInterval: 30_000,
  });
  // First login lands on the first-steps flow; the server state decides, and finishing it
  // (or having it already finished) restores the regular overview. A failed lookup never
  // counts as completed — the page itself surfaces the error with a retry affordance.
  const onboardingActive = page === 'overview' && !onboarding.data?.completedAt;
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
  // STK-F1-10: bilhetes, finanças, configurações e qualquer modal do produto
  // são superfícies sensíveis — nunca gravadas pelo replay (§6.1).
  useEffect(() => {
    // STK-F2-08: `reports` entrou na lista porque a página mostra resultado,
    // ROI e exposição — é uma superfície financeira como `bets` e `finance`,
    // e o replay (§6.1) não pode gravá-la. Uma tela de número que escapasse
    // daqui seria a mesma falha que motivou a marcação das outras três.
    setSensitiveSurface(
      'product-app',
      page === 'bets' ||
        page === 'finance' ||
        page === 'reports' ||
        page === 'analytics' ||
        // STK-F2-15: o ranking também é uma tela de número externo — posição,
        // P&L e volume de terceiros. Uma sessão gravada aqui registrararia
        // a carteira pública que o dono estava consultando, e isso é dado de
        // interesse, não ruído de navegação.
        page === 'ranking' ||
        page === 'settings' ||
        modal !== null,
    );
    return () => setSensitiveSurface('product-app', false);
  }, [page, modal]);
  // Funil (opt-in): apenas a mudança de página gera evento; telas sensíveis
  // são excluídas dentro de capturePageView.
  useEffect(() => {
    capturePageView(page);
  }, [page]);
  // Identificação pseudônima (id interno) — nunca e-mail ou nome.
  useEffect(() => {
    identifyOwner(owner.id);
  }, [owner.id]);
  const open: OpenModal = (value) => {
    actions.clearError();
    setModal(value);
  };
  const close = () => setModal(null);
  // STK-F2-12 — a casca do Mini App: sem barra lateral, sem "sair da conta" e
  // com um menu inferior de quatro destinos. Tudo abaixo do menu (telas,
  // modais, formulários e o caminho financeiro com confirmação) é o MESMO
  // componente da web — por isso a troca não pode duplicar regra nenhuma.
  const items = variant === 'mini' ? miniAppNavigation : navigation;
  return (
    <div className={variant === 'mini' ? 'product-shell miniapp-shell' : 'product-shell'}>
      {/*
        STK-F2-18: skip link. O alvo (`#product-main`) já existia no código
        desde antes desta fase e nada apontava para ele — a navegação por
        teclado passava por 8 links de menu antes de chegar ao conteúdo, em
        todas as telas do produto. Fica oculto até receber foco e some de
        novo ao perder.
      */}
      <a className="skip-link" href="#product-main">
        Pular para o conteúdo
      </a>
      {variant === 'web' ? (
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
                <span className="nav-icon">
                  <NavGlyph icon={item.icon} />
                </span>
                <span className="nav-label">{item.title}</span>
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="private-dot" /> Acesso privado<p>Horário de São Paulo</p>
          </div>
        </aside>
      ) : null}
      <div className="product-content">
        <header className="product-topbar">
          <span>
            {variant === 'mini' ? (
              'stakeframe'
            ) : (
              <>
                Olá, {owner.name.split(' ')[0]}
                <span className="greeting-dot">.</span>
              </>
            )}
          </span>
          <div className="button-row">
            {/* STK-F2-12: dentro do Telegram não existe "conta" do navegador para
                encerrar — o vínculo é desfeito no site (F2-04), e a seção
                "Ajustes" aponta para lá. */}
            {variant === 'web' ? (
              <Button
                variant="ghost"
                size="small"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
              >
                Sair da conta
              </Button>
            ) : null}
            <Button
              disabled={!workspace.initialized || !!actions.pending}
              onClick={() => open({ kind: 'bet' })}
            >
              + Nova aposta
            </Button>
          </div>
        </header>
        <main className="product-main" id="product-main" tabIndex={-1}>
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
              <h1>
                {onboardingActive
                  ? 'Primeiros passos'
                  : page === 'imports'
                    ? 'Recebimentos técnicos'
                    : items.find((item) => item.id === page)!.title}
              </h1>
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
          {!workspace.initialized && !onboardingActive ? (
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
          {onboardingActive ? (
            <OnboardingPage workspace={workspace} open={open} />
          ) : page === 'overview' ? (
            <Overview workspace={workspace} open={open} owner={owner.id} />
          ) : page === 'bets' ? (
            <BetsPage workspace={workspace} open={open} owner={owner.id} />
          ) : page === 'finance' ? (
            <FinancePage workspace={workspace} open={open} />
          ) : page === 'imports' ? (
            <ImportsPage workspace={workspace} open={open} />
          ) : page === 'calendar' ? (
            <CalendarPage workspace={workspace} open={open} />
          ) : page === 'analytics' ? (
            <Suspense fallback={<p role="status">Carregando análises…</p>}>
              <AnalyticsPage workspace={workspace} open={open} />
            </Suspense>
          ) : page === 'ranking' ? (
            // STK-F2-15: o ranking oficial Polymarket. Não recebe `workspace`
            // porque é a única tela que NÃO lê dado da organização: o ranking
            // é público e idêntico para qualquer conta, e passar o workspace
            // aqui abriria espaço para alguém ligar a lista pública a um
            // tenant — que é impersonação, e a rota não aceita nem usuário nem
            // organização justamente por isso.
            <PolymarketRankingPage />
          ) : page === 'reports' ? (
            // STK-F2-08: a página do relatório privado. Ela não recebe o
            // `workspace` porque é a ÚNICA tela do produto que lê o SNAPSHOT
            // congelado em vez do estado atual — e é autenticada pelo mesmo
            // caminho das demais.
            <ReportsPage />
          ) : (
            <SettingsPage workspace={workspace} open={open} />
          )}
        </main>
        <div className="product-footer">
          Seus movimentos, com contexto.
          <span>BRL · America/Sao_Paulo{releaseLabel}</span>
        </div>
      </div>
      {variant === 'mini' ? (
        // STK-F2-12 — menu inferior do Telegram. Usa `open`/hashchange em vez de
        // `button` para que o fluxo Continue sendo uma ROTA: o botão do menu do
        // bot pode abrir uma rota específica, o botão de voltar do Telegram
        // funciona, e o mesmo endereço abre o mesmo fluxo.
        <nav className="miniapp-nav" aria-label="Navegação do aplicativo">
          {items.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <span className="nav-icon">
                <NavGlyph icon={item.icon} size={18} />
              </span>
              <span className="nav-label">{item.title}</span>
            </a>
          ))}
        </nav>
      ) : null}
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
function Overview({
  workspace,
  open,
  owner,
}: {
  workspace: Workspace;
  open: OpenModal;
  owner: string;
}) {
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
      <OverviewReport version={workspace.version} />
      <BetsPage workspace={workspace} open={open} owner={owner} compact />
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
    case 'import-batch':
      title = 'Importar arquivo';
      content = <ImportBatchForm onDone={close} />;
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
      // STK-F2-18 (Fase 3): o detalhe da aposta é o ÚNICO modal que virou
      // drawer. A lista é o contexto e o detalhe é a resposta — centralizado,
      // o diálogo cobria as linhas que a pessoa estava comparando.
      return (
        <BetDrawer title="Detalhes da aposta" open onClose={close}>
          <BetDetails id={modal.id} workspace={workspace} open={open} />
        </BetDrawer>
      );
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
