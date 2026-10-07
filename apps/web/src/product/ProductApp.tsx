import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { capturePageView, identifyOwner, setSensitiveSurface } from '../lib/telemetry.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  workspaceSchema,
  onboardingStatusSchema,
  formatBRL,
  saoPauloDate,
  polymarketFavoritesResponseSchema,
  POLYMARKET_DEFAULT_WINDOW,
  POLYMARKET_RANKING_LIMIT,
  type Workspace,
  type Bet,
  type CatalogItem,
  type ReleaseInfo,
  type PolymarketFavoritesResponse,
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
// STK-F3-04: a tela Global em cards de tipster (esportes e e-sports).
import { PolymarketGlobalPage, PolymarketTipsterPage } from './polymarket-global.js';
import { PolymarketFavoritesPage } from './polymarket-favorites.js';
import { PolymarketSimulationPage } from './polymarket-simulation.js';
import { NavGlyph, type NavIcon } from './nav-icons.js';
import { SidebarFooter, TopBar } from './app-shell.js';
import { readSidebarMode, writeSidebarMode, type SidebarMode } from './sidebar-mode.js';
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
      amount?: string;
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
 *
 * A categoria Polymarket tem telas de ranking global, Favoritos e Simulação.
 * `pm-telegram` permanece como destino reservado até a tela ser implementada.
 * A rota antiga `#ranking` encaminha para o ranking global.
 *
 * A união é mantida CONTÍGUA, sem comentário no meio, porque o teste de
 * tokens a lê com um regex que para na primeira linha fora do padrão. Um
 * comentário aqui não é estilo: é a asserção de concord navigation ↔ Page
 * parando de enxergar as quatro rotas.
 */
type Page =
  | 'overview'
  | 'bets'
  | 'calendar'
  | 'analytics'
  | 'reports'
  | 'finance'
  | 'profile'
  | 'settings'
  | 'imports'
  | 'pm-global'
  | 'pm-favorites'
  | 'pm-telegram'
  | 'pm-simulation'
  | 'pm-tipster';
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
  { id: 'finance', title: 'Banca', icon: 'finance' },
  { id: 'profile', title: 'Perfil', icon: 'settings' },
  { id: 'settings', title: 'Configurações', icon: 'settings' },
  /* STK-F3-01: Favoritos e Simulação NÃO estão nesta lista. Eles são
     destinos de primeira classe (as telas da F2-16 e da F2-17, promovidas a
     página sem reescrita), mas a navegação os desenha a partir de
     `polymarketItems`, que guarda a ordem do card e o estado de reservado.
     Listá-los aqui também os renderizaria DUAS vezes — uma na categoria e
     outra no fim da lista plana. */
] as const satisfies ReadonlyArray<{ id: Page; title: string; icon: NavIcon }>;

/**
 * STK-F3-01 — as categorias da sidebar, na ordem da prova visual.
 *
 * `sidebarGroups` NÃO duplica os destinos: ele guarda o rótulo de cada
 * categoria e os IDS que a compõem, e a navegação continua sendo a
 * `navigation` acima — a lista plana é a que o teste de tokens lê e a que
 * `currentPage` resolve. Se as duas tivessem os títulos, uma delas
 * passaria a ser a verdade e a outra uma cópia.
 *
 * `pm-telegram` não entra em `sidebarGroups`: ele é renderizado como item
 * reservado dentro da categoria Polymarket. As telas disponíveis ficam
 * visíveis como destinos normais da navegação.
 */
const sidebarGroups = [
  { caption: 'PAINEL', ids: ['overview'] },
  { caption: 'APOSTAS', ids: ['bets', 'calendar'] },
  { caption: 'ANÁLISES', ids: ['analytics', 'reports'] },
  { caption: 'BANCA', ids: ['finance'] },
  { caption: 'POLYMARKET', ids: ['pm-favorites', 'pm-simulation'] },
  { caption: 'CONTA', ids: ['profile', 'settings'] },
] as const satisfies ReadonlyArray<{ caption: string; ids: ReadonlyArray<Page> }>;
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
/**
 * A categoria Polymarket guarda Ranking global, Favoritos, Telegram e
 * Simulação, nesta ordem. Ranking global, Favoritos e Simulação têm telas;
 * Telegram permanece reservado.
 *
 * A lista guarda a ordem porque a ordem é parte do que o dono pediu, e ela
 * é o tipo de coisa que se perde em uma refatoração: os dois destinos
 * Cada destino é declarado uma única vez para que a ordem não dependa de
 * condicionais espalhadas pelo componente.
 *
 * `reserved: true` marca o destino cuja tela está FORA DE ESCOPO. Ele
 * aparece declarado e desligado: um item ausente some da decisão do dono,
 * e um item clicável que leva a lugar nenhum é pior que os dois.
 *
 * `count: true` marca o único item com badge de contagem (Favoritos) — e a
 * badge só é desenhada com o dado carregado, nunca com um zero escrito à
 * mão (R2).
 */
const polymarketItems = [
  // STK-F3-04: `pm-global` DEIXOU de ser reservado — a tela existe, em cards,
  // e a `reserved: true` é o que faria a sidebar continuar desenhando um item
  // desligado para uma rota que agora funciona. `pm-telegram` continua
  // reservado: nenhuma tela dele foi pedida aqui, e continua sendo o
  // destino honesto para "ainda não existe".
  { id: 'pm-global', title: 'Ranking global', icon: 'global' },
  { id: 'pm-favorites', title: 'Favoritos', icon: 'favorite', count: true },
  { id: 'pm-telegram', title: 'Telegram', icon: 'telegram', reserved: true },
  { id: 'pm-simulation', title: 'Simulação', icon: 'simulation' },
] as const satisfies ReadonlyArray<{
  id: Page;
  title: string;
  icon: NavIcon;
  reserved?: boolean;
  count?: boolean;
}>;

/**
 * STK-F3-01 — as rotas RESERVADAS da categoria Polymarket.
 *
 * STK-F3-04: sobrou só `pm-telegram`. `pm-global` saiu daqui porque a tela
 * foi construída, e a entrada que saía daqui era o que mantinha a rota
 * resolvida — removê-la sem trocar o `currentPage` teria feito a tela nova
 * cair em "Visão geral" (e foi exatamente isso que aconteceu até a correção).
 *
 * A reserva não é um detalhe de menu: uma rota reservada continua sendo ROTA
 * e renderiza a explicação de "ainda não existe", e não um id que devolve
 * "Visão geral" em silêncio. Um link guardado para o futuro que cai na tela
 * errada é pior que um 404 honesto.
 */
const reservedPages = new Set<Page>(['pm-telegram']);

/**
 * STK-F3-01 — os rótulos de `h1` das rotas da categoria Polymarket.
 *
 * STK-F3-04: este conjunto deixou de ser só das rotas RESERVADAS. O `h1` é
 * resolvido por `items.find(...) ?? esteConjunto`, e `items` é `navigation`,
 * que não contém os ids da categoria Polymarket desde o F3-01 (eles foram
 * para `polymarketItems` para não aparecerem duas vezes). Então o rótulo de
 * uma tela Polymarket que FUNCIONA vem daqui — e é o que impede o `h1` de
 * sair vazio. O nome ficou `pageTitles` porque ele serve às duas situações.
 */
const pageTitles: Partial<Record<Page, { title: string }>> = {
  // `pm-global` deixou de ser reserva no STK-F3-04, e o `h1` da tela nova
  // continua precisando do rótulo.
  'pm-global': { title: 'Ranking global' },
  'pm-tipster': { title: 'Tipster' },
  'pm-telegram': { title: 'Telegram' },
};

/**
 * STK-F3-01 — a tela de um destino RESERVADO.
 *
 * Ela existe para que `#pm-global` não caia em silêncio na Visão geral. A
 * mensagem diz o que o destino é e o que falta, e oferece o caminho que
 * funciona hoje — a categoria Polymarket já tem Favoritos e Simulação
 * funcionando, e são esses os destinos para onde a pessoa vai agora.
 */
function ReservedPage({ title }: { title: string }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{title} · Polymarket</h2>
          <p>
            Esta tela ainda não existe. Os dois destinos que já funcionam estão em Favoritos e em
            Simulação, na mesma categoria da barra lateral.
          </p>
        </div>
      </div>
      <div className="button-row">
        <Button
          variant="secondary"
          onClick={() => {
            location.hash = '#pm-favorites';
          }}
        >
          Ir para Favoritos
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            location.hash = '#pm-simulation';
          }}
        >
          Ir para Simulação
        </Button>
      </div>
    </section>
  );
}

/**
 * STK-F3-01 — um destino do card cuja tela está FORA DE ESCOPO.
 *
 * Ele é um item VISÍVEL e DESLIGADO, não um link: existe para que a decisão
 * decisão do dono fique à vista sem prometer uma
 * tela que não existe. Um link que leva a lugar nenhum seria pior que
 * silencioso; um item cinza sem explicação seria pior que ausente.
 *
 * `aria-disabled` num elemento que não é interativo é inocuo aqui e é o que
 * a auditoria espera encontrar: o item não recebe foco, não é anunciável
 * como ação e o texto do motivo é lido no mesmo lugar.
 */
function ReservedDestination({ icon, title }: { icon: NavIcon; title: string }) {
  return (
    <span className="sidebar-reserved" aria-disabled="true">
      <span className="nav-icon">
        <NavGlyph icon={icon} />
      </span>
      <span className="nav-label">{title}</span>
      <span className="sidebar-reserved-note">EM BREVE</span>
    </span>
  );
}

/**
 * STK-F3-01 — a badge de contagem de Favoritos na sidebar.
 *
 * R2 vale aqui com força: dado ausente NÃO é zero. Enquanto a resposta não
 * chega — ou se a rota falha — a badge não é desenhada, e um `0` seria uma
 * afirmação de que a pessoa não tem favorito nenhum, que é o oposto de "não
 * sabemos". Quando aparece, é o número que o CONTRATO devolveu (`used`),
 * nunca um número escrito aqui.
 *
 * A consulta é a MESMA da tela de Favoritos (`queryKey` idêntica), então
 * favoritar em qualquer lugar já reflete na badge sem uma segunda chamada. E
 * ela roda mesmo fora da tela: uma badge que só existe quando a página está
 * aberta deixa de avisar a pessoa justamente quando ela está em outro lugar.
 */
function FavoritesBadge() {
  const favorites = useQuery({
    queryKey: ['polymarket', 'favorites'],
    queryFn: () =>
      request(
        '/api/v1/polymarket/favorites',
        polymarketFavoritesResponseSchema,
        {},
        /* STK-F3-01 — `decorative: true` NÃO É AFORDAMENTO DE REDE: é
           integridade da casca.

           A rota responde 401 em qualquer produto sem o Polymarket
           liberado, e `api.ts` transforma 401 em
           `stakeframe:session-expired`, que em `App.tsx` faz
           `removeQueries({ queryKey: ['product'] })` — desmonta o produto
           inteiro e o reconstrói. A tela voltava a "Seu espaço" e o
           navegador reclamava "element was detached from the DOM, retrying"
           no clique da navegação: 45 testes de produto caíram de uma vez por
           causa de uma badge decorativa.

           O 401 dessa consulta não significa sessão perdida — significa que
           este usuário não tem a feature. Tratar isso como sessão expirada
           desligava a tela de quem estava lendo as apostas. */
        { decorative: true },
      ),
    /* `placeholderData`, e NÃO `initialData`: o segundo CONGELA a chave com
       o sentinela e adia a consulta até `staleTime`, o que fazia a badge
       nunca aparecer. O primeiro não bloqueia nada — a consulta roda e o
       sentinela só ocupa o lugar enquanto ela não volta. */
    placeholderData: favoritesPending,
    staleTime: 30_000,
  });
  // Os dois estados em que a badge NAO é desenhada: o sentinela de
  // "ainda não buscou" e a ausência de dado (a consulta ainda não voltou,
  // ou falhou). Nenhum dos dois vira um zero escrito à mão.
  if (favorites.data === undefined || favorites.data === favoritesPending) return null;
  return (
    <span className="nav-count" aria-hidden="true">
      {favorites.data.used}
    </span>
  );
}

/**
 * O estado de "a lista de favoritos ainda não foi buscada". Ele é um
 * SENTINELA e não um objeto com `used: 0`: um zero aqui seria uma
 * afirmação de que a pessoa não tem favorito nenhum, que é o oposto de
 * "não sabemos" — R2 vale para a badge como vale para o resto.
 */
const favoritesPending = { favoritesPending: true } as unknown as PolymarketFavoritesResponse;

function currentPage(): Page {
  const tipster = location.hash.match(/^#\/polymarket\/tipster\/(0x[a-f\d]{40})$/i);
  if (tipster) return 'pm-tipster';
  const id = location.hash.slice(1);
  // Link legado: leva à tela que agora concentra o ranking.
  if (id === 'ranking') return 'pm-global';
  if (id === 'imports') return 'imports';
  const known = navigation.find((item) => item.id === id)?.id;
  if (known) return known;
  /* STK-F3-01 moveu os destinos da categoria Polymarket para `polymarketItems`
     — é ela que guarda a ordem do card e o estado de reservado — e a busca
     acima só varre `navigation`. Um id dessa categoria só era resolvido
     porque passava pelo `reservedPages` logo abaixo.

     STK-F3-04: `pm-global` deixou de ser reservado, e a rota deixou de ser
     resolvida: o hash caía em "Visão geral" e a tela nova nunca aparecia. É
     o defeito que os 12 testes de navegador pegaram de uma vez só, e ele é a
     razão desta linha existir. A busca passa a olhar `polymarketItems`, que
     é a lista que DETÉM o id: um destino da categoria continua resolvido
     porque alguém o declarou, e não porque sobrou no fim de um `if`. */
  const polymarket = polymarketItems.find((item) => item.id === id);
  if (polymarket) return polymarket.id;
  // As rotas reservadas caem na explicação de "ainda não existe" — nunca em
  // "Visão geral" em silêncio.
  return reservedPages.has(id as Page) ? (id as Page) : 'overview';
}
function currentTipsterWallet() {
  return location.hash.match(/^#\/polymarket\/tipster\/(0x[a-f\d]{40})$/i)?.[1] ?? '';
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
  const [tipsterWallet, setTipsterWallet] = useState(currentTipsterWallet);
  const [modal, setModal] = useState<Modal | null>(null);
  // STK-F3-01 — o modo da sidebar é estado do CASCA, não do conteúdo: sobrevive
  // à troca de página e é lido do storage uma vez, na montagem. A leitura é
  // preguiçosa de propósito — o valor inicial só importa na primeira
  // renderização, e reler a cada render faria a sidebar piscar entre o modo
  // gravado e o padrão enquanto o usuário navega.
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    readSidebarMode(typeof window === 'undefined' ? null : window.localStorage),
  );
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
    const changed = () => {
      setPage(currentPage());
      setTipsterWallet(currentTipsterWallet());
    };
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
        // Ranking global e perfis exibem posições e resultados públicos de
        // terceiros, então essa navegação também não entra em replay.
        page === 'pm-global' ||
        page === 'pm-tipster' ||
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
  /* STK-F3-01 — a classe do shell carrega o MODO, e é dela que a folha tira
     a largura reservada (`.sidebar-mode-*`). O `metrics` não vai para a
     marcação: publicá-lo exigiria estilo inline (proibido) ou `attr()`
     tipado, que ainda não é confiável entre os navegadores do projeto. A
     folha repete os mesmos dois números de `sidebarMetrics`, e o teste de
     tokens confere que as duas cópias concordam. */
  const shellClass =
    variant === 'mini'
      ? 'product-shell miniapp-shell'
      : `product-shell product-web-theme sidebar-mode-${sidebarMode}`;
  return (
    <div className={shellClass}>
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
        <TopBar
          collapsed={sidebarMode === 'collapsed'}
          ownerName={owner.name}
          signingOut={logout.isPending}
          onSignOut={() => logout.mutate()}
          onToggleSidebar={() => {
            const next: SidebarMode = sidebarMode === 'collapsed' ? 'expanded' : 'collapsed';
            writeSidebarMode(typeof window === 'undefined' ? null : window.localStorage, next);
            setSidebarMode(next);
          }}
        />
      ) : null}
      {variant === 'web' ? (
        <aside className="product-sidebar" data-mode={sidebarMode}>
          <a href="#overview" className="product-brand">
            stakeframe<span>.</span>
          </a>
          {/* Hardening: o CTA "+ Nova aposta" da sidebar saiu — o cabeçalho já
              tem o botão, e dois controles com o mesmo nome acessível quebram o
              alvo (strict mode do Playwright) e confundem quem usa leitor de tela. */}
          {/* STK-F3-01 — a sidebar tem UM `nav` só, com as categorias
              dentro dele. Não são quatro `nav`: os quatro seriam quatro listas
              de mesmo peso para o leitor de tela, e a barra inferior do mobile
              (que é este mesmo `nav`) precisa de UM elemento com a grade
              explícita que o teste de navegador mede. As categorias são
              `<section>` com `aria-label`, não navegação — elas não mudam de
              contexto, só seccionam. */}
          <nav aria-label="Navegação principal">
            {sidebarGroups.map((group) => (
              <section className="sidebar-group" key={group.caption} aria-label={group.caption}>
                <p className="sidebar-caption">{group.caption}</p>
                {/* STK-F3-01 — a categoria Polymarket é a única que NÃO é uma
                    lista de ids. Ranking global, Favoritos e Simulação têm
                    telas; Telegram fica reservado. A ordem é a do card —
                    Ranking global, Favoritos, Telegram, Simulação
                    — e a lista `polymarketItems` é a que a garante; deixá-la
                    espalhada por condicionais dentro do mapa era a forma de a
                    ordem depender de onde alguém-editaria o arquivo. */}
                {group.caption === 'POLYMARKET'
                  ? polymarketItems.map((entry) =>
                      'reserved' in entry ? (
                        <ReservedDestination key={entry.id} icon={entry.icon} title={entry.title} />
                      ) : (
                        <a
                          key={entry.id}
                          href={`#${entry.id}`}
                          aria-current={
                            page === entry.id || (entry.id === 'pm-global' && page === 'pm-tipster')
                              ? 'page'
                              : undefined
                          }
                        >
                          <span className="nav-icon">
                            <NavGlyph icon={entry.icon} />
                          </span>
                          <span className="nav-label">{entry.title}</span>
                          {'count' in entry ? <FavoritesBadge /> : null}
                        </a>
                      ),
                    )
                  : group.ids.map((id) => {
                      const item = navigation.find((entry) => entry.id === id)!;
                      return (
                        <a
                          key={item.id}
                          href={`#${item.id}`}
                          aria-current={page === item.id ? 'page' : undefined}
                        >
                          <span className="nav-icon">
                            <NavGlyph icon={item.icon} />
                          </span>
                          <span className="nav-label">{item.title}</span>
                          {'count' in item ? <FavoritesBadge /> : null}
                        </a>
                      );
                    })}
              </section>
            ))}
          </nav>
          <SidebarFooter mode={sidebarMode} onChange={setSidebarMode} />
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
            <Button
              disabled={!workspace.initialized || !!actions.pending}
              onClick={() => open({ kind: 'bet' })}
            >
              + Nova aposta
            </Button>
          </div>
        </header>
        <main className="product-main" id="product-main" tabIndex={-1}>
          <div
            className={`page-heading${page === 'bets' ? ' bets-page-heading' : ''}${page === 'finance' ? ' finance-page-heading' : ''}`}
          >
            <div>
              <p className={`product-eyebrow${page === 'overview' ? ' dashboard-date' : ''}`}>
                STAKEFRAME /{' '}
                {new Intl.DateTimeFormat('pt-BR', {
                  timeZone: 'America/Sao_Paulo',
                  month: 'long',
                  year: 'numeric',
                }).format(new Date())}
              </p>
              <h1>
                {page === 'overview' && !onboardingActive
                  ? 'Dashboard'
                  : onboardingActive
                    ? 'Primeiros passos'
                    : page === 'imports'
                      ? 'Recebimentos técnicos'
                      : // STK-F3-01: uma rota da categoria Polymarket não tem item
                        // em `navigation` (ela vive em `polymarketItems`, para
                        // não aparecer duas vezes), então o título vem de
                        // `pageTitles` — e, no caso de uma rota RESERVADA, a
                        // página logo abaixo diz que ela ainda não existe. Um
                        // `!` aqui derrubaria a tela inteira para quem abrir um
                        // link guardado para o futuro, e um `?? ''` mostraria
                        // um `h1` vazio numa tela que existe.
                        (items.find((item) => item.id === page) ?? pageTitles[page as Page])?.title}
              </h1>
            </div>
            <span className={`live-label${page === 'overview' ? ' dashboard-live-label' : ''}`}>
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
          ) : page === 'pm-favorites' ? (
            // STK-F3-01: Favoritos deixa de ser SEÇÃO do ranking e vira
            // DESTINO. A tela é a MESMA seção da F2-16 — nenhuma regra foi
            // reescrita —; o que muda é que ela agora tem endereço próprio e
            // aparece na navegação. Continua sem `workspace` pelo mesmo
            // motivo do ranking: quem guarda uma carteira pública escolhe uma
            // carteira, não um espaço de trabalho.
            <PolymarketFavoritesPage />
          ) : page === 'pm-simulation' ? (
            // STK-F3-01: a simulação também vira destino. A JANELA é a padrão
            // do produto (a mesma de `POLYMARKET_DEFAULT_WINDOW`) porque a
            // tela deixou de estar abaixo do ranking — herdar a janela do
            // ranking por contexto deixou de existir, e repetir os três
            // `select` aqui devolveria dois controles com o mesmo rótulo
            // acessível na mesma tela.
            //
            // `limit` não entra: ele limita a QUANTIDADE de linhas do
            // leaderboard, que é do ranking, e a simulação não pede tabela.
            <PolymarketSimulationPage
              window={{
                ...POLYMARKET_DEFAULT_WINDOW,
                limit: POLYMARKET_RANKING_LIMIT,
              }}
            />
          ) : page === 'pm-tipster' ? (
            <PolymarketTipsterPage wallet={tipsterWallet} />
          ) : page === 'pm-global' ? (
            // STK-F3-04: a tela Global do Polymarket em CARDS de tipster, só
            // esportes e e-sports. Sem `workspace` pelo mesmo motivo do
            // ranking: é dado público, idêntico para qualquer conta, e ligar
            // a lista a um tenant abriria espaço para impersonação.
            //
            // A integração está PENDENTE (gate F2-18 não autorizado) e a
            // tela usa os dados locais de `polymarket-global-data.ts`, que
            // passam pelo mesmo contrato que um payload real passaria.
            <PolymarketGlobalPage />
          ) : reservedPages.has(page) ? (
            <ReservedPage title={pageTitles[page as Page]!.title} />
          ) : page === 'reports' ? (
            // STK-F2-08: a página do relatório privado. Ela não recebe o
            // `workspace` porque é a ÚNICA tela do produto que lê o SNAPSHOT
            // congelado em vez do estado atual — e é autenticada pelo mesmo
            // caminho das demais.
            <ReportsPage />
          ) : page === 'profile' ? (
            <ProfilePage
              name={owner.name}
              signingOut={logout.isPending}
              onSignOut={() => logout.mutate()}
            />
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

const profileAvatarColors = [
  'blue',
  'mint',
  'orange',
  'red',
  'purple',
  'pink',
  'cyan',
  'teal',
  'lime',
] as const;
type ProfileAvatarColor = (typeof profileAvatarColors)[number];
const profileAvatarColorNames: Record<ProfileAvatarColor, string> = {
  blue: 'azul',
  mint: 'menta',
  orange: 'laranja',
  red: 'vermelho',
  purple: 'roxo',
  pink: 'rosa',
  cyan: 'ciano',
  teal: 'turquesa',
  lime: 'lima',
};
const profileAvatarColorKey = 'stakeframe.profile.avatar-color';
const profileAvatarImageKey = 'stakeframe.profile.avatar-image';

function ProfilePage({
  name,
  signingOut,
  onSignOut,
}: {
  name: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState(name);
  const [avatarColor, setAvatarColor] = useState<ProfileAvatarColor>(() => {
    try {
      const saved = window.localStorage.getItem(profileAvatarColorKey);
      return profileAvatarColors.find((color) => color === saved) ?? 'blue';
    } catch {
      return 'blue';
    }
  });
  const [avatarImage, setAvatarImage] = useState(() => {
    try {
      return window.localStorage.getItem(profileAvatarImageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = displayName.trim();
    if (!value) {
      setError('Informe o nome que deve aparecer no seu perfil.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await request('/api/v1/onboarding', onboardingStatusSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'profile', displayName: value, timezone }),
      });
      await client.invalidateQueries({ queryKey: ['owner-session'] });
      setMessage('Perfil atualizado.');
    } catch {
      setError('Não foi possível salvar o perfil. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };
  const chooseAvatarColor = (color: ProfileAvatarColor) => {
    setAvatarColor(color);
    try {
      window.localStorage.setItem(profileAvatarColorKey, color);
    } catch {
      setMessage('A cor foi aplicada nesta sessão, mas não pôde ser salva neste dispositivo.');
    }
  };
  const chooseAvatarImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 600_000) {
      setError('Escolha uma imagem de até 600 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      try {
        window.localStorage.setItem(profileAvatarImageKey, reader.result);
        setAvatarImage(reader.result);
        setError('');
        setMessage('Imagem salva neste dispositivo.');
      } catch {
        setError('Não foi possível salvar a imagem neste dispositivo.');
      }
    };
    reader.onerror = () => setError('Não foi possível abrir essa imagem.');
    reader.readAsDataURL(file);
  };
  const useInitials = () => {
    setAvatarImage('');
    try {
      window.localStorage.removeItem(profileAvatarImageKey);
    } catch {
      // A imagem só muda nesta sessão se o navegador bloquear o armazenamento local.
    }
  };
  return (
    <div className="profile-reference-page">
      <p className="profile-reference-subtitle">QUEM VOCÊ É E COMO ACESSA SUA CONTA</p>
      <div className="profile-reference-layout">
        <section className="profile-reference-identity" aria-labelledby="profile-identity-title">
          <h2 id="profile-identity-title">IDENTIDADE</h2>
          <div className="profile-reference-divider" />
          <div className="profile-field-label">AVATAR</div>
          <div className="profile-avatar-editor">
            <div
              className={`profile-avatar profile-avatar-${avatarColor}`}
              aria-label={`Avatar de ${displayName}`}
            >
              {avatarImage ? <img src={avatarImage} alt="" /> : initials}
            </div>
            <div className="profile-avatar-actions">
              <button
                className={!avatarImage ? 'is-active' : ''}
                type="button"
                onClick={useInitials}
                aria-pressed={!avatarImage}
              >
                INICIAIS
              </button>
              <label className="profile-upload-image">
                ENVIAR IMAGEM
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={chooseAvatarImage}
                />
              </label>
            </div>
          </div>
          <div className="profile-field-label">COR DO AVATAR</div>
          <div className="profile-avatar-palette" role="group" aria-label="Cor do avatar">
            {profileAvatarColors.map((color) => (
              <button
                key={color}
                type="button"
                className={`profile-avatar-swatch profile-avatar-swatch-${color}`}
                aria-label={`Cor ${profileAvatarColorNames[color]}`}
                aria-pressed={avatarColor === color}
                onClick={() => chooseAvatarColor(color)}
              />
            ))}
          </div>
          <form className="profile-reference-form" onSubmit={(event) => void saveProfile(event)}>
            <label className="profile-field-label" htmlFor="profile-display-name">
              NOME
            </label>
            <input
              id="profile-display-name"
              maxLength={120}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <p>Este nome aparece na sua conta e nos registros compartilhados.</p>
            <label className="profile-field-label" htmlFor="profile-username">
              NOME DE USUÁRIO
            </label>
            <div className="profile-locked-field">
              <input id="profile-username" value="Não definido" readOnly />
              <span aria-hidden="true">⌑</span>
            </div>
            <p>O Stakeframe ainda não oferece um nome de usuário público.</p>
            {error ? (
              <p className="profile-feedback is-error" role="alert">
                {error}
              </p>
            ) : null}
            {message ? (
              <p className="profile-feedback" role="status">
                {message}
              </p>
            ) : null}
            <button className="profile-save-button" type="submit" disabled={saving}>
              {saving ? 'SALVANDO…' : 'SALVAR ALTERAÇÕES'}
            </button>
          </form>
        </section>
        <section className="profile-reference-access" aria-labelledby="profile-access-title">
          <h2 id="profile-access-title">ACESSO</h2>
          <div className="profile-reference-divider" />
          <div className="profile-reference-access-row">
            <span>E-MAIL</span>
            <strong>Protegido pelo provedor</strong>
            <b>PRIVADO</b>
          </div>
          <div className="profile-reference-access-row">
            <span>SENHA</span>
            <strong>Gerenciada pela conta Google</strong>
            <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">
              GERENCIAR
            </a>
          </div>
          <div className="profile-reference-access-row">
            <span>ÚLTIMO ACESSO</span>
            <strong>Não informado</strong>
          </div>
          <div className="profile-reference-access-row">
            <span>MEMBRO DESDE</span>
            <strong>Data indisponível</strong>
          </div>
          <p className="profile-reference-note">
            O Stakeframe não recebe seu e-mail nem a senha da conta Google. Esses dados são
            gerenciados pelo provedor de acesso.
          </p>
        </section>
      </div>
      <section className="profile-danger-zone" aria-labelledby="profile-danger-title">
        <h2 id="profile-danger-title">ZONA DE PERIGO</h2>
        <div className="profile-danger-content">
          <div>
            <strong>Sair da conta</strong>
            <p>Encerre sua sessão neste dispositivo. Seus registros permanecem na conta.</p>
          </div>
          <button type="button" disabled={signingOut} onClick={onSignOut}>
            {signingOut ? 'SAINDO…' : 'SAIR DA CONTA'}
          </button>
        </div>
      </section>
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
      {/* STK-F2-18 (Fase 4): as 4 métricas de POSIÇÃO. Saldo, disponível e
          exposição são três leituras do mesmo instante e ficam no mesmo plano;
          `exposure` é o único que é promessa — dinheiro que só volta se a aposta
          ganhar. Restauradas no hardening do redesign: a Visão geral tinha
          ficado sem estes rótulos, que são contrato das specs e2e e do Mini App. */}
      <div className="metric-grid">
        <Metric
          label="Saldo em conta"
          value={formatBRL(workspace.bankroll)}
          detail="Reserva e saldo somados nas casas"
          featured
        />
        <Metric
          label="Disponível para apostar"
          value={formatBRL(workspace.available)}
          detail="Saldo menos o que está em jogo"
        />
        <Metric
          label="Exposição em aberto"
          value={formatBRL(workspace.exposure)}
          detail="Principal real ainda no jogo"
          commitment
        />
        <Metric
          label="Unidade do mês"
          value={unit ? formatBRL(unit.amount) : 'A conferir'}
          detail={unit ? 'Valor congelado durante o mês' : 'Cadastre os saldos para começar'}
        />
      </div>
      <OverviewReport version={workspace.version} workspace={workspace} />
      <div className="panel overview-accounts">
        <div className="section-heading">
          <div>
            <h2>Onde está sua banca</h2>
            <p>Saldo disponível por conta</p>
          </div>
          <a className="text-link" href="#finance">
            Ver movimentações
          </a>
        </div>
        <div className="account-grid">
          {workspace.accounts.map((account) => (
            <div className="account-card" key={account.id}>
              <span className="account-icon" aria-hidden="true">
                {account.kind === 'reserve' ? 'R$' : account.name.trim().charAt(0).toUpperCase()}
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
      <BetsPage workspace={workspace} open={open} owner={owner} compact />
    </>
  );
}
export function Metric({
  label,
  value,
  detail,
  featured = false,
  commitment = false,
}: {
  label: string;
  value: string;
  detail: string;
  featured?: boolean;
  /** Exposição: dinheiro que só volta se a aposta ganhar. */
  commitment?: boolean;
}) {
  const negative = value.includes('−');
  return (
    <div className={`metric-card${featured ? ' featured' : ''}${commitment ? ' committed' : ''}`}>
      <span>{label}</span>
      <strong className={negative ? 'negative' : undefined}>{value}</strong>
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
          {...(modal.amount ? { initialAmount: modal.amount } : {})}
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
    <Dialog
      title={title}
      {...(modal.kind === 'settings'
        ? { description: 'Defina o percentual que vai orientar a unidade dos próximos meses.' }
        : {})}
      open
      onClose={close}
    >
      {content}
    </Dialog>
  );
}
