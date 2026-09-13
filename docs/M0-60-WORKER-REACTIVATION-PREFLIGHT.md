# STK-M0-60 — Preflight read-only para reativação do worker

Data: 2026-09-12. Base: `9fcd048a2faa14bb641e6a7c43e620d3750da30d`.
Execução somente leitura (VPS, banco e repositório); nenhuma mutação, nenhum
segredo lido, nenhum `getUpdates`/Telegram/OpenRouter, nenhum `docker pull`.

**Classificação: PRONTO para janela controlada autorizada**, com as decisões de
janela listadas na §7 e o comando proposto (não executado) na §8.

## 1. Estado e causa da parada

- `worker`: **`Exited (0)`** desde `2026-09-11T17:43:02Z` — parada
  **intencional** da STK-M0-41 (`docker compose … stop worker`, execução única;
  `restart: unless-stopped` respeitado; contêiner preservado com 7 mounts e as
  redes `backend` e `provider-egress`). **Não é crash.**
- `api` `Up` healthy (digest `741c1f6d…`, recriada na STK-M0-49); `web`
  (`066ee861…`), `operations` (`8f9e5f34…`) e `postgres` (`postgres:18.4-alpine`)
  `Up` há ~2 dias. Projeto `stakeframe-production`; conjunto de três arquivos
  Compose.

## 2. Imagem instalada × imagem aprovada/publicada

|                                       | Digest             | Source SHA                       |
| ------------------------------------- | ------------------ | -------------------------------- |
| Instalada (presa ao contêiner parado) | `sha256:cbe6b61a…` | `317ec268` (piloto M0-24, 07/09) |
| Aprovada/publicada (mais recente)     | `sha256:3fbfd4c7…` | `0b4e4b73` (STK-M0-48)           |

- **Diferenças de código**: `apps/worker` e `packages` são **idênticos** entre
  as duas origens; a única mudança de aplicação no intervalo é
  `apps/api/src/operations.ts` (não integra a imagem do worker). **Migrações
  idênticas** (`0000`–`0004`; 5 aplicadas).
- **Operações tecnicamente distintas**: `start` do contêiner existente usa a
  imagem já presente (sem pull); "atualizar/recriar" com o digest aprovado
  exige `docker pull` + recriação (`up -d --no-deps worker`) — não autorizado
  aqui e não necessário para a paridade de código do worker.

## 3. Banco — contagens sanitizadas (somente SELECT)

| Item                                   | Valor                                                 |
| -------------------------------------- | ----------------------------------------------------- |
| `pgboss.job`                           | 0 (nenhum em qualquer estado)                         |
| `integration.inbox`                    | 0 (nenhum `processing`)                               |
| `integration.extraction_request`       | 0                                                     |
| `integration.attachment`               | 0 (nada em `local`/`deleting`)                        |
| `integration.event_search`             | 0 pendentes/processing (1 linha histórica `complete`) |
| `integration.ai_usage_day`             | 0 linhas / 0 requisições (dia e mês)                  |
| Advisory lock `782341094`              | **ausente** (consumo parado)                          |
| Cursor Telegram (`integration.cursor`) | **`nonzero`** (preservado)                            |

## 4. Segredos — somente metadados

- Diretório `/etc/stakeframe/secrets`: `root:root 0700`; arquivos regulares
  (sem symlink) `0640` com proprietário operacional (`opc:opc`); exceções
  canônicas: `postgres_password` `0600 root`, `r2_backup_restore_*`
  `root:opc`.
- Os **7 mounts do worker** seguem declarados no Compose (`db_password` +
  Telegram×3 + OpenRouter + R2 writer×2); R2 reader presente/montado onde
  esperado (presença e permissão apenas — nenhuma credencial testada).
- `AI_ENABLED=true` e `TELEGRAM_ENABLED=true` (fonte configuracional
  sanitizada: `compose.integrations.yml`).

## 5. Identidade Telegram (gate 5 do M0-40)

Conferência privada executada **pelo proprietário**, com os valores permanecendo
na tela dele: **`IDENTIDADE_CONFERE=true`** (nenhum ID transita no registro).

## 6. Relação causal `worker:failed` × `aiBudget:failed`

Em `apps/api/src/operations.ts`, as duas checagens leem o **mesmo serviço**:

- `checks.worker` ← `readInternal('http://worker:9091/')`;
- `checks.aiBudget` ← `readInternal('http://worker:9091/budget')`.

Com o contêiner parado, ambas falham pela **mesma indisponibilidade imediata**.
Nada indica credencial ou saldo OpenRouter inválidos — a validade real do
orçamento só se observa com o worker ativo ou por sonda externa autorizada.

## 7. Matriz de decisão

| Opção                                       | Estado                                                                |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Seguro iniciar o contêiner existente        | **SIM**                                                               |
| Exige atualizar/recriar com imagem aprovada | ALTERNATIVA (não requerida; código do worker idêntico; exigiria pull) |
| Bloqueado por backlog                       | Decisão de janela (backlog Telegram não observável sem `getUpdates`)  |
| Bloqueado por identidade privada            | **RESOLVIDO** (`IDENTIDADE_CONFERE=true`)                             |
| Bloqueado por migração                      | NÃO (nenhuma pendente; schema igual, 5 aplicadas)                     |
| Bloqueado por configuração/permissões       | NÃO (metadados canônicos)                                             |
| **Pronto para janela controlada**           | **SIM**                                                               |

## 8. Comando exato proposto — **NÃO executado**

De `/opt/stakeframe`, como root, com o conjunto exato dos três arquivos:

```bash
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml \
  -f compose.integrations.yml \
  -f compose.operations.yml \
  start worker
```

## 9. Plano de interrupção imediata

O comando da contenção da STK-M0-41, execução única, preservando banco, volumes,
cursor e contêiner:

```bash
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml \
  -f compose.integrations.yml \
  -f compose.operations.yml \
  stop worker
```

## 10. Riscos externos ao reativar

- **Telegram**: consumo de updates novos (mensagem ao bot é processada,
  limitada à identidade autorizada; janela de retenção ≈24 h — o backlog deve
  ser tratado na janela, por decisão explícita).
- **R2**: gravação de anexos admitidos (credencial writer).
- **OpenRouter**: chamadas pagas dentro da cota configurada (60/dia,
  1.500/mês; teto declarado USD 5) — base em 0/0.
- **Sem monitor dedicado do consumidor** (limitação registrada na M0-41 §9).

## 11. Limitações

- Backlog do lado Telegram não verificado (excluído da autorização).
- Digest aprovado não conferido no host (não puxado).
- 1 linha histórica em `event_search` (`complete`) sem pendência associada.

## 12. Confirmações

Zero mutações (nenhum `docker start/pull/stop`, nenhuma alteração de banco,
arquivos, Compose, firewall, DNS ou Cloudflare); zero segredos lidos
(apenas metadados e booleanos); sem `getUpdates`/`setWebhook`/mensagens;
sem chamadas OpenRouter. Documento sanitizado: sem IDs, IPs, hostname ou
conteúdo privado.

## 13. Consumação do preflight (2026-09-12/13)

O preflight foi **consumado com sucesso no nível de runtime**: a STK-M0-61
reativou o contêiner existente exatamente como proposto na §8 — execução
única do mesmo comando, imagem `sha256:cbe6b61a…` preservada, sem pull ou
recriação — e validou a operação: advisory lock presente, `/` e `/budget`
`ready`, filas **locais** estáveis, monitor `ready` após três ciclos e
notificação de recuperação do monitor externo entregue e confirmada uma única
vez. Classificação: **OPERACIONAL (runtime)**. Registro completo em
[M0-61-WORKER-REACTIVATION.md](M0-61-WORKER-REACTIVATION.md).

Limitações da §11: **não consumidas** a observação do backlog remoto do
Telegram (permaneceu não observado; `getUpdates` direto não executado) nem a
validação de reader/writer R2 com operação real (acompanhada no
[M0-CHECKLIST.md](M0-CHECKLIST.md)). A reativação **não substitui** um ensaio
funcional ponta a ponta do consumidor: nenhuma mensagem de teste foi enviada
e o fluxo de ingestão não foi exercitado nesta janela.
