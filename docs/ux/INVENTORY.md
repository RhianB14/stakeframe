# STK-UX-01 — Inventário das telas e estados reais

Auditoria visual do produto em **2026-09-23**, sobre `origin/main` = `6be4f0eda7ad0d2718edf80aca23a2c09840b289`.

Todo o conteúdo exibido nas capturas vem de **fixtures sintéticas** (`tests/ux-capture/fixtures.ts`): casas, tipsters, eventos, valores e referências são inventados. Não há dado pessoal, token, bilhete real ou credencial. Telegram e provedores externos permanecem mockados.

As referências externas citadas ao final foram **verificadas uma a uma antes de citar** (ver §7).

---

## 1. Como este inventário foi produzido

| Etapa                                               | Artefato                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixtures sintéticas válidas contra os schemas reais | `tests/ux-capture/fixtures.ts`                                                                                                                                                                                                                         |
| Guarda contra payload inválido                      | `tests/unit/ux-capture-fixtures.test.ts` (4/4)                                                                                                                                                                                                         |
| Captura desktop 1440×1000 + mobile 412×915          | `tests/ux-capture/capture.spec.ts`                                                                                                                                                                                                                     |
| Config dedicado, **fora do `testDir` da CI**        | `tests/ux-capture/playwright.ux.config.ts`                                                                                                                                                                                                             |
| 22 capturas geradas                                 | `docs/ux/captures/*.png`                                                                                                                                                                                                                               |
| Análise visual página a página                      | §4                                                                                                                                                                                                                                                     |
| **Limitação**                                       | 3 capturas do Mini App (edição desktop, salvando, conflito) **não receberam análise visual**: o provedor devolveu `503 chat_admission_busy` em todas as tentativas. Os achados sobre essas telas vêm de **leitura de código**, identificados como tal. |

Evidência de execução:

```
Captura desktop+mobile .......... 22/22 GREEN
Unit (fixtures) ................. 4/4 GREEN
typecheck (tsconfig.tests.json) . EXIT=0
eslint . ....................... EXIT=0
prettier (arquivos novos) ....... OK
```

O `playwright.config.ts` da raiz mantém `testDir: './tests/e2e'`, então **a captura não roda na CI** e não altera a bateria existente.

---

## 2. Telas, rotas e estados

Navegação é por hash. Sete rotas de produto + o Mini App:

| Rota                           | Título        | Componente raiz                                                                                                     | Estados capturados                    |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `#overview`                    | Visão geral   | `OverviewReport`                                                                                                    | normal, erro de resultado, sem estado |
| `#bets`                        | Apostas       | `BetsPage`                                                                                                          | lista, detalhe, vazio                 |
| `#calendar`                    | Calendário    | `MonthGrid` + `entriesByDate`                                                                                       | normal                                |
| `#analytics`                   | Análises      | filtros + KPIs + gráfico + tabela                                                                                   | normal                                |
| `#finance`                     | Financeiro    | `AccountList`, `CreditList`, `EntryList`, crédito automático                                                        | normal                                |
| `#settings`                    | Configurações | `ProfileSection`, `CatalogSection`, `UserManagementSection`, `PreferencesSection`, `SecuritySection`, `DataSection` | normal                                |
| `#imports`                     | Importações   | `ImportList`                                                                                                        | lista, erro                           |
| `/miniapp#miniapp?import=<id>` | —             | `MiniApp`, `MiniDraftEditor`                                                                                        | edição, confirmação, conflito, erro   |

### 2.1 Estados do Mini App (as4 rotas de erro/estado do app)

| Estado                 | Gatilho real no código                                                                              | Captura                        |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| Edição                 | rota `#miniapp?import=<id>`                                                                         | `STK-UX-02-miniapp-edicao-*`   |
| Salvando / confirmação | `save()` com `statusChanged && statusSender` → `setConfirmStatus(true)` (`MiniDraftEditor.tsx:838`) | `STK-UX-02-miniapp-salvando-*` |
| Conflito de versão     | `VERSION_CONFLICT` → `catch` → `setHint(...)` (`MiniDraftEditor.tsx:684`)                           | `STK-UX-02-miniapp-conflito-*` |
| Erro de carregamento   | query da importação falha → `role="alert"`                                                          | `capture.spec.ts`              |

Gatilho documentado: o diálogo **só abre com mudança de status**. Mudar apenas a casa não dispara confirmação — comportamento real, não é defeito de teste.

---

## 3. Achados de código (medições, não impressões)

### 3.1 Tipografia

Sete declarações abaixo de 10px, medidas por `grep` em `apps/web/src`:

| Arquivo       | Ocorrências                                       |
| ------------- | ------------------------------------------------- |
| `product.css` | `font-size: 9px` ×4 — linhas 572, 660, 1523, 1569 |
| `product.css` | `font-size: 8px` ×1 — linha 1496                  |
| `style.css`   | `font-size: 9px` ×2 — linhas 157, 239             |
| `style.css`   | `font-size: 8px`                                  | **0 — não existe** |

`product.css:572` é `.sidebar-caption` e `:660` é um rótulo de seção: os 9px estão em rótulos de navegação e cabeçalhos reais, não em código morto.

### 3.2 Cor sem tokens

- `product.css` contém **30+ cores hex distintas**, nenhuma centralizada em variáveis de tema.
- **Três fundos diferentes** convivem: `#101318` (shell), `#101216` (acesso), `#07101f` (Mini App).
- **Seis azuis de ação diferentes**: `#94afff` (botão e `outline`), `#92adff` (rótulo e série do gráfico), `#7d9eff` (acesso), `#739bff` (focus), `#9fb4ff`/`#8ca9ff` (acesso), `#2878ff` (Mini App `--mini-blue`).

### 3.3 Breakpoints

Cinco breakpoints sem escada aparente: `430`, `760`, `960`, `1100`, `1180`.

### 3.4 Acessibilidade

| Medida                          | Valor                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| `role="status"`                 | 51×                                                                       |
| `role="alert"`                  | 47×                                                                       |
| `aria-live`                     | **1×**                                                                    |
| `aria-busy`                     | 3×                                                                        |
| `<input>/<select>/<textarea>`   | 134                                                                       |
| Campos via componente `<Field>` | 86 — **corretos**: `useId()` + `htmlFor` + `aria-describedby` deduplicado |
| Campos com `<label>` direto     | 19                                                                        |
| Campos com `aria-label`         | 0                                                                         |

Conclusão: **o componente `Field` está bem feito** e não é fonte de problema. O risco real está em `aria-live` aparecer só 1 vez para 51 regiões `role="status"` — anúncios de atualização podem não chegar a leitores de tela.

---

## 4. Achados visuais por tela

Análise obtida por inspeção das capturas reais em `docs/ux/captures/`.

### 4.1 Visão geral (`STK-UX-01-visao-geral-desktop-01-overview.png`)

1. **`R$ 0,00` de aposta aberta aparece em verde**, a mesma semântica de lucro. Verde comunica ganho; em aberto não há resultado ainda.
2. **`Resultado do mês` não usa cor semântica**: `R$ 728,40` sai em branco, enquanto a tabela embaixo colore `R$ 68,00` em verde. Duas semânticas na mesma tela.
3. Card `Banca real` tem fundo destacado — sugere seleção/interatividade. Se é só informativo, o destaque é ambíguo.
4. `Registros pessoais` fica solto no topo direito, sem contexto visível.
5. Rótulos secundários (`Disponível + principal em aberto`, cabeçalhos da tabela, `Horário de São Paulo`) no limite do contraste.
6. **Conceitos técnicos sem ajuda**: `Banca real`, `Unidade do mês`, `u`, `Resultado realizado`.

**Pontos fortes**: grid de quatro KPIs funciona bem; `Onde está sua banca` é a seção mais clara da tela (soma coerente com `Disponível`).

### 4.2 Visão geral mobile (`STK-UX-01-visao-geral-mobile-01-overview.png`)

1. **Tabela coberta pela bottom nav fixa** — linhas ficam atrás da barra.
2. **Seis itens na bottom nav para 412px**; o último aparece como `Conf`, cortado.
3. Rodapé empilha três blocos de contexto verticalmente, ocupando espaço de leitura.
4. **R`$ 0,00` segue em verde** no mobile.
5. Filtros e campos têm bom tamanho de toque.

### 4.3 Lista de apostas desktop (`STK-UX-01-apostas-lista-desktop-02-bets-list.png`)

1. **Filtros competem com a tabela** por peso visual e **não têm ações**: não há `Aplicar filtros`, nem `Limpar filtros`. Não fica claro se a filtragem é automática.
2. **Coluna de ação sem cabeçalho**; `Ver ↗` é texto pequeno, sem affordance de botão.
3. **Metadados pequenos demais**: `Bilhete #42`, datas, `4,032 u`, cabeçalhos — todos ~10–11px.
4. Contradição de densidade: **linha alta com texto miúdo**.
5. **Colunas numéricas sem alinhamento à direita** (valor, odd, resultado) — atrapalha comparação.
6. `R$ 0,00` em verde, mesmo problema da visão geral.
7. `Data do evento a conferir` em amarelo, mas **tamanho pequeno demais** para a importância.
8. Filtros de data ambíguos: `Apostada desde` / `Apostada até` — não dizem claramente que data é aquela, sem validação visível, sem chips de filtros ativos.

### 4.4 Lista de apostas mobile (`STK-UX-01-apostas-lista-mobile-02-bets-list.png`)

1. **A tabela não vira cards**: continua horizontal, **última coluna cortada** sem indicação de scroll.
2. **Bottom nav cobre uma linha da tabela**.
3. **Cinco filtros sempre abertos** empurram os dados para baixo.
4. `Apostada desde` e `Apostada até` ficam em linhas separadas — grupo de data quebrado.
5. Mesma falta de `Aplicar`/`Limpar`.
6. `Sair da conta` é link textual com alvo de toque pequeno.

### 4.5 Detalhe da aposta (`STK-UX-01-apostas-detalhe-desktop-03-bet-detail.png`)

1. **`Valor apostado: R$ 100,00` e `Principal aberto: R$ 100,00` duplicam a informação** com termo técnico ambíguo.
2. **`Unidade do registro: R$ 24,80` no mesmo nível dos dados financeiros principais**, sem explicação.
3. **`Retorno recebido: R$ 0,00` e `Resultado realizado: R$ 0,00` em aposta aberta** — parecem resultado fechado em zero. Deveriam ser `—` ou `Não liquidado`.
4. **Faltam retorno e lucro potencial** — o dado mais relevante para aposta de `R$ 100,00` a `2.00`.
5. Badge `Em aberto` pequeno demais para informação crítica.
6. `Comprovantes` vazio antes do card da seleção, quebrando a leitura.
7. `Cancelar registro` (destrutivo) **muito próximo** de `Liquidar aposta` (principal), sem footer separado.
8. `Bilhete #42` e `Referência: BIL-4821` competem como identificador.

### 4.6 Análises (`STK-UX-01-analises-desktop-05-analytics.png`)

1. **Gráfico principal quase fora da primeira dobra** — página de análise onde o gráfico é o que menos aparece.
2. **Card de filtros alto demais** para quatro campos.
3. **Ambiguidade semântica**: `Resultado realizado` vs `Resultado real` vs uso repetido de `real`.
4. **`Datas confirmadas` contradiz o alerta logo abaixo** (`2 apostas com datas incompletas ... foram excluídas`).
5. Indicadores secundários soltos, sem container.
6. `Registros pessoais` posicionado longe do gráfico a que se refere.
7. `Exportar apostas em CSV` discreto demais para uma ação importante.

### 4.7 Estado de erro (`STK-UX-01-estado-de-erro-na-visao-geral-desktop-11-overview-error.png`)

1. **Erro subcomunicado**: `Não foi possível carregar o resultado.` é **linha de texto simples** — sem ícone, sem fundo, sem borda, sem `role` visual de alerta.
2. **`Ver análises` permanece ativo** mesmo com o dado falho.
3. Hierarquia estrutural se mantém (não quebra o layout).
4. `Tentar novamente` é link inline pequeno, sem feedback de estado (`Tentando...`).
5. **Nenhum número antigo do resultado mensal aparece** — correto, não induz a erro.
6. Porém a tabela `Últimas apostas` segue com resultados individuais enquanto o agregado falha — possível inconsistência percebida.

### 4.8 Mini App — edição (`STK-UX-02-miniapp-edicao-*`)

1. **Grupos de formulário sem cabeçalho nem separador visual** — seis blocos de campos em sequência contínua (`Edit bet`, `Close bet`, `Edit origin`, `Edit event`, `Edit match`, `Edit staking`) com uma única `hr` entre dois deles.
2. **O botão principal domina a barra de ação**: `.mini-save-bar button` tem `min-height: 52px`, `font-size: 16px`, `font-weight: 800`, `background: var(--mini-blue)` e largura `min(652px, 100%)` — é o elemento de maior peso da tela.
3. **Título do app quase invisível**: `stakeframe. · Mini app · Editar aposta` em `10px` e `var(--muted)`; a única `h1` da tela tem o menor peso.
4. Contraste de placeholder `Edit as necessary` **abaixo do mínimo WCAG**.
5. **Filtro de `.mini-segmented label` tem `min-height: 42px`** — 2px abaixo do alvo de toque mínimo de 44×44. E o item ativo é sinalizado **apenas por `background` + `box-shadow`**, sem borda.
6. O estado de salvamento **existe e é adequado**: o botão passa para `Salvando e confirmando…` / `Salvando e sincronizando…`, fica `disabled` e recebe `opacity: 0.6; cursor: wait`.

#### 4.8.1 Mobile (análise visual independente)

7. **A barra fixa de salvar sobrepuja o conteúdo** — na captura ela aparece **entre `País` e `Tipo de aposta`**, cortando a continuidade do formulário. O `padding-bottom` de `.app-body` não compensa a barra fixa.
8. **Campos informativos com aparência de editável** — `Enviado em 22/09/2026, 15:00` parece um input que aceita digitação; não há `disabled`, cadeado ou rótulo de leitura.
9. **Rótulos ambíguos**: `Origem da aposta` (dinheiro/freebet/híbrida) e `Origem e identificação` (casa/tipster) são nomes quase iguais para coisas diferentes.
10. **`Aposta 1` repetido** — título do card e rótulo interno, com significados distintos.
11. Duas colunas (`Data+Hora`, `Casa+Tipster`, `Valor+Odd`) funcionam nos textos atuais mas ficam apertadas com valores mais longos.
12. Título de seção **`Legenda original do Telegram`** sem conteúdo visível logo abaixo.

### 4.9 Mini App — confirmação e conflito

1. `Confirmar status` abre como `alertdialog` com a consequência financeira escrita — bom (exige confirmação explícita antes de liquidar/estornar).
2. Conflito de versão é sinalizado por `hint`, não por alerta com papel/ícone — o usuário pode não perceber que a escrita falhou e **que o que digitou não foi salvo**.

---

## 5. Problemas por categoria

### 5.1 Hierarquia

| ID  | Problema                                                    | Onde                  |
| --- | ----------------------------------------------------------- | --------------------- |
| H1  | Card destacado (`Banca real`) sugere interatividade sem ser | `#overview`           |
| H2  | Card de filtros compete com o conteúdo principal            | `#bets`, `#analytics` |
| H3  | Gráfico abaixo da dobra em página de análise                | `#analytics`          |
| H4  | Indicadores secundários sem container                       | `#analytics`          |
| H5  | Ação destrutiva junto da principal, sem footer              | detalhe da aposta     |
| H6  | Camadas de formulário do Mini App sem cabeçalho/separador   | Mini App              |
| H7  | Único `h1` é o menor texto da tela do Mini App              | Mini App              |

### 5.2 Legibilidade

| ID  | Problema                                               | Onde                       |
| --- | ------------------------------------------------------ | -------------------------- |
| L1  | `8px` e `9px` em uso real                              | `product.css`, `style.css` |
| L2  | Metadados da tabela ~10–11px                           | `#bets`                    |
| L3  | Cabeçalhos e textos secundários no limite do contraste | todas                      |
| L4  | Placeholder do Mini App abaixo de 4.5:1                | Mini App                   |
| L5  | `Data do evento a conferir` amarelo e pequeno          | `#bets`                    |

### 5.3 Formulários

| ID  | Problema                                                                                        | Onde                   |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| F1  | **Dois padrões de filtro incompatíveis**: `#bets` sem botão, `#analytics` com `Aplicar filtros` | `#bets` × `#analytics` |
| F2  | Sem `Limpar filtros` em nenhuma tela                                                            | todas                  |
| F3  | Sem chips de filtros ativos                                                                     | `#bets`, `#analytics`  |
| F4  | `Apostada desde/até` ambíguos, sem validação visível                                            | `#bets`                |
| F5  | Filtros sempre abertos no mobile empurram dados                                                 | `#bets` mobile         |
| F6  | Grupo de data quebrado em duas linhas no mobile                                                 | `#bets` mobile         |

### 5.4 Feedback

| ID  | Problema                                                       | Onde             |
| --- | -------------------------------------------------------------- | ---------------- |
| E1  | Erro como linha de texto, sem papel visual                     | `#overview` erro |
| E2  | Conflito de versão só por `hint`, sem alerta de não-salvamento | Mini App         |
| E4  | `Tentar novamente` sem feedback de retomada                    | `#overview` erro |
| E5  | `aria-live` 1× para 51 `role="status"`                         | app              |

> Verificado: o estado de salvamento do Mini App **não** é um problema — o botão muda de rótulo, desabilita e escurece. Não entrou nesta lista.

### 5.5 Carregamento

| ID  | Problema                              | Onde             |
| --- | ------------------------------------- | ---------------- |
| C1  | `aria-busy` só 3×                     | app              |
| C2  | `Ver análises` ativo com o dado falho | `#overview` erro |

### 5.6 Acessibilidade

| ID  | Problema                                                                             | Onde                          |
| --- | ------------------------------------------------------------------------------------ | ----------------------------- |
| A1  | Bottom nav cobre conteúdo da tabela                                                  | mobile                        |
| A2  | 6 itens na bottom nav; `Conf` cortado                                                | mobile                        |
| A3  | `.mini-segmented label` com `min-height: 42px` (2px abaixo de 44)                    | Mini App                      |
| A4  | Itens ativos de seguidores só por borda                                              | Mini App                      |
| A5  | Sem `aria-label` em nenhum dos 134 controles                                         | app (mitigado pelo `<Field>`) |
| A6  | Barra fixa de salvar sem `padding-bottom` suficiente: **sobrepuja o formulário**     | Mini App mobile               |
| A7  | Campo informativo (`Enviado em…`) com aparência de editável                          | Mini App                      |
| A8  | Rótulos ambíguos: `Origem da aposta` × `Origem e identificação`; `Aposta 1` repetido | Mini App                      |

---

## 6. Achado transversal mais importante

**`R$ 0,00` em aposta aberta aparece em verde, junto de lucro positivo.**

Isso ocorre em `#overview` e `#bets`. Num produto cuja proposta é ser uma operação financeira confiável, **zerado e lucrativo não podem dividir cor**. É o único achado que afeta a confiança nos números, e não é cosmético.

---

## 7. Referências externas — verificadas antes de citar

Toda URL abaixo foi aberta e confirmada individualmente. Uso é **inspiracional**: nenhuma tela, artefato ou recurso é copiado.

| Referência                                                                                                                                                   | Status da verificação                                                                     | O que serve                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| [Mobbin — KakaoBank iOS Account Overview](https://mobbin.com/explore/screens/04517e3b-abac-4250-8af0-433d2c26d7de)                                           | Confirmada: `Account cards displaying balances and options for card and transfer actions` | Hierarquia de saldo + ação             |
| [Mobbin — Front Inbox Email Thread](https://mobbin.com/explore/web/screens/emails-messages)                                                                  | Confirmada na coleção `Front Web > Emails & Messages > Inbox Email Thread`                | Listagem → detalhe em colunas          |
| [Mobbin — Saturn Calendar iOS Scheduled Events](https://mobbin.com/explore/screens/8a1dfb72-930d-4665-8de0-c67e54416dfd)                                     | Confirmada: `Event card is selected to display detailed event information`                | Calendário com seleção inline          |
| [Mercury — Transactions page](https://support.mercury.com/hc/en-us/articles/38790547830036-Viewing-cashflow-and-transactions-data-on-your-Transactions-page) | Confirmada: `Viewing cashflow and transactions data on your Transactions page`            | Leitura de tabela financeira densa     |
| [W3C — How to Meet WCAG (Quick Reference)](https://www.w3.org/WAI/WCAG22/quickref/)                                                                          | Confirmada: norma WCAG 2.2, níveis A e AA                                                 | Critérios de contraste e alvo de toque |

**Não utilizada**: a URL `Origin Spending Overview` não foi confirmada individualmente nesta rodada e, por isso, **não é citada como referência**. A categoria (visão de gastos em app bancário) é mencionada apenas como gênero, sem URL.

---

## 8. Confronto com `docs/UI-UX-PLAN.md` (não versionado)

O arquivo foi localizado em `C:/Users/Rhian Batista/.codex/worktrees/7740/NEW-TRACK/docs/UI-UX-PLAN.md`, estado `?? docs/UI-UX-PLAN.md` — **não versionado, em outro worktree**. Lido apenas para confronto; **não copiado, não movido, não sobrescrito**, e a cópia original permanece intacta.

| Ponto do plano                                                       | Confronto com o produto real                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6 define `action: #92ADFF`                                          | **Existe parcialmente**: `#92adff` está em `product.css:569` (rótulo) e em `analytics.tsx:145,176` (série do gráfico). Mas o botão primário usa `#94afff` e o Mini App `#2878ff`. Ou seja, o token está escrito no plano, mas **não é a cor da ação principal**. |
| §6 define `surface: #181D26`                                         | **Não existe em nenhum arquivo** de `apps/web/src`, `packages/` ou `tests/`. O shell usa `#101318`. Superfície proposta ≠ superfície implementada.                                                                                                               |
| §2.1 cita 6 URLs Mobbin                                              | Verificadas 5 de 6; **`Origin Spending Overview` não confirmada e por isso não citada**.                                                                                                                                                                         |
| §4 prevê `UX-01 = baseline` e `UX-02 = sistema + 3 fluxos`           | **Consistente** com o pedido atual.                                                                                                                                                                                                                              |
| §4 descreve os 3 fluxos como `visão geral, revisão e edição MiniApp` | **Divergente do pedido atual**, que manda `visão geral, apostas (lista/detalhe) e edição no Mini App`, e proíbe recriar a antiga página de revisão de importações. **Prevalece o pedido atual.**                                                                 |
| §5 lista `UX-03..UX-06`                                              | Fora do escopo desta tarefa; não tocados.                                                                                                                                                                                                                        |
| §9 diz `Artefatos propostos ainda não foram criados`                 | Confirmado: nenhum artefato existia antes desta tarefa.                                                                                                                                                                                                          |

---

## 9. Fora do escopo

- **Nenhuma alteração de comportamento financeiro**, de comando canônico, de idempotência ou de liquidação.
- A antiga página de revisão de importações **não é recriada** nem redesenhada.
- Nenhum dado real de bilhete, conta, usuário ou token é exibido.
- `UX-03..UX-06`, fundos animados e rebranding completo: fora desta tarefa.
