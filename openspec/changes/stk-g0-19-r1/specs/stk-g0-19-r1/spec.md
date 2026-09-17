# Capability: stk-g0-19-r1

Correção dos contratos que sustentam a homologação privada da importação automática:
avaliação de negativos cross-house, tipo da aposta informado na legenda (real × freebet),
contrato visual de freebet e normalização determinística de eventos empilhados.

## ADDED Requirements

### Requirement: Avaliação de negativos cross-house

A avaliação DEVE (MUST) tratar um negativo corretamente rejeitado (`expectedLayoutId=null`
e `layoutId=null`) como caso de rejeição: schema, vínculo de imagem/modelo e a própria
rejeição continuam validados, mas o conteúdo extraído NUNCA é comparado com o corpus da
outra casa e não pode gerar erro essencial. Um falso positivo de layout
(`layoutId` não nulo) DEVE continuar registrando erro e bloqueando a elegibilidade.

#### Scenario: negativo rejeitado com conteúdo estranho

- **WHEN** um negativo tem `layoutId=null` e conteúdo arbitrário de outra casa
- **THEN** não há erro essencial para o caso
- **AND** `crossHouseRejected` e a cobertura negativa continuam contados

#### Scenario: falso positivo cross-house

- **WHEN** um negativo é reconhecido com `layoutId` não nulo
- **THEN** o erro de layout é registrado e a elegibilidade permanece bloqueada

### Requirement: Contexto informado do tipo da aposta

A legenda DEVE (MUST) aceitar `<tipster>\n<casa>\n<real|freebet>`. O terceiro valor é contexto
explícito e fail-closed: duas linhas (legado), valor ausente, desconhecido ou ambíguo
permanecem em revisão manual e NUNCA autorizam importação automática. O tipo informado é
a fonte de verdade financeira; a leitura visual da IA serve apenas como detecção de
conflito.

#### Scenario: conflito visual bloqueia

- **WHEN** o tipo informado é `real` e a IA indica freebet (ou o inverso)
- **THEN** a importação automática é recusada com `FREEBET_CONFLICT`
- **AND** nenhum lançamento financeiro é criado

#### Scenario: null da IA não contradiz contexto explícito

- **WHEN** o tipo informado é explícito e a IA retorna `null` para freebet
- **THEN** o contexto decide (dinheiro real sem crédito; freebet com crédito único)

#### Scenario: legado de duas linhas

- **WHEN** o envio tem apenas tipster e casa
- **THEN** o item permanece em revisão manual e nunca é importado automaticamente

### Requirement: Contrato visual de freebet

O prompt DEVE (MUST) definir `freebet:true` somente com evidência explícita de aposta grátis,
`freebet:false` somente com evidência visual explícita de saldo/dinheiro real, e `null`
quando não houver indicação — sem exemplo sintético que induza `false`.

#### Scenario: ausência de indicação

- **WHEN** a imagem não prova o tipo da aposta
- **THEN** o campo `freebet` permanece `null`

### Requirement: Eventos empilhados determinísticos

Quando dois participantes estiverem claramente visíveis em linhas separadas no mesmo
evento, o extrator DEVE (MUST) produzir `participante 1 x participante 2`, preservando grafia e
ordem; nunca escolher entre `x`, `v` e `vs`; com mais/menos de dois participantes,
ilegibilidade ou associação ambígua, manter o texto visível e registrar `warnings` (MUST).

#### Scenario: separador já visível

- **WHEN** a tela apresenta `x`, `v` ou `vs` entre os participantes
- **THEN** a transcrição preserva o texto visível (nada é reescrito)

#### Scenario: ambiguidade

- **WHEN** a associação entre linhas e participantes é ambígua
- **THEN** nenhum separador é inventado e a dúvida é registrada em `warnings`

### Requirement: Preservação da rodada

A correção NÃO DEVE (MUST NOT) alterar ground truths para acomodar saídas do modelo,
executar chamadas pagas novas, habilitar importação automática ou criar política.
Corpus, avaliações e resultados privados são preservados por SHA-256.

#### Scenario: preservação sem chamadas novas

- **WHEN** a correção é implementada e validada offline
- **THEN** nenhuma chamada paga nova é executada e nenhuma policy é criada
- **AND** corpus, avaliações e ground truths permanecem preservados por SHA-256
