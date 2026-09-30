# STK-F2-15 — Ranking oficial Polymarket, filtros e truncamento visível

Plano Master 2026 §9.1–§9.3 e §15. Card `t_63434b3b`. Depende da **STK-F2-14**
(ingestão, PR #239).

**Alterações de banco: NENHUMA.** Nenhuma migração foi criada ou aplicada. A
leitura usa exatamente as tabelas que a F2-14 gravou.

## O que mudou, em uma frase

A tela mostra o **top 100 do leaderboard oficial** — posição, P&L, volume e
amostra, nos decimais exatos que a Polymarket publicou — e **declara na tela**
quando a série está truncada, bloqueando a métrica que dependeria de cobertura
completa.

## 1. O enum oficial, e uma divergência com o contrato da F2-14

A tarefa exige os enums oficiais **conferidos contra o contrato verificado na
F2-14**. A conferência encontrou uma divergência, e ela está registrada aqui em
vez de resolvida em silêncio.

A F2-14 afirma (e o CHECK do banco impõe) que `category` aceita **apenas
`OVERALL`**. A documentação oficial de `/v1/leaderboard` declara **onze**
categorias. Os onze valores foram sondados **um a um** contra a origem:

| `category`     | Resposta | Filtra?                                 |
| -------------- | -------- | --------------------------------------- |
| `OVERALL`      | 200      | base                                    |
| `POLITICS`     | 200      | sim (1 trader em comum com OVERALL/T10) |
| `SPORTS`       | 200      | sim (0 em comum)                        |
| `ESPORTS`      | 200      | sim (0 em comum)                        |
| `CRYPTO`       | 200      | sim (0 em comum)                        |
| `CULTURE`      | 200      | sim (0 em comum)                        |
| `MENTIONS`     | 200      | sim (0 em comum)                        |
| `WEATHER`      | 200      | sim (0 em comum)                        |
| `ECONOMICS`    | 200      | sim (0 em comum)                        |
| `TECH`         | 200      | sim (0 em comum)                        |
| `FINANCE`      | 200      | sim (0 em comum)                        |
| `SCIENCE`      | **400**  | rótulo fora da lista oficial            |
| `WORLD`        | **400**  | rótulo fora da lista oficial            |
| `BUSINESS`     | **400**  | rótulo fora da lista oficial            |
| `OVERALL_TIME` | **400**  | rótulo fora da lista oficial            |

`timePeriod` (`DAY`, `WEEK`, `MONTH`, `ALL`) e `orderBy` (`PNL`, `VOL`) foram
reconferidos e **batem** com a F2-14. O teto `limit=50` também bate.

### O que a interface faz com a divergência

As dez categorias além de `OVERALL` **são filtros reais da API oficial**, e
este card as oferece na tela. Elas ainda **não têm série ingerida** — a F2-14
ingere uma única categoria e o CHECK `polymarket_series_category_check`
recusaria as outras (o teste de integração prova que o banco recusa).

A resposta para uma delas **não é lista vazia**: é `available: false`, com o
rótulo **"Janela ainda não coletada"** e a explicação de que a janela não foi
coletada pela nossa ingestão. Isso é a diferença entre _"não existe trader
nessa categoria"_ e _"ainda não coletamos essa categoria"_, que são frases
opostas e que a tela não pode confundir.

**Pendência para a F2-17 (ativação):** ampliar a ingestão para as categorias
exige migração (CHECK novo), o que está fora do escopo desta tarefa.

## 2. Período padrão: P&L de 30 dias

O card pede "ranking padrão PnL oficial 30d". O enum da API **não tem `30d`**:
o valor oficial é `MONTH`, e é ele que vai para a query. O rótulo em português
é que diz "30 dias". `GET /api/v1/polymarket/ranking` sem query devolve
exatamente `category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=100`.

## 3. A completude é lida, nunca inferida

`integration.polymarket_series.status` é o único campo que fala de
completude. A contagem de linhas **não** decide nada, e o teste §15 prova os
dois lados:

- **100 linhas com `status = 'truncated'`** → aviso visível. A lista é real, os
  valores são exatos, mas **não** é o ranking inteiro.
- **3 linhas com `status = 'complete'`** → sem aviso. Tratar como truncada
  seria um aviso falso, que também é mentira.
- **`partial`** → truncada _com o motivo a mais_ (quantas páginas falharam).
- **`unknown` / sem série** → "Janela ainda não coletada".

`truncated` é o estado real e normal deste backfill: a origem entrega página
cheia em `offset=5000` e nunca declara o fim da paginação.

## 4. A métrica dependente de série completa é BLOQUEADA

O total do tabuleiro (P&L e volume de **todos** os traders) e a participação de
cada trader nele dependem de a série ser `complete`. `rankingAggregatePolicy`
recusa com o motivo em `truncated`, `partial`, `unknown` e `available: false`, e
a recusa **viaja na resposta** como `aggregate: { blocked: true, reason }` — a
tela escreve "Métrica bloqueada" com a razão. Não há caminho de código que
devolva o número, e não há simulação nem estimativa no lugar dele.

## 5. Composite Score, badge e recomendação: AUSENTES

O card (§9.3) exclui Composite Score, badge, recomendação e qualquer trade. A
ausência aqui é **estrutural**, não uma omissão:

1. **O schema recusa.** `polymarketRankingSchema` e `polymarketRankingRowSchema`
   são `strictObject`: um campo de pontuação acrescentado no servidor quebra o
   parse em vez de aparecer em silêncio. O teste §15 tenta e confirma a falha.
2. **A função pura não produz.** `rankingRowView` devolve exatamente sete
   campos — `key`, `rank`, `trader`, `wallet`, `pnl`, `vol`, `negative`.
3. **O render não escreve.** O e2e varre o `innerText` da página inteira
   procurando `composite`, `score`, `badge`, `recomend`, `selo`, `rating` e
   compara os cabeçalhos da tabela com a lista exata de cinco colunas da origem.
4. **O código-fonte não nomeia.** O teste varre os arquivos de produto
   (schema, leitura, rota, OpenAPI, view, componente) e exige a ausência do
   termo fora de comentário.

O termo aparece **apenas** em comentários, que explicam a ausência, e nos
nomes dos testes que verificam a ausência.

## 6. Valores exatos, do banco até a tela

`numeric(38, 18)` devolve a escala cheia do Postgres: `792578.3948993701` volta
como `792578.394899370100000000`. A leitura normaliza com
`canonicalDecimalToken`, que remove **apenas** os zeros à direita do padding
(nenhum dígito significativo muda) e devolve a grafia que a origem publica. O
teste de integração compara **caractere a caractere**.

`formatExactDecimal` exibe sem arredondar e sem conversão de moeda: a
Polymarket publica em US$ e **não há cotação no produto** — converter
publicaria um número que ninguém mediu.

## 7. Ordenação

A ordem é `rank::bigint` — a posição **declarada** pela origem. O `rank` é
texto no banco (a F2-14 o guardou assim), então o cast serve só para ORDENAR e
o valor volta ao texto original. Reordenar por `pnl` trocaria a resposta
oficial por uma ordenação nossa; o teste de integração grava as linhas fora de
ordem, com P&L invertido, e exige `1, 2, 3`.

## 8. Amostra

A regra é a **mesma** que o dashboard analítico já usa (`DASHBOARD_MIN_SAMPLE`,
padrão 30) — este card não cria uma segunda regra. `N` é o número de registros
**exibidos** (o que o usuário confere na tela), não o ingerido. Abaixo do
limiar, aparece o aviso e **nenhum** texto de leitura, comparação ou
recomendação.

## 9. Autorização, escopo e segurança

- **Sem chamada externa nova.** A rota lê o banco. Por isso **não** consulta a
  porta de entitlement da F2-13: ela existe para pagar por uma chamada, e esta
  rota não paga por nenhuma.
- **Sem organização, usuário ou tenant** na rota nem na tela. O ranking é
  público; aceitar um id de destino abriria impersonação.
- **Sem feature flag** nesta tarefa. A ativação é da F2-17, e a rota responde
  **503 fail-closed** quando o serviço de leitura não está registrado.
- A tela entra nas **superfícies sensíveis** (sem replay), como as demais telas
  de número.

## 10. Arquivos

| Arquivo                                       | Papel                                    |
| --------------------------------------------- | ---------------------------------------- |
| `packages/shared/src/polymarket-ranking.ts`   | contrato, enums, completude, recusa      |
| `packages/shared/src/polymarket.ts`           | `canonicalDecimalToken` (leitura/escala) |
| `packages/db/src/polymarket-ranking.ts`       | leitura; nenhuma escrita                 |
| `apps/api/src/polymarket-ranking-routes.ts`   | rota + filtros oficiais                  |
| `apps/web/src/product/ranking-view.ts`        | view model puro                          |
| `apps/web/src/product/polymarket-ranking.tsx` | a página                                 |

## 11. Testes §15

- `tests/unit/polymarket-ranking.test.ts` — 28 testes: enums oficiais,
  decimais exatos, completude (os dois lados), recusa do agregado, amostra,
  ausência de Composite Score.
- `tests/integration/polymarket-ranking.test.ts` — 7 testes contra PostgreSQL 18
  real: exatidão do decimal, ordem declarada, truncada na leitura, categoria
  não ingerida, CHECK do banco, limite do top 100, ausência de migração.
- `tests/e2e/polymarket-ranking.test.ts` — 4 testes no navegador: aviso
  visível com 100 linhas, **ausência de score no texto renderizado**, janela
  não coletada, enums na tela.
