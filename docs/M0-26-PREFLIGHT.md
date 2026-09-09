# STK-M0-26A — Preflight da primeira restauração isolada

> **STATUS: preflight + mutações B, C e C2 registradas; mutação D pendente —
> a primeira tentativa autorizada (STK-M0-27) falhou antes da criação dos
> recursos de restore; nova execução exige correção revisada e nova
> autorização operacional, ver `docs/M0-27-VALIDATION.md`.** Nenhum segredo, valor de
> credencial ou dado financeiro aparece neste documento. A inspeção original da
> VPS e do Restic/R2 foi SOMENTE LEITURA (sem lock, sem
> `prune/forget/unlock/backup/restore/upload`). A credencial lógica
> `stakeframe-backups-reader-prod` já havia satisfeito a mutação A na
> STK-M0-21; a mutação B foi executada na STK-M0-26B sob autorização própria,
> com evidência sanitizada em `docs/M0-26B-VALIDATION.md`; a mutação C foi
> executada na STK-M0-26C sob autorização própria, com evidência sanitizada em
> `docs/M0-26C-VALIDATION.md` (Node instalado, permissões corrigidas e Docker
> config privado validados; a troca do checkout foi revertida pelo rollback
> prescrito após divergência de EOL no bind do PostgreSQL); a conclusão do
> checkout foi executada na STK-M0-26C2 sob autorização própria, com evidência
> sanitizada em `docs/M0-26C2-VALIDATION.md`. As mutações D e E continuam
> pendentes de autorização própria.

Base da análise original: `main` @ `ea17414fc44353fa62707e3b5567b43319a3d2a3`
(branch histórica `codex/m0-26-restore-preflight`, issue #71). Estado
reconciliado na `main` @ `0f3fd75a5ce049bebf7648cb72e38396e4f34731` pela
STK-M0-26B (issue #75).

## 1. Revalidação dos docs e artefatos

- `docs/OPERATIONS.md` (218 linhas) descreve `compose.restore.yml`, o runner
  `scripts/restore-rehearsal.mjs`, os units systemd `stakeframe-restore.*`, os
  limites de disco (10 GiB / 20% para iniciar; aborta abaixo de 5 GiB / 10%),
  os relatórios privados e o gate de confirmação — tudo verificado abaixo,
  com exceção de um gap corrigido nesta branch (seção 4, linha (a)).
- `docs/RECOVERY.md` (107 linhas): estratégia D009, RPO 1 h, RTO 4 h, critérios
  de aceite (restauração integral, alerta de atraso, timer mensal documentado)
  continuam abertos e coerentes com o que o código entrega hoje: o ensaio
  valida banco + metadados + anexos em cluster novo, não o failover integral.
- `docs/RECOVERY-DRILL.md` e `docs/R2.md`: coerentes com o inventário (seção
  3): bucket `stakeframe-v1` no repositório Restic, snapshots a cada ~30 min.
- Artefatos da main: os 9 arquivos de restore/rehearsal existem em `ea17414`
  e os SHA-256 estão na seção 6. Nenhum arquivo do pacote estava faltando.

## 2. Inventário VPS (129.146.113.111, leitura em 2026-09-08)

- Host: `vnci110`, Ubuntu (arm64), uptime 8 d 16 h, carga 0.09/0.15/0.11.
  RAM 11 927 MiB total, 10 959 MiB disponível. Disco `/` (raiz do Docker,
  `/var/lib/docker`): 48 GB, 7.9 GB usados, 40 GB livres (17% usados,
  aproximadamente 83% livres) — passa o gate de início do runner (10 GiB / 20%).
- Relógio: NTP ativo e sincronizado.
- Containers (todos os 5 `running` + `healthy`;RestartCount/ExitCode abaixo):

  | Container                          | Estado            | RestartCount | ExitCode | OOMKilled |
  | ---------------------------------- | ----------------- | ------------ | -------- | --------- |
  | stakeframe-production-postgres-1   | Up 24 h (healthy) | 1            | 0        | false     |
  | stakeframe-production-api-1        | Up 20 h (healthy) | 0            | 0        | false     |
  | stakeframe-production-worker-1     | Up 20 h (healthy) | 0            | 0        | false     |
  | stakeframe-production-operations-1 |
  | (imagem `sha256:ae3cbab6…`)        | Up 20 h (healthy) | 0            | 0        | false     |
  | stakeframe-production-web-1        | Up 19 h (healthy) | 0            | 0        | false     |

  O RestartCount=1 do postgres é HISTÓRICO do deploy de 07/09
  (FinishedAt 15:35:23.599Z < StartedAt 15:35:23.738Z, ExitCode 0, sem OOM):
  não é falha nova. A partir de 07/09 19:09 nenhum container reiniciou.

- Última linha de log do operations: `OPS_BACKUP_VERIFIED` (presente,
  repetida a cada ciclo).
- `/var/lib/stakeframe/operations-status/backup.json` (lido com sudo, sem
  valores sensíveis): `state=ready`, `cutoff=2026-09-08T15:00:02.309Z`,
  `completedAt=15:00:15.744Z`, `snapshot=4dca3fa7…d8a` (coincide com o
  snapshot mais recente do Restic), `imageCount=0`, `imageBytes=0`,
  `retention=true`. Nenhum `restore-latest.json` presente ainda (esperado:
  nenhum ensaio rodou).
- Diretório de segredos `/etc/stakeframe/secrets`: `root:root 0700`. Os 16
  arquivos esperados, com dono/modo (apenas metadados, nunca conteúdo):
  | Arquivo                                                           | Owner       | Mode |
  | ----------------------------------------------------------------- | ----------- | ---- |
  | auth_secret, db_password, google_client_secret, monitor_token,    |
  | openrouter_api_key, r2_backup_access_key, r2_backup_secret_key,   |
  | r2_reader_access_key, r2_reader_secret_key, r2_writer_access_key, |
  | r2_writer_secret_key, recovery_key, telegram_bot_token,           |
  | telegram_owner_chat_id, telegram_owner_user_id (15 arquivos)      | `opc:opc`   |
  | 0640                                                              |
  | postgres_password                                                 | `root:root` | 0600 |
- Ausências esperadas confirmadas (nenhum componente de restore instalado):
  `/opt/stakeframe-tools/node/bin/node` AUSENTE,
  `/etc/stakeframe/docker` AUSENTE, `/var/lib/stakeframe/restore-reports`
  AUSENTE, units `stakeframe-restore.service`/`.timer` AUSENTES.
- Redes Docker de produção: `stakeframe-production_{auth-egress,backend,
backup-egress,frontend,provider-egress}`. Volumes: `_caddy-config`,
  `_caddy-data`, `_database`, `_operations-status`. Nenhuma rede/volume de
  restore existe; o ensaio criará os seus próprios, com labels
  `io.stakeframe.restore`.
- Redis, filas ou outros componentes: não existem nesta pilha (postgres, api,
  worker, operations, web + Caddy). Nada além do inventariado precisa ser
  conferido para o restore isolado.

## 3. Inventário Restic/R2 (somente leitura, `--no-lock`)

- Repositório: `s3:https://<account>.r2.cloudflarestorage.com/<bucket>/
stakeframe-v1` (conta/bucket vindos das envs do container `operations`;
  valores NÃO impressos). Comandos executados com credenciais de backup
  existentes, dentro do container, sem ecoar variáveis.
- **44 snapshots**, todos `host=stakeframe-production`, `paths=['/work/bundle']`,
  tag `stakeframe-bundle-v1` + `complete` + `cycle-<uuid>`.
- Mais recente: `4dca3fa7f9194c0616323fc4f2f90aad3ac8c2abb45fb5fe12c0c51c2b2e0d8a`
  em 2026-09-08T15:00:02.600Z (idade 0,4 h na leitura; 25 min após o cutoff
  do backup.json — consistente com o ciclo de 30 min).
- Conteúdo do snapshot mais recente (`restic ls`): `manifest.json`,
  `roles.json`, `permissions.json`, `attachments.json`, `database.dump` e o
  diretório `attachments/` vazio — coerente com `imageCount=0` (nenhum
  anexo real ainda; o dump PostgreSQL e o manifesto ESTÃO presentes).
- Stats agregados (`stats --mode raw-data --json`): 44 snapshots,
  ~0,9 MB de blobs únicos (corpus fictício pequeno).
- Nenhuma operação de escrita, reparo ou lock foi executada.

## 4. Matriz de garantias (a)–(h) — evidência arquivo:linha na main ea17414

| Garantia                                               | Evidência                                                                                                                                                                                                                                                                                                                                                                              | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) PostgreSQL e volumes NOVOS (sem reuso de produção) | `compose.restore.yml:13,56-70` (volume `restore-database` + redes/volumes por-run com labels), `restore-rehearsal.mjs:23,95-103` (project único `stk-restore-<uuid>`, segredos efêmeros gerados por run), `restore.mjs:37-42,62-63` (host fixo `restore-postgres`, recusa banco ocupado), `restore-config.mjs:18-22`                                                                   | **GAP CORRIGIDO nesta branch** (`4293561`): `assertRestoreConfig` não validava os mounts do `restore-postgres`, então um compose que apontasse o banco isolado a um volume de PRODUÇÃO passaria no gate. Correção em `scripts/deployment/restore-config.mjs:23-41`: só permite volume `restore-database` + bind read-only de `init-app-role.sh`; rejeita reuso de produção, binds extras e bind gravável (testado — matriz na seção 5). |
| (b) não entra na rede nem no banco de produção         | `compose.restore.yml:11,37,56-58` (rede `restore-private` `internal: true`; postgres só nela), `restore-config.mjs:6-11,19,24` (valida `internal: true`, redes exatas), `restore.mjs:37-41` (connection string reescrita para `restore-postgres`, falha se não mudar)                                                                                                                  | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| (c) não publica portas                                 | `compose.restore.yml` (sem `ports:`), `restore-config.mjs:14` (`service.ports === undefined`)                                                                                                                                                                                                                                                                                          | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| (d) usa credencial R2 somente leitura                  | `compose.restore.yml:47-48,78-81` (secrets `r2_backup_restore_access_key`/`_secret_key` — nomes distintos dos de produção `r2_backup_access_key`), `restore-config.mjs:35-42` (valida os arquivos de secret exatos), `backup.mjs:20-26` (`BACKUP_READ_ONLY=true` restringe restic a `snapshots                                                                                         | dump                                                                                                                                                                                                                                                                                                                                                                                                                                    | check`+`--no-lock`), `config.mjs:51` | OK — a credencial existente `stakeframe-backups-reader-prod` atende a mutação A (STK-M0-21) e seus dois valores foram instalados nos secrets de restore pela mutação B (STK-M0-26B); nenhum token novo foi criado. |
| (e) valida labels ANTES do cleanup                     | `restore-rehearsal.mjs:37-61` (`owned()` inspeciona cada recurso e assegura `com.docker.compose.project` + `io.stakeframe.restore` ANTES do `finally`), `190-201` (cleanup só remove recursos com os labels; assegura zero após down)                                                                                                                                                  | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| (f) falha se cleanup/manifesto/ACLs/espaço divergirem  | cleanup: `restore-rehearsal.mjs:196-201,211-215`; manifesto: `restore.mjs:80-97` (versão, ciclo, serverVersion 18.x, cutoff, checksums SHA-256 de dump+metadados); ACLs/permissões: `restore.mjs:139-144` (roles + permissions comparadas pós-restore); espaço: `restore-capacity.mjs:1-5` + `restore-rehearsal.mjs:134-143` (gate inicial 10 GiB/20%, monitor 5 s, aborta <5 GiB/10%) | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| (g) integrações em quarentena                          | `restore.mjs:178-193` (cursor `recovery-quarantine`, inbox/search incertos → `failed` com `*_OUTCOME_UNCERTAIN`, `extraction_request` esvaziada, sessões/verificações revogadas, tokens nulos), retomada só com `RESTORE_CONFIRM=reviewed-recovery-and-telegram-backlog` (`server.mjs:49-56`)                                                                                          | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| (h) relatório privado e restore-latest.json atômicos   | `restore-rehearsal.mjs:216-237` (relatório 0600 `wx` em `/var/lib/stakeframe/restore-reports`, persiste também em falha), `restore-status.mjs:8-27` (diretório conferido uid/gid 1000, 0700, sem symlink; tmp `wx` 0600 + `rename()` atômico; unlink em falha)                                                                                                                         | OK                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Linha de evidência corrigida: na main, `restore-config.mjs` tinha 59 linhas;
a versão corrigida nesta branch tem 78.

## 5. Testes locais (dados fictícios, sem segredos reais)

Ambiente local: Windows 11, bash/MSYS, Node v22.23.2 (engines do repo pedem

> =24.20 <25 — o pnpm só emite WARN e todas as fases passaram; a VPS alvo terá
> Node 24.20.0 exato). `pnpm install` OK (431 s). Resultados REAIS:

| Teste                                                                                                               | Resultado                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run lint` (eslint .)                                                                                          | exit 0                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm run typecheck` (tsc -b + tsconfig.tests.json)                                                                 | exit 0 (rodado pré e pós-fix)                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test` (vitest)                                                                                                | **121 testes / 11 arquivos passaram** (pré-fix); re-run pós-fix: passou (duração 7,7 s)                                                                                                                                                                                                                                                                             |
| `pnpm run operations:test` (node --test tests/operations)                                                           | 10 testes, 0 falhas (pós-fix)                                                                                                                                                                                                                                                                                                                                       |
| `pnpm run recovery:test-safety`                                                                                     | 0 falhas (1 skipped)                                                                                                                                                                                                                                                                                                                                                |
| `scripts/restore-rehearsal.mjs` com fixture falsa (`RESTIC_PASSWORD=dummy`, repo local em `$LOCALAPPDATA/Temp`)     | Falha esperada e observada no Windows (`process.platform` !== linux, sem daemon Docker linux); imprimiu `RESTORE_REHEARSAL_FAILED` e exit 1 — comportamento correto fora do host alvo                                                                                                                                                                               |
| `scripts/deployment/restore-config.mjs` — matriz de 15 mutações (arquivo `.cache/m026-config-matrix.mjs` na branch) | 1 config válida aceita; **14/14 mutações rejeitadas**: rede não-interna, portas publicadas, chaves R2 de produção, reuso de volume de produção (antes do fix passava — gap), postgres na rede egress, token de confirmação errado, override de repositório, label ausente, volume externo, reuso no postgres, bind gravável, volume ausente, bind extra de produção |
| `scripts/deployment/restore-capacity.mjs`                                                                           | import direto: 30 GiB livres/100 GiB → `true`; 5 GiB → `false` (gate inicial correto)                                                                                                                                                                                                                                                                               |
| `scripts/deployment/restore-config.mjs` — bind com caminho Windows (backslash)                                      | aceito (robusto a SEPs)                                                                                                                                                                                                                                                                                                                                             |

O runner completo em host Linux só é exercido na janela D (seção 7); o
`pnpm operations:rehearse`/`deployment:rehearse` cobrem o fluxo com Docker
real e rodam na CI desta PR.

## 6. Pacote de instalação e próximas janelas (B concluída; C pendente)

### 6.1 Credencial R2 somente leitura — mutação A concluída, B executada

- A credencial lógica existente `stakeframe-backups-reader-prod` foi criada e
  validada na STK-M0-21. Ela tem **Object Read only**, é restrita ao bucket
  `stakeframe-backups` e permite leitura e listagem de objetos, sem escrita,
  exclusão ou administração.
- A mutação A não será repetida: nenhum token novo foi criado nesta execução.
- A mutação B instalou os dois secrets abaixo na VPS, conforme a validação
  sanitizada em `docs/M0-26B-VALIDATION.md`:
  - `/etc/stakeframe/secrets/r2_backup_restore_access_key`
  - `/etc/stakeframe/secrets/r2_backup_restore_secret_key`
- Os destinos são arquivos regulares, sem symlink, `root:opc 0640`, com
  tamanhos normalizados 32 e 64; ambos tiveram `MATCH=true`. Os 16 secrets
  anteriores permaneceram inalterados e os cinco containers permaneceram
  `running/healthy`, com RestartCount inalterado.
- A credencial de leitura deve permitir `restic snapshots/dump/check` sem
  lock de escrita; se um `prune` concorrente causar erro de leitura, o ensaio
  falha com segurança e deve ser repetido após o ciclo (OPERATIONS.md:139-142).

### 6.2 Node 24.20.0 linux-arm64 (mutação C)

- URL oficial: `https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-arm64.tar.xz`
- SHA-256 (SHASUMS256.txt oficial, conferido por download real do tarball em
  2026-09-08): `5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7`
  — o hash calculado do arquivo baixado (`sha256sum`) é IDÊNTICO ao publicado
  no SHASUMS256.txt oficial. Repetir a conferência na instalação.
- Instalar em `/opt/stakeframe-tools/node/` de modo que exista
  `/opt/stakeframe-tools/node/bin/node` (o unit `stakeframe-restore.service`
  chama esse caminho exato).

### 6.3 SHA-256 dos artefatos aprovados (main `ea17414`, blob = conteúdo git)

| Arquivo                                     | SHA-256 do blob na main                                            | SHA-256 do blob na PR (4293561)                                                      |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| infra/production/stakeframe-restore.service | `6dc2e66f48305e959410c22d6b6015e2ff95ca9e1a84fae934ba668ccfdefcc2` | igual à main                                                                         |
| infra/production/stakeframe-restore.timer   | `8759cf4897b7ec5a81df18745406d320aa0abd96da0e3da5b335b3ea570f6fbd` | igual à main                                                                         |
| compose.restore.yml                         | `c09cfce31c5ae92bf3abb08c44630843c3ed6ff60f2870433ca9405f0ac62412` | igual à main                                                                         |
| scripts/restore-rehearsal.mjs               | `e39dc52ecf8480a06e559067cc617bfb66b24ff71749b4f805158159bce34ee6` | igual à main                                                                         |
| apps/ops/src/restore.mjs                    | `5b744a8a7be5b53850850a5966576076f46140a1c860a1a8332d04937b17f370` | igual à main                                                                         |
| scripts/deployment/restore-config.mjs       | `bb798228a8c252a1cf2beae785a873a048c828eae5dfa944cdb1b086e1c41a8f` | **`3c7829aa4b40ce1d843f9b278acd396e7a4234e2ab59a913471228fc7f129f4d`** (fix 4293561) |
| scripts/deployment/restore-capacity.mjs     | `e15ae23cd09511dc225a263d4421a3c5d05d6b1cd277262e316680473c21bb14` | igual à main                                                                         |
| scripts/deployment/restore-status.mjs       | `12de26c06ffb49ee33cf0940e356016fc1d171e5ccded498824819abe4317565` | igual à main                                                                         |
| scripts/recovery/restore.sh                 | `d02f84376a6dd69552d4eee296e2c50c0a0775c1c9935278d9a2b3570baa04a6` | igual à main                                                                         |

Nota: no worktree Windows com `core.autocrlf=true` os arquivos em disco têm
CRLF; a main tem LF. Hashes em disco (pós `tr -d '\r'`) conferem com os blobs
git — o conteúdo aprovado é o mesmo; instalar na VPS a partir do checkout git
(LF), não de cópia do disco Windows.

### 6.4 Layout de diretórios futuros (mutação C)

- `/opt/stakeframe-tools/node/bin/node` — binário Node 24.20.0 (tarball
  oficial, hash conferido). Diretório raiz sugerido `root:root 0755`.
- `/opt/stakeframe` — checkout revisado (mesma revisão da PR aprovada),
  `root:root`, `0755`, arquivos não graváveis pelo serviço.
- `/etc/stakeframe/docker` — `config.json` do Docker privado para o serviço
  (`DOCKER_CONFIG` no unit), `root:root 0700`.
- `/etc/stakeframe/deployment.env` — já existente (citado pelo unit),
  conferir que `OPERATIONS_IMAGE`, `DEPLOYMENT_ID`, `R2_BACKUP_ACCOUNT_ID`,
  `R2_BACKUP_BUCKET` e `SECRET_DIRECTORY` batem com a produção.
- `/var/lib/stakeframe/restore-reports` — criado pelo unit
  (`StateDirectory=stakeframe/restore-reports`, 0700) e pelo runner
  (`mkdir mode 0700`); relatórios `*.json` 0600.
- `/run/stakeframe-restore` — `RuntimeDirectory` (0700) no unit, efêmero.
  Na execução manual (sem `RuntimeDirectory`), o runner cria o diretório
  (`0700`, `root:root`), valida diretório real, sem symlink, `realpath` exato,
  proprietário `root:root` e modo exatamente `0700`, e só remove o runtime
  root que ele mesmo criou nesta execução — um diretório preexistente é
  preservado.
- Novos secrets (mutação B): `r2_backup_restore_access_key`,
  `r2_backup_restore_secret_key` em `/etc/stakeframe/secrets/`, `root:opc 0640`
  (owner root deliberado; grupo opc e modo 0640), além de `postgres_password`/`db_password` EFÊMEROS
  gerados por run em `/run/stakeframe-restore/<project>/` (0700, arquivos 0444) — nunca persistidos.

## 7. Janela D — comandos exatos do primeiro restore isolado

Pré-condições (gates pré-execução, TODOS obrigatórios):

1. Mutações A/B/C concluídas e conferidas (credencial R2 leitura instalada,
   Node instalado, checkout revisado em `/opt/stakeframe`, Docker config em
   `/etc/stakeframe/docker`).
2. `docker inspect stakeframe-production-postgres-1` sem reinício nas últimas
   24 h e `backup.json` com `state=ready`, cutoff < 1 h.
3. Disco: `df /var/lib/docker` ≥ 10 GiB e ≥ 20% livres (o runner também
   recusa iniciar abaixo disso; e aborta < 5 GiB / 10% durante a execução).
4. Autorização explícita do proprietário para a janela D registrada (a PR
   merged NÃO autoriza execução).
5. Nenhuma outra janela de manutenção/backup concorrente prevista (uma poda
   concorrente pode interromper a leitura — repetir depois do ciclo).

Execução (todos os comandos como root no host da VPS):

```bash
# 1. (opcional, diagnóstico) Estado antes:
systemctl list-timers 'stakeframe-restore*'

# 2. Primeira execução manual, sem esperar o timer:
sudo env \
  RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery \
  DOCKER_CONFIG=/etc/stakeframe/docker \
  /opt/stakeframe-tools/node/bin/node \
  /opt/stakeframe/scripts/restore-rehearsal.mjs \
  /etc/stakeframe/deployment.env

# 3. Verificações pós-execução:
sudo cat /var/lib/stakeframe/operations-status/restore-latest.json
sudo ls -la /var/lib/stakeframe/restore-reports/
journalctl -u stakeframe-restore.service --since -1h   # se via unit
```

Critérios de sucesso: saída `RESTORE_REHEARSAL_PASSED`,
`restore-latest.json` com `status=passed`, `countsVerified`,
`financeVerified`, `rolesVerified`, `permissionsVerified`, `importsPaused`,
`sessionsRevoked` = true e `cleanup=passed`; zero recursos com label
`io.stakeframe.restore` remanescentes
(`docker ps -a`, `docker volume ls`, `docker network ls` filtrando pelo label).

Critérios de interrupção/abort (qualquer um → abortar e investigar):

- `RESTORE_REHEARSAL_FAILED` ou exit != 0; `cleanup=failed` no relatório;
- disco abaixo de 5 GiB ou 10% livres durante a execução (o runner aborta
  sozinho — não intervir manualmente nos containers de produção);
- `OPS_RESTORE_TARGET_OCCUPIED`, `OPS_BACKUP_CHECKSUM_FAILED`,
  `OPS_RESTORE_COUNT_MISMATCH`, `OPS_RESTORE_FINANCE_MISMATCH`,
  `OPS_RESTORE_PERMISSIONS_MISMATCH` no log do container one-off `*-run`;
- qualquer erro de leitura R2 (possível poda concorrente): repetir após o
  ciclo de backup, nunca ampliar permissões da credencial de leitura;
- pull da imagem falha por digest indisponível: reavaliar antes de pinar
  outro digest (exige autorização própria).

Cleanup e rollback:

- O runner faz o cleanup sozinho no `finally` (remove apenas recursos com os
  labels do project, assegura zero remanescentes, apaga `/run/
stakeframe-restore/<project>` conferindo o conteúdo).
- Se `cleanup=failed`: NÃO remover recursos manualmente antes de inventariar
  (`docker ps -a`, `volume ls`, `network ls` com `--filter
label=io.stakeframe.restore=<project>`); investigar e remover com os
  comandos filtrados por label, um a um, registrando cada remoção.
- Rollback: o ensaio nunca toca produção (rede internal, sem portas, banco
  novo). Não há rollback a fazer em produção; se algo de produção for
  afetado, é incidente — registrar e reavaliar os gates.
- Falha do ensaio substitui `restore-latest.json` com `status=failed`
  (comportamento desejado: estado reflete a última tentativa).

## 8. Mutações que exigem autorização própria

| Ref | Mutação                             | Escopo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Criar credencial R2 somente leitura | Concluída na STK-M0-21: `stakeframe-backups-reader-prod`, Object Read only no bucket `stakeframe-backups`, com leitura/listagem e sem write/delete/admin                                                                                                                                                                                                                                                                                                                                                                                                            |
| B   | Instalar os 2 segredos              | **Executada na STK-M0-26B**: `/etc/stakeframe/secrets/r2_backup_restore_access_key` e `r2_backup_restore_secret_key`, `root:opc 0640`, valores nunca em log                                                                                                                                                                                                                                                                                                                                                                                                         |
| C   | Instalar Node/config/checkout       | **Executada na STK-M0-26C com exceção documentada**: Node 24.20.0 linux-arm64 instalado em `/opt/stakeframe-tools/node` (hash conferido), `/etc/stakeframe/docker` 0700 criado e permissões da árvore corrigidas; troca do checkout revertida pelo rollback prescrito (divergência de EOL no bind) — ver `docs/M0-26C-VALIDATION.md`. **Concluída na STK-M0-26C2**: checkout byte a byte idêntico à `main` @ `d00717f` instalado por troca atômica, sem restart/recreate, com aceite explícito do inode antigo mantido pelo bind — ver `docs/M0-26C2-VALIDATION.md` |
| D   | Executar o primeiro restore isolado | **Concluída na STK-M0-29 (execução única, retry autorizado após a correção M0-28/PR #84)**: `RESTORE_REHEARSAL_PASSED`, `RUNNER_EXIT=0`, `status=passed`, `cleanup=passed`, todos os critérios da janela D satisfeitos, produção ilesa, zero resíduos, mutação E ausente — ver `docs/M0-29-VALIDATION.md` (a falha da primeira tentativa permanece registrada em `docs/M0-27-VALIDATION.md`). Janela D da seção 7, gates 1-5, sem merge-e-executa                                                                                                                   |
| E   | Instalar e habilitar o timer mensal | `cp infra/production/stakeframe-restore.{service,timer} /etc/systemd/system/` + `daemon-reload` + `enable --now stakeframe-restore.timer`; só após 1º ensaio bem-sucedido na janela D                                                                                                                                                                                                                                                                                                                                                                               |
