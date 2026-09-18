# Spec — histerese e deduplicação de alertas do monitor

## ADDED Requirements

### Requirement: Transições estáveis com histerese configurável

O monitor DEVE (MUST) exigir observações consecutivas de uma assinatura antes
de considerá-la estável: `ready → atenção` após `MONITOR_ATTENTION_OBSERVATIONS`
(default 3) leituras consecutivas; `atenção → ready` após
`MONITOR_RECOVERY_OBSERVATIONS` (default 3) leituras consecutivas de `ready`.

#### Scenario: oscilação rápida não alerta

- **WHEN** a assinatura alterna entre `ready` e uma atenção sem atingir N observações consecutivas
- **THEN** nenhuma mensagem é enviada

#### Scenario: atenção persistente alerta uma vez

- **WHEN** uma atenção se mantém por N observações consecutivas
- **THEN** exatamente uma mensagem de atenção é enviada, e as leituras seguintes da mesma condição permanecem silenciosas

### Requirement: Deduplicação e piora real

Alertas idênticos à última assinatura notificada NÃO DEVEM (MUST NOT) ser
reenviados; uma piora real (categoria nova ou severidade `warning → failed`)
DEVE (MUST) gerar novo alerta; cooldown configurável
(`MONITOR_ALERT_COOLDOWN_MS`, default 0) suprime alertas diferentes não-piores
dentro da janela.

#### Scenario: nova categoria durante atenção

- **WHEN** o estado estável é `retention:warning` e passa a incluir `aiBudget:warning` de forma estável
- **THEN** um novo alerta é enviado com a assinatura atualizada

### Requirement: Recuperação única e gate de notificação

A mensagem de recuperação DEVE (MUST) ser enviada no máximo uma vez por ciclo
de atenção e somente se uma atenção foi previamente notificada; um novo ciclo
de atenção após a recuperação pode alertar novamente.

#### Scenario: recuperação sem atenção notificada

- **WHEN** o monitor nunca notificou atenção e o estado volta a `ready`
- **THEN** nenhuma mensagem de recuperação é enviada

### Requirement: Retry de entrega incerta

Falha no envio Telegram NÃO DEVE (MUST NOT) perder o alerta nem marcar entrega
como confirmada: enquanto `delivery=uncertain` e a assinatura pendente for o
estado estável corrente, o ciclo seguinte DEVE (MUST) reoferecer a mesma
notificação; `delivery=confirmed` exige o ack autenticado do provedor.

#### Scenario: retry após falha

- **WHEN** o envio falha e o próximo ciclo mantém a mesma assinatura
- **THEN** a notificação é reoferecida e, no sucesso, confirmada — sem duplicar quando o ack chega

### Requirement: Persistência e concorrência

O estado de histerese DEVE (MUST) persistir no Durable Object (migração
idempotente) sobrevivendo a reinícios; avaliações concorrentes NÃO DEVEM
(MUST NOT) produzir mensagens duplicadas (serialização por transação + lease
existentes).

#### Scenario: reinício do worker

- **WHEN** o worker reinicia com estado em memória vazio
- **THEN** a contagem de observações e a assinatura notificada são retomadas do armazenamento

### Requirement: Observabilidade sanitizada

`/status` DEVE (MUST) permanecer compatível (campos atuais) e adicionar
`lastStableSignature`; nenhum log, métrica ou payload pode conter tokens,
segredos, PII ou conteúdo privado.

#### Scenario: payload sem segredos

- **WHEN** o `/status` autenticado é lido
- **THEN** o payload não contém o token do monitor nem dados privados
