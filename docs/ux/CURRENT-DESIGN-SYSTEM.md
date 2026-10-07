# Sistema de design em vigor

Atualizado no redesign web iniciado em outubro de 2026. Os tokens do produto ficam em `apps/web/src/product/tokens.css`; a casca e os padrões compartilhados ficam em `apps/web/src/product/product.css`. As decisões D1–D9 estão registradas em [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) §3.

## Direção

Interface escura para leitura de registros financeiros, com carvão em camadas, verde-lima para ação e resultado positivo, âmbar para atenção e vermelho para perda **no contrato do produto** — a skin BetTrack (abaixo) usa laranja para perda. Títulos condensados criam hierarquia e aproximam a linguagem visual de placares esportivos; textos corridos usam uma família de sistema sem serifa. Números continuam tabulares para alinhar valores monetários.

| Papel                         | Token                        |
| ----------------------------- | ---------------------------- |
| Fundo                         | `--bg: #0d0f0d`              |
| Superfície base               | `--surface: #141714`         |
| Texto principal               | `--fg: #f4f5ef`              |
| Texto auxiliar                | `--muted: #a0a69b`           |
| Divisor                       | `--border: #2a3029`          |
| Ação lima                     | `--accent: #c5f36b`          |
| Positivo / negativo / atenção | `--pos` / `--neg` / `--warn` |

## Duas paletas registradas

O produto tem **duas** paletas nomeadas, e a guarda de tokens (`tests/unit/design-tokens.test.ts`) registra as duas: `PALETTE` (o contrato da tabela acima) e `SKIN_PALETTE` (a skin BetTrack, inspirada em `app.bet-track.com`). Cor nova em qualquer uma delas exige registro explícito no teste — não há aceitação silenciosa, e o teste de contraste lê os valores de `tokens.css` em vez de recopiá-los.

A camada `--web-*` (declarada em `tokens.css`, no mesmo `:root`) pinta a interface autenticada: fundo e painéis de carvão mais frio, bordas, textos, o lima `--web-accent: #c5f622`, o laranja `--web-negative: #ff9d2e`, o azul `--web-blue`, a paleta de avatares e selos (`--web-avatar-*`) e os tons de tinta `--web-ink` / `--web-gray-soft`. `--web-warning` e `--web-orange` são aliases de tokens do contrato (`--warn` e `--web-negative`). O Mini App e a entrada pública continuam usando os tokens-base.

## Tipografia e geometria

- Display: `Impact`, `Haettenschweiler` e fontes estreitas equivalentes; títulos em caixa alta.
- Corpo: Segoe UI com fallback para fontes de sistema; valores usam números tabulares.
- Escala: 12 px rótulo, 13 px auxiliar, 14 px controle, 15 px corpo, 18/24/38 px títulos. O piso de 12 px é verificado pela guarda (`—text-xs: 12px`), que reprova qualquer `font-size` em px abaixo disso.
- Raio base de 3 px, superfícies com cantos quase retos e alvo interativo mínimo de 44 px (`--tap`), também verificado pela guarda.
- Sidebar desktop: `--sidebar-w` = 208 px **no contrato**; o tema web sobrescreve para 202 px em `product.css` (`--sidebar-w-active` idem); recolhida de 56 px nos dois. Os três modos continuam persistidos por dispositivo. Em telas estreitas, a navegação passa para a barra inferior.

## Componentes e acessibilidade

O cabeçalho identifica a marca, apresenta o perfil conectado e oferece saída de sessão em uma ação separada. Perfil mostra apenas identidade disponível e provedor de autenticação; edição de e-mail, avatar e dados não fornecidos pela API não são simulados. Estados de foco usam o acento lima; tons semânticos mantêm papéis separados — verde só para resultado **realizado** positivo, nunca para valor potencial ou para o simples estado "liquidada". O menu respeita os modos Expandida, Recolhida e Expandir ao passar o cursor.
