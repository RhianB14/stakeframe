# Capability: stk-g0-19-r2

Correções bloqueantes da revisão da PR #136: casa informada, rótulos por
layout, data e referência, isolamento de duplicatas, GT v6 e avaliação de
decisão.

## ADDED Requirements

### Requirement: Casa informada como fonte de verdade

O contexto da legenda DEVE (MUST) decidir a casa; `extraction.bookmaker=null`
é aceitável; leitura visual igual à casa informada é aceitável; outra casa
cadastrada retorna `BOOKMAKER_CONFLICT`; texto visual não nulo que não resolve
para casa cadastrada permanece em revisão fail-closed; o contexto NUNCA é
copiado para a extração.

#### Scenario: marca ausente

- **WHEN** a imagem não mostra marca e a casa vem da legenda
- **THEN** o bilhete importa normalmente e a extração preserva `bookmaker: null`

#### Scenario: conflito ou texto não resolvido

- **WHEN** a leitura visual aponta para outra casa cadastrada ou não resolve
- **THEN** o item permanece em revisão, sem criação financeira

### Requirement: Rótulos financeiros por layout

Os rótulos autorizados de `potentialReturn` DEVEM (MUST) fazer parte da
política do layout (digest-bound). Bet365: `Retorno Total`. Superbet: `Prêmio`
e `Ganho Potencial`. `Retorno Obtido`, `Retorno Líquido`, cashout, saldo, stake
e odds NUNCA preenchem o campo. Os rótulos autorizados viajam no contexto dos
layouts enviado ao modelo.

#### Scenario: OCR detecta divergência

- **WHEN** um rótulo autorizado está visível no OCR e o modelo omite o valor,
  ou o valor extraído diverge do OCR, ou não há rótulo autorizado visível
- **THEN** `ocrConsistent=false` mantém o item em revisão

### Requirement: Data da aposta e referência

O parser DEVE (MUST) aceitar o formato textual Superbet (meses PT-BR,
separadores hifen/en/em-dash normalizados apenas entre data e hora). A legenda
aceita quarta linha opcional `DD/MM/AAAA HH:mm`; quando a imagem não traz data
legível, ela é obrigatória para automatizar; imagem e contexto precisam
representar o mesmo instante. Referência vazia é aceita quando a casa não a
apresenta, sem valor sintético, mantendo a deduplicação.

#### Scenario: divergência de instante

- **WHEN** a data da imagem e a da quarta linha não representam o mesmo instante
- **THEN** o item permanece em revisão (`PLACED_AT_UNCERTAIN`)

#### Scenario: sem referência

- **WHEN** a casa não apresenta referência
- **THEN** o campo grava string vazia e colisões continuam bloqueando

### Requirement: Isolamento da consulta de duplicatas

A consulta de duplicatas DEVE (MUST) filtrar `organization_id` sobre os três
critérios (imagem, referência, similaridade), nunca apenas sobre o primeiro.
Uma organização jamais enxerga candidato de outra; os três critérios seguem
funcionando dentro da mesma organização.

#### Scenario: colisão entre organizações

- **WHEN** os valores coincidem entre organizações (mesmo com a FK de casa
  removida em banco descartável de teste)
- **THEN** nenhum candidato cruza a fronteira e o registro prossegue

### Requirement: Ground truth Superbet v6

O v6 DEVE (MUST) ser criado somente após inspeção visual, preservando o v5 por
SHA-256: warning de corte real incluído; período ao vivo
(`2º Tempo • 61'`) nunca é data do evento (`eventDateText=null`); separadores
entre data e hora são normalização permitida sem alterar o texto privado; erro
de um caractere na referência permanece como erro real do modelo.

#### Scenario: preservação

- **WHEN** o v6 é criado
- **THEN** o v5 permanece intacto e o v6 registra apenas os casos justificados

### Requirement: Avaliação orientada à decisão

A avaliação offline DEVE (MUST) classificar cada caso como
`AUTO_IMPORT_EXPECTED`/`AUTO_IMPORT_EXPECTED_WITH_CREDIT`/
`MANUAL_REVIEW_EXPECTED` (lado esperado) e simular a decisão real sobre a
extração preservada. Os gates exigem: zero importação automática insegura, zero
valor financeiro incorreto em autoaprovado, zero conflito aceito, zero
vazamento cross-tenant (coberto por testes de integração), contagem explícita
de positivos realmente autoimportáveis por casa; incompletos em revisão não são
falsos erros de segurança; a qualidade de transcrição permanece reportada
separadamente.

#### Scenario: nenhuma política é aprovada

- **WHEN** a avaliação roda
- **THEN** nada é escrito no banco financeiro, nenhuma política é criada e
  nenhuma chamada externa acontece
