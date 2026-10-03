/**
 * STK-F2-18 (Fase 1 do redesign web) — ícones de navegação como SVG.
 *
 * Antes disto a navegação usava glifos Unicode (`◫ ▤ ▦ ↗ ▥ ⇧ ⇄ ⚙`): o
 * glifo varia entre plataformas, não é redimensionável, não aceita
 * `currentColor` e some em algumas fontes. Cada ícone aqui é traçado
 * monoline de 1,6px em grade de 24, com `currentColor` — o mesmo desenho
 * em qualquer sistema operacional.
 *
 * Os `path` são geometria própria, não cópia de nenhum conjunto de
 * ícones de terceiro.
 */

/**
 * STK-F3-01: os ícones da barra superior e da categoria Polymarket entram no
 * MESMO catálogo, pelo mesmo motivo dos anteriores — traçado monoline de
 * 1,6px em grade de 24, com `currentColor`. Um segundo catálogo para a mesma
 * navegação seria duas fontes para o mesmo desenho.
 */
export type NavIcon =
  | 'overview'
  | 'bets'
  | 'calendar'
  | 'analytics'
  | 'reports'
  | 'ranking'
  | 'finance'
  | 'settings'
  | 'inbox'
  // Categoria Polymarket.
  | 'global'
  | 'favorite'
  | 'telegram'
  | 'simulation'
  // Barra superior e controle da sidebar.
  | 'menu'
  | 'panel'
  | 'search'
  | 'issue'
  | 'pull-request'
  | 'actions';

const paths: Record<NavIcon, string> = {
  // 4 painéis + barra de título
  overview: 'M4 5.5h16M4 5.5V19h16V5.5M4 10h16',
  // 3 linhas com marca de conferência
  bets: 'M4 6.5h16M4 12h16M4 17.5h10M17 16l2 2 3-3.5',
  // grade mensal com dia marcado
  calendar: 'M4 6.5h16v14H4zM4 11h16M8.5 4v4M15.5 4v4M8 15h2',
  // linha subindo com barra de referência
  analytics: 'M4 19.5h16M6 16l4-5 3.5 3L20 6',
  // documento com selo
  reports: 'M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 13h6M9 16.5h4',
  // pódio com três posições
  ranking: 'M4 20h16M7 20v-6M12 20V8M17 20v-9',
  // dois cofres com setas em sentido oposto
  finance: 'M3.5 8.5h6v7h-6zM14.5 8.5h6v7h-6zM9.5 12h5M13 10.5l1.5 1.5L13 13.5',
  // engrenagem simplificada
  settings:
    'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6',
  // bandeja de entrada
  inbox: 'M4 13.5h4l1.5 2.5h5l1.5-2.5h4M4 13.5L6.5 5h11L20 13.5V19H4z',
  /* --- STK-F3-01: categoria Polymarket --- */
  // globo com os dois meridianos: é o que distingue "global" de um círculo
  global:
    'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17M3.5 12h17M12 3.5c2.3 2.4 2.3 14.6 0 17M12 3.5c-2.3 2.4-2.3 14.6 0 17',
  // estrela de cinco pontas
  favorite: 'M12 3.8l2.6 5.5 5.9.8-4.3 4.2 1.1 5.9L12 17.4l-5.3 2.8 1.1-5.9-4.3-4.2 5.9-.8z',
  // balão de fala do Telegram, com o rabo
  telegram:
    'M20.5 11.3c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.2-2.9-.4l-4.6 1.3 1.4-3.9a6.9 6.9 0 01-1.9-4.4C4 7.2 7.8 3.9 12.5 3.9s8 3.3 8 7.4z',
  // painel com duas linhas de controle
  simulation: 'M3.8 5.5h16.4v13H3.8zM7 9h7M7 13h4.5',
  /* --- STK-F3-01: barra superior e controle da sidebar --- */
  // três barras (hamburger)
  menu: 'M4 7h16M4 12h16M4 17h16',
  // painel com um divisor: o ícone do "sidebar control"
  panel: 'M3.8 4.6h16.4v14.8H3.8zM9.6 4.6v14.8',
  // lupa
  search: 'M11 4.6a6.4 6.4 0 100 12.8 6.4 6.4 0 000-12.8M15.6 15.6l4 4',
  // alvo com círculo central (issues)
  issue: 'M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8M12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2',
  // dois nós e a linha que os liga (pull request)
  'pull-request':
    'M6.5 4.8a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8M6.5 14.4a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8M17.5 6.8a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8M6.5 9.6v4.8M17.5 11.6v2.6a2.6 2.6 0 01-2.6 2.6H8.9',
  // círculo com sinal de mais (ações)
  actions: 'M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8M12 8.4v7.2M8.4 12h7.2',
};

export function NavGlyph({ icon, size = 20 }: { icon: NavIcon; size?: number }) {
  return (
    <svg
      className="nav-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      /* O rótulo ao lado já nomeia o destino; repetir no nome acessível
         faria o leitor de tela dizer "Visão geral, Visão geral". */
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[icon]} />
    </svg>
  );
}
