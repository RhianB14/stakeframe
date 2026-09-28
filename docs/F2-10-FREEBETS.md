# STK-F2-10 — Freebets: registro, alerta de expiração, valor efetivo e notificações

Unidade STK-F2-10 do plano master 2026 (§8.7 Freebets e notificações, §3.6
Freebets, §15 Plano de testes). Base: o modelo financeiro existente (a tabela
`finance.freebet` e o comando `freebet.create` já existiam desde a fundação) e o
padrão de fila durável da STK-M4-01.

Esta entrega **não** autoriza produção: sem deploy, sem migração aplicada fora do
ambiente local e sem promoção. A dependência da STK-F2-04 (notificações Telegram)
está em desenvolvimento em outra branch e é tratada aqui como canal desligado.

## 1. Objetivo

Completar o §8.7 em quatro partes:

- **Registro** de freebet com casa, valor, validade, devolução da stake, nota e
  **requisitos estruturados** do bônus;
- **Alerta antes da expiração**, gerado por job no worker existente e
  deduplicado;
- **Calculadora transparente de valor efetivo** — mostra a conta inteira;
- **Preferências de notificação por usuário** com quiet hours, timezone e
  tópicos.

Fora do escopo, por decisão do plano (§8.7 e §3.6): carteiras de bônus e
rollover, alerta de tilt/modo pausa/metas/diagnóstico emocional e checklist
obrigatório de stake/exposição. Nada disso foi implementado.

## 2. O que mudou

### 2.1 Contratos (`packages/shared/src/freebets.ts`)

`FreebetRecord` (id, casa, valor, validade, `expiresAt`, `stakeReturned`,
`usedBy`, `status`, `requirements`, nota), `EffectiveValue` (a calculadora),
`NotificationPreferences` e `NotificationRecord`. Requisitos são **estruturados**,
nunca texto livre: `min_odds`, `min_odds_per_selection`, `min_selections`,
`single_only`, `no_exchange`, `sports_restriction`, `market_restriction`,
`new_customer_only`, `other`.

### 2.2 Regra de expiração (a decisão de domínio central)

A validade é uma **data civil** (§3.7) e a freebet vale **durante todo aquele
dia**. A expiração efetiva é o **fim** dessa data no fuso do usuário, não a
meia-noite dela:

```
expiresAtFor('2026-12-31', 'America/Sao_Paulo') = 2027-01-01T02:59:59.999Z
expiresAtFor('2026-12-31', 'Asia/Tokyo')       = 2026-12-31T14:59:59.999Z
```

O deslocamento é medido no **próprio dia** da validade (a meio-dia UTC), o que
evita a fronteira de meia-noite em fusos de meia hora e na virada do horário de
verão. Situação canônica: `revoked` > `used` > `expired` > `available`.

### 2.3 Calculadora de valor efetivo (§8.7)

Transparente de propósito: cada parcela volta com **a regra que a produziu**.

| Situação                      | Valor efetivo                                         |
| ----------------------------- | ----------------------------------------------------- |
| Sem devolução da stake        | `face × (odd − 1)`                                    |
| Com devolução da stake        | `face × odd`                                          |
| Aposta híbrida (parcela real) | subtrai a parcela real — proteger a perda não é ganho |

- **Requisito não satisfeito BLOQUEIA o uso** (`blockers` + `eligible: false`).
  Reduzir o valor em silêncio esconderia a diferença entre "vale pouco" e "não
  pode usar", que são decisões diferentes para o usuário.
- Restrições de conta (`new_customer_only`, `no_exchange`) **nunca bloqueiam
  offline**: aparecem com `required: 'verificar na casa'`.
- Odd por seleção desconhecida **não bloqueia** — a casa valida na conta.
- Arredondamento half-up em centavo, em `bigint`, com o mesmo `roundedDivide` do
  resto do sistema (sem ponto flutuante).

### 2.4 Preferências e quiet hours

Por **usuário** (§8.7), dentro da organização. Quiet hours são avaliados no fuso
**do usuário**, com janela circular (o silêncio pode cruzar a meia-noite).
Fuso IANA inválido é **recusado** (fail-closed): um fuso quebrado silenciaria
toda notificação para sempre. Fuso válido em `Intl` mas resolve `null` também
silencia — o padrão é nunca entregar no escuro sem querer.

### 2.5 Alerta de expiração (fila durável + dedupe)

Janelas: `3d`, `1d` e `4h` antes do fim da validade. A chave de deduplicação é
`freebet_expiring:<freebetId>:<janela>` dentro da organização, garantida pelo
**índice único** com `ON CONFLICT DO NOTHING` — não por checagem em memória.
Rodar o job N vezes nunca gera N notificações, nem sob concorrência.

Quiet hours **adiam, nunca descartam**: um alerta que cairia no silêncio é
reprogramado para o primeiro instante fora da janela.

### 2.6 Canal de notificação — DESABILITADO (limitação conhecida)

`apps/worker/src/notification-channel.ts` define a interface
(`NotificationChannel`) e um **stub fail-closed**: `deliver()` sempre recusa com
`NOTIFICATION_CHANNEL_UNAVAILABLE` e nunca toca a rede.

Escolha deliberada: um stub que "envia" e descartaria seria pior que não enviar —
o usuário teria um registro marcado como entregue sem nunca ter visto a
mensagem. Como a fila continua aceitando e adiando, **nada se perde** quando o
canal real chegar na STK-F2-04.

O que **não** existe aqui, por ser escopo da STK-F2-04: deep link, botão de
abertura, vínculo de conta, edição/apagamento de mensagem e qualquer chamada de
rede.

Quando o canal recusa, o alerta volta para `pending` com backoff
(`notifications.restore`). Sem isso ele ficaria marcado como entregue sem nunca
ter chegado — o `claim` reserva o item para impedir entrega duplicada, e o
`restore` é a contraparte obrigatória dessa reserva.

## 3. Isolamento e segurança

Todo acesso usa `organization_id = current_setting($$app.organization_id$$, true)::uuid`
dentro de `withOrganizationTransaction`. O RLS **não** é a defesa (o papel de
conexão é dono/superusuário e o ignora) — as policies ficam como profundidade
para um papel futuro, sem FORCE.

- A fila é escopada por `(organization_id, user_id)`: um usuário da organização
  A nunca escreve nem lê a fila de B, mesmo com o contexto trocado.
  **Exceção deliberada:** `notification.preference` e `notification.outbox` **não**
  têm FK para `core.membership`. `tenant-context.test.ts` derruba
  `core.membership` para simular falha de lookup e `tenant-registry.test.ts`
  derruba o schema `core` no replay — uma FK para lá recusaria os dois
  (`cannot drop table because other objects depend on it`). O vínculo
  usuário↔organização é o de `core.membership`, validado na aplicação; a defesa
  de isolamento é o predicado explícito de organização, não a FK.
- O job resolve o destinatário do registry de tenancy (`recipientOf`), nunca do
  rótulo `system:worker` — que não tem preferência gravada e faria o alerta sair
  no fuso errado.
- Erros são códigos estáveis e sanitizados (`FreebetError`, mensagem = código);
  nenhum id, e-mail, token ou conteúdo financeiro chega a log ou resposta.

## 4. Banco (LOCAL apenas)

`packages/db/migrations/0021_freebet_notifications.sql`, forward-only e
replay-safe (`IF NOT EXISTS` / `DROP ... IF EXISTS`), no padrão da 0010 e da 0011:

- `finance.freebet` ganha `requirements` (jsonb), `updated_at` e `revoked_at`
  (revogação é soft-delete auditável — a linha sai da lista, não do histórico);
- índice parcial `freebet_expiry_idx` sobre as não usadas e não revogadas;
- schema novo `notification` com `preference` e `outbox`, RLS habilitada.

**Não executada em produção nem na VPS.** Aplicação em produção exige o fluxo
de autorização, backup e recuperação do runbook.

**Numeração 0021, e não 0020:** a 0020 do `main` é a auditoria do painel interno
(STK-F2-11, PR #225). A branch foi criada sobre `74d22c5` e o rebase sobre
`e9afb48` colidiu por número de versão e por `meta/_journal.json`; a renomeação
para 0021 preserva a 0020 do outro agente e a cadeia fica contígua
(0019 → 0020 → 0021). O replay local confirma que as duas coexistem: 22
marcadores, segunda aplicação idempotente, `core.admin_panel_access` (da 0020)
intacta, RLS habilitada sem FORCE.

## 5. Endpoints

| Método | Rota                               | operationId                     |
| ------ | ---------------------------------- | ------------------------------- |
| GET    | `/api/v1/freebets`                 | `listFreebets`                  |
| POST   | `/api/v1/freebets`                 | `createFreebet`                 |
| GET    | `/api/v1/freebets/:id`             | `getFreebet`                    |
| PATCH  | `/api/v1/freebets/:id`             | `updateFreebet`                 |
| DELETE | `/api/v1/freebets/:id`             | `revokeFreebet`                 |
| POST   | `/api/v1/freebets/evaluate`        | `evaluateFreebet`               |
| GET    | `/api/v1/notification-preferences` | `getNotificationPreferences`    |
| PUT    | `/api/v1/notification-preferences` | `updateNotificationPreferences` |
| GET    | `/api/v1/notifications`            | `listNotifications`             |

Todas exigem sessão, origem e consentimento; a organização vem **sempre** do
usuário autenticado. A organização B recebendo o id de uma freebet da A recebe
**404** (§15).

Códigos de erro novos: `FREEBET_NOT_FOUND`, `FREEBET_ALREADY_USED`,
`FREEBET_REVOKED`, `FREEBET_INVALID`.

## 6. Testes (§15)

`tests/unit/freebets.test.ts` (27) — calculadora (devolução/não devolução, híbrido,
perda em relação à face, bloqueio por requisito, mínimo exato, simples/múltipla,
seleções, esporte, rounding half-up), quiet hours (janela simples, janela que
cruza a meia-noite, janela vazia, fuso inválido fail-closed, fuso do usuário vs.
do servidor) e contratos.

`tests/integration/freebets.test.ts` (22) — registro, casa inativa recusada,
imutabilidade após consumo, revogação, expiração no fim do dia, calculadora
contra o registro, preferências (padrão, upsert, fuso inválido), fila (dedupe,
janela, quiet hours adiando, tópico desligado, restore após falha de canal) e
**isolamento por organização** (a freebet de B é criada depois, para que o teste
falhasse sem o predicado).

Verificações: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`,
`pnpm api:spec:check`, `pnpm local:test-db`, `pnpm operations:rehearse`,
`pnpm deployment:rehearse`, `pnpm validation:performance`, `pnpm format:check`.

## 7. Fora do escopo (não implementado)

Carteiras de bônus e rollover (§3.6); alerta de tilt, modo pausa, metas e
diagnóstico emocional (§8.7, rejeitado); checklist obrigatório de
stake/exposição (voluntário e não bloqueante); deep link e vínculo Telegram
(STK-F2-04); envio real por qualquer canal.

Também não houve: materialized view, IA narrativa, recomendação, alteração em
`compose/*`, corpus privado, telemetria ou qualquer material de outro agente.
