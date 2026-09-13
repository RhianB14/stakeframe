# F1-03 — Provisionamento e sessão da organização autenticada

Data: 2026-09-13 · Base: `2114bd417c106d444852b4befbe308a2896da271` (main)
Branch: `hermes/stk-f1-03-auth-organization`

## Objetivo

Vincular a sessão autenticada ao contexto da organização: cada usuário autenticado passa a
ter **exatamente uma organização técnica** e uma membership válida, no fluxo
`usuário autenticado → core.membership → core.organization`. O cliente nunca escolhe a
organização.

## Provisionamento idempotente — `ensureOrganizationMembership(userId)`

Adicionado ao módulo da STK-F1-02 (`packages/db/src/tenant-context.ts`, via
`createTenantContext(database)`):

- localiza a membership existente e **retorna a organização existente** quando há exatamente
  uma (papel preservado — `owner` ou `superadmin` — sem reescrita);
- cria organização + membership `owner` quando **não há** membership (nome = `name` do
  usuário, fallback `Fundação` para nome vazio);
- falha de forma fechada e sanitizada em estado inconsistente (`MEMBERSHIP_INCONSISTENT`),
  usuário inexistente (`USER_NOT_FOUND`) e falhas de infraestrutura (`PROVISIONING_FAILED`);
- **nunca** cria duas organizações para o mesmo usuário nem altera o papel existente.

### Concorrência

A operação roda em uma transação PostgreSQL própria com
`pg_advisory_xact_lock(hashtext('stakeframe.organization.provision'), hashtext(userId))` —
bloqueio **por usuário**, com escopo de transação (liberado automaticamente no
COMMIT/ROLLBACK). Duas requisições simultâneas para o mesmo usuário serializam: a primeira
cria, a segunda lê a existente. O índice único global `membership_user_id_unique` da F1-01
permanece como segunda linha de defesa. Conexão sempre liberada (`finally`); nenhuma
transação fica aberta no pool.

## Sessão — `getOwner()` (apps/api/src/auth.ts)

Sequência: sessão Better Auth (sem cookie cache/refresh) → validação do proprietário
(Google/subject/e-mail verificados como antes) → `ensureOrganizationMembership` →
`resolveOrganizationContext` → retorno **somente após sucesso**:

```json
{
  "user": { "id": "...", "name": "..." },
  "organization": { "id": "<uuid>", "role": "owner | superadmin" },
  "expiresAt": "<ISO>"
}
```

- Falha de membership/organização → comportamento sanitizado idêntico ao de sessão não
  autenticada (HTTP 401 `UNAUTHENTICATED`), sem erro cru do banco e sem detalhes internos;
- Nada de e-mail, identificador Google, tokens, cookies ou dados financeiros no retorno;
- Google, cookies, sessões, validações do proprietário, tokens e logout **inalterados**.

`/api/v1/me` e o OpenAPI (`docs/openapi.json`) refletem o contrato acima
(componente `OwnerSession` com `organization.id` e `organization.role`).

## Limites e não-objetivos

- **RLS nas tabelas financeiras/de integração ainda NÃO está ativa** — esta unidade apenas
  garante o vínculo usuário↔organização e o contexto de sessão;
- Nenhuma rota financeira ou de integração usa tenant nesta tarefa; nenhum
  `organization_id` foi adicionado a essas tabelas;
- Sem e-mail/senha, convites, equipe, onboarding ou cobrança; sem migração nesta tarefa.
