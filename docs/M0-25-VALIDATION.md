# STK-M0-25 — Reconciliação do estado operacional

Data: 2026-09-08. Issue: [#67](https://github.com/RhianB14/stakeframe/issues/67).
Base: `main` `5a84beb6e60014b2e610101682f95e03c7862399`. Autoria: STK-M0-25A e
25B foram executadas e verificadas pelo Hermes sob autorizações específicas do
Codex, com evidências retransmitidas pelo proprietário; o Codex revisa a
evidência e a PR, sem apresentar essa revisão como verificação independente da
VPS. A STK-M0-25C cobre exclusivamente a alteração documental — issue, branch,
commit, push e PR; as mutações de 25A (permissões) e 25B (remoção da cópia
redundante) já ocorreram na VPS sob as autorizações correspondentes.

## Contexto

A ativação operacional (repositório Restic e daemon de backup com retenção)
ocorreu junto à janela do piloto ARM64 (STK-M0-24, 07/09/2026). Esta
reconciliação registra o estado observado nas janelas STK-M0-25A (correção de
permissões) e STK-M0-25B (remoção da cópia redundante), ambas de 08/09/2026, e
divide requisitos compostos em partes comprovadas e pendentes.

## Divergência operacional da M0-24

O registro M0-24 declara explicitamente que o piloto não altera a autorização
para produção contínua, retenção externa de backups ou instalação de
credenciais R2. Ainda assim, o repositório Restic no R2, a retenção e o daemon
de backup foram ativados na mesma janela, fora do escopo registrado. Fatos:

- A divergência foi descoberta em 08/09/2026, no preflight que antecedeu as
  janelas 25A/25B.
- O comando exato de ativação não pôde ser recuperado (`auth.log` não registra
  o comando); a cronologia foi reconstruída por mtimes e metadados.
- O próprio registro M0-24 atribui a execução da janela ao Codex; não há
  evidência para atribuir a ativação ao Hermes.
- Após a descoberta, o Codex autorizou explicitamente manter o daemon em
  execução durante 25A/25B, para não reduzir a proteção existente.
- As permissões do diretório de segredos e a duplicação de segredos foram
  corrigidas separadamente em 25A/25B.
- Esta reconciliação não transforma retroativamente a ativação inicial em
  ação previamente autorizada.

## 1. Cronologia da ativação (metadados, 07/09/2026 UTC)

Reconstruída somente por mtimes e metadados de containers; `auth.log` não
registra o comando de ativação.

| Hora (UTC)   | Evento                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| 15:10:25     | Três arquivos Compose copiados para `/opt/stakeframe`                                          |
| 15:33:33     | `/etc/stakeframe/secrets` criado; cópia aninhada criada no mesmo evento                        |
| 15:35:17–23  | PostgreSQL criado e iniciado; restart imediato (ExitCode 0, 140 ms) → RestartCount=1 histórico |
| 19:09:32     | `deployment.env` finalizado, com `BACKUP_CONFIRM=production-with-retention`                    |
| 19:09:44–53  | api, worker, web e operations criados e iniciados                                              |
| 19:09:55.762 | Primeiro `OPS_SCHEDULER_READY` no log do operations                                            |
| 19:10:20.013 | Primeiro `OPS_BACKUP_VERIFIED` (~27 s depois)                                                  |
| 19:58:49     | Única recriação do web (mesmos pinos; sem mudança de estado)                                   |

O daemon de operações nunca reiniciou desde a ativação; a cópia aninhada de
segredos era um resíduo da mesma janela.

## 2. Backup externo R2 ativo desde 07/09/2026

- Repositório Restic no bucket `stakeframe-backups` (R2), operado pelo serviço
  `operations` em modo daemon.
- Ciclos automáticos de 30 minutos nas fronteiras :00/:30 UTC.
- Retenção ativa: `BACKUP_CONFIRM=production-with-retention` e
  `retention: true` em `backup.json`.
- Estado contínuo `state=ready`, com cutoff/completedAt avançando a cada ciclo.
- Uso em operação: o daemon `operations` usa a credencial de backup e a
  credencial reader de anexos; a credencial writer de anexos não é usada pelo
  daemon. As credenciais `r2_backup_restore_*` permanecem ausentes
  (instalação futura no ensaio de restauração, com autorização própria).
  Presença de arquivo não equivale a validação operacional: com
  `imageCount=0`, reader/writer de anexos ainda não foram validadas com
  anexos reais.

## 3. Ciclos comprovados e retenção

- Preflight de 08/09 (11:15 UTC): 33 ocorrências de `OPS_BACKUP_VERIFIED`,
  zero WARN/ERR/FAIL, `backup.json` `state=ready`
  (cutoff 11:00:01Z, completedAt 11:00:13Z, ~12 s por ciclo).
- Ciclo pós-25A (12:00 UTC): `OPS_BACKUP_VERIFIED` em 12:00:29.479Z;
  snapshot novo; estado `ready`.
- Ciclo pós-25B (12:30 UTC): `OPS_BACKUP_VERIFIED` em 12:30:30.471Z;
  `backup.json` avançou (cutoff 12:30:02Z, completedAt 12:30:13.828Z,
  `state=ready`).
- Total comprovado: **36 ciclos** registrados no log do serviço desde a
  ativação, conferidos em três pontos independentes (11:15, 12:00 e 12:30 UTC
  de 08/09), sem falha.

## 4. STK-M0-25A — correção de permissões (08/09/2026)

| Caminho                               | Antes                                                  | Depois         |
| ------------------------------------- | ------------------------------------------------------ | -------------- |
| `/etc/stakeframe/secrets`             | root:root 0755                                         | root:root 0700 |
| `/etc/stakeframe/secrets/secrets`     | root:root 0600                                         | root:root 0700 |
| 16 arquivos do diretório aninhado     | root:root 0666                                         | root:root 0600 |
| Canônicos `/etc/stakeframe/secrets/*` | 15 × root:opc 0640; `postgres_password` root:root 0600 | intactos       |

Correção técnica: a mudança de 0600 para 0700 no diretório aninhado
**acrescentou permissões somente ao proprietário do diretório; grupo e outros
permaneceram sem acesso**. Nenhum arquivo teve permissões ampliadas (0666 →
0600 é restrição).

Ausência de impacto: o diretório canônico em 0700 já bloqueava a travessia por
qualquer usuário sem privilégio; testes empíricos como `ubuntu` e `nobody`
confirmaram impossibilidade de listar ou atravessar os dois diretórios. Os
cinco containers permaneceram `healthy`, o ciclo seguinte concluiu com
`OPS_BACKUP_VERIFIED` e não surgiram WARN/ERR/FAIL. A comparação silenciosa de
bytes contra os canônicos resultou 16/16 `SAME`.

## 5. STK-M0-25B — remoção da cópia redundante (08/09/2026)

- Nove gates pré-exclusão verificados (realpath, pai, diretório real 0700 sem
  symlink nem mountpoint, exatamente 16 arquivos regulares root:root 0600,
  nenhuma entrada adicional, 16/16 `SAME`, nenhum mount de container com fonte
  no aninhado, cinco containers healthy com RestartCount inalterado, canônicos
  intactos).
- Exclusão com `unlink` dos 16 caminhos literais seguida de `rmdir` do
  diretório vazio; sem `rm -rf`, sem wildcard, sem `shred`.
- Inode liberado registrado; ausência do caminho confirmada.
- Pós-exclusão: canônicos preservados (owner/group, modo e bytes), cinco
  containers `healthy`, ciclo seguinte concluído com `OPS_BACKUP_VERIFIED`,
  `backup.json` avançou e permaneceu `state=ready`, zero WARN/ERR/FAIL.

## 6. Arquivos canônicos preservados

O conjunto canônico tem 16 arquivos no total: 15 em root:opc modo 0640 e
`postgres_password` em root:root modo 0600. Todos permanecem em
`/etc/stakeframe/secrets` com bytes idênticos à baseline (verificado em 25A e
25B); `deployment.env` root:root 0600 intocado.

## 7. Saúde dos containers

Cinco containers `healthy` (postgres, api, worker, operations, web) nas três
aferições de 08/09. O RestartCount=1 do PostgreSQL é histórico — restart
imediato na criação, em 07/09 15:35:23Z (ExitCode 0, sem OOM, 140 ms), não
relacionado às janelas 25A/25B.

## 8. Requisitos compostos: comprovado × pendente

Comprovado nesta reconciliação:

- Backup externo ativo e recorrente (ciclos de 30 min, retenção ativa, estado
  `ready`, 36 ciclos verificados).

Pendente, exigindo autorização e janela próprias:

- Restauração em ambiente isolado, com anexos reais e manifesto (hoje
  `imageCount=0` — a ausência de anexos impede comprovar esse cenário).
- Alerta de atraso de backup.
- Timer mensal de ensaio de restauração.
- Métricas RPO/RTO medidas.
- Monitor externo.
- Instalação e validação das credenciais `r2_backup_restore_*`.

Este documento é evidência, não um quinto checklist canônico: usa listas
textuais "Comprovado"/"Pendente" e não entra na contagem de checkboxes.

Nenhum destes itens foi marcado como concluído em nenhum documento. Login
Google real, Telegram contínuo e operação integral sem PC permanecem sem
evidência específica e não foram marcados como concluídos.

## Verificação final (pós-25B, 12:30 UTC)

Ciclo automático seguinte: `OPS_BACKUP_VERIFIED` na fronteira 12:30 UTC;
`backup.json` com novo cutoff/completedAt e `state=ready`; cinco containers
`healthy` com RestartCount inalterado; zero WARN/ERR/FAIL desde a exclusão.

Contagens documentais (checkboxes dos quatro documentos canônicos de
checklist: M0-CHECKLIST, DEPLOYMENT, NETWORK-SECURITY e RECOVERY):
83/109 → 87/113 itens concluídos (76% → 77%). Foram adicionados quatro estados
concluídos e quatro divisões de denominador (pendências antes agregadas em
itens compostos, agora explícitas), sem ocultar pendências reais. Este
documento, por ser evidência, não entra na contagem.
