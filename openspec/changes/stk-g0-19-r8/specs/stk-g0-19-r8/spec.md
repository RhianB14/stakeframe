# Capability: stk-g0-19-r8

Fonte canônica pós-importação e sincronização real Telegram ↔ web.

## ADDED Requirements

### Requirement: Fronteira rascunho × aposta importada

Antes de `imported_bet_id`, o rascunho (inbox) DEVE (MUST) permanecer a fonte
canônica das edições; depois dele, edições que afetam a aposta DEVEM (MUST)
gravar nas tabelas financeiras canônicas, nunca apenas na inbox, e a inbox não
pode divergir da aposta.

#### Scenario: edição pós-importação

- **WHEN** uma importação já tem aposta registrada e o usuário altera casa, origem ou data
- **THEN** a gravação alcança as tabelas financeiras e a leitura web reflete imediatamente

### Requirement: Troca de casa canônica

A troca de casa de aposta aberta DEVE (MUST) ser um comando financeiro
transacional com versão otimista, idempotência determinística, auditoria
sanitizada e journal de reclassificação que preserva banca e exposição totais;
aposta com freebet DEVE (MUST) exigir crédito compatível na mesma operação ou
recusar com erro sanitizado; estados liquidado/cancelado DEVEM (MUST) recusar.

#### Scenario: reclassificação de dinheiro real

- **WHEN** uma aposta real aberta muda de casa
- **THEN** `finance.bet.bookmaker_id` muda, o journal move o valor entre as contas das casas sem alterar os totais e a mensagem do Telegram reflete a nova casa

### Requirement: Origem canônica pós-importação

A troca real↔freebet e freebet↔freebet DEVE (MUST) usar journals
compensatórios (nunca reescrever journals antigos), consumo/liberação atômica
de crédito da mesma casa/valor, bloqueio após liquidação/cancelamento e
idempotência; a política automática NÃO interfere na declaração verdadeira.

#### Scenario: real vira freebet

- **WHEN** o usuário declara freebet com crédito válido para uma aposta real aberta
- **THEN** a exposição de dinheiro real é retirada, o crédito é consumido atomicamente e a aposta segue consistente

### Requirement: Datas pós-importação por seleção

A data editada depois da importação DEVE (MUST) atualizar `finance.selection`
pelo comando canônico de evento; simples edita a única seleção; múltipla
apresenta cada seleção separadamente, sem aplicar data global silenciosa; web e
Telegram leem a mesma data.

#### Scenario: aposta simples

- **WHEN** o usuário salva a data de um evento de aposta simples importada
- **THEN** a seleção canônica e a mensagem do Telegram refletem a data nova

### Requirement: Renderização canônica e sincronização efetiva

A mensagem do Telegram DEVE (MUST) ser construída do rascunho antes da
importação (casa declarada incluída) e das tabelas financeiras depois; os testes
DEVEM (MUST) executar a outbox com cliente mockado e inspecionar o corpo de
`editMessageText`, garantindo ausência dos valores antigos e que operação antiga
não sobrescreve versão nova.

#### Scenario: edição web reflete no Telegram

- **WHEN** uma edição canônica é feita e a outbox é processada
- **THEN** o texto editado contém os valores novos e não contém os antigos
