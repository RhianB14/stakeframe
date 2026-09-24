# Spec — edição contínua do status no Mini App

## ADDED Requirements

### Requirement: Correção e edição contínua do status pelo Mini App

O Mini App DEVE (MUST) manter a seção de status acessível no editor completo
sempre que houver uma aposta canônica vinculada, qualquer que seja o estado
`open` ou `settled`. Deve mostrar o estado atual, pedir confirmação explícita e
gravar pela transação financeira canônica, com autorização da organização,
controle otimista de versão e idempotência. Uma aposta incompleta DEVE continuar
visível como Pendente; o servidor só pode aplicar transições financeiras quando
os campos requeridos pela operação estiverem completos. Uma aposta cancelada
NÃO DEVE ser reaberta por esta seção. Se o proprietário corrigir uma liquidação
ativa pelo Mini App ou pela Web, o servidor DEVE registrar
`settlement.reverse` auditável e aplicar a nova transição atomicamente; ao voltar
para Pendente, deve apenas efetivar a reversão. O teclado inline legado do
Telegram DEVE manter sua semântica terminal até a liquidação. Ao liquidar pelo
Mini App, a outbox DEVE remover a foto original, a mensagem temporária e a
resposta final do Telegram; edições posteriores ficam disponíveis pela Web.

#### Scenario: status disponível no editor completo

- **WHEN** o usuário abre Editar no Mini App com uma aposta canônica incompleta,
  pendente ou já liquidada
- **THEN** a seção Status da aposta permanece visível
- **AND** o estado atual é exibido e ações financeiras incompletas são recusadas
  com orientação acionável

#### Scenario: liquidação total remove as mensagens do Telegram

- **WHEN** o proprietário confirma uma transição financeira válida para uma
  aposta pendente pelo Mini App
- **THEN** o resultado é registrado pelo comando financeiro canônico
- **AND** a outbox remove a foto original, a mensagem de processamento e a
  resposta final do bot
- **AND** a atualização não mantém um botão do Telegram que reabra o bilhete

#### Scenario: status visível na lista de apostas

- **WHEN** o proprietário consulta a lista de apostas na Web
- **THEN** a tabela mostra a coluna "Status da aposta" logo após Evento
- **AND** o status apresenta Pendente, Ganha, Perdida, Reembolso, Meio-Ganha,
  Meio-Perdida ou Cashout conforme o ledger
- **AND** a apresentação móvel inclui o mesmo status no cartão do bilhete

#### Scenario: correção de resultado liquidado

- **WHEN** o proprietário altera o resultado de uma aposta liquidada
- **THEN** a liquidação ativa anterior é revertida por lançamento compensatório
  auditável e a nova transição é aplicada na mesma transação
- **AND** falha em qualquer etapa não deixa reversão parcial nem liquidação
  duplicada

#### Scenario: retornar uma aposta liquidada a Pendente

- **WHEN** o proprietário escolhe Pendente numa aposta liquidada
- **THEN** a reversão compensatória restaura a exposição e o estado aberto
- **AND** nenhuma liquidação ativa permanece

#### Scenario: repetição e concorrência

- **WHEN** o mesmo pedido é repetido com a versão já consumida, ou uma tela
  concorrente envia uma versão obsoleta
- **THEN** a repetição idêntica é idempotente e a versão obsoleta não sobrescreve
  estado mais novo

#### Scenario: aposta cancelada

- **WHEN** o usuário tenta mudar o status de uma aposta cancelada
- **THEN** o servidor recusa a operação sem alterar ledger nem Telegram
