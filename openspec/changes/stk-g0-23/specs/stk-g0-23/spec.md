# Spec — confiabilidade do salvamento no Mini App

## ADDED Requirements

### Requirement: Nunca anunciar salvo sem persistência canônica

O servidor NÃO DEVE (MUST NOT) responder sucesso para edição de um campo de
aposta já confirmada quando essa edição não puder ser persistida na fonte
canônica correspondente; a recusa DEVE (MUST) ocorrer antes de qualquer gravação
de rascunho, de modo que rascunho, aposta financeira e mensagem do Telegram não
divergam.

#### Scenario: edição divergente em aposta confirmada

- **WHEN** o Mini App envia valor, odd, casa, tipster, crédito, origem ou
  seleções diferentes do registro canônico de uma aposta completa
- **THEN** a API responde `409 STATE_CONFLICT`
- **AND** `finance.bet` e `finance.selection` permanecem inalterados
- **AND** a versão do rascunho não avança
- **AND** o Mini App informa que nada foi salvo

#### Scenario: reenvio idêntico ao registro

- **WHEN** o PATCH reenvia exatamente os valores vigentes do registro canônico
- **THEN** a operação é aceita (não há o que persistir, logo não há engano)

### Requirement: edição financeira pelo comando canônico

A troca de casa, tipster, origem/crédito e data de aposta registrada DEVE (MUST)
ocorrer pelos comandos canônicos já existentes, e o registro financeiro DEVE
(MUST) refletir a mudança imediatamente.

#### Scenario: troca de casa

- **WHEN** o proprietário troca a casa pelo comando canônico
- **THEN** `finance.bet.bookmaker_id` passa a ser a nova casa
- **AND** a mensagem do Telegram, que lê o canônico, exibe a casa nova

### Requirement: reabertura mostra o valor vigente

Ao reabrir o Mini App, a tela DEVE (MUST) inicializar os campos financeiros a
partir do registro canônico quando a aposta já está registrada, prevalecendo
sobre os overrides do rascunho.

#### Scenario: reabertura após mudança canônica

- **WHEN** a casa da aposta é alterada canonicamente e o Mini App é reaberto
- **THEN** a tela exibe a casa vigente do registro
- **AND** a tela e a mensagem do Telegram mostram o mesmo valor

### Requirement: falha parcial não vira sucesso integral

Se os dados forem gravados e a mudança de status falhar, o Mini App NÃO DEVE
(MUST NOT) exibir sucesso integral nem fechar; DEVE (MUST) informar o que
ocorreu e permitir recuperação sem duplicar efeitos financeiros.

#### Scenario: liquidação de aposta incompleta

- **WHEN** o status é solicitado para aposta ainda incompleta
- **THEN** a gravação anterior persiste
- **AND** nenhuma liquidação é criada
- **AND** o cliente encadeia a versão devolvida por cada operação até concluir

#### Scenario: repetição da liquidação

- **WHEN** a mesma liquidação é reenviada
- **THEN** a operação é reconhecida como idempotente
- **AND** nenhuma segunda liquidação ou lançamento é criado

#### Scenario: versão obsoleta

- **WHEN** um PATCH chega com versão anterior à vigente
- **THEN** a API responde `409 VERSION_CONFLICT`
- **AND** a mudança mais recente não é sobrescrita

### Requirement: persistência distinta da entrega no Telegram

O Mini App DEVE (MUST) tratar a persistência canônica como a operação
principal, distinguindo-a da entrega da mensagem no Telegram, que PODE (MAY)
ficar pendente ou falhar sem invalidar a gravação.

#### Scenario: edição com entrega pendente

- **WHEN** uma edição é persistida com sincronização do Telegram pendente
- **THEN** o detalhe já reflete o valor novo
- **AND** a fila de sincronização permanece `pending`
- **AND** o Mini App fecha apenas após a operação principal ser confirmada
