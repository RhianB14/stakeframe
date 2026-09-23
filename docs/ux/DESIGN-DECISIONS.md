# STK-UX-02 — Sistema visual e decisões de design

Derivado do produto **real** em `6be4f0e`, não de referência externa. Cada token abaixo foi conferido contra `apps/web/src` antes de ser proposto — onde o código diverge, isso está escrito.

> **Princípio:** os tokens aqui **unificam o que já existe**, não introduzem paleta nova. Nenhuma decisão altera regra financeira, comando canônico, idempotência ou comportamento de liquidação.

---

## 1. Situação medida

| Medida                               | Valor real                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Cores hex distintas em `product.css` | 30+                                                                            |
| Azuis de ação convivendo             | 6 (`#94afff`, `#92adff`, `#7d9eff`, `#739bff`, `#9fb4ff`/`#8ca9ff`, `#2878ff`) |
| Fundos distintos                     | 3 (`#101318`, `#101216`, `#07101f`)                                            |
| Fontes abaixo de 10px                | 7 (`8px` ×1, `9px` ×6)                                                         |
| Breakpoints                          | 5 (`430`, `760`, `960`, `1100`, `1180`)                                        |
| `aria-live` vs `role="status"`       | 1 vs 51                                                                        |

O `UI-UX-PLAN.md` propõe `action: #92ADFF` e `surface: #181D26`. Confrontado com o código: **`#92adff` existe** (rótulo e gráfico) mas não é a cor do botão; **`#181d26` não existe** em lugar nenhum. Por isso este documento **não adota a paleta do plano** — adota a paleta implementada e a consolida.

---

## 2. Tokens

### 2.1 Superfície — escada derivada do real

O fundo `#101318` é o único amplamente usado e é mantido. As camadas acima são derivadas dele, não inventadas.

| Token             | Valor     | Origem                                                                       |
| ----------------- | --------- | ---------------------------------------------------------------------------- |
| `--bg`            | `#101318` | `.product-shell` (real)                                                      |
| `--bg-access`     | `#101216` | `style.css` (real) — mantido separado por ser tela de acesso, não do produto |
| `--bg-mini`       | `#07101f` | `.miniapp-page` (real)                                                       |
| `--surface-1`     | `#161b24` | derivado: camada de card                                                     |
| `--surface-2`     | `#1d232e` | derivado: camada elevada (hover/dialog)                                      |
| `--border`        | `#262d3a` | derivado: borda de card                                                      |
| `--border-strong` | `#333c4d` | derivado: borda focada/ativa                                                 |

### 2.2 Ação — de seis azuis para um

| Token            | Valor     | Uso                                                                             |
| ---------------- | --------- | ------------------------------------------------------------------------------- |
| `--action`       | `#94afff` | **única** cor de ação primária (era a do botão e do `outline`)                  |
| `--action-hover` | `#aabaff` | hover derivado                                                                  |
| `--action-ink`   | `#0d1220` | texto sobre `--action`                                                          |
| `--focus`        | `#739bff` | `outline` de foco (mantido; precisa de 3:1 contra fundo)                        |
| `--action-mini`  | `#2878ff` | **apenas** dentro do Mini App, por ser contexto Telegram e já ter `--mini-blue` |

`#92adff` continua nas séries de gráfico (já é o uso lá). Os demais (`#7d9eff`, `#9fb4ff`, `#8ca9ff`) deixam de ser ação e viram variações de `--action` ou são removidos.

### 2.3 Semântica — o achado mais importante

| Token             | Valor     | Regra                                                        |
| ----------------- | --------- | ------------------------------------------------------------ |
| `--positive`      | `#4ade80` | **somente** lucro liquidado                                  |
| `--negative`      | `#f87171` | **somente** prejuízo liquidado                               |
| `--neutral-value` | `#a8b3c5` | saldo, valor apostado, **`R$ 0,00`, resultado ainda aberto** |
| `--pending`       | `#fbbf24` | aposta em aberto, datas a conferir                           |
| `--danger`        | `#ef4444` | ações destrutivas                                            |

**Regra que muda comportamento visual:** aposta em aberto **não usa verde**. O verde é exclusivo de resultado liquidado positivo. Isso corrige o achado `H1`/`§6` do inventário.

### 2.4 Texto e contraste

| Token | Valor | Regra |
|`--text` | `#edf0f6` | títulos e valores |
| `--text-muted` | `#a7b1c2` | rótulos — **substitui os cinzas atuais no limite do contraste** |
| `--text-faint` | `#8794a8` | metadados — **nunca abaixo de 12px** |

Piso de contraste: **4.5:1** para texto normal (WCAG 2.2 AA), **3:1** para texto grande e componentes.

### 2.5 Tipografia

| Nível             | Tamanho        | Onde                                      |
| ----------------- | -------------- | ----------------------------------------- |
| Métrica (KPI)     | `32px` / `700` | valores da visão geral                    |
| Título de seção   | `17px` / `600` | `Onde está sua banca`, `Resultado do mês` |
| Corpo             | `14px` / `400` | tabelas, formulários                      |
| Metadado          | `12px` / `500` | datas, unidades, cabeçalhos de coluna     |
| **Piso absoluto** | **12px**       | **nenhum texto abaixo disso**             |

Os sete `8px`/`9px` atuais sobem para `12px`. O `letter-spacing: 1.6px` dos `.sidebar-caption` pode ser mantido — ele não é problema, o tamanho é.

### 2.6 Espaçamento e raio

| Token                   | Valor                          |
| ----------------------- | ------------------------------ |
| `--space-1..8`          | `4, 8, 12, 16, 20, 24, 32, 40` |
| `--radius-sm / md / lg` | `6 / 10 / 14`                  |

### 2.7 Breakpoints — de cinco para três

| Token     | Valor    | Substitui |
| --------- | -------- | --------- |
| `--bp-sm` | `640px`  | —         |
| `--bp-md` | `900px`  | —         |
| `--bp-lg` | `1200px` | —         |

Os atuais `430`, `760`, `960`, `1100`, `1180` são migrados. `1100` e `1180` são tão próximos que provavelmente nascem de ajuste pontual, não de intenção.

### 2.8 Alvo de toque

| Token       | Valor  | Corrige                                            |
| ----------- | ------ | -------------------------------------------------- |
| `--tap-min` | `44px` | `.mini-segmented label` hoje em `min-height: 42px` |

---

## 3. Decisões de design

### D1 — Um azul de ação

**Decisão:** consolidar os seis azuis em `--action`, mantendo `--action-mini` isolado.

**Justificativa:** hoje a mesma ação tem cor diferente dependendo da tela. Quem usa o produto não percebe, mas qualquer teste visual ou token futuro quebra.

**Não altera:** nenhuma lógica de envio, confirmação ou comando canônico.

### D2 — Verde só para lucro liquidado

**Decisão:** `--neutral-value` para `R$ 0,00`, saldo e resultado em aberto.

**Justificativa:** em produto financeiro, **zerado e lucrativo não podem dividir cor**. É o único achado que afeta a confiança nos números.

**Não altera:** o cálculo, a exposição, a liquidação ou o ledger. É só apresentação do valor que já é calculado.

### D3 — Piso tipográfico de 12px

**Decisão:** nenhum texto abaixo de `12px`, inclusive cabeçalhos de tabela e `sidebar-caption`.

**Justificativa:** os sete `8px`/`9px` medidos estão em rótulos reais de navegação e tabela. Combinado com `--text-faint`, é o maior ganho de legibilidade por menor esforço.

### D4 — Padrão único de filtro

**Decisão:** adotar o padrão de `#analytics` (que **já tem** `Aplicar filtros`) como canônico, e portá-lo para `#bets`.

**Justificativa:** hoje as duas telas são incompatíveis — `#bets` não tem botão algum. Um padrão só remove a dúvida sobre se a filtragem é automática.

**Adicional:** `Limpar filtros` + chips de filtros ativos em ambas.

### D5 — Mobile da tabela vira lista de cards

**Decisão:** abaixo de `--bp-md`, a tabela de apostas vira cards com rótulo explícito por linha, em vez de tabela horizontal cortada.

**Justificativa:** a medição visual mostrou última coluna cortada sem indicação de scroll e linha coberta pela bottom nav.

### D6 — Erro com papel visual

**Decisão:** erro de carregamento vira componente com `role="alert"`, ícone e ação primária, dentro do card afetado.

**Justificativa:** hoje é uma linha de texto sem sinal de alerta para uma falha em dado financeiro.

### D7 — Footer separado no detalhe da aposta

**Decisão:** `Corrigir dados` / `Liquidar aposta` no footer; `Cancelar registro` isolado, com confirmação.

**Justificativa:** hoje a destrutiva está encostada na principal.

### D8 — Zero é `—`, não `R$ 0,00`

**Decisão:** em aposta aberta, `Retorno recebido` e `Resultado realizado` exibem `—` ou `Não liquidado`.

**Justificativa:** `R$ 0,00` em aposta aberta lê-se como "já fechou em zero".

### D9 — Mini App ganha cabeçalhos de seção

**Decisão:** os seis blocos de formulário ganham `h2` e separador.

**Justificativa:** hoje é sequência contínua de campos; a única `h1` é o menor texto da tela.

---

## 4. O que **não** muda

Bloqueios herdados de STK-G0-23 e preservados integralmente:

- Fail-closed para valor, odd e campos sem comando canônico.
- Confirmação financeira explícita antes de liquidação/estorno.
- Fechamento do Mini App **somente** após sucesso integral.
- Idempotência, isolamento por organização, controle de versão e auditoria.
- Sincronização Web ↔ Telegram.
- A antiga página de revisão de importações **não é recriada**.

---

## 5. Referências — verificadas

| Fonte                                                                                                                                                        | Uso                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| [W3C — How to Meet WCAG (Quick Reference)](https://www.w3.org/WAI/WCAG22/quickref/)                                                                          | critérios de contraste 4.5:1 e alvo 44×44 |
| [Mobbin — KakaoBank iOS Account Overview](https://mobbin.com/explore/screens/04517e3b-abac-4250-8af0-433d2c26d7de)                                           | hierarquia saldo + ação                   |
| [Mobbin — Front Inbox Email Thread](https://mobbin.com/explore/web/screens/emails-messages)                                                                  | listagem → detalhe                        |
| [Mobbin — Saturn Calendar iOS Scheduled Events](https://mobbin.com/explore/screens/8a1dfb72-930d-4665-8de0-c67e54416dfd)                                     | seleção inline                            |
| [Mercury — Transactions page](https://support.mercury.com/hc/en-us/articles/38790547830036-Viewing-cashflow-and-transactions-data-on-your-Transactions-page) | leitura de tabela densa                   |

**Não citada:** a referência `Origin Spending Overview` não foi confirmada individualmente e por isso não aparece em nenhum documento desta entrega.
