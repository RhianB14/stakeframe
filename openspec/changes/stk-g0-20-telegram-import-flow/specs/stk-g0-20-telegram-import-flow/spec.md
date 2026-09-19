# Spec — fluxo de importação Telegram/MiniApp (G0-20)

## ADDED Requirements

### Requirement: Recebimento sem legenda e mensagem de processamento

O bot DEVE (MUST) aceitar foto enviada sem legenda. Após o recebimento, DEVE
(MUST) enviar a mensagem de processamento com estrutura, texto e emojis
preservados; somente o UUID do processamento varia:

```
🤖 Sua aposta está sendo processada!
Estamos analisando as informações enviadas. Caso ocorra alguma instabilidade, o sistema tentará novamente automaticamente. ⏳⚙️

ID do processamento:
<UUID>

Status atual:
Validando informações iniciais da aposta...

Assim que o processamento for concluído, você receberá uma notificação aqui mesmo. ✅

Para acompanhar todos os seus processamentos, digite:
👉 /fila 👀
```

Quando o processamento concluir, a mensagem de processamento DEVE (MUST) ser
apagada antes/ao enviar a mensagem final.

#### Scenario: foto sem legenda

- **WHEN** o proprietário envia somente a foto
- **THEN** o processamento inicia e a mensagem de processamento é enviada com o UUID

#### Scenario: estrutura fixa com UUID variável

- **WHERE** duas importações distintas
- **THEN** as mensagens diferem apenas no UUID do processamento

### Requirement: Mensagem final formatada

Após o processamento, DEVE (MUST) ser enviada a mensagem final com emojis em
todas as linhas:

```
✅ Bilhete processado com sucesso

🆔 ID: <UUID>
💰 Banca: Padrão

⏳ Status: Pendente
🔹 Sem lucro ou prejuízo.
🎾 Esporte: <valor>
🏆 Torneio: Definir Manualmente
⚔️ Evento: <valor>
🌎 País: <valor>
🎰 Aposta: <valor>
🎯 Mercado: <valor>
💰 Valor Apostado: <valor>
🎲 Odd: <valor>
💵 Retorno Potencial: <valor>
📝 Tipo: <Simples|Múltipla>
📅 Enviado em: <data/hora original do Telegram>
🎮 Evento em: <data/hora do jogo ou pendente>
🎁 Bônus: <Não|Freebet|Híbrida>
🏠 Casa: <selecionada ou pendente>
🗣️ Tipster: <selecionado ou pendente>
```

A data/hora do Telegram é IMUTÁVEL (nunca editável); a data/hora do evento
inicia pendente ou conforme extração confiável e PODE (MUST) ser alterada pelo
usuário.

#### Scenario: todos os campos e emojis

- **WHEN** o processamento conclui
- **THEN** a mensagem final contém todas as linhas e emojis acima, com os valores do registro

#### Scenario: evento pendente e editável

- **WHEN** a extração não fornece data confiável
- **THEN** `🎮 Evento em: pendente` e a edição do usuário passa a exibir o valor escolhido

### Requirement: Modalidades financeiras

O sistema DEVE (MUST) suportar dinheiro real, freebet e híbrida, com retorno
potencial: real = `valor real × odd`; freebet = `freebet × (odd − 1)` (o valor
da freebet NÃO retorna); híbrida = `(valor real × odd) + (freebet × (odd − 1))`.
Os componentes financeiros DEVEM (MUST) ser exibidos no MiniApp, na Web e na
mensagem do Telegram.

#### Scenario: dinheiro real

- **WHEN** a aposta é de dinheiro real
- **THEN** o retorno potencial é `valor × odd`

#### Scenario: freebet sem devolução do valor

- **WHEN** a aposta é de freebet com valor F e odd O
- **THEN** o retorno potencial é `F × (O − 1)` — o valor da freebet não retorna

#### Scenario: aposta híbrida

- **WHEN** a aposta combina valor real R e freebet F com odd O
- **THEN** o retorno potencial é `(R × O) + (F × (O − 1))`

### Requirement: Casa e tipster ativos por organização

Na mensagem final DEVEM (MUST) existir os botões `🏠 Alterar Casa` e
`🗣️ Alterar Tipster`. As opções DEVEM (MUST) vir somente dos cadastros ATIVOS
da organização do usuário (registrados na Web), separadas por tipo — casas e
tipsters nunca se misturam; a seleção DEVE (MUST) atualizar a aposta, a Web, o
MiniApp e a mensagem correspondente do Telegram.

#### Scenario: somente cadastros ativos

- **WHEN** a organização tem casas/tipsters inativos
- **THEN** eles não aparecem nas opções da seleção

#### Scenario: seleção sincroniza as três superfícies

- **WHEN** o usuário seleciona casa ou tipster
- **THEN** a aposta, a Web e a mensagem do Telegram refletem a seleção

#### Scenario: isolamento entre organizações

- **WHEN** outra organização tem cadastros próprios
- **THEN** eles nunca aparecem para a organização do usuário

### Requirement: Botões e callbacks da mensagem

- `✏️ Editar` DEVE (MUST) abrir o MiniApp correto já preenchido com todos os
  dados da aposta.
- `📚 Alterar Status` DEVE (MUST) abrir somente o teclado inline de status,
  sem abrir o MiniApp.
- `🏠 Alterar Casa` e `🗣️ Alterar Tipster` DEVEM (MUST) abrir apenas os
  cadastros ativos do respectivo tipo, cadastrados na Web.
- `🗑️ Excluir` DEVE (MUST) excluir a aposta da Web (cancelamento canônico,
  quando registrada) e remover a foto e as mensagens relacionadas do Telegram,
  com confirmação adequada e repetição idempotente.
- `💸 Cashout` DEVE (MUST) preservar o comportamento financeiro existente
  (total/parcial pelo comando canônico); o valor recebido é INFORMADO pelo
  usuário na seção própria do MiniApp e nunca derivado.

#### Scenario: Alterar Status abre somente o teclado

- **WHEN** o usuário toca `📚 Alterar Status`
- **THEN** apenas o teclado inline de status é exibido (sem MiniApp)

#### Scenario: Excluir limpa as mensagens

- **WHEN** a exclusão é confirmada
- **THEN** a aposta sai da Web e a foto e as mensagens relacionadas são removidas do Telegram

### Requirement: Status e limpeza pós-liquidação

O teclado de status DEVE (MUST) abrir exclusivamente: ✅ Ganha, ❌ Perdida,
⏳ Pendente, 🌗 Meio-Ganha, 🌗 Meio-Perdida, 💱 Reembolsada, ◀️ Voltar para o
bilhete. Quando o status sair de Pendente, o sistema DEVE (MUST): atualizar a
aposta na Web, apagar a foto do Telegram, apagar a mensagem de processamento
(se ainda existir) e apagar a mensagem final — sem mensagens órfãs.

#### Scenario: transições disponíveis

- **WHEN** o teclado de status é aberto
- **THEN** as sete opções (com Voltar) estão disponíveis; o cashout NÃO faz
  parte do teclado (valor informado na seção própria do MiniApp)

#### Scenario: cashout total e parcial

- **WHEN** o usuário informa o valor recebido no MiniApp
- **THEN** o cashout total encerra todo o valor aberto e o parcial apenas a
  parte declarada, ambos pelo comando canônico com versão otimista

#### Scenario: sair de Pendente limpa o Telegram

- **WHEN** o status muda de Pendente para qualquer liquidação
- **THEN** Web atualizada, foto, processamento e mensagem final apagados

### Requirement: Sincronização MiniApp ↔ Web ↔ Telegram

O MiniApp DEVE (MUST): abrir pelo botão Editar; carregar todos os campos atuais;
permitir editar os campos autorizados; salvar sem perder dados não alterados;
atualizar imediatamente a mensagem do Telegram e a Web. Alterações na Web DEVEM
(MUST) atualizar a mensagem correspondente no Telegram; alterações no MiniApp
DEVEM (MUST) atualizar a Web e o Telegram. Uma edição antiga NUNCA (MUST NOT)
sobrescreve uma edição nova (versão otimista + idempotência).

#### Scenario: salvar no MiniApp atualiza as três superfícies

- **WHEN** o usuário salva uma edição no MiniApp
- **THEN** a Web e a mensagem do Telegram refletem a edição

#### Scenario: editar na Web atualiza o Telegram

- **WHEN** o usuário edita na Web um campo suportado
- **THEN** a mensagem do Telegram correspondente é atualizada

#### Scenario: concorrência e idempotência

- **WHEN** duas edições concorrem com a mesma versão
- **THEN** a primeira vence, a segunda é recusada por versão e nenhum efeito duplica

#### Scenario: seções do MiniApp sincronizam as três superfícies

- **WHEN** o usuário altera casa, tipster, status ou cashout pelo MiniApp
- **THEN** a aposta (banco), a Web e a mensagem do Telegram refletem a mudança
  na mesma transação canônica (outbox), e a limpeza do chat sai ao deixar de
  pendente
