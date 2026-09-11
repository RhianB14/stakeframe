# STK-M0-41 — Contenção do consumidor Telegram (worker parado)

Data: 2026-09-11. Base: `142b2d5c30166697f5360674e2cb90798c84452a`.
Issue: [#102](https://github.com/RhianB14/stakeframe/issues/102). Branch:
`hermes/m0-41-telegram-worker-containment`. Execução pelo Hermes; PR desta
tarefa vinculada à issue.

## 1. Autorização retransmitida pelo proprietário

A autorização do Codex para a contenção foi retransmitida pelo proprietário
por meio do prompt da STK-M0-41 (registro conforme a regra 8 do
[AGENTS.md](../AGENTS.md): aprovação retransmitida é identificada como tal).
Escopo coberto:

1. consultas sanitizadas e somente leitura do preflight;
2. parada **somente** do contêiner `worker`, uma única vez, com o conjunto
   exato de arquivos Compose (`compose.production.yml`,
   `compose.integrations.yml`, `compose.operations.yml`);
3. verificações sanitizadas posteriores;
4. documentação e operações Git/GitHub desta tarefa.

**Nenhuma reativação foi autorizada.** Merge, deploy, migração e rollback não
autorizados.

## 2. Base e revisão de produção

- `origin/main` conferido antes de qualquer operação:
  `142b2d5c30166697f5360674e2cb90798c84452a` — exatamente a base esperada.
- Revisão de produção observada no M0-40 (leitura de 11/09/2026 16:47Z):
  `36c0e638…` (STK-M0-28). Nesta tarefa não houve deploy, migração ou pull:
  imagens e revisão permanecem as mesmas.

## 3. Horários (UTC)

| Fase                           | Horário             |
| ------------------------------ | ------------------- |
| Preflight (leitura)            | 2026-09-11 17:42:34 |
| Pinning do worker (label)      | 2026-09-11 17:42:55 |
| Parada (comando único)         | 2026-09-11 17:43:02 |
| Conclusão da parada            | 2026-09-11 17:43:03 |
| Primeira verificação posterior | 2026-09-11 17:43:09 |
| Reverificação (sem restart)    | 2026-09-11 17:43:34 |
| Reverificação final            | 2026-09-11 17:44:09 |

## 4. Preflight sanitizado (somente leitura)

Todos os critérios de fail-closed foram satisfeitos antes da parada:

- cinco contêineres esperados `running`/`healthy` (api, worker, web, operações
  e PostgreSQL), `container_count=5`;
- `pgboss.job`: nenhum job em qualquer estado (portanto nenhum em `created`,
  `retry` ou `active`); `integration.inbox`: 0 linhas e nenhum `processing`;
  `integration.extraction_request`: 0; `integration.attachment`: 0;
- advisory lock `782341094` presente (`consumer_lock_present=1`;
  `advisory_locks_total=1`), comprovando o consumidor em execução;
- cursor Telegram: linha presente, valor `nonzero` (a preservar);
- `integration.ai_usage_day`: 0 linhas / 0 requisições;
- arquivos Compose presentes em `/opt/stakeframe/`; o `worker` foi criado com
  o conjunto exato dos três arquivos (label
  `com.docker.compose.project.config_files`), projeto
  `stakeframe-production`, `working_dir=/opt/stakeframe`, reinício
  `unless-stopped`;
- identidade do host verificada por SSH
  (`StrictHostKeyChecking=yes` contra `known_hosts`);
- logs do worker (24 h): código `WORKER_READY` (1 ocorrência), sem códigos de
  falha.

Nenhum segredo, conteúdo de mensagem ou identificador privado foi lido.

## 5. Comando exato executado (única mutação)

Executado de `/opt/stakeframe` (diretório de trabalho da criação), como root,
via SSH com identidade de host verificada — **uma única vez, sem retry**:

```bash
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml \
  -f compose.integrations.yml \
  -f compose.operations.yml \
  stop worker
```

Resultado:

- `Container stakeframe-production-worker-1 Stopping` → `Stopped`;
- `stop_exit_code=0`;
- os demais quatro contêineres permaneceram intactos no mesmo instante.

## 6. Verificações posteriores (sanitizadas)

1. `worker` em `exited` (código de saída 0); `worker_still_exited=yes` na
   reverificação de 17:44:09Z, sem reinício automático;
2. advisory lock `782341094` **ausente** (`consumer_lock_present=0`;
   `advisory_locks_total=0`) — o consumo cessou;
3. api, web, PostgreSQL e operações seguem `running`/`healthy`;
4. backup externo ativo: contêiner de operações `healthy`, com
   `OPS_BACKUP_VERIFIED` recorrente (53 ocorrências em 26 h) e 1 timer
   `stakeframe*` ativo;
5. nenhuma linha nova em `integration.inbox` (0 antes e 0 depois);
6. nenhuma linha nova em `integration.ai_usage_day` (0 linhas / 0 requisições
   antes e depois);
7. cursor Telegram preservado (linha presente, `nonzero`);
8. contêiner, volumes, redes, segredos e configuração preservados: o
   contêiner existe parado, com 7 mounts e as redes `backend` e
   `provider-egress` intactas; nenhum arquivo foi removido ou alterado;
9. a parada manual é respeitada pelo `restart: unless-stopped`, verificado por
   ~1 minuto de observação sem reinício. O host **não** foi reiniciado e não
   será reiniciado como parte desta tarefa.

Observação: o estado de health do contêiner parado permanece com o último
valor registrado antes da parada (o processo de readiness foi encerrado) —
sem significado operacional após o desligamento.

## 7. Efeitos colaterais aceitos

A parada do `worker` suspende, junto, as demais tarefas do mesmo contêiner:
consumidor da fila de probe, dispatcher de extração, unidades mensais,
verificador de anexos e busca de eventos. O consumidor Telegram — objetivo da
contenção — está parado. Nenhum dado, segredo, volume ou configuração foi
removido.

## 8. Reversão (plano NÃO autorizado)

A reversão é `docker compose … start worker` (mesmo conjunto de arquivos),
**somente** em reativação autorizada separada, após as pré-checagens da §9.
Esta tarefa **não** reativa o worker.

## 9. Limitações e pendências para reativação

- A conferência privada dos valores de identidade contra a identidade
  autorizada na STK-M0-15 segue pendente (gate 5 do M0-40, PARCIAL) e é
  pré-requisito da reativação.
- O backlog do lado Telegram não foi observado (sem `getUpdates`); a decisão
  deve ocorrer na janela de reativação, por procedimento privado.
- R2 (bucket/credenciais) e política de IA (cota/custo) devem ser conferidos
  na janela de reativação.
- Não existe monitoramento específico do consumidor parado. O Worker de
  monitoramento externo foi ativado na STK-M0-37, mas sua execução
  operacional, alerta e recuperação continuam **sem validação** (STK-M0-38);
  portanto ele **não** deve ser apresentado como cobertura operacional
  comprovada.

## 10. Confirmações

- Nenhum segredo foi lido, impresso, criado ou alterado.
- Nenhum `getUpdates`/`setWebhook`; nenhuma mensagem Telegram; nenhuma chamada
  OpenRouter.
- Nenhuma remoção: contêiner, volumes, redes, segredos e dados preservados.
- O `worker` **não** foi reativado; nenhum deploy, migração, release ou
  rollback; firewall, DNS e Cloudflare intocados.
- Documento sanitizado: sem identificadores privados, IPs adicionais,
  hostname ou conteúdo de mensagens.
