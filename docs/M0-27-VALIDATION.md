# STK-M0-27 — Primeiro restore isolado (mutação D)

> **STATUS: execução única realizada; falha de pré-condição de ambiente antes do
> restore; produção ilesa; decisão retornada ao Codex.** Nenhum valor de secret,
> hash de secret, credencial, conteúdo de `deployment.env`, IP administrativo,
> caminho privado local ou dado restaurado aparece neste documento. Todo o
> acesso à VPS foi por SSH com host key previamente conhecida (nenhuma host key
> nova ou alterada aceita).

## 1. Autorização e escopo

- Autorização explícita do proprietário (Rhian) em 09/09/2026 para a mutação D:
  primeiro ensaio de restore isolado, conforme `docs/M0-26-PREFLIGHT.md` §7.
- Fora do escopo e **não executados**: mutação E, instalação/ativação de
  `stakeframe-restore.service`/`.timer`, deploy, migração, credenciais,
  firewall, DNS, OCI, SSH, containers de produção, checkout da VPS e proteções
  do GitHub.
- Registro: issue #82; branch `hermes/m0-27-first-isolated-restore`; base
  autorizada `29b66f63f2c3f14527732aef8f81ab58a95b8561`.

## 2. Base e checkout executado

- `main` autorizada: `29b66f63f2c3f14527732aef8f81ab58a95b8561`, com CI 5/5
  `completed/success` revalidada por API antes da execução.
- Checkout instalado na VPS: `/opt/stakeframe/.stakeframe-revision` =
  `d00717f383420753dace164bcefa489ca33af48d` (gate 7).
- Diff `d00717f..29b66f6`: dois documentos + `pnpm-workspace.yaml`/
  `pnpm-lock.yaml` (override dev-only do advisory `sharp`, PR #81); nenhum
  arquivo de `scripts/`, `apps/`, `infra/` ou `compose.*.yml`.
- Igualdade dos artefatos entre checkout instalado e `main` autorizada,
  confirmada por hash SHA-256 (prefixos de 16 caracteres; hashes integrais
  verificáveis no repositório):

| Artefato                                  | Prefixo do SHA-256 na VPS | Igual à `main` |
| ----------------------------------------- | ------------------------- | -------------- |
| `scripts/restore-rehearsal.mjs`           | `e39dc52ecf8480a0`        | sim            |
| `scripts/deployment-rehearsal.mjs`        | `2ce208d018553a0d`        | sim            |
| `compose.restore.yml`                     | `c09cfce31c5ae92b`        | sim            |
| `scripts/deployment/restore-config.mjs`   | `78503e621fb76a7a`        | sim            |
| `scripts/deployment/restore-capacity.mjs` | `e15ae23cd09511dc`        | sim            |
| `scripts/deployment/restore-status.mjs`   | `12de26c06ffb49ee`        | sim            |
| `scripts/recovery/r2.mjs`                 | `dd60c43407c412c0`        | sim            |
| `scripts/recovery/restore.sh`             | `d02f84376a6dd695`        | sim            |
| `scripts/recovery/common.sh`              | `3d9c654253114988`        | sim            |

## 3. Gates de preflight (14/14 aprovados)

| #   | Gate                           | Resultado                                                                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Host/arquitetura               | host `vnci110`, `aarch64` (esperados)                                                                               |
| 2   | Cinco containers de produção   | todos `running/healthy`                                                                                             |
| 3   | Baseline sanitizada            | IDs, `StartedAt`, `RestartCount`, `OOMKilled`, health registrados (seção 7)                                         |
| 4   | PostgreSQL sem restart em 24 h | `RestartCount=1` (da instalação), `StartedAt` há ~42 h                                                              |
| 5   | `backup.json`                  | `state=ready`, cutoff com idade de 2,4 min (< 1 h), ciclo concluído                                                 |
| 6   | Concorrência                   | zero processos de backup/prune/restore/manutenção                                                                   |
| 7   | Mutações A–C                   | credenciais presentes só por metadados; Node `v24.20.0`; Docker config `root:root 600`; revision igual a `d00717f…` |
| 8   | Hash dos artefatos             | 9/9 idênticos à `main` (seção 2)                                                                                    |
| 9   | Filesystem de dados            | 40 GiB livres, 17% de uso (≥ 10 GiB e ≤ 80%)                                                                        |
| 10  | Labels `io.stakeframe.restore` | zero recursos preexistentes                                                                                         |
| 11  | Systemd                        | zero units `stakeframe-restore.*` instaladas, habilitadas ou ativas                                                 |
| 12  | Diretórios de status           | `/var/lib/stakeframe` `root:root 755`; `operations-status` `opc:opc 700`                                            |
| 13  | Imagens/digests                | exatamente os digests revisados; nada substituído                                                                   |
| 14  | Autorização                    | registrada neste documento (seção 1)                                                                                |

Transparência de método: dois falso-positivos do **script de preflight local**
(match de substring no filtro do PostgreSQL e caminho inicial incorreto do
`backup.json`) foram corrigidos no próprio método de verificação antes da
aprovação — nenhum estado da VPS foi alterado em nenhum momento.

## 4. Execução (única)

Comando exato do runbook (§7 do PREFLIGHT), executado uma única vez:

```bash
sudo env RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery \
  /opt/stakeframe-tools/node/bin/node /opt/stakeframe/scripts/restore-rehearsal.mjs \
  /etc/stakeframe/deployment.env
```

- Início do shell: 10:35:36Z; fim: 10:35:39Z (duração total do shell ~3 s).
- `RUNNER_EXIT=1`; saída: `RESTORE_REHEARSAL_FAILED` (marcador do catch e
  marcador final).
- Identificador da execução: `stk-restore-b6f601c7…` (run id truncado).
- Vida útil do runner: 34 ms (10:35:40.523Z → 10:35:40.557Z no relatório
  privado) — nenhum container, volume ou rede chegou a ser criado (sondas
  durante e após a execução: zero recursos com o label).

## 5. Diagnóstico (somente leitura)

- Relatório privado (`/var/lib/stakeframe/restore-reports/`, `root:root 0600`):
  `status=failed`, `cleanup=passed`, sem nenhum indicador de restore
  (`countsVerified` etc. ausentes — o processo falhou antes da fase de
  restore). `restore-latest.json` publicado com o mesmo conteúdo sanitizado.
- Replicação fora do runner (o catch do runner não registra a exceção):
  todas as pré-condições do runner passam — argv/plataforma, lstat do env
  (`0600`), regexes de configuração (sem exibir valores), contexto Docker
  local (`unix:///var/run/docker.sock`) — exceto uma: o diretório-pai
  `/run/stakeframe-restore` está **AUSENTE**.
- Causa raiz: o runner cria o diretório de trabalho por execução com `mkdir`
  **não-recursivo** em `/run/stakeframe-restore/<project>`
  (`scripts/restore-rehearsal.mjs:95`). Esse diretório-pai é provisionado
  exclusivamente pelo `RuntimeDirectory=stakeframe-restore` do unit
  `stakeframe-restore.service` — componente da **mutação E**, não instalada
  (verificação do gate 11). `/run` é tmpfs e a VPS tem uptime de semanas, o
  que exclui perda por reboot.
- Consistência temporal: startup + import do runner ≈ 48 ms; dois spawns do
  Docker CLI ≈ 37 ms medidos. Os 34 ms registrados são incompatíveis com
  qualquer spawn de Docker e compatíveis com falha imediata de sistema de
  arquivos. A localização exata dentro do `try` é inferida por eliminação
  (o catch do runner não registra a exceção — limitação da seção 9).
- Gap de runbook: a janela D (`docs/M0-26-PREFLIGHT.md` §7) não prevê
  provisionamento prévio de `/run/stakeframe-restore` para execução manual.

## 6. Decisão de governança

- Criar `/run/stakeframe-restore` manualmente seria uma mutação adicional não
  prevista nem no comando executado nem na autorização daquela execução — por
  isso, corretamente recusada ("não altere produção para tentar fazer o
  ensaio passar"). Um diretório efêmero em `/run`, isoladamente, não instala
  o `stakeframe-restore.service` nem o `stakeframe-restore.timer` da mutação
  E, que permanecem não autorizados. Nada foi criado.
- Conforme §5 da autorização: não houve repetição automática; a evidência
  privada foi preservada; o cleanup do `finally` do runner executou
  (`cleanup=passed`); o inventário de resíduos por label/run id resultou em
  zero recursos (seção 8).
- Retorno ao Codex com as opções identificadas (nenhuma executada):
  1. provisionar o diretório na janela D com comando efêmero documentado
     (`0700`, remoção pós-execução), atualizando o runbook;
  2. executar o ensaio via unit `stakeframe-restore.service` (mutação E, sob
     autorização própria);
  3. ajustar o runner para `mkdir` recursivo do diretório-pai (mudança de
     código revisada).

  Decisão do Codex (09/09/2026): correção no runner em PR separada — preparar
  o diretório de forma segura (diretório real, sem symlink, `root:root`,
  `0700`, diretório da execução exclusivo, testes sem `RuntimeDirectory`,
  exceção registrada no relatório sanitizado), sem instalar service ou timer.
  A nova execução da mutação D dependerá dessa correção revisada e de nova
  autorização operacional.

  Encaminhamento (STK-M0-28): a correção do runner foi implementada e
  encaminhada na PR de código dedicada (branch
  `hermes/m0-28-restore-runtime-root`). O runner passa a criar o runtime root
  `/run/stakeframe-restore` quando ausente (`0700`, `root:root`), recusar
  arquivo, symlink, proprietário/grupo divergentes ou permissões mais amplas,
  aceitar um diretório preexistente somente com `realpath` exato e só remover
  o runtime root criado pela própria execução; o comando manual documentado
  passou a incluir `DOCKER_CONFIG=/etc/stakeframe/docker`. Este registro não
  altera o resultado da mutação D: ela permanece pendente e a execução
  retratada neste documento continua sendo a única tentativa.

## 7. Baseline antes/depois (sanitizada)

| Container                            | ID (prefixo)   | `StartedAt` (UTC)    | `RestartCount` | `OOMKilled` | Health  |
| ------------------------------------ | -------------- | -------------------- | -------------- | ----------- | ------- |
| `stakeframe-production-web-1`        | `79b0ac5df767` | 2026-09-07T19:58:49Z | 0              | false       | healthy |
| `stakeframe-production-operations-1` | `f74bb7898aef` | 2026-09-07T19:09:53Z | 0              | false       | healthy |
| `stakeframe-production-worker-1`     | `d5256f310f71` | 2026-09-07T19:09:53Z | 0              | false       | healthy |
| `stakeframe-production-api-1`        | `029092033e01` | 2026-09-07T19:09:53Z | 0              | false       | healthy |
| `stakeframe-production-postgres-1`   | `82b4db600030` | 2026-09-07T15:35:23Z | 1              | false       | healthy |

Comparação mecânica antes/depois da execução: **idênticos em todos os campos**
(diff vazio contra o snapshot de baseline).

## 8. Pós-execução e resíduos

- `backup.json`: `state=ready` (ciclo de produção saudável).
- Zero recursos com o label `io.stakeframe.restore` (containers, volumes e
  redes); zero diretórios em `/run/stakeframe-restore`; zero containers
  `stk-restore-*`.
- Disco estável em 40 GiB livres / 17% durante e após a execução.
- Nenhuma porta publicada e nenhuma conexão com redes de produção em
  qualquer momento (nenhum recurso chegou a existir).

## 9. Limitações

1. O catch do runner não registra a exceção — o diagnóstico exato da linha de
   falha é inferido por replicação fora do runner e consistência temporal
   (seção 5), não por stack trace.
2. O runbook da janela D não prevê o pré-requisito do diretório-pai
   (`RuntimeDirectory` do unit E); a decisão de correção pertence ao Codex
   (seção 6).
3. O objetivo da mutação D (validar o restore de ponta a ponta) **não foi
   alcançado nesta execução**; nenhum critério de sucesso da seção 4 da
   autorização foi satisfeito, exceto os de segurança (produção ilesa,
   cleanup íntegro, zero resíduos, zero mutação E).

## 10. Confirmações de sanitização

- Nenhum secret, hash de secret, credencial, valor de `deployment.env`, IP
  administrativo, caminho privado local ou dado restaurado neste documento.
- Hashes de artefatos truncados a 16 caracteres; IDs de container a 12;
  run id a 8. O relatório bruto permanece apenas em armazenamento privado na
  VPS (`/var/lib/stakeframe/restore-reports/`, `root:root 0600`).

## 11. Referência ao novo resultado (STK-M0-29)

O objetivo desta primeira execução (mutação D — validar o restore isolado de
ponta a ponta) foi alcançado na execução única autorizada pela STK-M0-29, após
a correção M0-28 (PR #84): `RESTORE_REHEARSAL_PASSED`, `RUNNER_EXIT=0`,
`status=passed` com `cleanup=passed` e todos os critérios da autorização
satisfeitos. Evidência completa em
[docs/M0-29-VALIDATION.md](docs/M0-29-VALIDATION.md). As seções anteriores
deste documento permanecem sem reescrita.
