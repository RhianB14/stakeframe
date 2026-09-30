"""STK-F2-18 — Fase 1: a casca do produto sobre os tokens.

Aplica a ordem de migração do plano (§4): fundo e texto primeiro, depois
borda, depois acento. Cada substituição é por texto exato e ABORTA se o
bloco não for encontrado — um replace silencioso que não casa deixaria a
casca meio migrada, que é pior do que não migrada.
"""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "apps/web/src/product/product.css"

HEAD_OLD = """.product-shell {
  min-height: 100svh;
  display: flex;
  background: var(--surface-1);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}"""

HEAD_NEW = """/* ==========================================================================
   STK-F2-18 — casca do produto sobre a camada de tokens.
   Ordem de populacao: fundo e texto primeiro (a pagina fica legivel),
   depois borda, depois acento. Todo bloco abaixo consome `var(--*)`; um
   literal hex aqui e defeito, e tests/unit/design-tokens.test.ts barra.
   ========================================================================== */

.product-shell {
  min-height: 100svh;
  display: flex;
  background: var(--bg);
  color: var(--text-primary);
  font-size: var(--text-body);
  line-height: 1.5;
}

/* --- Skip link: oculto ate receber foco ---------------------------------
   O alvo (`#product-main`) ja existia no codigo desde antes desta fase e
   nada apontava para ele: a navegacao por teclado passava por 8 links de
   menu antes de chegar ao conteudo, em todas as telas do produto. Fica
   fora da tela em vez de `display: none`, porque um elemento com display
   none nao e focavel e o link nunca apareceria. */
.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 100;
  padding: 12px 20px;
  min-height: var(--tap);
  display: inline-flex;
  align-items: center;
  background: var(--accent);
  color: var(--bg);
  font-size: var(--text-md);
  font-weight: 600;
  border-radius: 0 0 var(--radius) 0;
  text-decoration: none;
}
.skip-link:focus-visible {
  left: 0;
  outline-offset: -4px;
}"""

# (rotulo, padrao regex, substituto)
BLOCKS: list[tuple[str, str, str]] = [
    (
        "sidebar",
        r"\.product-sidebar \{[^}]*\}",
        """.product-sidebar {
  width: var(--shell-w);
  padding: 32px 20px;
  border-right: var(--hairline) solid var(--border);
  position: fixed;
  inset: 0 auto 0 0;
  background: var(--surface-1);
  display: flex;
  flex-direction: column;
}""",
    ),
    (
        "brand",
        r"\.product-brand \{[^}]*\}",
        """.product-brand {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  padding-left: 8px;
  color: var(--text-primary);
}""",
    ),
    (
        "sidebar-caption",
        r"\.sidebar-caption \{[^}]*\}",
        """.sidebar-caption {
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.09em;
  color: var(--text-tertiary);
  padding: 32px 12px 12px;
}""",
    ),
    (
        "nav",
        r"\.product-sidebar nav \{[^}]*\}",
        """.product-sidebar nav {
  display: grid;
  gap: 4px;
}""",
    ),
    (
        "nav-a",
        r"\.product-sidebar nav a \{[^}]*\}",
        """.product-sidebar nav a {
  min-height: var(--tap);
  padding: 10px 12px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: var(--text-md);
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}""",
    ),
    (
        "nav-a-hover",
        r"\.product-sidebar nav a:hover \{[^}]*\}",
        """/* STK-F2-18: os tres estados, com o par fundo/texto trocado na mesma
   regra. O :hover move o fundo e escurece o texto ao mesmo tempo — nunca
   "puxar o texto para o cinza da marca", que e o defeito classico. */
.product-sidebar nav a:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}
.product-sidebar nav a:active {
  background: var(--surface-3);
}""",
    ),
    (
        "nav-a-current",
        r"\.product-sidebar nav a\[aria-current='page'\] \{[^}]*\}",
        """.product-sidebar nav a[aria-current='page'] {
  background: var(--surface-3);
  color: var(--accent-ink);
  font-weight: 600;
}""",
    ),
    (
        "nav-icon",
        r"\.product-sidebar nav a \.nav-icon \{[^}]*\}",
        """.product-sidebar nav a .nav-icon {
  display: block;
  line-height: 0;
  flex-shrink: 0;
}""",
    ),
    (
        "nav-label",
        r"\.product-sidebar nav a \.nav-label \{[^}]*\}",
        """.product-sidebar nav a .nav-label {
  min-width: 0;
  /* Rotulo longo quebra em palavra, nunca no meio dela. */
  overflow-wrap: anywhere;
}""",
    ),
    (
        "sidebar-bottom",
        r"\.sidebar-bottom \{[^}]*\}",
        """.sidebar-bottom {
  margin-top: auto;
  padding: 16px 12px 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  border-top: var(--hairline) solid var(--border);
}""",
    ),
    (
        "sidebar-bottom-p",
        r"\.sidebar-bottom p \{[^}]*\}",
        """.sidebar-bottom p {
  color: var(--text-tertiary);
  margin: 8px 0 0;
  font-size: var(--text-xs);
}""",
    ),
    (
        "content",
        r"\.product-content \{[^}]*\}",
        """.product-content {
  margin-left: var(--shell-w);
  width: calc(100% - var(--shell-w));
  min-width: 0;
  display: flex;
  flex-direction: column;
}""",
    ),
    (
        "topbar",
        r"\.product-topbar \{[^}]*\}",
        """.product-topbar {
  min-height: var(--topbar-h);
  padding: 0 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: var(--hairline) solid var(--border);
  gap: 16px;
}""",
    ),
    (
        "topbar-span",
        r"\.product-topbar > span \{[^}]*\}",
        """.product-topbar > span {
  font-size: var(--text-body);
}""",
    ),
    (
        "main",
        r"\.product-main \{[^}]*\}",
        """.product-main {
  display: block;
  padding: 40px 40px 32px;
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  min-width: 0;
}
/* O alvo do skip link recebe foco por script, nao por clique. Sem isto o
   anel apareceria como um contorno solto ao redor da pagina inteira. */
.product-main:focus {
  outline: none;
}
.product-main:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}""",
    ),
    (
        "page-heading",
        r"\.page-heading \{[^}]*\}",
        """.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}""",
    ),
    (
        "eyebrow",
        r"\.product-eyebrow \{[^}]*\}",
        """.product-eyebrow {
  margin: 0 0 10px;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: 600;
  /* CAPS exige tracking positivo: 0,09em e o piso de tipografia. */
  letter-spacing: 0.09em;
  text-transform: uppercase;
}""",
    ),
    (
        "h1",
        r"\.product-main h1 \{[^}]*\}",
        """.product-main h1 {
  font-family: var(--font-display);
  font-size: var(--text-h1);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.15;
}""",
    ),
    (
        "h2",
        r"\.product-shell h2,\n\.dialog-content h2 \{[^}]*\}",
        """.product-shell h2,
.dialog-content h2 {
  font-family: var(--font-display);
  font-size: var(--text-h2);
  font-weight: 600;
  letter-spacing: -0.012em;
  line-height: 1.25;
  margin: 0;
}""",
    ),
    (
        "h3",
        r"\.product-shell h3,\n\.dialog-content h3 \{[^}]*\}",
        """.product-shell h3,
.dialog-content h3 {
  font-family: var(--font-display);
  font-size: var(--text-h3);
  font-weight: 600;
  line-height: 1.3;
  margin: 0;
}""",
    ),
    (
        "live-label",
        r"\.live-label \{[^}]*\}",
        """.live-label {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}""",
    ),
    (
        "button",
        r"\.ui-button \{[^}]*\}",
        """.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 7px;
  /* STK-F2-18: alvo de toque. A versao anterior tinha 40px aqui e 30px
     no botao "Copiar" da tabela — o unico controle que se mira com o
     dedo numa tela de 14 colunas. */
  min-height: var(--tap);
  padding: 10px 18px;
  font: inherit;
  font-size: var(--text-md);
  font-weight: 600;
  border: var(--hairline) solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}""",
    ),
    (
        "button-primary",
        r"\.ui-button-primary \{[^}]*\}",
        """.ui-button-primary {
  background: var(--accent);
  color: var(--bg);
}""",
    ),
    (
        "button-primary-hover",
        r"\.ui-button-primary:hover \{[^}]*\}",
        """.ui-button-primary:hover {
  /* O hover inverte os DOIS lados: o par continua com 7,00:1. Escurecer
     so o fundo deixaria o texto preto sem contraste. */
  background: color-mix(in oklab, var(--accent) 88%, var(--fg));
  color: var(--bg);
}
.ui-button-primary:active {
  background: color-mix(in oklab, var(--accent) 78%, var(--fg));
}""",
    ),
    (
        "button-secondary",
        r"\.ui-button-secondary \{[^}]*\}",
        """.ui-button-secondary {
  background: var(--surface-2);
  border-color: var(--border-strong);
  color: var(--text-primary);
}""",
    ),
    (
        "button-secondary-hover",
        r"\.ui-button-secondary:hover \{[^}]*\}",
        """.ui-button-secondary:hover {
  background: var(--surface-3);
  border-color: var(--text-tertiary);
}""",
    ),
    (
        "button-ghost",
        r"\.ui-button-ghost \{[^}]*\}",
        """.ui-button-ghost {
  background: transparent;
  color: var(--text-secondary);
}""",
    ),
    (
        "button-ghost-hover",
        r"\.ui-button-ghost:hover \{[^}]*\}",
        """.ui-button-ghost:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}""",
    ),
    (
        "button-destructive",
        r"\.ui-button-destructive \{[^}]*\}",
        """.ui-button-destructive {
  background: var(--neg-soft);
  border-color: var(--neg);
  color: var(--neg);
}
.ui-button-destructive:hover {
  background: color-mix(in oklab, var(--neg-soft) 80%, var(--neg));
  color: var(--neg);
}""",
    ),
    (
        "button-small",
        r"\.ui-button-small \{[^}]*\}",
        """/* STK-F2-18: alvo pequeno continua tocavel. A variante compacta nao
   pode ser menor que 44px — o teste de toque e a unica garantia de que
   o botao e alcancavel no celular, e vale para as duas variantes. */
.ui-button-small {
  min-height: var(--tap);
  padding: 8px 14px;
  font-size: var(--text-sm);
}""",
    ),
    (
        "miniapp-nav-icon",
        r"\.miniapp-nav \.nav-icon \{[^}]*\}",
        """.miniapp-nav .nav-icon {
  display: block;
  line-height: 0;
}""",
    ),
    (
        "miniapp-nav-a",
        r"\.miniapp-nav a \{[^}]*\}",
        """.miniapp-nav a {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 2px;
  border-radius: var(--radius);
  text-decoration: none;
  /* Alvo de toque confortavel em tela de bolso. */
  min-height: var(--tap);
  justify-content: center;
  color: var(--text-tertiary);
  transition: background 0.15s, color 0.15s;
}
.miniapp-nav a:hover {
  color: var(--text-secondary);
}
.miniapp-nav a:active {
  background: var(--surface-2);
}""",
    ),
    (
        "miniapp-nav-current",
        r"\.miniapp-nav a\[aria-current='page'\] \{[^}]*\}",
        """.miniapp-nav a[aria-current='page'] {
  background: var(--surface-3);
  color: var(--accent-ink);
}""",
    ),
]


def main() -> None:
    src = open(PATH, encoding="utf-8").read()
    if HEAD_OLD not in src:
        raise SystemExit("bloco .product-shell nao encontrado — a base mudou?")
    src = src.replace(HEAD_OLD, HEAD_NEW, 1)

    missing: list[str] = []
    for label, pattern, replacement in BLOCKS:
        src, count = re.subn(pattern, lambda _m, r=replacement: r, src, count=1)
        if not count:
            missing.append(label)

    if missing:
        raise SystemExit("blocos nao encontrados: " + ", ".join(missing))

    open(PATH, "w", encoding="utf-8", newline="").write(src)
    print(f"{len(BLOCKS)} blocos da casca migrados")


if __name__ == "__main__":
    main()
