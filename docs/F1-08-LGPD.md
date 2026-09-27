# STK-F1-08 — LGPD: exportação de dados, exclusão com carência e purge

> Unidade do Plano Master Stakeframe 2026 (§7.3 e §15). Escopo: exportação completa
> dos dados do próprio titular (JSON e apostas em CSV), exclusão de conta com carência
> de 30 dias, bloqueio imediato de login e sessões, cancelamento dentro da janela e
> purge irreversível executado pelo worker com trilha mínima sem PII.
>
> **Fora de escopo declarado:** anonimização de registros legalmente obrigatórios —
> o usuário mínimo (`auth.user`) e os aceites (`core.consent_record`) sobrevivem ao
> purge e aguardam orientação profissional, como prevê o próprio §15 do plano.

## 1. Modelo de dados (`migração 0018_account_deletion`)

### `core.account_deletion` — máquina de estados da exclusão

| Coluna                    | Tipo                               | Notas                                                               |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `user_id`                 | text PK                            | FK `auth.user.id` com `onDelete: cascade`                           |
| `organization_id`         | uuid                               | **sem FK** de propósito: a trilha sobrevive ao purge da organização |
| `state`                   | enum `core.account_deletion_state` | `pending` · `cancelled` · `purged`                                  |
| `requested_at`            | timestamptz                        | início da carência                                                  |
| `expires_at`              | timestamptz                        | `requested_at + 30 dias` — vencida, habilita o purge                |
| `cancelled_at`            | timestamptz                        | preenchido no cancelamento dentro da janela                         |
| `purged_at`               | timestamptz                        | preenchido pelo purge; base dos 90 dias de anexos                   |
| `created_at`/`updated_at` | timestamptz                        | padrão do schema `core`                                             |

Índices: `(organization_id)` e `(state, expires_at)` para a varredura do worker.

Uma linha por usuário. Novo pedido após cancelamento reabre a janela (`update`); o
pedido repetido com estado `pending` é idempotente e preserva a janela original.

## 2. Exportação (o arquivo do titular)

- `GET /api/v1/account/export.json` — envelope da conta (`user`, `organization`,
  `membership`, `sessions` e `providers`) seguido do histórico financeiro completo
  (`history`), com as mesmas tabelas de portabilidade do §15 (`portabilityTables`,
  filtradas pela organização da sessão). **Nunca** inclui tokens de sessão,
  credenciais de provedor, senhas ou bytes de imagem.
- `GET /api/v1/account/export/bets.csv` — todas as apostas do titular no CSV aprovado
  da tabela BETS-02 (14 colunas na ordem útil: Nº do bilhete, Data do jogo, Hora do
  jogo, Evento, Aposta/seleção, Mercado, Tipo da aposta, Tipster, Casa de aposta,
  Valor apostado, Odd, Retorno recebido, Resultado/status, ID técnico), UTF-8 com BOM
  e delimitador vírgula. A semântica das células vem das fontes canônicas já
  existentes: `betTablePresentation`/`betResultLabel` (movidas para
  `packages/shared`, com a web usando o mesmo comportamento) e
  `classifyTicketKind`; retorno aberto aparece como `—`, nunca como zero.

Ambos os endpoints são autenticados pela sessão do proprietário, servem apenas os
dados da própria conta, registram o evento de exportação em `finance.audit`
(`account.export`, sem payloads) e têm rate-limit leve de **1 requisição por minuto
por rota e por usuário** (`RATE_LIMITED`). O snapshot usa conexão dedicada com
`repeatable read`, uma por processo, igual aos relatórios.

## 3. Exclusão com carência

- `POST /api/v1/account/exclusion-request` — marca `pending` com `expires_at = now()
  - 30 dias` e **derruba todas as sessões do usuário na mesma transação**.
- `POST /api/v1/account/exclusion-cancel` — dentro da janela (`pending` e ainda não
  vencida) devolve o estado `cancelled`; fora dela ou sem pedido responde
  `STATE_CONFLICT` (409).

O re-login normal volta a funcionar apenas depois do cancelamento; um novo pedido
reabre a janela.

## 4. Bloqueio imediato (auth)

O gate fica em `apps/api/src/auth.ts`, em dois pontos:

- `databaseHooks.session.create.before`: conta `pending` ou `purged` não inicia sessão.
- `getIdentity`: cookie existente deixa de autenticar no instante do pedido — a
  sessão ativa é invalidada mesmo antes da exclusão das linhas (defesa em
  profundidade, já que o request também apaga as sessões).

O serviço é fail-closed: falha de leitura no gate bloqueia o login.

## 5. Purge (worker)

`apps/worker/src/account-purge.ts` roda como os demais subsistemas do worker (loop
de 60 s com `AbortController`, registrado/parado em `apps/worker/src/server.ts` —
mesmo padrão de `attachments` e `monthly`). O job:

1. Busca pedidos vencidos (`state = pending` e `expires_at <= now()`) — consulta de
   infraestrutura, fora de qualquer organização.
2. Executa o purge em transação única: dados da organização (integração e financeiro,
   filhos antes de pais), membros, onboarding, sessões e credenciais do usuário e a
   própria organização. Os triggers de imutabilidade financeira são desabilitados
   **apenas dentro da transação** (`disable trigger user`) e restaurados antes do
   commit — DDL é transacional, então falha reverte tudo.
3. Marca `state = purged` com `purged_at` (a trilha mínima, sem PII) e registra
   `ACCOUNT_PURGED` no log do worker — nunca valores, nomes ou identificadores.

É idempotente: reexecutar não encontra linha `pending` vencida e não faz nada.

## 6. Anexos privados (90 dias)

`integration.attachment` **não** é apagada pelo purge. A política
(`attachmentExpiredSql`) ganhou um segundo ramo: anexos órfãos (sem `inbox`) de uma
organização purgada só expiram quando `purged_at + 90 dias` passa — a retenção do
§7.3 — e o job de imagens existente os remove normalmente depois disso. Anexos já
excluídos antes da exclusão permanecem excluídos ("salvo exclusão anterior").

## 7. Backups

Nota operacional em `docs/OPERATIONS.md` (seção de recuperação): contas excluídas
não são reativadas por restauração fora de recuperação de desastre; o snapshot
carrega a trilha apenas para auditoria e a retomada pós-restore mantém a janela
própria já documentada.

## 8. API (OpenAPI)

As quatro rotas entram no `docs/openapi.json` regenerado por `pnpm api:spec`:
`export.json` (200 `application/json`), `export/bets.csv` (200 `text/csv`),
`exclusion-request` e `exclusion-cancel` (200 `AccountDeletionResponse`, 404/409
mapeados via `AccountDeletionError`). O mapeamento de erro aceita tanto
`instanceof` quanto o nome da classe — o entry do pacote pode resolver uma cópia
diferente (`dist` vs `src`) entre o bundle da API e os serviços dos testes.

## 9. Testes

`tests/integration/account-lgpd.test.ts` (checker LGPD do §15): exportação completa
JSON sem credenciais, CSV com as colunas e semântica BETS-02 (simples, múltipla,
retorno aberto), bloqueio imediato com sessão viva invalidada, cancelamento dentro
da janela, purge com relógio deslocado e convergência em retry, retenção de 90 dias
dos anexos e rate-limit das rotas. Migrações: `tenant-registry` e
`import-action-atomicity` foram atualizados para a nova sequência.
