# STK-F2-09 — Importação: template Stakeframe + CSV genérico com mapeamento visual

Unidade STK-F2-09 do Plano Master 2026 (§8.4, §15 "Financeiro, importação").
Base: `faed20c` (main, com a STK-F2-13 já integrada).

Esta entrega **não** autoriza produção: sem merge, sem deploy, sem promoção e
sem aplicação da migração fora do ambiente local.

## 1. Objetivo

Dois caminhos de importação por arquivo, com a mesma fronteira financeira da
foto e sem nenhum atalho:

1. **Template Stakeframe** — o servidor gera o modelo com as colunas canônicas
   e o cliente baixa. O arquivo é reconhecido pelo **cabeçalho**, não pelo nome:
   renomear o template não o transforma em genérico, e um genérico com as
   colunas canônicas não é aceito sem o mapeamento declarado.
2. **CSV genérico com mapeamento visual** — o usuário diz qual coluna do
   arquivo é cada campo do produto. A sugestão chega preenchida, e ele confirma.

Sobre os dois: preview linha a linha com o motivo de cada recusa, validação por
linha, commit do lote com idempotência, resultado parcial explícito, rollback
antes da confirmação e progresso pelo estado do job (sem SSE).

## 2. Onde a política mora

| Camada        | Arquivo                                 | Responsabilidade                                               |
| ------------- | --------------------------------------- | -------------------------------------------------------------- |
| Contrato puro | `packages/shared/src/import-csv.ts`     | colunas, mapeamento, quebra de CSV, datas, veredito por linha  |
| Serviço       | `packages/db/src/import-batch.ts`       | preview, commit pelo comando canônico, rollback, estado do job |
| API           | `apps/api/src/import-batch-routes.ts`   | rotas, sessão do dono, gate de recurso da F2-13                |
| Web           | `apps/web/src/product/import-batch.tsx` | download do modelo, mapeamento visual, preview, reversão       |

## 3. Quatro garantias, e cada uma é uma função

**1) O mapeamento é do usuário, nunca inferido.** `resolveMapping` recebe o
mapeamento DECLARADO; `suggestMapping` existe justamente para o servidor _não_
decidir — ela devolve a equivalência óbvia como sugestão, e a sugestão que o
usuário recusou não tem caminho de volta. Duas colunas para o mesmo campo é
`IMPORT_MAPPING_CONFLICT`, porque escolher uma delas seria inventar dado.

**2) Nada entra no banco antes do preview.** `preview()` não escreve em
`finance.bet`, `finance.journal` nem `finance.posting` — o teste
`o template é reconhecido pelo cabeçalho e o preview não escreve aposta` prova
que a aposta e a exposição continuam em zero depois do preview.

**3) O commit usa o comando financeiro canônico.** Cada aposta do lote entra por
`executeFinancialCommand` com `bet.create` — o mesmo caminho do formulário
manual, com catálogo ativo, unidade do mês, crédito, exposição e auditoria. Não
existe escrita de `bet.create` paralela: a origem seria a primeira divergência,
e ela apareceria na segunda aposta do lote.

**4) O rollback reverte, não apaga.** Cada aposta carrega `import_batch_id` e o
estorno sai por `bet.cancel` (journal de reversão + `cancelled`). O lançamento
e a sua reversão permanecem, e a exposição volta ao valor anterior.

## 4. Modelo de dados (migração `0026_import_batches`)

Forward-only e replay-safe (`IF NOT EXISTS`, `DROP ... IF EXISTS`, `ON CONFLICT
DO NOTHING`, `DO $$ … END $$`), no mesmo padrão da 0024 e da 0025. **Aplicada só
em local.**

### `integration.import_batch`

Uma linha por upload, com a identidade `content_sha256` = SHA-256 de
`conteúdo ‖ mapeamento efetivo ‖ origem`. O mapeamento entra na identidade
porque o mesmo arquivo lido de duas formas produz resultados diferentes — sem
ele, corrigir o mapeamento devolveria o preview antigo, que é exatamente o
defeito que o usuário está tentando corrigir.

O CHECK `import_batch_partition_check` é a garantia do resultado parcial:
`committed + skipped = total` nos estados gravados, e o banco recusa a
divergência (23514).

### `integration.import_batch_receipt`

Recibo idempotente da confirmação: hash do pedido + resultado sanitizado,
`ON CONFLICT DO NOTHING`. Repetir a confirmação devolve o resultado gravado; a
mesma chave com outro conteúdo é `IMPORT_BATCH_ALREADY_COMMITTED`.

### `finance.bet` — marcação de origem

`import_batch_id` (ON DELETE SET NULL) e `import_origin`. A segunda é a origem
**permanente** do lançamento e sobrevive à reversão e à exclusão do lote — é ela
que responde "de onde veio este registro" depois que o arquivo foi descartado.

O CHECK `bet_import_origin_pair_check` exige que origem e lote nasçam juntos e
que, sem lote, a aposta esteja revertida: aposta aberta com origem e sem lote é
um lançamento que ninguém consegue reverter.

### RLS

`import_batch` e `import_batch_receipt` têm RLS fail-closed (predicado
explícito de organização, como as demais tabelas privadas): sem contexto, a
comparação com `NULL` não casa linha nenhuma.

## 5. Decisões que o card não pedia e valem registro

**O resultado da aposta importada NÃO foi trazido.** Uma coluna `outcome` foi
considerada e descartada: a data e o retorno de um lançamento já liquidado não
podem ser deduzidos de um arquivo, e o escopo excluído do card (parsers de
concorrente) impede que o produto aprenda o formato de outro. A importação
registra a aposta ABERTA; a liquidação é sempre uma decisão posterior do
usuário.

**A múltipla agrupa por referência declarada.** Linhas com a mesma casa, mesma
referência e mesmo instante formam UMA aposta, e a stake/odd vêm da primeira
linha. Sem referência, cada linha é uma aposta. Duas linhas do mesmo grupo com
valores diferentes recusam o grupo INTEIRO (`IMPORT_ROW_INCOMPATIBLE`):
dividir exigiria saber qual valor é o da aposta, e o arquivo não diz.

**Origem promocional exige crédito declarado.** `freebet`/`hibrida` sem
`freebet_id` é `IMPORT_FREEBET_REQUIRED`, e o crédito precisa ser válido para a
casa e não expirado na data. Dinheiro real COM crédito é
`IMPORT_ROW_INCOMPATIBLE` (contradição, não aproximação). Sem isso, um arquivo
preenchido às pressas registraria exposição de caixa real por um crédito que o
usuário não escolheu.

**A data civil sem hora vira meia-noite de São Paulo.** Quem exporta de um
histórico externo traz data, e inventar a hora seria pior do que declarar a menor
unidade de tempo informada. `31/02/2026` é recusado — o construtor de Date
normalizaria para março.

**A rota NÃO aceita initData do Mini App.** O Mini App não tem upload de
arquivo, e um caminho de importação que o Telegram abre seria um caminho que
ninguém revisou.

## 6. Gate de entitlement (F2-13)

O CSV é o **mesmo recurso** de leitura de comprovante que a foto, e a consulta
é a mesma: recurso ausente da lista = negado, com o mesmo
`ENTITLEMENT_FEATURE_DENIED`. Sem serviço de entitlement, a rota recusa em 503 —
um produto sem o banco de entitlement não pode afirmar que respeita plano.

**Não há teto de chamada paga nesta fronteira, e a ausência é deliberada:**
nenhuma chamada paga acontece aqui — o arquivo já está escrito. Inventar uma cota
de "chamadas pagas" para um upload seria um número sem lastro.

## 7. Testes (§15)

`tests/unit/import-csv.test.ts` — 25 casos, sem banco: template, mapeamento
declarado, quebra de CSV (aspas, escape, separador, teto de linhas), datas,
origem fechada, agrupamento, retorno estimado e progresso.

`tests/integration/import-batch.test.ts` — 34 casos contra PostgreSQL real,
dados fictícios, nenhuma chamada a fornecedor:

- template e genérico mapeado gravam a marcação de origem correta;
- múltipla por referência é UMA aposta com duas seleções;
- inválido (casa, valor, odd, futuro, data impossível) recusa só as próprias
  linhas, e a mensagem não carrega o valor que falhou;
- duplicata dentro do arquivo não entra;
- resultado parcial fecha `committed + skipped = total`, e o banco recusa a
  divergência (23514);
- subconjunto escolhido pelo usuário conta o resto como pulado;
- idempotência: a mesma chave devolve o mesmo resultado, sem duplicar aposta nem
  duplicar o lançamento de exposição; a mesma chave com outro conteúdo é
  conflito;
- rollback devolve a exposição a zero, deixa a aposta cancelada e grava UM
  estorno por aposta; reverter duas vezes não estorna duas vezes;
- freebet sem crédito recusado, com crédito válido entra e consome o crédito
  sem expor caixa;
- a 0026 é a última do journal, tem os dois objetos, a RLS falha fechada sem
  contexto e reaplicar é no-op.

**Contadores de replay.** `tenant-registry` e `import-action-atomicity` já leem
`journal.entries.length` e a 0026 entra sozinha; o `import-action-atomicity`
ganhou a remoção dos objetos da 0026 para que o replay a exercite de verdade. A
contagem de policies em `finance-tenant-isolation` foi de 21 para 23 (+2 pelas
RLS do lote e do seu recibo).

## 8. Limitações conhecidas

- **O Mini App não importa arquivo.** A rota é da web; o upload do Telegram
  continua sendo foto, e a importação por arquivo é um caminho separado.
- **O resultado de uma aposta importada não é lido do arquivo** (§5).
- **A data do evento continua `pending`.** A importação registra a aposta com
  `date_status = 'pending'`; o enriquecimento de eventos é o mesmo caminho do
  resto do produto e não faz parte deste card.
- **O preview devolve no máximo 200 linhas** de 500. A linha 201+ aparece
  apenas nas contagens e no código `IMPORT_ROW_LIMIT_REACHED`; um arquivo com
  500 linhas exigirá o commit para ver o resto.
- **Sem limite de linhas por organização.** O teto é por lote (500); um tenant
  pode enviar lotes ilimitados. O que protege a infraestrutura hoje é a banca
  inicial e a regra de saldo negativo, não uma cota de importação.
- **Nenhuma chamada paga é feita**, então não há breaker nem teto de gasto a
  exercitar nesta fronteira — a exclusão é deliberada e está documentada (§6).
- A 0026 **não foi executada fora do ambiente local**.
