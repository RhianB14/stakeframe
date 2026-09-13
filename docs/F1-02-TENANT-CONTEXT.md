# F1-02 — Contexto de organização por requisição (fundação de isolamento)

Data: 2026-09-13 · Base: `b688d4bf28b5ff805e75faf54272b82bf1cb23d3` (main)
Branch: `hermes/stk-f1-02-tenant-context`

## Objetivo

Fundação reutilizável para resolver a **organização autenticada** e aplicá-la de forma
segura dentro de uma transação PostgreSQL. A resolução deriva exclusivamente de
`auth.user` → `core.membership` → `core.organization`; **o cliente nunca escolhe a
organização** (nada de header, query string, parâmetro de rota, corpo, cookie ou campo
enviado pelo frontend).

## Contrato público — `createTenantContext(database)`

- **`resolveOrganizationContext(userId)`** → `{ organizationId, role: 'owner' | 'superadmin', userId }`
  - aceita somente usuário autenticado (identificador não vazio);
  - consulta `core.membership` via ORM (`coreSchema`) e carrega `organization_id` e `role`;
  - falha de forma fechada sem membership ou com estado inconsistente;
  - não retorna dados sensíveis.
- **`withOrganizationTransaction(context, callback, options?)`**
  - obtém uma conexão do pool existente; abre transação;
  - configura o contexto com `set_config('app.organization_id', organizationId, true)` —
    o terceiro argumento garante **escopo local da transação**;
  - valida o UUID da organização **antes** de qualquer consulta/configuração;
  - executa `callback(client)` dentro da transação; confirma (COMMIT) somente após
    sucesso; executa ROLLBACK em caso de erro (preservando o erro original do callback);
  - libera a conexão **sempre** (`finally`); nunca usa `SET` persistente na sessão do pool;
  - `options.expectedOrganizationId` (contrato interno): quando informado, compara com a
    organização resolvida e recusa divergências (`ORGANIZATION_MISMATCH`).
- **`ORGANIZATION_CONTEXT_SETTING`** = `'app.organization_id'` (constante exportada, lida
  futuramente por políticas RLS).

## Erros internos estáveis (sanitizados — a mensagem é o próprio código)

| Código                     | Situação                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`          | usuário ausente/vazio na resolução                                               |
| `MEMBERSHIP_MISSING`       | sem membership para o usuário                                                    |
| `MEMBERSHIP_INCONSISTENT`  | estado inconsistente (registros/papel fora do contrato)                          |
| `MEMBERSHIP_LOOKUP_FAILED` | falha na consulta de membership — o erro original nunca é propagado              |
| `INVALID_ORGANIZATION_ID`  | UUID inválido — recusado antes de consulta ou conexão                            |
| `ORGANIZATION_MISMATCH`    | organização divergente da esperada no contrato interno                           |
| `CONTEXT_SETUP_FAILED`     | falha ao configurar `app.organization_id` (ROLLBACK executado antes de retornar) |
| `TRANSACTION_FAILED`       | falha de conexão/BEGIN/COMMIT                                                    |

Erros do `callback` são propagados como estão (após ROLLBACK). Falhas de `set_config` também
executam ROLLBACK antes de retornar — nenhuma transação fica aberta no pool. Nenhum erro ou
log contém token, cookie, segredo, e-mail, imagem, saldo ou conteúdo financeiro.

## Garantias contra vazamento de contexto no pool

- `set_config(..., true)` é **local à transação**: descartado automaticamente no
  COMMIT/ROLLBACK;
- a conexão é devolvida ao pool em `finally`, sempre, mesmo em falha — falhas de
  `set_config`, do `callback` e de COMMIT executam ROLLBACK antes da liberação;
- testes de integração cobrem: contexto presente **durante** a transação; ausente **após**
  o término; reuso sequencial de conexões sem resíduo da requisição anterior; duas
  transações concorrentes isoladas entre si; erros sanitizados.

## Limites e não-objetivos

- **RLS nas tabelas financeiras e de integração NÃO está concluída** — esta unidade apenas
  prepara o mecanismo (`app.organization_id` por transação) para a fase seguinte.
- Nenhum fluxo financeiro, rota, UI, OpenAPI ou autenticação foi alterado; o módulo ainda
  **não está conectado** a endpoints — a integração ocorrerá em unidades próprias.
- `superadmin` segue apenas como papel de membership (nenhuma atribuição automática).
- Nenhuma migração nesta tarefa (o schema `core` foi integrado pela F1-01).
