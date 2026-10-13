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
  betPageSchema,
  reportSchema,
  saoPauloDate,
  POLYMARKET_DEFAULT_WINDOW,
  POLYMARKET_RANKING_LIMIT,
  type Workspace,
  type Bet,
  type CatalogItem,
  type ReleaseInfo,
} from '@stakeframe/shared';
import { authAction } from '../OwnerAccess.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { ProductErrorIcon } from './product-error-icon.js';
import { ActionProvider, PendingOperation, useFinanceActions } from './actions.js';
import { request, type CommandInput } from './api.js';
import {
  displayCurrencyReady,
  fetchReferenceRates,
  formatDisplayDate,
  formatDisplayMoney,
  formatDisplayOdds,
  displayTimeZone,
  readDisplayPreferences,
  referenceRateDate,
  setReferenceRates,
} from './preferences.js';
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
import {
  BetsPage,
  BetEditPage,
  BetTrackBetDetailPage,
  BetDetails,
  FinancePage,
  SettingsPage,
  BetTrackSettingsPage,
} from './pages.js';
import { BetDrawer } from './bet-drawer.js';
import { ticketSportLabel } from './sports.js';
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
import { TelegramLinkPanel } from './telegram-link.js';
import { NavGlyph, type NavIcon } from './nav-icons.js';
import { BetTrackSidebar, TopBar } from './app-shell.js';
import { readSidebarMode, writeSidebarMode, type SidebarMode } from './sidebar-mode.js';
import { observeUiLanguage } from './ui-translation.js';
import './product.css';
const AnalyticsPage = lazy(() => import('./analytics.js'));
const BetTrackAnalyticsPage = lazy(() =>
  import('./analytics.js').then((module) => ({ default: module.BetTrackAnalyticsPage })),
);

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
  | { kind: 'bet'; bet?: Bet; financialEditAllowed?: boolean }
  | { kind: 'detail'; id: string }
  | { kind: 'settle'; bet: Bet; outcome?: 'win' | 'loss' | 'void' | 'cashout' }
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
 * A categoria Polymarket tem telas de ranking global, Favoritos, Telegram e
 * Simulação.
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
  | 'new-bet'
  | 'hedge'
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
  { id: 'pm-telegram', title: 'Telegram', icon: 'telegram' },
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
const reservedPages = new Set<Page>();

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
  'new-bet': { title: 'New Bet' },
  hedge: { title: 'Hedge' },
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

function currentPage(): Page {
  const tipster = location.hash.match(/^#\/polymarket\/tipster\/(0x[a-f\d]{40})$/i);
  if (tipster) return 'pm-tipster';
  const hash = location.hash.slice(1);
  if (/^bets\/edit\/[0-9a-f-]{36}(?:\?.*)?$/i.test(hash)) return 'bets';
  if (/^bets\/[0-9a-f-]{36}(?:\?.*)?$/i.test(hash)) return 'bets';
  if (hash === 'bets/new' || hash.startsWith('bets/new?')) return 'new-bet';
  const id = hash.split('?')[0] ?? '';
  if (id === 'hedge') return 'hedge';
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
function currentBetEditId() {
  return location.hash.match(/^#bets\/edit\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] ?? '';
}
function currentBetDetailId() {
  return location.hash.match(/^#bets\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] ?? '';
}
function currentBetEditAmountMode(): 'money' | 'units' {
  const mode = new URLSearchParams(location.hash.split('?')[1] ?? '').get('mode');
  if (mode === 'money' || mode === 'units') return mode;
  return window.sessionStorage.getItem('bettrack:bet-edit-amount-mode') === 'money'
    ? 'money'
    : 'units';
}
function currentTipsterWallet() {
  return location.hash.match(/^#\/polymarket\/tipster\/(0x[a-f\d]{40})$/i)?.[1] ?? '';
}

function NewBetPage({
  workspace,
  onStepChange,
}: {
  workspace: Workspace;
  onStepChange: (step: number) => void;
}) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const initialStake = params.get('stake') ?? undefined;
  const initialOdds = params.get('odds') ?? undefined;
  const done = () => {
    window.location.hash = '#bets';
  };
  return (
    <section className="new-bet-reference-page">
      <BetForm
        workspace={workspace}
        referenceLayout
        onStepChange={onStepChange}
        {...(initialStake ? { initialStake } : {})}
        {...(initialOdds ? { initialOdds } : {})}
        onDone={done}
      />
    </section>
  );
}

function HedgePage({
  workspace,
  onStepChange,
}: {
  workspace: Workspace;
  onStepChange: (step: number) => void;
}) {
  const requestedBetId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('betId') ?? '';
  const params = new URLSearchParams({ page: '1', pageSize: '100' }).toString();
  const betsQuery = useQuery({
    queryKey: ['product', 'bets', workspace.version, params],
    queryFn: () => request(`/api/v1/bets?${params}`, betPageSchema),
  });
  const openBets = betsQuery.data?.items.filter((bet) => bet.state === 'open') ?? [];
  const [selectedId, setSelectedId] = useState('');
  const [inputMode, setInputMode] = useState<'existing' | 'manual'>('existing');
  const [step, setStep] = useState(0);
  const [stake, setStake] = useState('');
  const [odds, setOdds] = useState('');
  const [oppositeOdds, setOppositeOdds] = useState('');
  const changeStep = (next: number) => {
    setStep(next);
    onStepChange(next);
  };
  useEffect(() => {
    if (selectedId || !openBets.length) return;
    const first = openBets.find((bet) => bet.id === requestedBetId) ?? openBets[0];
    if (!first) return;
    setSelectedId(first.id);
    setStake(first.stake ?? '');
    setOdds(first.odds ?? '');
  }, [openBets, requestedBetId, selectedId]);
  const selected = openBets.find((bet) => bet.id === selectedId);
  const toNumber = (value: string) => Number(value.replace(',', '.'));
  const originalStake = toNumber(
    inputMode === 'existing' && selected ? (selected.stake ?? '') : stake,
  );
  const originalOdds = toNumber(
    inputMode === 'existing' && selected ? (selected.odds ?? '') : odds,
  );
  const otherOdds = toNumber(oppositeOdds);
  const hedgeStake =
    originalStake > 0 && originalOdds > 1 && otherOdds > 1
      ? (originalStake * originalOdds) / otherOdds
      : 0;
  const guaranteed = hedgeStake > 0 ? hedgeStake * (otherOdds - 1) - originalStake : 0;
  const canCalculate = originalStake > 0 && originalOdds > 1 && otherOdds > 1;
  const updateBet = (id: string) => {
    setSelectedId(id);
    const bet = openBets.find((item) => item.id === id);
    if (bet) {
      setStake(bet.stake ?? '');
      setOdds(bet.odds ?? '');
    }
  };
  const logHedge = () => {
    const query = new URLSearchParams({ stake: hedgeStake.toFixed(2), odds: oppositeOdds });
    window.location.hash = `#bets/new?${query.toString()}`;
  };
  const selection = selected?.selections[0];
  const sourceStake = inputMode === 'existing' && selected ? (selected.stake ?? '') : stake;
  const sourceOdds = inputMode === 'existing' && selected ? (selected.odds ?? '') : odds;
  const canStart = inputMode === 'existing' ? !!selected : originalStake > 0 && originalOdds > 1;
  return (
    <section className="hedge-reference-page">
      <div className="hedge-reference-progress" aria-label="Hedge calculator steps">
        {['START', 'ODDS', 'DECIDE'].map((label, index) => (
          <button
            key={label}
            type="button"
            className={index === step ? 'is-current' : index < step ? 'is-complete' : ''}
            onClick={() => index < step && changeStep(index)}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div className="hedge-reference-layout">
        <div className="hedge-reference-main">
          {step === 0 ? (
            <>
              <h2>What are we calculating on?</h2>
              <p>
                You can start from a bet you already logged, or just run the numbers without logging
                anything.
              </p>
              <div className="hedge-reference-grid">
                <button
                  type="button"
                  className={`hedge-reference-card hedge-mode-card${inputMode === 'existing' ? ' is-selected' : ''}`}
                  onClick={() => setInputMode('existing')}
                >
                  <strong>ONE OF MY BETS</strong>
                  <small>{openBets.length} OPEN</small>
                  <span>
                    It brings the bet's odds and amount, and at the end it can log the hedge next to
                    it.
                  </span>
                </button>
                <button
                  type="button"
                  className={`hedge-reference-card hedge-mode-card${inputMode === 'manual' ? ' is-selected' : ''}`}
                  onClick={() => setInputMode('manual')}
                >
                  <strong>NUMBERS ONLY</strong>
                  <small>LOGS NOTHING</small>
                  <span>
                    You type the odds and amount by hand. Good for testing the water before betting,
                    or for a bet that isn't in the app.
                  </span>
                </button>
              </div>
              {inputMode === 'existing' ? (
                <div className="hedge-pick-list">
                  <span className="hedge-reference-kicker">PICK WHICH ONE</span>
                  {openBets.length ? (
                    openBets.map((bet) => (
                      <button
                        key={bet.id}
                        type="button"
                        className={`hedge-pick-row${selectedId === bet.id ? ' is-selected' : ''}`}
                        onClick={() => updateBet(bet.id)}
                      >
                        <b>{bet.selections[0]?.sport?.slice(0, 3).toUpperCase() || 'OTH'}</b>
                        <span>
                          <strong>{bet.selections[0]?.selection || 'Untitled bet'}</strong>
                          <small>
                            {bet.selections[0]?.event || bet.reference || 'Open ticket'}
                          </small>
                        </span>
                        <em>
                          {formatDisplayOdds(bet.odds)}
                          <small>{formatDisplayMoney(bet.stake ?? '0.00')}</small>
                        </em>
                      </button>
                    ))
                  ) : (
                    <p className="hedge-empty">
                      No open bets yet. Use Numbers only to calculate by hand.
                    </p>
                  )}
                </div>
              ) : (
                <div className="hedge-reference-pair hedge-manual-fields">
                  <label className="hedge-field">
                    <span>AMOUNT</span>
                    <input
                      inputMode="decimal"
                      value={stake}
                      onChange={(event) => setStake(event.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                  <label className="hedge-field">
                    <span>YOUR ODDS</span>
                    <input
                      inputMode="decimal"
                      value={odds}
                      onChange={(event) => setOdds(event.target.value)}
                      placeholder="2.00"
                    />
                  </label>
                </div>
              )}
            </>
          ) : step === 1 ? (
            <section className="hedge-reference-card hedge-odds-card">
              <h2>What are the odds on the other side?</h2>
              <p>Enter the decimal odds for the opposite outcome.</p>
              <label className="hedge-field">
                <span>OPPOSITE ODDS</span>
                <input
                  autoFocus
                  inputMode="decimal"
                  value={oppositeOdds}
                  onChange={(event) => setOppositeOdds(event.target.value)}
                  placeholder="2.00"
                />
              </label>
              {!canCalculate && oppositeOdds ? (
                <p className="hedge-validation">Use odds above 1.00 and an amount above zero.</p>
              ) : null}
            </section>
          ) : (
            <section className="hedge-reference-card hedge-result-card">
              <span className="hedge-reference-kicker">THE TWO SIDES TOGETHER</span>
              <h2>
                {guaranteed >= 0 ? 'HEDGING LEAVES YOU' : 'HEDGING COSTS YOU'}{' '}
                {formatDisplayMoney(Math.abs(guaranteed).toFixed(2))} GUARANTEED
              </h2>
              <p>
                Stake {formatDisplayMoney(hedgeStake.toFixed(2))} on the opposite side. The estimate
                uses the odds and amount you entered.
              </p>
              <dl>
                <div>
                  <dt>HEDGE STAKE</dt>
                  <dd>{formatDisplayMoney(hedgeStake.toFixed(2))}</dd>
                </div>
                <div>
                  <dt>GUARANTEED RESULT</dt>
                  <dd>
                    {guaranteed >= 0 ? '+' : '−'}
                    {formatDisplayMoney(Math.abs(guaranteed).toFixed(2))}
                  </dd>
                </div>
              </dl>
              <button type="button" className="hedge-log-button" onClick={logHedge}>
                LOG THE HEDGE
              </button>
            </section>
          )}
          <div className="hedge-reference-actions">
            {step > 0 ? (
              <button type="button" onClick={() => changeStep(Math.max(0, step - 1))}>
                BACK
              </button>
            ) : null}
            {step < 2 ? (
              <button
                type="button"
                disabled={step === 0 ? !canStart : !canCalculate}
                onClick={() => changeStep(Math.min(2, step + 1))}
              >
                CONTINUE
              </button>
            ) : null}
          </div>
        </div>
        <aside className="hedge-reference-preview">
          <span className="hedge-reference-kicker">THE ONE YOU'RE HEDGING</span>
          <div className="hedge-preview-card">
            <strong>
              {selection?.sport?.slice(0, 3).toUpperCase() ||
                (inputMode === 'manual' ? 'MANUAL' : '—')}
            </strong>
            <h3>
              {selection?.selection ||
                (inputMode === 'manual' ? 'Your selection' : 'Choose an open bet')}
            </h3>
            <p>
              {selection?.event || (inputMode === 'manual' ? 'Numbers only' : 'Your logged ticket')}
            </p>
            <dl>
              <div>
                <dt>ODDS</dt>
                <dd>{formatDisplayOdds(sourceOdds)}</dd>
              </div>
              <div>
                <dt>AMOUNT</dt>
                <dd>{sourceStake ? formatDisplayMoney(sourceStake) : '—'}</dd>
              </div>
              <div>
                <dt>IF IT WINS ALONE</dt>
                <dd>
                  {originalStake > 0 && originalOdds > 1
                    ? formatDisplayMoney((originalStake * (originalOdds - 1)).toFixed(2))
                    : '—'}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </section>
  );
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
        {workspace.isError ? (
          <div className="notice warning product-error-alert" role="alert">
            <ProductErrorIcon />
            <div>
              <p>Não foi possível carregar seus registros.</p>
              <Button onClick={() => void workspace.refetch()}>Tentar novamente</Button>
            </div>
          </div>
        ) : (
          <p role="status">Carregando seus registros…</p>
        )}
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
  const [analyticsDetail, setAnalyticsDetail] = useState(false);
  const [betEditId, setBetEditId] = useState(currentBetEditId);
  const [betDetailId, setBetDetailId] = useState(currentBetDetailId);
  const [betEditAmountMode, setBetEditAmountMode] = useState(currentBetEditAmountMode);
  const [flowStep, setFlowStep] = useState(0);
  const [tipsterWallet, setTipsterWallet] = useState(currentTipsterWallet);
  const [modal, setModal] = useState<Modal | null>(null);
  const [, setPreferencesRevision] = useState(0);
  // STK-F3-01 — o modo da sidebar é estado do CASCA, não do conteúdo: sobrevive
  // à troca de página e é lido do storage uma vez, na montagem. A leitura é
  // preguiçosa de propósito — o valor inicial só importa na primeira
  // renderização, e reler a cada render faria a sidebar piscar entre o modo
  // gravado e o padrão enquanto o usuário navega.
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    readSidebarMode(typeof window === 'undefined' ? null : window.localStorage),
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    return observeUiLanguage(document.body);
  }, []);
  useEffect(() => setMobileNavOpen(false), [page]);
  const referenceRates = useQuery({
    queryKey: ['product', 'display-currency-rates', 'BRL'],
    queryFn: fetchReferenceRates,
    staleTime: 12 * 60 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    setReferenceRates(referenceRates.data ?? null);
    setPreferencesRevision((revision) => revision + 1);
  }, [referenceRates.data]);
  useEffect(() => {
    const applyPreferences = () => {
      const preferences = readDisplayPreferences();
      document.documentElement.lang = preferences.language;
      setPreferencesRevision((revision) => revision + 1);
    };
    applyPreferences();
    window.addEventListener('bettrack:preferences', applyPreferences);
    return () => window.removeEventListener('bettrack:preferences', applyPreferences);
  }, []);
  const actions = useFinanceActions();
  const client = useQueryClient();
  const onboarding = useQuery({
    queryKey: ['product', 'onboarding'],
    queryFn: () => request('/api/v1/onboarding', onboardingStatusSchema),
    refetchInterval: 30_000,
  });
  const dashboardToday = saoPauloDate(new Date());
  const dashboardMonth = dashboardToday.slice(0, 7);
  const dashboardBetsParams = new URLSearchParams({ page: '1', pageSize: '100' }).toString();
  const dashboardBets = useQuery({
    queryKey: ['product', 'bets', workspace.version, dashboardBetsParams],
    queryFn: () => request(`/api/v1/bets?${dashboardBetsParams}`, betPageSchema),
    enabled: variant === 'web' && (page === 'overview' || page === 'analytics'),
  });
  const dashboardReport = useQuery({
    queryKey: ['product', 'overview-report', dashboardMonth, workspace.version],
    queryFn: () =>
      request(`/api/v1/reports?from=${dashboardMonth}-01&to=${dashboardToday}`, reportSchema),
    enabled: variant === 'web' && (page === 'overview' || page === 'analytics'),
  });
  const [dashboardMode, setDashboardMode] = useState<'money' | 'units'>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'units' ? 'units' : 'money',
  );
  const [hideDashboardAmounts, setHideDashboardAmounts] = useState(false);
  const dashboardOpenCount = dashboardBets.data?.items.filter((bet) => bet.state === 'open').length;
  const dashboardSettledToday = dashboardReport.data?.timeline.find(
    (bucket) => bucket.date === dashboardToday,
  )?.metrics.settledBets;
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
      setAnalyticsDetail(false);
      setBetEditId(currentBetEditId());
      setBetDetailId(currentBetDetailId());
      setBetEditAmountMode(currentBetEditAmountMode());
      setTipsterWallet(currentTipsterWallet());
      setFlowStep(0);
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
        page === 'new-bet' ||
        page === 'hedge' ||
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
    if (variant === 'web' && value.kind === 'bet' && !value.bet) {
      window.location.hash = '#bets/new';
      return;
    }
    if (variant === 'web' && value.kind === 'detail') {
      window.location.hash = `#bets/${value.id}`;
      window.scrollTo(0, 0);
      return;
    }
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
     folha é dona da largura (`--sidebar-w` em tokens.css, com o override do
     tema web em product.css); o componente só publica o modo escolhido. */
  const shellClass =
    variant === 'mini'
      ? 'product-shell miniapp-shell'
      : `product-shell product-web-theme bettrack-theme sidebar-mode-${sidebarMode}`;
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
          brand="bettrack"
          collapsed={sidebarMode === 'collapsed'}
          mobileNavOpen={mobileNavOpen}
          onToggleMobileNav={() => setMobileNavOpen((open) => !open)}
          ownerName={owner.name}
          signingOut={logout.isPending}
          newBetDisabled={!workspace.initialized || !!actions.pending}
          onNewBet={() => {
            window.location.hash = '#bets/new';
          }}
          onSignOut={() => logout.mutate()}
          onToggleSidebar={() => {
            const next: SidebarMode = sidebarMode === 'collapsed' ? 'expanded' : 'collapsed';
            writeSidebarMode(typeof window === 'undefined' ? null : window.localStorage, next);
            setSidebarMode(next);
          }}
        />
      ) : null}
      {variant === 'web' ? (
        <BetTrackSidebar
          page={page}
          workspace={workspace}
          disabled={!workspace.initialized || !!actions.pending}
          mobileOpen={mobileNavOpen}
          onNavigate={() => setMobileNavOpen(false)}
          onNewBet={() => {
            window.location.hash = '#bets/new';
          }}
        />
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
            {/* No WEB este CTA vive no TopBar (cabecalho da skin, visivel em
                todas as larguras): aqui ele fica so para o Mini App, que nao
                monta o TopBar — assim existe exatamente UM controle com este
                nome acessivel por tela. */}
            {variant === 'mini' ? (
              <Button
                disabled={!workspace.initialized || !!actions.pending}
                onClick={() => open({ kind: 'bet' })}
              >
                + Nova aposta
              </Button>
            ) : null}
          </div>
        </header>
        <main
          className={`product-main bettrack-page-${page}${betEditId ? ' bettrack-ticket-edit-page' : ''}${betDetailId ? ' bettrack-ticket-detail-route' : ''}`}
          id="product-main"
          tabIndex={-1}
        >
          <div
            className={`page-heading${page === 'bets' ? ' bets-page-heading' : ''}${page === 'finance' ? ' finance-page-heading' : ''}${page === 'analytics' ? ' analytics-page-heading' : ''}${page === 'settings' ? ' settings-page-heading' : ''}${page === 'new-bet' ? ' new-bet-page-heading' : ''}${page === 'hedge' ? ' hedge-page-heading' : ''}`}
          >
            <div>
              <p className={`product-eyebrow${page === 'overview' ? ' dashboard-date' : ''}`}>
                {page === 'new-bet' && variant === 'web'
                  ? `STEP ${flowStep + 1} OF 3 · ${['BET TYPE', 'DETAILS', 'AMOUNT AND SOURCE'][flowStep] ?? 'BET TYPE'}`
                  : page === 'hedge' && variant === 'web'
                    ? `STEP ${flowStep + 1} OF 3 · ${['WHERE WE START', 'THE OTHER ODDS', 'THE DECISION'][flowStep] ?? 'WHERE WE START'}`
                    : page === 'analytics' && variant === 'web'
                      ? `${dashboardReport.data?.metrics.settledBets ?? '—'} SETTLED BETS · SINCE ${formatDisplayDate(dashboardReport.data?.timeline.find((bucket) => bucket.metrics.settledBets > 0)?.date ?? dashboardToday, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase()}`
                      : page === 'settings' && variant === 'web'
                        ? 'HOW THE APP BEHAVES WITH YOU'
                        : page === 'overview' && variant === 'web'
                          ? `TODAY · ${dashboardOpenCount ?? '—'} OPEN · ${dashboardSettledToday === undefined ? 'LOADING RESULTS' : dashboardSettledToday === 0 ? 'NONE SETTLED THAT DAY' : `${dashboardSettledToday} SETTLED TODAY`}`
                          : `STAKEFRAME / ${formatDisplayDate(new Date().toISOString(), { month: 'long', year: 'numeric' })}`}
              </p>
              <h1>
                {onboardingActive
                  ? 'Primeiros passos'
                  : variant === 'web'
                    ? {
                        overview: 'DASHBOARD',
                        bets: 'BETS',
                        'new-bet': 'NEW BET',
                        hedge: 'HEDGE A BET',
                        finance: 'BANKROLL',
                        analytics: 'ANALYTICS',
                        settings: 'SETTINGS',
                        profile: 'PROFILE',
                        calendar: 'CALENDAR',
                        reports: 'REPORTS',
                        imports: 'INBOX',
                        'pm-global': 'GLOBAL RANKING',
                        'pm-favorites': 'FAVORITES',
                        'pm-telegram': 'TELEGRAM',
                        'pm-simulation': 'SIMULATION',
                        'pm-tipster': 'TIPSTER',
                      }[page]
                    : page === 'overview'
                      ? 'Painel'
                      : page === 'imports'
                        ? 'Recebimentos técnicos'
                        : (items.find((item) => item.id === page) ?? pageTitles[page as Page])
                            ?.title}
              </h1>
            </div>
            {page === 'overview' && variant === 'web' ? (
              <div className="bettrack-dashboard-actions" aria-label="Dashboard display options">
                <button
                  type="button"
                  className="bets-visibility-toggle"
                  aria-label={hideDashboardAmounts ? 'Show amounts' : 'Hide amounts'}
                  aria-pressed={hideDashboardAmounts}
                  onClick={() => setHideDashboardAmounts((hidden) => !hidden)}
                >
                  <span aria-hidden="true">◉</span>
                </button>
                <div className="bets-mode-toggle" role="group" aria-label="Show in money or units">
                  <button
                    type="button"
                    className={dashboardMode === 'money' ? 'is-active' : ''}
                    aria-pressed={dashboardMode === 'money'}
                    onClick={() => setDashboardMode('money')}
                  >
                    $
                  </button>
                  <button
                    type="button"
                    className={dashboardMode === 'units' ? 'is-active' : ''}
                    aria-pressed={dashboardMode === 'units'}
                    onClick={() => setDashboardMode('units')}
                  >
                    U
                  </button>
                </div>
              </div>
            ) : page === 'new-bet' && variant === 'web' ? (
              <button
                type="button"
                className="bettrack-page-close"
                aria-label="Close"
                onClick={() => {
                  window.location.hash = '#bets';
                }}
              >
                ×
              </button>
            ) : (
              <span className="live-label">
                <span className="private-dot" /> Personal records
              </span>
            )}
          </div>
          {logout.isError ? (
            <p role="alert" className="notice warning">
              Não foi possível sair. Tente novamente.
            </p>
          ) : null}
          <PendingOperation />
          {variant === 'web' && page === 'hedge' ? (
            <button
              type="button"
              className="bettrack-page-close"
              aria-label="Close"
              onClick={() => {
                window.location.hash = '#bets';
              }}
            >
              ×
            </button>
          ) : null}
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
            <Overview
              workspace={workspace}
              open={open}
              amountMode={dashboardMode}
              hideAmounts={hideDashboardAmounts}
              openBetCount={dashboardOpenCount}
            />
          ) : page === 'bets' ? (
            betEditId ? (
              <BetEditPage id={betEditId} workspace={workspace} amountMode={betEditAmountMode} />
            ) : betDetailId ? (
              <BetTrackBetDetailPage
                id={betDetailId}
                workspace={workspace}
                amountMode={betEditAmountMode}
                open={open}
              />
            ) : (
              <BetsPage workspace={workspace} open={open} owner={owner.id} />
            )
          ) : page === 'new-bet' ? (
            <NewBetPage workspace={workspace} onStepChange={setFlowStep} />
          ) : page === 'hedge' ? (
            <HedgePage workspace={workspace} onStepChange={setFlowStep} />
          ) : page === 'finance' ? (
            <FinancePage workspace={workspace} open={open} />
          ) : page === 'imports' ? (
            <ImportsPage workspace={workspace} open={open} />
          ) : page === 'calendar' ? (
            <CalendarPage workspace={workspace} open={open} />
          ) : page === 'analytics' ? (
            <Suspense fallback={<p role="status">Carregando análises…</p>}>
              {variant === 'web' ? (
                analyticsDetail ? (
                  <>
                    <button
                      className="ui-button ui-button-secondary"
                      type="button"
                      onClick={() => setAnalyticsDetail(false)}
                    >
                      Voltar à visão geral de análises
                    </button>
                    <AnalyticsPage workspace={workspace} open={open} />
                  </>
                ) : (
                  <BetTrackAnalyticsPage
                    workspace={workspace}
                    onOpenDetailed={() => setAnalyticsDetail(true)}
                  />
                )
              ) : (
                <AnalyticsPage workspace={workspace} open={open} />
              )}
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
            // A página consulta a série autenticada do backend. Sem ingestão,
            // a própria tela informa que o leaderboard ainda não está disponível.
            <PolymarketGlobalPage />
          ) : page === 'pm-telegram' ? (
            <TelegramLinkPanel />
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
          ) : variant === 'web' ? (
            <BetTrackSettingsPage workspace={workspace} open={open} />
          ) : (
            <SettingsPage workspace={workspace} open={open} />
          )}
        </main>
        <div className="product-footer">
          Seus movimentos, com contexto.
          <span>
            {(() => {
              const preferences = readDisplayPreferences();
              const currencyLabel =
                preferences.currency === 'BRL'
                  ? 'BRL'
                  : displayCurrencyReady()
                    ? `≈${preferences.currency} · ${referenceRateDate()}`
                    : `BRL · ${preferences.currency} rate unavailable`;
              return `${currencyLabel} · ${preferences.timezone}${releaseLabel}`;
            })()}
          </span>
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
  const timezone = displayTimeZone();
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
  amountMode,
  hideAmounts,
  openBetCount,
}: {
  workspace: Workspace;
  open: OpenModal;
  amountMode: 'money' | 'units';
  hideAmounts: boolean;
  openBetCount: number | undefined;
}) {
  const today = saoPauloDate(new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const unit = workspace.units.find((value) => value.month === today.slice(0, 7));
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
          value={formatDisplayMoney(workspace.bankroll)}
          detail="Reserva e saldo somados nas casas"
          featured
        />
        <Metric
          label="Disponível para apostar"
          value={formatDisplayMoney(workspace.available)}
          detail="Saldo menos o que está em jogo"
        />
        <Metric
          label="Exposição em aberto"
          value={formatDisplayMoney(workspace.exposure)}
          detail="Principal real ainda no jogo"
          commitment
        />
        <Metric
          label="Unidade do mês"
          value={unit ? formatDisplayMoney(unit.amount) : 'A conferir'}
          detail={unit ? 'Valor congelado durante o mês' : 'Cadastre os saldos para começar'}
        />
      </div>
      <OverviewReport
        version={workspace.version}
        workspace={workspace}
        amountMode={amountMode}
        hideAmounts={hideAmounts}
        openBetCount={openBetCount}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
      />
      <BetTrackDashboardBottom workspace={workspace} open={open} selectedDate={selectedDate} />
    </>
  );
}

function BetTrackDashboardBottom({
  workspace,
  open,
  selectedDate,
}: {
  workspace: Workspace;
  open: OpenModal;
  selectedDate: string;
}) {
  const params = new URLSearchParams({ page: '1', pageSize: '100' }).toString();
  const query = useQuery({
    queryKey: ['product', 'bets', workspace.version, params],
    queryFn: () => request(`/api/v1/bets?${params}`, betPageSchema),
  });
  const rows = query.data?.items ?? [];
  const openBets = rows.filter((bet) => bet.state === 'open');
  const todayBets = rows.filter((bet) =>
    bet.selections.some((selection) => {
      if (selection.eventAt) return saoPauloDate(new Date(selection.eventAt)) === selectedDate;
      return selection.dateStatus === 'confirmed' && selection.eventDate === selectedDate;
    }),
  );
  const sportCounts = new Map<string, number>();
  for (const bet of todayBets) {
    const sport = bet.selections[0]?.sport?.toUpperCase() || 'OTHER';
    sportCounts.set(sport, (sportCounts.get(sport) ?? 0) + 1);
  }
  return (
    <div className="bettrack-dashboard-bottom">
      <section className="bettrack-dashboard-widget">
        <header>
          <div>
            <h2>Open bets</h2>
            <span>{openBets.length} to settle</span>
          </div>
          <a href="#bets">VIEW ALL</a>
        </header>
        {openBets.length ? (
          <div className="bettrack-open-bet-list">
            {openBets.slice(0, 5).map((bet) => (
              <a href={`#bets/${bet.id}`} key={bet.id} className="bettrack-open-bet-row">
                <strong>
                  {bet.ticketKind === 'simple'
                    ? ticketSportLabel(bet.selections[0]?.sport ?? null)
                    : 'MULTI'}
                </strong>
                <span>
                  <b>{bet.selections[0]?.selection || bet.reference || 'Untitled bet'}</b>
                  <small>{bet.selections[0]?.event || bet.bookmakerId}</small>
                </span>
                <em>{formatDisplayMoney(bet.stake ?? '0')}</em>
              </a>
            ))}
          </div>
        ) : (
          <div className="bettrack-dashboard-empty">
            <h3>NO OPEN BETS</h3>
            <p>Open tickets appear here until they are settled.</p>
          </div>
        )}
      </section>
      <section className="bettrack-dashboard-widget">
        <header>
          <div>
            <h2>Breakdown</h2>
            <span>
              {selectedDate === saoPauloDate(new Date()) ? 'Today' : selectedDate} · by sport
            </span>
          </div>
          <button type="button" aria-label="Change breakdown">
            •••
          </button>
        </header>
        {sportCounts.size ? (
          <div className="bettrack-breakdown-list">
            {[...sportCounts].map(([sport, count]) => (
              <div key={sport}>
                <span>{sport}</span>
                <strong>
                  {count} BET{count === 1 ? '' : 'S'}
                </strong>
              </div>
            ))}
          </div>
        ) : (
          <div className="bettrack-dashboard-empty">
            <h3>NO BETS THAT DAY</h3>
            <p>
              Once there are bets on this date, this shows how the stake splits by type or sport.
            </p>
            <Button variant="secondary" onClick={() => open({ kind: 'bet' })}>
              LOG ONE
            </Button>
          </div>
        )}
      </section>
    </div>
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
      title = modal.bet ? 'Edit bet' : 'Nova aposta';
      content = (
        <BetForm
          workspace={workspace}
          {...(modal.bet
            ? {
                bet: modal.bet,
                referenceLayout: true,
                financialEditAllowed: modal.financialEditAllowed ?? false,
                onCancel: close,
              }
            : {})}
          onDone={close}
        />
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
      content = (
        <SettleForm
          bet={modal.bet}
          onDone={close}
          {...(modal.outcome ? { initialOutcome: modal.outcome } : {})}
        />
      );
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
      {...(modal.kind === 'catalog'
        ? {
            description:
              modal.catalogKind === 'bookmaker'
                ? 'Cadastre a casa que você usa para organizar seus bilhetes e seu histórico.'
                : 'Cadastre um tipster para organizar suas apostas.',
          }
        : modal.kind === 'settings'
          ? { description: 'Defina o percentual que vai orientar a unidade dos próximos meses.' }
          : {})}
      open
      onClose={close}
    >
      {content}
    </Dialog>
  );
}
