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

export type NavIcon =
  | 'overview'
  | 'bets'
  | 'calendar'
  | 'analytics'
  | 'reports'
  | 'ranking'
  | 'finance'
  | 'settings'
  | 'inbox';

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
