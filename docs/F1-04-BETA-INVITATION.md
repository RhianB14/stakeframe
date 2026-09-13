# F1-04 — Fundação do convite beta e gate de acesso

Data: 2026-09-13 · Base: `08e9a80e0127dddcff9901383d29bd7178bac2ff` (main)
Branch: `hermes/stk-f1-04-beta-invitation`

## Objetivo

Criar a fundação segura do beta fechado por convite: tabela `core.beta_invitation` e os
serviços internos `createBetaInvitation(email, expiresAt)` / `redeemBetaInvitation(token)`.

Este convite é de **acesso ao beta** — não é convite de membro de organização. A
organização continua sendo criada automaticamente por usuário autenticado (F1-01/F1-03), e
**nada no convite permite ao cliente escolher uma organização**.

## Modelo da tabela (`core.beta_invitation`)

| Coluna                      | Tipo                                      | Notas                                                                 |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `id`                        | uuid                                      | PK, `gen_random_uuid()`                                               |
| `email`                     | text                                      | e-mail normalizado (trim + lowercase); CHECK de não vazio             |
| `token_hash`                | text                                      | **somente** SHA-256 hex do token bruto; índice único                  |
| `status`                    | enum `core.beta_invitation_status`        | `pending` \| `accepted` \| `revoked`; default `pending`               |
| `expires_at`                | timestamptz                               | expiração; convite expirado é **derivado** da data (sem status extra) |
| `accepted_at`               | timestamptz                               | preenchido no resgate único                                           |
| `accepted_user_id`          | text (FK `auth.user`, ON DELETE SET NULL) | preenchido por etapa posterior, quando aplicável                      |
| `created_at` / `updated_at` | timestamptz                               | `now()`                                                               |

Índices:

- `beta_invitation_token_hash_key` — único, garante lookup direto pelo hash;
- `beta_invitation_pending_email_key` — **único parcial** (`WHERE status = 'pending'`),
  garante no banco **um único convite pendente por e-mail** sem impedir novos convites
  depois de aceito/revogado.

Migration: `packages/db/migrations/0006_beta_invitation.sql` (forward-only). Aplicada
apenas em banco local/CI nesta tarefa — **não executar em produção**.

## Estratégia de token e hash

- Token: 32 bytes de `node:crypto.randomBytes` → base64url (43 caracteres). O token bruto
  existe **somente em memória** durante a criação e retorna **apenas** ao chamador interno
  autorizado.
- Persistência: apenas `sha256(token)` em hex — determinístico para permitir o lookup pelo
  índice único do hash; não há comparação sensível a tempo em código de aplicação.
- O token bruto nunca aparece em logs, erros, documentação, card Kanban ou banco.

## Contrato dos serviços

### `createBetaInvitation(database)` → `createInvitation(email, expiresAt)`

1. Normaliza o e-mail (trim, lowercase, formato válido, ≤ 254) — falha com
   `INVITATION_EMAIL_INVALID` sem tocar o banco.
2. Gera token criptograficamente seguro e persiste **somente o hash**.
3. Um segundo convite **pendente** para o mesmo e-mail é recusado com
   `INVITATION_CONFLICT` (erro estável; garantia reforçada pelo índice único parcial).
4. Retorna `{ invitationId, email, expiresAt, token }` — o `token` só deve ser usado pelo
   chamador interno (entrega futura ao usuário). Sem rota pública nesta tarefa.

### `redeemBetaInvitation(token)`

1. Rejeita token malformado (`INVITATION_INVALID`) antes de abrir conexão.
2. Abre transação e busca por `token_hash = $1` com **`FOR UPDATE`** (bloqueio de linha).
3. Recusa, de forma sanitizada e estável: token inexistente (`INVITATION_INVALID`),
   revogado (`INVITATION_REVOKED`), já aceito (`INVITATION_ALREADY_ACCEPTED`) e expirado
   (`INVITATION_EXPIRED` — `expires_at <= now()`; a linha permanece `pending`).
4. Aceita **uma única vez**: `status = 'accepted'`, `accepted_at = now()`, `updated_at = now()`.
5. Retorna somente `{ invitationId, email }` — o mínimo para a próxima etapa de
   autenticação (gate efetivo virá em tarefa posterior). Nunca retorna token nem detalhes
   internos.
6. Sempre libera a conexão (`finally`) e nunca deixa transação aberta no pool.

## Concorrência

Duas tentativas simultâneas do mesmo token: a primeira obtém o `FOR UPDATE` e conclui; a
segunda bloqueia, relê a linha já `accepted` sob READ COMMITTED (reavaliação pós-lock) e
falha com `INVITATION_ALREADY_ACCEPTED`. Comprovado por teste de integração com duas
tentativas concorrentes — exatamente uma conclui.

## Erros estáveis e sanitizados (`BetaInvitationError`)

Mensagem = código; nada de SQL, tabela, host, porta, e-mail ou token:

`INVITATION_EMAIL_INVALID` · `INVITATION_INVALID` · `INVITATION_EXPIRED` ·
`INVITATION_REVOKED` · `INVITATION_ALREADY_ACCEPTED` · `INVITATION_CONFLICT` ·
`INVITATION_STORAGE_FAILED`

## Fora do escopo (nesta tarefa)

Sem envio de e-mail/Resend, sem e-mail+senha, sem signup público, sem endpoint público de
convite, sem UI/onboarding, sem convite de membros, sem organizações compartilhadas, sem
RLS, sem `organization_id` nas tabelas financeiras, sem Mercado Pago, sem release/deploy e
**sem migração em produção**.

## Limitações anotadas

- `accepted_user_id` fica nulo no resgate: o vínculo com o usuário pertence à tarefa do
  gate de autenticação (o usuário ainda não existe no momento do resgate).
- A entrega do token ao usuário (e-mail/UI) fica para a tarefa de gate.
