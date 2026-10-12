import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { betPageSchema, saoPauloDate, type Workspace } from '@stakeframe/shared';
import { Button } from '../components/ui/button.js';
import { NavGlyph } from './nav-icons.js';
import { SIDEBAR_MODES, writeSidebarMode, type SidebarMode } from './sidebar-mode.js';
import { request } from './api.js';

/** Cabeçalho do produto: marca, identidade conectada e saída de sessão. */

export function TopBar({
  brand = 'stakeframe',
  collapsed,
  onToggleSidebar,
  ownerName,
  onSignOut,
  signingOut,
  newBetDisabled,
  onNewBet,
  mobileNavOpen = false,
  onToggleMobileNav,
}: {
  brand?: 'stakeframe' | 'bettrack';
  collapsed: boolean;
  onToggleSidebar: () => void;
  ownerName: string;
  onSignOut: () => void;
  signingOut: boolean;
  newBetDisabled: boolean;
  onNewBet: () => void;
  mobileNavOpen?: boolean;
  onToggleMobileNav?: () => void;
}) {
  const displayName = ownerName.replace(/\s*\(prévia\)/i, '').trim();
  const initials = displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <header className={`product-topbar-github${brand === 'bettrack' ? ' bettrack-topbar' : ''}`}>
      {/* STK-F3-01: o hamburger alterna o modo recolhido e diz qual é o
          estado agora. Um botão que parece agir e não age é pior que um
          botão ausente — o `aria-expanded` aqui é o que impede isso. */}
      <button
        type="button"
        className="product-topbar-icon"
        aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={window.matchMedia('(max-width: 760px)').matches ? mobileNavOpen : !collapsed}
        onClick={() => {
          if (window.matchMedia('(max-width: 760px)').matches && onToggleMobileNav)
            onToggleMobileNav();
          else onToggleSidebar();
        }}
      >
        <NavGlyph icon="menu" size={18} />
      </button>
      <a href="#overview" className="product-topbar-brand" aria-label="StakeFrame, visão geral">
        <span className="product-topbar-logo" aria-hidden="true">
          {brand === 'bettrack' ? (
            <span className="product-topbar-logo-mark bettrack-logo-mark">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="product-topbar-logo-mark">S</span>
          )}
        </span>
        {brand === 'bettrack' ? (
          <span className="product-topbar-brand-copy">
            <strong>STAKEFRAME</strong>
            <small>CONTROLE SEU JOGO</small>
          </span>
        ) : (
          <span>STAKEFRAME</span>
        )}
      </a>
      <div className="product-topbar-spacer" />
      {/* O cabecalho da skin e o unico visivel em todas as larguras (ela
          esconde .product-topbar a partir de 761px, e o CTA da sidebar saiu por
          decisao do dono): a acao principal mora aqui, com o mesmo estado
          desabilitado de antes. */}
      {brand !== 'bettrack' ? (
        <Button disabled={newBetDisabled} onClick={onNewBet}>
          + Nova aposta
        </Button>
      ) : null}
      <a className="product-topbar-profile" href="#profile" aria-label={`Perfil de ${displayName}`}>
        <span className="product-topbar-profile-name">
          {brand === 'bettrack' ? (
            <>
              <strong>{displayName.split(/\s+/)[0]}</strong>
              <small>CONTA</small>
            </>
          ) : (
            ownerName
          )}
        </span>
        <span className="product-topbar-avatar" aria-hidden="true">
          {initials}
        </span>
      </a>
      <button
        type="button"
        className="product-topbar-signout"
        aria-label={signingOut ? 'Saindo da conta' : 'Sair da conta'}
        title="Sair da conta"
        disabled={signingOut}
        onClick={onSignOut}
      >
        <NavGlyph icon="exit" size={18} />
      </button>
    </header>
  );
}

export function BetTrackSidebar({
  page,
  workspace,
  disabled,
  onNewBet,
  mobileOpen = false,
  onNavigate,
}: {
  page: string;
  workspace: Workspace;
  disabled: boolean;
  onNewBet: () => void;
  mobileOpen?: boolean;
  onNavigate?: () => void;
}) {
  const params = new URLSearchParams({ page: '1', pageSize: '100' }).toString();
  const bets = useQuery({
    queryKey: ['product', 'bets', workspace.version, params],
    queryFn: () => request(`/api/v1/bets?${params}`, betPageSchema),
    enabled: page === 'bets',
  });
  const today = saoPauloDate(new Date());
  const scheduleDate = (bet: NonNullable<typeof bets.data>['items'][number]) => {
    const dates = bet.selections.flatMap((selection) => {
      if (selection.dateStatus !== 'confirmed') return [];
      if (selection.eventAt) return [saoPauloDate(new Date(selection.eventAt))];
      return selection.eventDate ? [selection.eventDate] : [];
    });
    return dates.sort()[0] ?? null;
  };
  const todayCount = bets.data?.items.filter((bet) => {
    const date = scheduleDate(bet);
    return date !== null && date >= today;
  }).length;
  const historyCount = bets.data?.items.filter((bet) => {
    const date = scheduleDate(bet);
    return date === null || date < today;
  }).length;
  const activePage = page === 'new-bet' ? 'bets' : page;
  const items = [
    ['overview', 'DASHBOARD'],
    ['bets', 'BETS'],
    ['calendar', 'CALENDAR'],
    ['finance', 'BANKROLL'],
    ['analytics', 'ANALYTICS'],
    ['hedge', 'HEDGE'],
    ['settings', 'SETTINGS'],
  ] as const;
  const scrollTo = (id: string) => {
    if (page !== 'bets') window.location.hash = '#bets';
    window.requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }),
    );
  };
  return (
    <aside
      className={`product-sidebar bettrack-sidebar${mobileOpen ? ' is-mobile-open' : ''}`}
      aria-label="StakeFrame"
    >
      <nav aria-label="Main navigation">
        {items.map(([id, label]) => (
          <div className="bettrack-nav-item" key={id}>
            <a
              href={`#${id}`}
              aria-current={activePage === id ? 'page' : undefined}
              onClick={onNavigate}
            >
              {label}
            </a>
            {id === 'bets' && page === 'bets' ? (
              <div className="bettrack-subnav" aria-label="Bet sections">
                <button type="button" onClick={() => scrollTo('bets-today')}>
                  <span>TODAY</span>
                  <span>{todayCount ?? '—'}</span>
                </button>
                <button type="button" onClick={() => scrollTo('bets-history')}>
                  <span>HISTORY</span>
                  <span>{historyCount ?? '—'}</span>
                </button>
              </div>
            ) : null}
          </div>
        ))}
        <section className="bettrack-nav-group" aria-label="Polymarket">
          <h2>POLYMARKET</h2>
          <div className="bettrack-subnav" aria-label="Polymarket navigation">
            {[
              ['pm-global', 'GLOBAL RANKING'],
              ['pm-favorites', 'FAVORITES'],
              ['pm-telegram', 'TELEGRAM'],
              ['pm-simulation', 'SIMULATION'],
            ].map(([id, label]) => (
              <a
                href={`#${id}`}
                aria-current={activePage === id ? 'page' : undefined}
                key={id}
                onClick={onNavigate}
              >
                {label}
              </a>
            ))}
          </div>
        </section>
      </nav>
      <Button
        className="product-new-bet"
        disabled={disabled}
        onClick={() => {
          onNavigate?.();
          onNewBet();
        }}
      >
        + NEW BET
      </Button>
    </aside>
  );
}

/**
 * STK-F3-01 — o rodapé da sidebar com o controle de três modos.
 *
 * O botão abre um popover com os três modos, e o modo vigente é o mesmo que
 * `sidebarMetrics` aplica ao layout — uma única fonte para o que está
 * selecionado e para a geometria. O valor persiste por PRÓPRIO: quem escolhe
 * a sidebar recolhida espera a mesma coisa na próxima aba, e o modo é por
 * dispositivo (é uma preferência de tela, não de conta).
 *
 * O popover fecha por Escape, clique fora e devolve o foco ao botão — o
 * mesmo contrato do painel de colunas, e pelo mesmo motivo: é um controle
 * de preferência, não um diálogo, então o foco não fica preso e quem abriu
 * precisa conseguir sair com o teclado.
 */
const MODE_LABELS: Record<SidebarMode, string> = {
  expanded: 'Expandida',
  collapsed: 'Recolhida',
  hover: 'Expandir ao passar o cursor',
};

export function SidebarFooter({
  mode,
  onChange,
}: {
  mode: SidebarMode;
  onChange: (mode: SidebarMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);

  const choose = (next: SidebarMode) => {
    writeSidebarMode(typeof window === 'undefined' ? null : window.localStorage, next);
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="sidebar-bottom" ref={container}>
      <button
        type="button"
        className="sidebar-control"
        ref={trigger}
        aria-expanded={open}
        aria-controls="sidebar-control-popover"
        /* STK-F3-01: o rótulo VISÍVEL some quando o item fica com só o
           ícone (coluna de 56px), e o nome acessível do botão passa a vir
           do texto. Sem este `aria-label` explícito, o botão deixaria de ter
           nome — o leitor de tela anunciaria "botão" sem dizer o que ele
           controla. A regra vale para todo botão que vira só ícone. */
        aria-label="Controle da barra lateral"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nav-icon">
          <NavGlyph icon="panel" size={18} />
        </span>
        <span className="nav-label">Barra lateral</span>
      </button>
      {open ? (
        <div
          className="sidebar-control-popover"
          id="sidebar-control-popover"
          role="group"
          aria-label="Modo da barra lateral"
        >
          <p className="sidebar-control-title">Barra lateral</p>
          {SIDEBAR_MODES.map((value) => (
            <button
              key={value}
              type="button"
              className={
                value === mode ? 'sidebar-control-option is-active' : 'sidebar-control-option'
              }
              // O modo vigente é anunciado, não só pintado: sem isto o
              // popover seria três botões visualmente iguais para um
              // leitor de tela.
              aria-pressed={value === mode}
              onClick={() => choose(value)}
            >
              <span>{MODE_LABELS[value]}</span>
              <span className="sidebar-control-bullet" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      <p className="sidebar-bottom-env">
        <span className="private-dot" /> Ambiente local · BRT
      </p>
    </div>
  );
}
