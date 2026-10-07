# Sistema de design em vigor

Atualizado no redesign web iniciado em outubro de 2026. Os tokens do produto ficam em `apps/web/src/product/tokens.css`; a casca e os padrões compartilhados ficam em `apps/web/src/product/product.css`.

## Direção

Interface escura para leitura de registros financeiros, com carvão em camadas, verde-lima para ação e resultado positivo, âmbar para atenção e vermelho para perda. Títulos condensados criam hierarquia e aproximam a linguagem visual de placares esportivos; textos corridos usam uma família de sistema sem serifa. Números continuam tabulares para alinhar valores monetários.

| Papel                         | Token                        |
| ----------------------------- | ---------------------------- |
| Fundo                         | `--bg: #0d0f0d`              |
| Superfície base               | `--surface: #141714`         |
| Texto principal               | `--fg: #f4f5ef`              |
| Texto auxiliar                | `--muted: #a0a69b`           |
| Divisor                       | `--border: #2a3029`          |
| Ação lima                     | `--accent: #c5f36b`          |
| Positivo / negativo / atenção | `--pos` / `--neg` / `--warn` |

## Tipografia e geometria

- Display: `Impact`, `Haettenschweiler` e fontes estreitas equivalentes; títulos em caixa alta.
- Corpo: Segoe UI com fallback para fontes de sistema; valores usam números tabulares.
- Escala: 12 px rótulo, 13 px auxiliar, 14 px controle, 15 px corpo, 18/24/38 px títulos.
- Raio base de 3 px, superfícies com cantos quase retos e alvo interativo mínimo de 44 px.
- Sidebar desktop de 208 px, recolhida de 56 px; os três modos continuam persistidos por dispositivo. Em telas estreitas, a navegação passa para a barra inferior.

## Componentes e acessibilidade

O cabeçalho identifica a marca, apresenta o perfil conectado e oferece saída de sessão em uma ação separada. Perfil mostra apenas identidade disponível e provedor de autenticação; edição de e-mail, avatar e dados não fornecidos pela API não são simulados. Estados de foco usam o acento lima; tons semânticos mantêm papéis separados. O menu respeita os modos Expandida, Recolhida e Expandir ao passar o cursor.

O sistema de tokens segue como fonte de cores para as telas do produto. A interface autenticada usa a camada `--web-*`, inspirada na referência BetTrack, em todas as rotas web: dashboard, apostas, calendário, análises, relatórios, financeiro, perfil, configurações e áreas do Polymarket. Essa camada preserva a marca, os dados e as ações do Stakeframe, e muda a apresentação para preto/carvão, painéis retos, verde-lima, avatar azul e títulos condensados. O Mini App e a entrada pública continuam usando os tokens-base. Na aplicação web, a sidebar expandida mede 202 px; modos e comportamento mobile continuam responsivos.
