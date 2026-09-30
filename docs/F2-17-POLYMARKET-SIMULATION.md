# STK-F2-17 — Simulação indicativa Polymarket (stake fixa, recusa por cobertura incompleta)

Plano Master 2026 §9.5 e §15. Card `t_ba6185d4`. Depende da **STK-F2-14**
(ingestão, PR #239) e da **STK-F2-15** (ranking, PR #242).

**Alterações de banco: uma migração, `0030_polymarket_simulation`** (reservada
para esta tarefa). Forward-only e replay-safe. **LOCAL apenas** — nada é
aplicado em produção.

## O que mudou, em uma frase

A tela do ranking ganhou uma seção que aplica uma **stake fixa** às posições que
a Polymarket já publicou e devolve um número **meramente indicativo** — e se
recusa, sem nenhum número, sempre que a cobertura gravada pela F2-14 não for
completa.

## 1. As três regras do card e onde cada uma morde

### 1.1 Recusa por cobertura incompleta — sem exceção

A recusa é decidida pela função pura `simulationRefusalPolicy`, e a COMPLETUDE
vem de `integration.polymarket_series.status`, **o mesmo status gravado pela
F2-14** que a tela do ranking já mostra. A função `rankingCompleteness` é
reaproveitada em vez de redefinida, para que "truncada" tenha um único
significado no produto inteiro.

Quatro motivos, avaliados nesta ordem — e a ordem importa, porque a primeira
condição verdadeira é a relatada:

| Código                 | Quando                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| `SERIES_NOT_COLLECTED` | A janela nunca foi ingerida. Sem dado, não há o que simular.     |
| `SERIES_NOT_COMPLETE`  | A série existe e está `truncated`, `partial` ou `unknown`.       |
| `SAMPLE_TOO_SMALL`     | `N` abaixo de `DASHBOARD_MIN_SAMPLE` (a MESMA regra do produto). |
| `MISSING_DATA`         | Alguma observação não tem volume publicado.                      |

Não existe exceção, flag ou caminho de código que apure sobre série não
completa. `truncated` é o **estado real e normal** deste backfill — a
Polymarket responde `200` em `offset=5000` e nunca declara o fim da paginação —
e por isso a recusa é o comportamento esperado, não um erro raro.

**A recusa é resposta 200, não erro HTTP.** Se fosse 4xx, o usuário veria
"erro" numa situação que é o funcionamento correto, e a tela não teria como
mostrar a explicação. O card pede "impedir resultado", não "quebrar a tela".

### 1.2 Premissas sempre visíveis

AS SETE premissas viajam na resposta nos **dois desfechos**, e o banco recusa
gravar uma linha sem as sete (`polymarket_simulation_premise_shape_check`):

| Chave             | Origem       | O que é                                                    |
| ----------------- | ------------ | ---------------------------------------------------------- |
| `stake`           | `configured` | A stake fixa escolhida pelo usuário.                       |
| `delayMs`         | `declared`   | O atraso estrutural entre o dado consolidado e a leitura.  |
| `feeRate`         | `configured` | Taxa que o usuário supõe pagar.                            |
| `spreadRate`      | `configured` | Custo de atravessar o livro — não coletamos livro.         |
| `slippageRate`    | `configured` | Deslocamento entre preço teórico e de execução.            |
| `missingDataRate` | `measured`   | `(50 − n) / 50` — quanto da primeira página oficial falta. |
| `completeness`    | `measured`   | O status gravado pela coleta.                              |

O campo `kind` é o que separa **medição de hipótese**, e a tela escreve a
origem ao lado de cada uma: "Escolhido por você", "Medido pela coleta",
"Declarado pelo limite".

A taxa de dados ausentes é medida sobre a **primeira página oficial** (50
registros, teto verificado por probe na F2-14). Ela **não é subtraída** do
resultado: o sinal do dado que falta é desconhecido, e subtrair com sinal
presumido publicaria uma precisão que não existe. Aparece como **faixa de
incerteza** ao lado do líquido.

### 1.3 Retorno nunca apresentado como executável

A natureza não executável é uma decisão de **TIPO**, não de texto:

- `kind: z.literal('indicative')`
- `executable: z.literal(false)`
- `executed: z.literal(false)`

Não existe valor outro que o schema aceite. O `refine` da resposta fecha as
outras duas metades da invariante:

- recusada ⇒ `indicative` é `null` **e** há código, razão e remédio;
- apurada ⇒ a recusa é vazia, o número existe e a série é `complete`.

O teste §15 monta os dois forjamentos (`executable: true` e "número atrás de
recusa") e exige que o schema recuse **os dois**. O banco fecha a mesma regra em
`polymarket_simulation_outcome_exclusive` e
`polymarket_simulation_complete_required`.

Os **avisos de jogo responsável (§4.9)** são uma lista de cinco frases fixas,
obrigatórias em toda saída (`min(1)` no schema, CHECK no banco) e gravadas
junto do número — para que um registro nunca possa ser citado sem o aviso que
foi exibido. Nenhum campo de execução, estratégia ou recomendação existe no
schema, e `strictObject` faz um campo a mais quebrar o parse em vez de passar
em silêncio.

## 2. A aritmética

`BigInt`, três escalas, arredondamento half-up **exato no meio** e simétrico ao
sinal — nunca `Number`, nunca `parseFloat`:

| Escala        | Casas | Para quê                                       |
| ------------- | ----- | ---------------------------------------------- |
| `OBSERVATION` | 18    | `vol` e `pnl` da origem (o `numeric(38, 18)`). |
| `RATE`        | 6     | Razão e taxas.                                 |
| `MONEY`       | 2     | Stake e todos os números de saída.             |

A distinção entre a escala da origem e a do dinheiro é o ponto mais importante:
reduzir `792578.3948993701` a centavos no momento da leitura **descartaria um
dígito que a origem mandou**, e a razão derivada carregaria o erro no primeiro
dígito — exatamente onde a tela promete exatidão.

O cálculo, em ordem: `stake × n × razão` = bruto; cada fricção é um **custo
separado e visível**; o líquido é o bruto menos a soma das fricções; a faixa de
incerteza é a magnitude da lacuna, sem sinal.

## 3. O que o registro guarda

`integration.polymarket_simulation` é por **organização**, com RLS fail-closed
(a mesma fronteira de `report_snapshot`, 0027). A tentativa é gravada **recusada
ou apurada** — uma recusa sem registro é uma recusa que pode ser reescrita como
se nunca tivesse ocorrido.

`series_status` é uma **cópia** do status no instante da apuração, e não uma
referência viva. O motivo é o tempo: a série pode ser reingerida depois e virar
completa, mas o registro daquela recusa continua verdadeiro — a recusa reflete o
que se sabia quando a apuração foi pedida.

A dedupe é do banco (`ON CONFLICT DO NOTHING` sobre
`(organization_id, dedupe_key)`): o mesmo pedido com a mesma entrada é gravado
uma vez.

Não existe coluna de preço, book, ordem, recomendação ou estratégia. A ausência
é visível na lista de colunas.

## 4. A PENDÊNCIA HERDADA: o CHECK do enum `category`

**Decisão: NÃO tocar nos CHECKs da 0028.** A pendência fica registrada.

O problema: a F2-14 gravou `polymarket_series_category_check` e
`polymarket_trader_category_check` aceitando **apenas** `OVERALL`, e a F2-15
descobriu por **probe** que a API oficial aceita **onze** categorias (as onze
respondem `200`; rótulos fora da lista respondem `400`).

Por que esta card não precisa:

1. **A simulação aceita o enum oficial de onze** — é o que a interface oferece e
   o que a F2-15 gravou. Uma janela fora de `OVERALL` é **sempre recusada** com
   `SERIES_NOT_COLLECTED`, e a recusa explica que a janela não tem série. Nenhuma
   exceção, nenhuma estimativa.
2. **Ampliar o CHECK sem ampliar a INGESTÃO** criaria a possibilidade de gravar
   uma série que o job de ingestão não produz — a forma de um schema permissivo
   mentir sobre a cobertura. A ingestão multi-categoria muda o job do worker
   (11 × 4 × 2 = 88 séries), o volume de chamada externa, o custo pela porta de
   entitlement da F2-13 e o backfill de 180 dias.
3. **Soltar um CHECK em migração já aplicada** é a operação que exige backup
   recuperável e janela própria no runbook. Fazer isso "de brinde" numa tarefa
   de tela trocaria o risco pequeno de um schema novo pelo risco grande de
   reescrever uma restrição existente.
4. A tarefa proíbe tocar em `stk/f2-16-polymarket-favoritos`, que está sendo
   implementada em paralelo.

O teste §15 prova que o CHECK da F2-14 **continua intacto**: a tentativa de
gravar `SPORTS` em `polymarket_series` é recusada pelo Postgres.

## 5. Onde a simulação aparece na tela

Como **seção** da página do ranking, e não como destino novo da navegação: as
duas features leem o mesmo status gravado e precisam dizer a mesma coisa sobre a
completude, e um nono destino na barra inferior forçaria nove colunas com nove
rótulos numa tela de bolso — o alvo de toque que o teste de navegador já
garante em 44 px. A navegação continua com os **oito** destinos.

A ordem de leitura é fixa e é o card inteiro: **natureza → cobertura → recusa →
premissas → número → avisos**. A natureza vem antes de qualquer campo porque é
ela que muda a leitura de todo o resto; as premissas vêm antes do número porque
um número lido sem a ressalva que o limita já foi mal interpretado.

## 6. Arquivos

| Arquivo                                                 | Papel                                           |
| ------------------------------------------------------- | ----------------------------------------------- |
| `packages/shared/src/polymarket-simulation.ts`          | contrato, motor puro, recusa, premissas         |
| `packages/db/migrations/0030_polymarket_simulation.sql` | registro, CHECKs, RLS, funções IMMUTABLE        |
| `packages/db/migrations/meta/_journal.json`             | entrada `idx 29`                                |
| `packages/db/src/polymarket-simulation.ts`              | leitura do status gravado + apuração + registro |
| `apps/api/src/polymarket-simulation-routes.ts`          | rota + contrato de premissas/avisos             |
| `apps/web/src/product/simulation-view.ts`               | view model puro                                 |
| `apps/web/src/product/polymarket-simulation.tsx`        | a seção da tela                                 |
| `docs/openapi.json`                                     | contrato gerado                                 |

## 7. Testes §15

- `tests/unit/polymarket-simulation.test.ts` — **34 testes**: recusa por
  cobertura (truncada, parcial, desconhecida, não coletada), ordem de
  reporting, ausência de volume, taxa de dados ausentes, as sete premissas nos
  dois desfechos, os cinco forjamentos recusados (executável, executado, número
  atrás de recusa, número sobre cobertura incompleta, campo a mais), aritmética
  exata com literais que o IEEE-754 não reproduz, e validação da entrada.
- `tests/integration/polymarket-simulation.test.ts` — **13 testes** contra
  PostgreSQL 18 real: recusa com 50 linhas e série truncada, recusa gravada com
  os números a `NULL`, apuração com decimais exatos, categoria oficial sem
  série, dedupe do banco, **cinco tentativas forjadas recusadas pelo Postgres**
  (número atrás de recusa, apuração sobre série truncada, premissas quebradas
  em três formas, aviso vazio ou em branco), o CHECK da F2-14 intacto, RLS, e a
  0030 no journal.
- `tests/e2e/polymarket-simulation.test.ts` — **6 testes** no navegador: a recusa
  **não vira número** na tela, as sete premissas na recusa, o número com as
  fricções descontadas separadamente, o texto renderizado sem promessa de
  execução, os avisos nos dois desfechos, e a navegação com oito destinos.

## 8. Autorização, escopo e limites

- **Sem chamada externa nova.** A rota lê o banco; portanto **não** consulta a
  porta de entitlement da F2-13, que existe para pagar por uma chamada.
- **Sem execução real, sem otimização, sem estratégia, sem retorno prometido.**
  Não há caminho de código que faça qualquer uma dessas coisas.
- **A organização vem do usuário autenticado**, nunca do corpo. A rota não é
  registrada sem o resolvedor, e sem ele responde 503.
- **`POST` exige `Origin`** igual à origem configurada, como as demais
  mutações: a simulação grava uma linha.
- **A tela entra nas superfícies sensíveis** (sem replay), como as demais telas
  de número.
- **Sem feature flag.** A ativação do Polymarket é da F2-18 e **exige
  autorização específica do proprietário**.

### Limitações declaradas

1. A simulação **não apura** enquanto a série não for `complete` — e `truncated`
   é o estado real do backfill atual. Na prática, hoje, a apuração é rara: é o
   comportamento correto, não uma falha.
2. A razão é `soma(pnl) / soma(vol)` da janela, uma **média de razão**. Ela é
   publicada com o nome `publishedRatio` justamente para que ninguém a leia
   como coeficiente de forecast.
3. A taxa de dados ausentes é medida sobre a **primeira página** (50), não
   sobre o total do leaderboard — que a Polymarket nunca declara.
4. Fricções e atraso são **hipóteses do usuário**, não medidas: a Polymarket não
   publica taxa por leaderboard, e o produto não coleta livro de ofertas.
5. O registro é por organização e não tem leitura na interface: esta tarefa não
   ficha histórico de simulações.
