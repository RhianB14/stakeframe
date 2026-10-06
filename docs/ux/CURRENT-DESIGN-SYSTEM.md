# Sistema de design em vigor

Fase 0 do redesign web (STK-F2-18). A fonte única de cor do produto é `apps/web/src/product/tokens.css`; este resumo registra seus valores atuais.

Direção visual: sistema Framer. Paleta registrada (literais hex): `#000000 #0a0a0a #ffffff #737373 #242424 #0099ff`.

| Token                    | Valor vigente literal                                      |
| ------------------------ | ---------------------------------------------------------- |
| `--bg`                   | `#000000`                                                  |
| `--surface`              | `#0a0a0a`                                                  |
| `--fg`                   | `#ffffff`                                                  |
| `--muted`                | `#737373` — decorativo apenas                              |
| `--border`               | `#242424`                                                  |
| `--accent`               | `#0099ff` — preenchimento                                  |
| `--surface-1`            | `#0a0a0a`                                                  |
| `--surface-2`            | `oklch(0.16 0 0)`                                          |
| `--surface-3`            | `oklch(0.185 0 0)`                                         |
| `--surface-sunken`       | `oklch(0.13 0 0)`                                          |
| `--text-primary`         | `var(--fg)`                                                |
| `--text-secondary`       | `oklch(0.76 0 0)`                                          |
| `--text-tertiary`        | `oklch(0.68 0 0)`                                          |
| `--accent-ink`           | `oklch(0.76 0.13 245)`                                     |
| `--focus`                | `var(--accent-ink)`                                        |
| `--accent-soft`          | `color-mix(in oklab, var(--accent) 34%, var(--surface-3))` |
| `--pos` / `--pos-soft`   | `oklch(0.82 0.14 158)` / `oklch(0.22 0.05 158)`            |
| `--neg` / `--neg-soft`   | `oklch(0.78 0.15 26)` / `oklch(0.22 0.05 26)`              |
| `--warn` / `--warn-soft` | `oklch(0.84 0.13 82)` / `oklch(0.23 0.04 82)`              |
| `--border-strong`        | `oklch(0.58 0 0)`                                          |
| `--border-focus`         | `var(--accent-ink)`                                        |

Os contrastes foram medidos no arquivo de origem; `--muted` mede 4,43:1 sobre `--bg` e é decorativo, não texto pequeno.

## Decisões semânticas

As decisões D1–D9 estão em `DESIGN-DECISIONS.md` §3. D2 (verde somente para resultado realizado) e D8 (sem resultado realizado, exibir “—”/“Não liquidado”) continuam válidas como princípios semânticos; tokens e tons antigos não são vigentes. D3–D7 e D9 seguem como decisões de tipografia, fluxo, responsividade, feedback e hierarquia, sem conflito com a fonte atual. D1 continua válida como princípio de consistência, mas sua nomenclatura e tons `--action`/`--action-mini` descritos ali foram superados por esta implementação.

## Ainda não migrado

- Tela pública/acesso: `apps/web/src/style.css`.
- Telas/componentes: `onboarding.tsx`, `forms.tsx`, `imports.tsx`, `dashboard.tsx`, `splits.tsx`, `reports.tsx`, `MiniApp*.tsx`, `bet-drawer.tsx` e `bet-columns-panel.tsx`.
- `polymarket-simulation.tsx` ainda contém `#23262e`: único hex em `.tsx` do produto, atualmente fora da guarda de `tests/unit/design-tokens.test.ts`.
