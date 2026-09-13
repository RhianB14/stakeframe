# F1-01 — Registro de organização e membership (Fundação SaaS)

Data: 2026-09-13 · Base: `7994818b904eb47eb2f58cd701947def546efdde` (main)
Branch: `hermes/stk-f1-01-tenant-registry`

## Objetivo

Primeira unidade técnica da Fase 1 do Plano Master Stakeframe 2026: cada usuário passa
a ter uma **organização técnica própria** (`core.organization`) vinculada por um
registro de papéis (`core.membership`), preservando o funcionamento atual — sem alterar
tabelas financeiras, rotas, UI ou autenticação.

## Schema `core` (migration `0005_core_tenant_registry`)

`core.organization`

| Campo        | Definição                                              |
| ------------ | ------------------------------------------------------ |
| `id`         | `uuid` PK, default `gen_random_uuid()`                 |
| `name`       | `text` NOT NULL, CHECK não vazio (`btrim(name) <> ''`) |
| `created_at` | `timestamptz` NOT NULL, default `now()`                |
| `updated_at` | `timestamptz` NOT NULL, default `now()`                |

`core.membership`

| Campo             | Definição                                                      |
| ----------------- | -------------------------------------------------------------- |
| `organization_id` | `uuid` NOT NULL → `core.organization(id)` (ON DELETE CASCADE)  |
| `user_id`         | `text` NOT NULL → `auth.user(id)` (ON DELETE CASCADE)          |
| `role`            | enum `core.membership_role` ∈ {`owner`, `superadmin`} NOT NULL |
| `created_at`      | `timestamptz` NOT NULL, default `now()`                        |

- PK composta (`organization_id`, `user_id`).
- Índice único global em `user_id` (`membership_user_id_unique`): **uma organização por
  usuário** — um usuário não pode acumular duas memberships, mesmo em organizações
  diferentes.
- `superadmin` existe no contrato (enum do banco + tipo TypeScript) mas **não é
  atribuído automaticamente**; toda membership criada pelo backfill usa `owner`.

## Backfill da migration (fail-closed)

A migration é **forward-only**; as migrations históricas (0000–0004) permanecem
intocadas. Ao final do DDL, um bloco `DO` lê `auth.user` e aplica o contrato:

| Estado de `auth.user` | Comportamento esperado                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0 usuários            | nenhuma organização ou membership é criada                                                                       |
| exatamente 1 usuário  | cria a **organização fundadora** (nome = `name` do usuário; fallback `'Fundação'` se vazio) + membership `owner` |
| 2 ou mais usuários    | **aborta** com `RAISE EXCEPTION` sanitizada (sem IDs, e-mails ou nomes nos erros) — nenhuma mesclagem automática |

O nome da organização fundadora nunca inclui credenciais ou identificadores; a mensagem
de erro contém apenas o código da tarefa e o motivo. A migration inteira roda em
transação: no aborto, o schema `core` não é persistido e a migração não é registrada em
`drizzle.__drizzle_migrations`, permanecendo pendente para decisão humana.

## Limitações atuais (por desenho)

- **Sem RLS nesta etapa** — o isolamento por organização será tratado em unidade própria
  futura.
- Nenhuma tabela financeira ou de integração recebe `organization_id` ainda.
- Nenhuma rota, UI, OpenAPI ou fluxo de autenticação foi alterado; Google/owner
  continuam funcionando sem mudança.
- `superadmin` não é criado nem atribuído por esta unidade.
- Aplicação em produção **não faz parte desta tarefa** — a migration foi validada
  somente em PostgreSQL descartável (local/CI).
