# Spec — histerese e deduplicação de alertas do monitor

## ADDED Requirements

### Requirement: Transições estáveis com histerese configurável

O monitor DEVE (MUST) exigir observações consecutivas de uma assinatura antes
de considerá-la estável: `ready → atenção` após `MONITOR_ATTENTION_OBSERVATIONS`
(default 3) leituras consecutivas; `atenção → ready` após
`MONITOR_RECOVERY_OBSERVATIONS` (default 3) leituras consecutivas de `ready`.
As três variáveis (`MONITOR_ATTENTION_OBSERVATIONS`,
`MONITOR_RECOVERY_OBSERVATIONS`, `MONITOR_ALERT_COOLDOWN_MS`) são lidas do env
do Worker — configuráveis em `infra/monitor/wrangler.jsonc` (`vars`) no
momento do deploy; ausentes, valem os defaults 3/3/0 em produção.

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
como confirmada: enquanto `delivery=uncertain`, sem receipt persistido e com a
assinatura pendente ainda estável, o ciclo seguinte DEVE (MUST) reoferecer a
mesma notificação; com receipt persistido, o ciclo seguinte DEVE (MUST) apenas
reconciliar a confirmação, sem novo envio; `delivery=confirmed` exige o ack
autenticado do provedor.

#### Scenario: retry após falha antes de qualquer receipt

- **WHEN** o envio falha (sem aceite do Telegram) e o próximo ciclo mantém a mesma assinatura
- **THEN** a notificação é reoferecida e, no sucesso, confirmada — sem duplicar quando o ack chega

#### Scenario: aceite do Telegram com confirmação interna falha

- **WHEN** o Telegram aceita a mensagem (receipt persistido) mas a confirmação interna falha ou fica indisponível
- **THEN** o próximo ciclo não reenvia a mesma mensagem e apenas tenta reconciliar a confirmação; após confirmar, nenhum envio novo ocorre

### Requirement: Backfill de estado legado

Na primeira carga após a migração de schema, o estado legado DEVE (MUST) ser
adotado como estável; entrega legada `confirmed` NÃO DEVE (MUST NOT) gerar
alerta duplicado; entrega legada `uncertain` DEVE (MUST) preservar a pendência
(`notified_signature`) para reoferta/confirmação; o backfill DEVE (MUST) rodar
apenas na criação das colunas (idempotente) e nenhum estado legado válido pode
ficar congelado.

#### Scenario: legado incerto preserva a entrega pendente

- **WHEN** o banco legado tem uma assinatura de atenção com `delivery=uncertain`
- **THEN** após a migração a próxima verificação da mesma assinatura reoferece o alerta e a confirmação posterior muda para `confirmed`

#### Scenario: legado confirmado não duplica

- **WHEN** o banco legado tem assinatura com `delivery=confirmed`
- **THEN** a próxima verificação da mesma assinatura permanece silenciosa

### Requirement: Receipt e reconciliação de entrega

O aceite do Telegram (`ok=true`, chat privado do proprietário) DEVE (MUST) ser
persistido no Durable Object (`receipt_at`/`receipt_id`) antes da confirmação
interna; com receipt, o ciclo seguinte NÃO DEVE (MUST NOT) reenviar a mensagem
— apenas tentar reconciliar a confirmação; a reconciliação DEVE (MUST)
sobreviver a reinício; a janela residual (aceite do Telegram sem receipt
persistido, ex.: processo encerrado entre o aceite e o registro) DEVE (MUST)
ser documentada e coberta por teste.

#### Scenario: confirmação pendente após aceite

- **WHEN** o Telegram aceitou a mensagem mas a confirmação interna não completou
- **THEN** o ciclo seguinte reconcilia sem novo envio e a confirmação final não gera mensagem adicional

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
