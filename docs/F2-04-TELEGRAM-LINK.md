# STK-F2-04 — Telegram: conta única por usuário, deep link de uso único, revogação e relink auditados

Unidade STK-F2-04 do Plano Master 2026 (§8.2 e §15). Base: `74d22c578accd7eca545e1db27134647b9b34de0` (main).
Transporte: **o polling do worker existente** — nenhum webhook, nenhum serviço novo (rejeitado em §8.2).

## 1. Objetivo

Uma conta Telegram por usuário, **globalmente única**. A vinculação acontece por deep link de
uso único com expiração de **cinco minutos**, confirmação no site, e revogação/relink
auditados. O worker nunca decide vínculo: ele só registra a conta observada no Telegram;
a confirmação é sempre no site, com sessão autenticada.

## 2. Modelo de dados (migration `0020_telegram_link`)

### `core.telegram_link_request` — artefato global e temporário

| Coluna          | Tipo      | Notas                                                            |
| --------------- | --------- | ---------------------------------------------------------------- |
| `id`            | uuid      | PK                                                              |
| `user_id`       | text (FK) | dono do pedido                                                  |
| `token_hash`    | text      | **somente** SHA-256 hex do token bruto; índice único            |
| `state`         | enum      | `pending` \| `claimed` \| `consumed` \| `expired` \| `revoked`   |
| `telegram_user_id` | bigint | preenchido pelo worker quando o link é aberto no Telegram       |
| `expires_at`    | timestamptz | expiração; CHECK `expires_at > created_at`                     |
| `claimed_at` / `consumed_at` / `created_at` / `updated_at` | timestamptz | |

Sem RLS, como `core.beta_invitation`: a resolução por hash **é** a fronteira, e a tabela
nunca carrega nome, e-mail, organização ou conteúdo.

### `core.telegram_link` — vínculo duradouro e privado

| Coluna        | Tipo      | Notas                                                          |
| ------------- | --------- | -------------------------------------------------------------- |
| `id`          | uuid      | PK                                                            |
| `organization_id` | uuid (FK) | escopo de tenant; `ON DELETE cascade` (o purge da F1-08 remove) |
| `user_id`     | text (FK) | dono                                                         |
| `telegram_user_id` | bigint | conta do Telegram; CHECK `> 0`                             |
| `state`       | enum      | `active` \| `revoked`                                           |
| `linked_at` / `revoked_at` | timestamptz | CHECK de coerência entre `state` e `revoked_at`             |

Índices que **decidem** a unicidade (nunca uma checagem de aplicação):

- `telegram_link_active_telegram_id_key` — único, parcial (`state = 'active'`): **uma conta
  do Telegram ativa em toda a base**;
- `telegram_link_active_user_id_key` — único, parcial: **um vínculo ativo por usuário**.

A RLS `organization_isolation` segue a fronteira existente de `finance`/`integration`.

### `core.telegram_bot` — username público do bot (singleton)

Não é segredo (o Telegram publica o username na URL do bot) e **não é versionado**: o
worker resolve por `getMe` e grava. Nenhum segredo novo, nenhuma variável de ambiente nova.
Ausente = a API falha fechada (`503 TELEGRAM_LINK_UNAVAILABLE`) em vez de inventar URL.

## 3. Ciclo de vida

1. `POST /api/v1/telegram/link` — servidor autenticado emite o deep link. Um pedido anterior
   ainda vivo do mesmo usuário é **revogado no mesmo instante** (no máximo um link utilizável
   por conta). TTL = 5 min (teto fixo; um TTL maior é recusado).
2. O usuário abre `https://t.me/<bot>?start=<token>`. O Telegram entrega
   `message.text = "/start <token>"` ao **mesmo polling** já existente.
3. `apps/worker/src/telegram-link.ts` reconhece o update (mesma fronteira de autorização das
   imagens: par usuário/chat exato, conversa privada, sem bot/encaminhamento) e grava
   `state = 'claimed'` com o id numérico observado. Responde com orientação genérica.
4. `POST /api/v1/telegram/link/confirm` — o site confirma. O servidor exige, nesta ordem:
   link existente → dentro dos 5 minutos → não consumido → **pertencente a este usuário** →
   conta já observada pelo bot. Nenhum id de conta Telegram vem do navegador.
5. `DELETE /api/v1/telegram/link` — revoga o vínculo ativo. A linha **não é apagada**: fica
   `revoked` com o instante, e um evento de auditoria é gravado.

**Relink** é o mesmo caminho de confirmação: um vínculo ativo anterior do próprio usuário é
encerrado e o novo assume **na mesma transação**, com `relinked: true` na auditoria. Trocar de
celular é uma operação só e nunca deixa duas contas ativas.

## 4. Auditoria (sanitizada)

| Evento                     | `entity_id`    | `after`                                     |
| -------------------------- | -------------- | ------------------------------------------- |
| `telegram.link_confirmed`  | instante do link | `{"relinked": bool, "revokedLinkId": uuid\|""}` |
| `telegram.link_revoked`    | uuid do vínculo | `{}`                                       |

Nunca entram: token, id numérico da conta do Telegram, nome, e-mail, IP ou user-agent.

## 5. Códigos de erro (API)

`TELEGRAM_LINK_INVALID` (400) · `TELEGRAM_LINK_REVOKED` (400) · `TELEGRAM_LINK_NOT_LINKED`
(404) · `TELEGRAM_LINK_EXPIRED` / `TELEGRAM_LINK_CONSUMED` / `TELEGRAM_LINK_NOT_CLAIMED` /
`TELEGRAM_LINK_ALREADY_LINKED` / `TELEGRAM_LINK_IDENTITY_CONFLICT` (409) ·
`TELEGRAM_LINK_UNAVAILABLE` (503).

A mensagem é o código; nenhum SQL, tabela, host ou dado privado chega ao log ou à resposta.

## 6. Superfície da API

| Método   | Rota                          | operationId               |
| -------- | ----------------------------- | ------------------------- |
| `GET`    | `/api/v1/telegram/link`       | `getTelegramLink`         |
| `POST`   | `/api/v1/telegram/link`       | `requestTelegramLink`     |
| `POST`   | `/api/v1/telegram/link/confirm` | `confirmTelegramLink`    |
| `DELETE` | `/api/v1/telegram/link`       | `revokeTelegramLink`      |

Todas exigem o mesmo gate privado do produto: sessão válida de identidade admitida
(`getOwner`), consentimento vigente e, em escrita, `Origin` igual à origem configurada. A
organização vem **sempre** do usuário autenticado; o corpo nunca escolhe tenant nem conta.

## 7. Testes (§15)

- **Unit** (`tests/unit/telegram-link.test.ts`, 22 casos): reconhecimento do `/start` no
  polling; recusa de remetente/chat/grupo/bot/encaminhamento/`sender_chat`/`via_bot`/
  `business_connection_id`; parser de token; construção do deep link (https e username
  validado — falha fechada); contrato que rejeita conta ou organização no corpo; entrega do
  deep link pelo polling existente, sem rota nova; leitura de `getMe` com recusa de username
  fora do formato.
- **Integração** (`tests/integration/telegram-link.test.ts`, 17 casos, PostgreSQL real):
  janela de exatamente 5 min medida no banco e só o hash persistido; novo pedido revoga o
  anterior; **expiração**; recusa de TTL fora da faixa; confirmação antes de abrir no Telegram
  recusada; **consumo único** (reuso = `TELEGRAM_LINK_CONSUMED`); token de outro usuário e
  token inexistente recusados; **conflito de identidade** entre dois usuários (decidido pelo
  índice global); relink e unicidade; **revogação** com trilha e idempotência; bootstrap do
  singleton do bot; política de organização; worker respondendo orientação genérica sem
  revelar estado.
- **E2E** (`tests/e2e/onboarding.test.ts`): o passo do Telegram emite o deep link de uso
  único, confirma no site, apaga o token do navegador e revoga; nada é gravado ao apenas
  abrir a tela.
- **Regressão**: 423 unit e a suíte de integração completa, `pnpm typecheck`, `pnpm lint`,
  `pnpm api:spec:check`, `pnpm format:check`.

## 8. Fora do escopo (como no card)

Webhook (rejeitado em §8.2); múltiplas contas por usuário; `/undo` temporizado. Nenhuma
alteração em `compose.*`, corpus privado, telemetria ou material de produção. Nenhuma
operação de merge, deploy, promoção ou migration em produção nesta unidade.

## 9. Notas de operação

- `TELEGRAM_LINK_ALREADY_LINKED` ficou no contrato por simetria com o estado, mas o fluxo
  normal é o relink direto: a troca de conta é uma única confirmação auditada. O código só
  aparece se o índice parcial recusar a escrita, o que é a garantia final do banco.
- O username do bot só existe depois que o worker roda com o Telegram habilitado. Em
  ambientes sem worker, o site mostra o estado do vínculo normalmente e apenas a emissão do
  deep link responde 503 — sem erro e sem URL inventada.
