# STK-G0-19-R10 — atomicidade do rascunho, retry real, OpenAPI e schema 0013

## Por quê

1. O caminho PRÉ-importação (rascunho) grava o efeito (updateDraft) e o recibo em
   DUAS transações — queda entre elas deixa efeito sem recibo e o retry legítimo
   falha por versão antiga.
2. O retry de transporte do frontend nunca dispara: `request()` converte falhas
   de rede em `ApiFailure(0, NETWORK_ERROR)`, mas `sendWithIdempotentRetry`
   repete apenas em `TypeError`.
3. As três rotas de ação exigem `idempotency-key`, mas o contrato OpenAPI não
   declara o header.
4. A tabela `integration.import_action_receipt` existe na migration/snapshot mas
   NÃO no schema fonte Drizzle; o `result` é texto JSON com cast TypeScript cego
   no replay.

## O quê (MUST)

- Operação interna do serviço de rascunho usando o `PoolClient` existente;
  advisory lock por organização+chave, replay sob o lock, lock da inbox, versão,
  alteração, auditoria, outbox e recibo NA MESMA transação (bookmaker/origin/
  event pré-importação); concurrency com mesma chave converge; corpo diferente
  conflita; chave nova exige a versão atual.
- Retry do frontend somente para `ApiFailure(0, NETWORK_ERROR)`, UMA repetição,
  MESMA chave e mesmo corpo; nunca em HTTP com resposta; nova confirmação
  intencional gera chave nova.
- `headers: commandHeadersSchema` declarado nas três rotas + 400
  `IDEMPOTENCY_KEY_REQUIRED` documentado + teste de contrato.
- Tabela Drizzle `integration.import_action_receipt` (PK org+key, checks de
  ação/hash SHA-256/actor, `result` jsonb) alinhada à 0013 (ajustada), com
  replay tipado por ação fail-closed e sanitizado.

## Impacto

Migration 0013 ajustada (ainda não integrada/aplicada); OpenAPI regenerado;
testes RED→GREEN novos preservando integralmente os testes R9.
