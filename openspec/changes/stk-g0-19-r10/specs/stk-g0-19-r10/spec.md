# Spec — atomicidade, retry, OpenAPI e schema 0013

## ADDED Requirements

### Requirement: Atomicidade do rascunho

As ações de casa, origem e data quando a importação ainda for rascunho DEVEM
(MUST) executar advisory lock por organização+chave, leitura/replay do recibo sob
o mesmo lock, lock da inbox, validação da versão, alteração, auditoria,
enfileiramento da sincronização Telegram e gravação do recibo na MESMA transação
e no MESMO cliente; qualquer falha antes do commit reverter TUDO.

#### Scenario: queda na gravação do recibo

- **WHEN** a gravação do recibo falha depois da alteração da inbox
- **THEN** a alteração, a auditoria e a outbox são revertidas
- **AND** o retry legítimo posterior aplica normalmente

#### Scenario: concorrência com a mesma chave

- **WHEN** duas chamadas concorrentes usam a mesma chave e o mesmo corpo
- **THEN** ambas convergem para um efeito e o mesmo resultado
- **AND** apenas uma versão, uma auditoria e uma operação de outbox

### Requirement: Retry real do frontend

O cliente DEVE (MUST) repetir UMA única vez quando a falha for de transporte
(`ApiFailure` com status 0 e código NETWORK_ERROR), reutilizando a MESMA chave
de idempotência e o mesmo corpo; respostas HTTP (4xx/5xx) NÃO DEVEM ser
repetidas automaticamente; nova confirmação intencional gera chave nova.

#### Scenario: resposta perdida

- **WHEN** o servidor aplicou o efeito mas a resposta se perdeu
- **THEN** a segunda tentativa com a mesma chave recebe o recibo
- **AND** há apenas um efeito, um journal, uma auditoria e uma operação de outbox

### Requirement: Contrato OpenAPI das ações

As três rotas de ação DEVEM (MUST) declarar o header `idempotency-key` (UUID,
obrigatório) no contrato, com erro 400 sanitizado estável quando ausente.

### Requirement: Schema Drizzle do recibo

A tabela `integration.import_action_receipt` DEVE (MUST) ser declarada no
schema fonte com PK organização+chave, checks coerentes com a migration
(ação, hash SHA-256 hexadecimal de 64 caracteres, actor não vazio e limitado) e
`result` como `jsonb`; o replay DEVE validar o resultado pelo schema da ação e
falhar fechado e sanitizado quando o recibo estiver adulterado.
