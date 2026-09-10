# STK-M0-30 — Instalação do timer mensal de restore

> **STATUS: MUTAÇÃO E CONCLUÍDA.** O service e o timer mensais foram
> instalados; o timer foi habilitado e ativado, e uma execução inicial
> supervisionada terminou com sucesso. A produção permaneceu inalterada.

Autorização explícita do proprietário em 10/09/2026: executar a mutação E pela
variante supervisionada, incluindo a instalação e habilitação do timer e
exatamente uma execução imediata do restore. Não foram autorizados deploy,
migração, alteração dos containers de produção, firewall, DNS, credenciais,
execuções adicionais ou remoção do rollback do checkout.

Issue: [#86](https://github.com/RhianB14/stakeframe/issues/86). Base revisada:
`7e1b89d4cfa62d9b449b9d65bf4aa275b8804ed1`, com os cinco checks obrigatórios
`completed/success`.

## 1. Preflight

As verificações na VPS foram somente leitura até todos os gates passarem:

| Gate                    | Evidência sanitizada                                                |
| ----------------------- | ------------------------------------------------------------------- |
| Checkout instalado      | revisão `36c0e638`; artefatos chamados pelo unit idênticos à `main` |
| Service                 | SHA-256 `6dc2e66f48305e95…`; `systemd-analyze verify` aprovado      |
| Timer                   | SHA-256 `8759cf4897b7ec5a…`; calendário mensal validado             |
| Mutação E anterior      | units ausentes, não carregados, não habilitados e sem stamp         |
| Produção                | 5/5 containers `running/healthy`, sem OOM                           |
| Último restore          | `status=passed`, `cleanup=passed`, seis verificações verdadeiras    |
| Backup                  | `state=ready`, cutoff com idade de 16 minutos                       |
| Concorrência e resíduos | zero execução concorrente; containers/volumes/redes `0/0/0`         |
| Capacidade              | 40 GiB livres, 17% usados                                           |
| Runtime root            | ausente                                                             |
| Rollback do checkout    | presente e íntegro; caminho privado não publicado                   |

A observação do `systemd-analyze security` sobre ausência de `UMask=` foi
aceita sem mudança nesta janela. Os diretórios privados já usam modo `0700`, os
relatórios usam `0600` e os arquivos efêmeros têm modos definidos pelo runner.
Alterar o umask sem validar o acesso dos containers não root mudaria as
permissões efetivas desses arquivos.

## 2. Execução autorizada

Os arquivos aprovados foram instalados como `root:root 0644` em
`/etc/systemd/system/`, seguidos por `systemctl daemon-reload` e
`systemctl enable stakeframe-restore.timer`. A habilitação foi separada da
ativação para manter o ponto de controle explícito.

O `systemctl start stakeframe-restore.timer` criou o estado persistente e
agendou diretamente a próxima ocorrência, sem disparar catch-up neste host. A
inferência do preflight de que a ausência de stamp causaria execução imediata
não se confirmou. Para cumprir a autorização de exatamente uma execução
inicial supervisionada, o service foi iniciado explicitamente uma única vez:

```bash
systemctl start stakeframe-restore.service
```

Não houve segunda invocação pelo timer.

## 3. Resultado da execução inicial

O service encerrou com `Result=success`, `ExecMainStatus=0` e estado final
`inactive/dead`. O relatório atômico novo registrou:

| Campo                         | Resultado                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `status` / `cleanup`          | `passed` / `passed`                                                                                                       |
| Verificações                  | `countsVerified`, `financeVerified`, `rolesVerified`, `permissionsVerified`, `importsPaused` e `sessionsRevoked` = `true` |
| Falhas                        | `failureCode=null`, `cleanupFailureCode=null`                                                                             |
| Janela                        | `2026-09-10T10:25:57.162Z` → `2026-09-10T10:26:30.984Z`                                                                   |
| Duração do drill (durationMs) | `26361 ms`                                                                                                                |
| Intervalo externo             | `33822 ms` (`completedAt` - `startedAt`)                                                                                  |

## 4. Pós-validação

| Verificação         | Resultado                                       |
| ------------------- | ----------------------------------------------- |
| Timer               | `enabled/active`, subestado de espera           |
| Próxima ocorrência  | `2026-10-01 03:26:19 UTC`                       |
| Stamp persistente   | presente                                        |
| Units instalados    | hashes idênticos aos artefatos aprovados        |
| Produção            | baseline dos 5 containers idêntica antes/depois |
| Recursos de restore | containers/volumes/redes `0/0/0`                |
| Runtime root        | ausente após cleanup                            |
| Backup              | permaneceu `ready`                              |

Como todos os critérios passaram, o rollback da mutação E não foi acionado. O
rollback antigo do checkout foi preservado e continua sujeito a autorização
destrutiva separada; permanece **retido** após a leitura de reconciliação de
10/09/2026, que não o removeu
([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §8).

## 5. Limitações e autoria

- A ativação e o primeiro restore foram executados diretamente pelo Codex sob a
  autorização do proprietário. A verificação do próprio trabalho não é
  apresentada como revisão independente do GitHub.
- O próximo disparo está configurado e ativo, mas a ocorrência futura de
  01/10/2026 ainda não aconteceu.
- Este ensaio não comprova failover integral, RTO real nem alerta de backup
  atrasado.
- Nenhum segredo, conteúdo restaurado, IP administrativo ou caminho privado de
  credencial/rollback foi publicado.

Closes #86.
