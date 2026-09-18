# Capability: stk-g0-19-r5

Fluxo definitivo de importação Telegram/Web: rascunho canônico único, origem
financeira declarada, datas separadas, outbox idempotente e limpeza do chat.

## ADDED Requirements

### Requirement: Origem financeira declarada

O tipo financeiro (real|freebet) DEVE (MUST) ser declarado pelo usuário no
Mini App do Telegram ou no formulário de revisão web, nunca extraído da
imagem, do OCR, da IA ou da legenda. Enquanto `betOrigin` for nulo nenhuma
aposta financeira é criada; freebet exige a seleção explícita do crédito e
dinheiro real com crédito é contradição rejeitada. A leitura visual de
freebet é apenas diagnóstico e nunca altera a escolha.

#### Scenario: sem origem declarada

- **WHEN** o usuário confirma a importação sem origem (nem rascunho, nem comando)
- **THEN** nenhuma aposta é criada e o item permanece em revisão

#### Scenario: freebet com crédito explícito

- **WHEN** o usuário escolhe Freebet e seleciona o crédito
- **THEN** o crédito escolhido é o único usado, validado por organização, casa, valor, validade e disponibilidade

### Requirement: Retorno potencial calculado

O retorno potencial persistido/exibido DEVE (MUST) ser derivado server-side
com `potentialReturn = stake × totalOdds` em aritmética decimal exata. O valor
visual do bilhete é somente diagnóstico; sua ausência não bloqueia; sua
divergência indica stake/odd possivelmente incorretos e encaminha para
revisão; nunca é persistido como fonte financeira. Para freebet o valor
representa o bruto e não altera saldo, liquidação, lucro ou consumo do crédito.

#### Scenario: retorno ausente

- **WHEN** o bilhete não traz retorno visível
- **THEN** o valor calculado é usado e a importação não é bloqueada por isso

### Requirement: Datas com semânticas separadas

`telegramReceivedAt` (instante confiável da mensagem) DEVE (MUST) permanecer
imutável: nunca é sobrescrito pela data do evento nem pelo relógio do servidor.
`eventAt` e `eventDateStatus` DEVEM (MUST) ser modelados separadamente. `eventAt` nasce
nulo com `eventDateStatus=pending`; a mensagem inicial exibe o instante de
recebimento como provisório e editável; a edição grava `eventAt`, define
`confirmed` e preserva `placedAt`. Instantes persistidos em UTC e exibidos no
fuso configurado.

#### Scenario: confirmação da data do jogo

- **WHEN** o usuário informa a data/hora real do jogo
- **THEN** `eventAt` é gravado, `eventDateStatus` vira confirmed, `telegramReceivedAt` e `placedAt` permanecem intactos

### Requirement: Fonte canônica única e outbox idempotente

O banco DEVE (MUST) ser a única fonte de verdade; Telegram e web são
interfaces do mesmo registro. Toda edição valida autenticação e organização, confere versão
otimista, persiste no canônico, recalcula derivados, grava auditoria
sanitizada e emite operação idempotente na outbox (chave por organização +
importação + versão + operação). Retry com backoff somente em falhas
transitórias; 429 respeita `retry_after`; 400/403 permanentes não geram loop;
evento antigo nunca sobrescreve versão mais nova; falha no Telegram não desfaz
edição financeira válida.

#### Scenario: edição pelo Mini App

- **WHEN** o usuário salva no Mini App com initData válido
- **THEN** o canônico é atualizado, a web reflete a alteração e a mensagem final é editada, sem criar segunda aposta ou mensagem

#### Scenario: edição pela web

- **WHEN** o usuário salva pela web
- **THEN** o mesmo registro é atualizado e a mensagem do Telegram é sincronizada pelo backend (a web nunca chama o Telegram)

### Requirement: Limpeza automática ao sair de pending

Quando o status de uma aposta importada deixar de ser `pending` (por qualquer
origem: Mini App, web, comando, liquidação, cashout ou processo
administrativo), o backend DEVE (MUST) enfileirar a exclusão da foto
original, da mensagem final e de eventual temporária — somente após o commit
do status. Mensagem ausente é sucesso idempotente; falha permanente não
desfaz o status e fica marcada para reconciliação; mensagem já excluída nunca
é editada; voltar para `pending` não recria mensagens; o timestamp da
exclusão é registrado.

#### Scenario: liquidação

- **WHEN** uma aposta pendente é liquidada como ganha, perdida ou cashout
- **THEN** foto e resposta final são enfileiradas para exclusão e o histórico permanece no banco e na web
