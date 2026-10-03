import { useEffect, useRef, useState } from 'react';
import { NavGlyph } from './nav-icons.js';
import { SIDEBAR_MODES, writeSidebarMode, type SidebarMode } from './sidebar-mode.js';

/**
 * STK-F3-01 — a barra superior no padrão GitHub.
 *
 * Ela é fixa, tem 52px e ocupa a largura toda, INCLUDING a faixa da sidebar:
 * é a barra do aplicativo, não da área de conteúdo. Por isso `z-index` acima
 * da sidebar e por isso a sidebar e o conteúdo começam ABAIXO dela — o
 * deslocamento vertical é o que faz o topo da sidebar alinhar com a borda
 * inferior da barra em vez de passar por baixo.
 *
 * Nenhum item aqui é um botão de ação real: o breadcrumb, a busca e os três
 * ícones são a CASCA do padrão visual, e um controle que parece fazer algo e
 * não faz é pior do que um controle ausente. Por isso cada um carrega o
 * `aria-label` do que é — "Issues", "Pull requests", "Ações" — e o conjunto
 * do grupo direito é declarado como decorativo para o leitor de tela
 * (`aria-hidden`), que ouve uma lista de botões que não abrem nada. O que
 * precisa ser navegável aqui, e é, é a busca: ela é um campo de verdade.
 *
 * A busca recebe o atalho "/" porque é o que o padrão entrega, e o campo é
 * um `<input type="search">` de verdade — buscar nada é melhor que buscar
 * por engano quando se digita num campo que finge filtrar.
 */

/** O nome acessível do campo. O texto visível já diz "Buscar". */
const SEARCH_LABEL = 'Buscar no aplicativo';

export function TopBar({
  collapsed,
  onToggleSidebar,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="product-topbar-github">
      {/* STK-F3-01: o hamburger alterna o modo recolhido e diz qual é o
          estado agora. Um botão que parece agir e não age é pior que um
          botão ausente — o `aria-expanded` aqui é o que impede isso. */}
      <button
        type="button"
        className="product-topbar-icon"
        aria-label="Alternar barra lateral"
        aria-expanded={!collapsed}
        onClick={onToggleSidebar}
      >
        <NavGlyph icon="menu" size={18} />
      </button>
      <span className="product-topbar-logo" aria-hidden="true">
        <span className="product-topbar-logo-mark">S</span>
      </span>
      <nav aria-label="Contexto" className="product-topbar-crumb">
        <span className="product-topbar-crumb-owner">RhianB14</span>
        <span className="product-topbar-crumb-sep" aria-hidden="true">
          /
        </span>
        <span className="product-topbar-crumb-repo">stakeframe</span>
        <span className="product-topbar-caret" aria-hidden="true">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </nav>
      <div className="product-topbar-spacer" />
      <div className="product-topbar-search">
        <NavGlyph icon="search" size={14} />
        <label className="sr-only" htmlFor="topbar-search-input">
          {SEARCH_LABEL}
        </label>
        <input id="topbar-search-input" type="search" className="product-topbar-search-input" />
        <kbd aria-hidden="true">/</kbd>
      </div>
      <span className="product-topbar-divider" aria-hidden="true" />
      {/* STK-F3-01: o grupo direito é a casca do padrão, não ação do produto.
          Declarado decorativo para o leitor de tela — três botões que não
          abrem nada seriam lidos como navegação quebrada. */}
      <div className="product-topbar-icons" aria-hidden="true">
        <span className="product-topbar-icon" tabIndex={-1}>
          <NavGlyph icon="issue" size={17} />
        </span>
        <span className="product-topbar-icon" tabIndex={-1}>
          <NavGlyph icon="pull-request" size={17} />
        </span>
        <span className="product-topbar-icon" tabIndex={-1}>
          <NavGlyph icon="actions" size={17} />
        </span>
      </div>
      <span className="product-topbar-avatar" aria-hidden="true">
        RB
      </span>
    </header>
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
  expanded: 'Expanded',
  collapsed: 'Collapsed',
  hover: 'Expand on hover',
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
        aria-label="Sidebar control"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nav-icon">
          <NavGlyph icon="panel" size={18} />
        </span>
        <span className="nav-label">Sidebar control</span>
      </button>
      {open ? (
        <div
          className="sidebar-control-popover"
          id="sidebar-control-popover"
          role="group"
          aria-label="Modo da barra lateral"
        >
          <p className="sidebar-control-title">Sidebar control</p>
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
