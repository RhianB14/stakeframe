# STK-M0-61 — Reativação controlada e validação do worker

Data: 2026-09-12/13. Base: `7a58275404d5d22cad085c1459f6521e814ff560`.
Encerra formalmente a contenção iniciada na STK-M0-41; preflight da STK-M0-60
consumado. Execução pelo Hermes; aprovação do Codex retransmitida pelo
proprietário (regra 8 do [AGENTS.md](../AGENTS.md)).

**Classificação: OPERACIONAL (runtime)** — worker reativado e monitor
externo validado: `worker` e `aiBudget` `ready` após três ciclos; notificação
de recuperação do monitor externo entregue e confirmada uma única vez.
**Nenhuma mensagem de teste foi enviada; o fluxo funcional ponta a ponta do
consumidor não foi exercitado nesta janela.**

## 1. Autorização retransmitida pelo proprietário

> Autorizo a reativação em produção exclusivamente do contêiner existente
> `worker`, vinculado à main
> `7a58275404d5d22cad085c1459f6521e814ff560`, usando uma única execução de
> `docker compose ... start worker` com os três arquivos Compose registrados.
>
> Autorizo as operações externas normais do worker após a inicialização:
> polling do Telegram restrito à identidade configurada, consulta de metadados
> da chave OpenRouter, acesso R2 conforme os mounts existentes e processamento
> de itens legítimos que eventualmente já estejam na fila.
>
> Não autorizo `docker pull`, recriação, troca de imagem, deploy, migração,
> alteração de secrets/configuração, mensagem artificial, upload de teste ou
> chamada paga provocada para validação.
>
> Autorizo uma única execução de `stop worker` como contenção imediata somente
> se algum critério fail-closed ocorrer.

Imagem: iniciar o contêiner existente no digest `sha256:cbe6b61a…`; não
atualizar para `3fbfd4c7…` (paridade de código já comprovada na STK-M0-60 §2).

## 2. Gates imediatamente anteriores (somente leitura)

- `origin/main = 7a58275404d5d22cad085c1459f6521e814ff560`; CI pós-merge 5/5
  na `main` (squash da PR #113).
- `worker` ainda `Exited (0)` desde `2026-09-11T17:43:02Z`, sem reinício
  intermediário; demais quatro serviços `running`/`healthy`.
- Imagem, 7 mounts, redes `backend`/`provider-egress`,
  `restart: unless-stopped` e os três arquivos Compose idênticos ao preflight
  da STK-M0-60.
- `IDENTIDADE_CONFERE=true` (conferência privada do proprietário, STK-M0-60 §5).
- Secrets presentes com permissões canônicas (somente metadados).
- `pgboss.job` 0 (sem `created`/`retry`/`active`); `inbox` sem `processing`;
  `extraction_request` 0; anexos sem `local`/`deleting`; `event_search` sem
  `pending`/`processing`; cursor Telegram `nonzero`; `ai_usage_day` 0/0.
- Monitor: `lastHttpStatus=200` e assinatura `worker:failed,aiBudget:failed`
  (última leitura autenticada de 12/09 23:02Z; estável por construção com o
  worker parado).

Nenhum gate divergiu; o start prosseguiu.

## 3. Horário e comando executado (única mutação)

| Fase                          | Horário (UTC)                     |
| ----------------------------- | --------------------------------- |
| Gate final (somente leitura)  | imediatamente antes de 23:55:49   |
| `start worker` (única)        | 2026-09-12 23:55:49 → 23:55:54    |
| Verificações iniciais (≤90 s) | 23:57                             |
| Ciclos do monitor observados  | 00:00, 00:05 e 00:10 (2026-09-13) |

De `/opt/stakeframe`:

`docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml start worker`

`start_exit=0`, `Container stakeframe-production-worker-1 Started`. Execução
única; nenhuma repetição.

## 4. Estado do worker após o start

- `running` · `health=healthy` · `restarts=0` · started `23:55:53.954Z`.
- **Digest instalado preservado**: `sha256:cbe6b61a…` (sem pull, sem
  recriação, sem troca de imagem).
- **Advisory lock `782341094` presente**; endpoints internos `/` = `ready` e
  `/budget` = `ready`.
- Logs da janela: código `WORKER_READY` (1 linha); sem códigos de falha.

## 5. Leituras sanitizadas do monitor

| Leitura | Momento (UTC)  | state     | delivery  | lastHttpStatus | lastError | lastSignature                 |
| ------- | -------------- | --------- | --------- | -------------- | --------- | ----------------------------- |
| READ#1  | 12/09 23:58:09 | attention | confirmed | 200            | null      | worker:failed,aiBudget:failed |
| READ#2  | 13/09 00:03:34 | ready     | confirmed | 200            | null      | **ready**                     |

READ#2 reflete o ciclo de `00:00:58` (pós-reativação); `lastFiredAt` e
`lastCompletedAt` avançando, `lastCompletedAt ≥ lastStartedAt`. Bearer
permaneceu no procedimento privado do proprietário.

## 6. Recuperação entregue pelo monitor externo

Ciclo `00:00:58 → 00:01:00Z`: `fire → /check/start → /check/complete →
/check/confirm-delivery (204)`. A mudança real de assinatura gerou **uma única**
notificação, **recebida** pelo proprietário às 21:01 locais (00:01Z);
`delivery=confirmed`. Os ciclos `00:05` e `00:10` concluíram sem reenvio —
nenhum alerta duplicado. A notificação veio do **monitor externo**
(verificação do endpoint público de saúde da API) — **não** de mensagem
recebida ou processada pelo consumidor Telegram.

## 7. Contagens antes → depois (sanitizadas)

| Item                             | Antes   | Depois                              |
| -------------------------------- | ------- | ----------------------------------- |
| `pgboss.job`                     | 0       | 0                                   |
| `integration.inbox`              | 0       | 0                                   |
| `integration.extraction_request` | 0       | 0                                   |
| `integration.attachment`         | 0       | 0                                   |
| `integration.event_search`       | 0       | 0 (1 histórico `complete`)          |
| `integration.ai_usage_day`       | 0/0     | 0/0                                 |
| Cursor Telegram                  | nonzero | nonzero (avançou; sem persistência) |

Nenhum conteúdo foi observado — apenas contagens; nenhuma mensagem, imagem,
ID privado ou payload registrado. **Nenhuma mensagem de teste foi enviada.**
`/budget = ready` (consulta de metadados da chave OpenRouter); nenhuma
inferência paga; nenhuma mensagem artificial; nenhum upload de teste.

## 8. Estabilidade e classificação

Estabilidade confirmada até 2026-09-13 02:10Z: `running`/`healthy`,
`restarts=0`, started `23:55:53Z` inalterado.

**OPERACIONAL (runtime do worker e monitor externo)** — worker
`running/healthy` sem restart; lock presente; `/` `ready`; `/budget` `ready`;
filas **locais** estáveis; monitor HTTP 200 com `lastError=null`; `worker` e
`aiBudget` fora de `failed`; três ciclos concluídos; nenhum alerta duplicado.
Nenhuma contenção foi necessária — `stop worker` **não** executado. **Escopo
da classificação:** cobre a reativação e a validação de runtime do worker e
do monitor externo; **não comprova** ingestão Telegram, R2 ou extração —
nenhuma mensagem de teste foi enviada e o fluxo funcional ponta a ponta do
consumidor não foi exercitado nesta janela; o backlog remoto do Telegram
permaneceu não observado.

## 9. Confirmações

- Zero segredos lidos, impressos, copiados ou registrados; o bearer do
  `/status` permaneceu no procedimento privado do proprietário.
- Nenhuma mensagem de teste foi enviada; o fluxo funcional ponta a ponta do
  consumidor não foi exercitado nesta janela; a recuperação registrada veio
  do monitor externo.
- Zero mutações fora do escopo: a única escrita foi o `start worker`
  autorizado (sem `pull`, recriação, deploy, migração, rollback, alteração de
  secrets/configuração, Cloudflare, DNS, firewall ou banco além das consultas
  de contagem).
- Documento sanitizado: sem IDs, IPs, hostname, tokens, valores do cursor ou
  conteúdo privado.
- Contenção da STK-M0-41 **formalmente encerrada** (registro na
  [M0-41-TELEGRAM-WORKER-CONTAINMENT.md](M0-41-TELEGRAM-WORKER-CONTAINMENT.md)
  §11) e preflight da STK-M0-60 consumado
  ([M0-60-WORKER-REACTIVATION-PREFLIGHT.md](M0-60-WORKER-REACTIVATION-PREFLIGHT.md)
  §13).

Referências: [M0-60-WORKER-REACTIVATION-PREFLIGHT.md](M0-60-WORKER-REACTIVATION-PREFLIGHT.md),
[M0-41-TELEGRAM-WORKER-CONTAINMENT.md](M0-41-TELEGRAM-WORKER-CONTAINMENT.md),
[INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md), [TELEGRAM.md](TELEGRAM.md),
[M0-CHECKLIST.md](M0-CHECKLIST.md).
