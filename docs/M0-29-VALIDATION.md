# STK-M0-29 — Validação da execução única da mutação D (retry autorizado)

Autorização: execução única da mutação D pelo proprietário após o merge de
STK-M0-28 (base `36c0e6386fb4cc47cb899e32ae70fc25877f043f`). A primeira
tentativa (STK-M0-27) não alcançou o objetivo por causa da ausência do runtime
root; a correção M0-28 (PR #84) tornou o runner autossuficiente. Este documento
registra o novo resultado. O histórico da primeira tentativa permanece em
[docs/M0-27-VALIDATION.md](M0-27-VALIDATION.md), sem reescrita.

## 1. Revalidação final (§5) — 13/13 gates aprovados

Leitura-only, imediatamente antes da execução (`REVALID_DONE G=0`):

| Gate                                                        | Evidência sanitizada                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| 3. Revision do checkout                                     | `36c0e6386fb4cc47cb899e32ae70fc25877f043f` (exata)                   |
| 4. Artefatos instalados                                     | 9/9 `sha256sum -c` OK (mesmos hashes do manifesto de 303 blobs)      |
| 5. Containers de produção                                   | 5 running/healthy, baseline idêntica à pré-troca                     |
| 6. `backup.json`                                            | `state=ready`, cutoff com idade de 7,5 min (< 1 h)                   |
| 7. Concorrência                                             | 0 processos de backup/prune/restore/manutenção                       |
| 8. Disco                                                    | 40 GiB livres, 17% usados                                            |
| 9. Recursos preexistentes com label `io.stakeframe.restore` | 0/0/0                                                                |
| 10. `/run/stakeframe-restore`                               | ausente (aceito — runner cria e remove)                              |
| 11. Mutação E                                               | 0 units instaladas, 0 ativas, 0 arquivos                             |
| 12. Node e Docker config                                    | `v24.20.0`; `directory root:root 700` / `regular file root:root 600` |
| 13. Rollback do checkout                                    | íntegro: 300 arquivos, revisão `d00717f`                             |

A base obrigatória permaneceu exata (`origin/main` =
`36c0e6386fb4cc47cb899e32ae70fc25877f043f`, CI 5/5 `completed/success` nesse
SHA) e o worktree principal permaneceu limpo.

## 2. Execução única (§6)

Comando exato do runbook (docs/M0-26-PREFLIGHT.md §7), submetido **uma única
vez**, sem resubmissão por timeout ou silêncio, exit code capturado
diretamente:

```bash
sudo env \
  RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery \
  DOCKER_CONFIG=/etc/stakeframe/docker \
  /opt/stakeframe-tools/node/bin/node \
  /opt/stakeframe/scripts/restore-rehearsal.mjs \
  /etc/stakeframe/deployment.env
```

Resultado capturado:

- marcador de saída: `RESTORE_REHEARSAL_PASSED`;
- `RUNNER_EXIT=0` (exit code direto do processo, sem pipeline).

Progresso observado por sondas de leitura-only durante a execução: projeto
`stk-restore-da4af2be0c3d4eda8a0de1245c383659`, containers de restore
`*-restore-postgres-1` (healthy) e `*-run` (one-off) criados e destruídos pelo
próprio runner.

## 3. Critérios de sucesso (§7) — todos aprovados

`restore-latest.json` (campos sanitizados):

| Critério                             | Valor                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `status`                             | `passed`                                                                                           |
| `cleanup`                            | `passed`                                                                                           |
| `countsVerified`                     | `true`                                                                                             |
| `financeVerified`                    | `true`                                                                                             |
| `rolesVerified`                      | `true`                                                                                             |
| `permissionsVerified`                | `true`                                                                                             |
| `importsPaused`                      | `true`                                                                                             |
| `sessionsRevoked`                    | `true`                                                                                             |
| `runtimeRoot`                        | `created` (pela execução)                                                                          |
| `failureCode` / `cleanupFailureCode` | `none` / `none`                                                                                    |
| janela                               | `startedAt=2026-09-09T21:46:56.490Z` → `completedAt=2026-09-09T21:47:32.309Z` (`durationMs=28393`) |
| cutoff restaurado                    | `2026-09-09T21:30:02.025Z`                                                                         |

Verificações de resíduos e integridade (`POSTVALID_DONE G=0`):

| Verificação                                | Evidência                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Recursos com label `io.stakeframe.restore` | 0 containers, 0 volumes, 0 redes                                                                    |
| Diretórios `stk-restore-*`                 | 0 em todo o filesystem                                                                              |
| Runtime root                               | criado pela execução e removido por ela (`RR_ABSENT`, 0 entradas)                                   |
| Relatório privado                          | mais recente em `/var/lib/stakeframe/restore-reports/` (`root:root 600`, diretório `root:root 700`) |
| Baseline dos 5 containers                  | idêntica antes e depois (mesmos StartedAt/RestartCount/OOMKilled/health)                            |
| `backup.json` pós-execução                 | `state=ready`                                                                                       |
| Disco pós-execução                         | 40 GiB livres, 17% usados                                                                           |
| Portas publicadas                          | nenhuma nova: apenas as de produção pré-existentes (web 80/443); restore sem portas                 |
| Rede/banco de produção                     | não tocados (ensaio em rede internal isolada, banco novo)                                           |
| Mutação E                                  | continua ausente (0 units, 0 ativas)                                                                |

## 4. Rollback e scratch (§5 da retomada)

- Rollback do checkout **retido** (300 arquivos, 3,3 MiB, revisão `d00717f`,
  caminho completo não publicado). Exclusão destrutiva exigirá autorização
  separada; não houve divergência que justificasse restaurá-lo.
- Scratch de transporte em `/run` (9expect, 9check, scripts de troca e
  validação) removido após a captura das evidências: `SCRATCH_LEFT=0`.
- `restore-latest.json` reflete a última tentativa com `status=passed`
  (comportamento desejado do runner).

## 5. Mutações

| Mutação                          | Estado                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| A, B, C, C2                      | Concluídas                                                        |
| **D — primeiro restore isolado** | **Concluída nesta execução única**                                |
| E                                | **Pendente** — nunca autorizada, nunca instalada, nunca executada |

## 6. Trilha operacional

- Preflight completo de 15 gates (STK-M0-29 §3): `PREFLIGHT_DONE G=0`.
- Troca atômica do checkout (STK-M0-29 §4): `M029_SWAP_OK`, revision
  `d00717f` → `36c0e638`, 304 arquivos, rollback preservado, zero toques nos
  containers de produção.
- Revalidação (§5 da retomada): `REVALID_DONE G=0`.
- Execução única (§6): `RESTORE_REHEARSAL_PASSED`, `RUNNER_EXIT=0`.
- Pós-validação (§7): `POSTVALID_DONE G=0`.

## 7. Limitações

- Evidências sanitizadas: nenhum secret, hash de secret, conteúdo de
  configuração ou dado restaurado foi lido ou publicado.
- O inode antigo do bind do PostgreSQL (aceito na C2) permanece sem leitura
  pelo container até o próximo recreate — não houve restart, recreate ou
  intervenção em produção.
- Este registro cobre a execução única autorizada; repetições exigem nova
  autorização do proprietário.
