# Runbook — backup duplo (Restic: Cloudflare R2 + Backblaze B2)

STK-F1-11 (Plano Master §12.4). Cobre a operação do segundo provedor de backup:
espelhamento, retenção, integridade, restauração a partir de cada destino e
recuperação de chave. Complementa [OPERATIONS.md](../OPERATIONS.md), que
descreve o repositório primário, o daemon, o ensaio mensal e o monitor.

## 1. Arquitetura

- Dois repositórios Restic cifrados, um por provedor:
  - Primário: `s3:https://<conta>.r2.cloudflarestorage.com/<bucket>/stakeframe-v1`
    (Cloudflare R2, como já operado).
  - Espelho: `b2:stakeframe-backup:stakeframe-v1` (Backblaze B2, bucket privado
    do proprietário, Application Key `stakeframe-restic` restrita ao bucket).
- Decisão registrada: o espelho é mantido por **`restic copy`** (primário →
  B2), não por um repositório com dois remotos. O Restic não oferece backend
  múltiplo por repositório, e um remote `rclone union` para escrita não tem
  semântica transacional entre provedores (falha parcial corromperia o
  repositório). O `copy` é o mecanismo canônico: transfere apenas blobs
  ausentes no destino e preserva a deduplicação — os dois repositórios
  terminam com os mesmos IDs de snapshot e o mesmo conjunto de dados; a
  restauração de qualquer um dos dois é equivalente.
- Desvio do caminho rclone proposto: o backend `b2:` **nativo** do Restic
  0.19.1 (já presente na imagem de operações) é usado no lugar de rclone +
  arquivo de configuração. Menos binários e menos configuração no container
  endurecido, e as credenciais seguem o padrão do projeto: arquivos em
  `SECRET_DIRECTORY` montados como secret, nunca um arquivo de config em
  disco. Sem mudança no repositório primário (S3/R2 nativo, como hoje).
- Ciclo do daemon (`operations`, a cada 30 min, alinhado a `:00`/`:30`):
  1. backup primário (R2) — inalterado;
  2. `restic copy` R2 → B2;
  3. retenção §12.4 nos **dois** destinos: `forget` completo
     (`--keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`) e
     incompleto (`--keep-within 48h`);
  4. medição de deduplicação no primário (`stats` raw-data × restore-size);
  5. verificação de integridade semanal (`restic check --read-data-subset 10%`)
     nos dois destinos, com retry espaçado de 6 h em caso de falha.
- Estados e alertas: `/status/backup-dual.json` no volume `operations-status`
  alimenta os checks `backupSync` ("sincronização do backup") e
  `backupIntegrity` ("integridade do backup") na API e no monitor externo.

## 2. Provisão inicial (proprietário)

Pré-requisitos (não versionados):

- Conta Backblaze B2 ativa; bucket `stakeframe-backup` privado, sem Object
  Lock; Application Key `stakeframe-restic` restrita ao bucket (Read and
  Write).
- Arquivos em `SECRET_DIRECTORY` (0700, legíveis pelo UID 1000):
  `b2_backup_account_id` (keyID) e `b2_backup_application_key` (application
  key), um valor por arquivo. Nunca entram no repositório, no card, em logs
  ou na devolutiva.
- `deployment.env`: `B2_BACKUP_BUCKET=stakeframe-backup`.
- Gerenciador de senhas (fora da VPS, fora do repositório): cópia do keyID,
  da application key e da `recovery_key` do Restic.
- O serviço de operações é **fail-closed**: sem as variáveis e os arquivos
  acima ele não inicia (`OPS_SECOND_PROVIDER_REFUSED` / `SECRET_FILE_REQUIRED`).
  O primeiro ciclo após a ativação roda o `copy` inicial, que espelha todo o
  histórico ao B2 (pode levar alguns minutos; é idempotente).

Ativação e conferência (janela autorizada):

```bash
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml \
  --profile operations up -d --wait operations
# Primeiro ciclo: conferir OPS_REPLICATION_VERIFIED nos logs.
# Corte do monitor: atualizar API+worker na MESMA janela, com menos de 15
# minutos entre as partes (ver §3); cruzamento de versões além disso faz o
# monitor emitir 1 alerta de "aplicação ou acesso do monitor".
```

## 3. Operação normal

- Logs do daemon: `OPS_BACKUP_VERIFIED`, `OPS_REPLICATION_VERIFIED`,
  `OPS_REPLICATION_FAILED` (o sync falho nunca invalida o backup primário).
- Sinais no monitor (Telegram, com histerese e deduplicação):
  - `backupSync` — atraso/falha da sincronização e aviso de deduplicação
    anômala (`ready` → `warning` 1–2 h ou dedup < 1.05 → `failed` ≥ 2 h);
  - `backupIntegrity` — check semanal (`warning` após 8 dias, `failed` após
    14 dias, ou falha registrada da última tentativa);
  - `backup`, `retention`, `restoreTest` — como antes (primário e ensaio).
- Leitura direta do estado: `/var/lib/stakeframe/operations-status/backup-dual.json`
  (`sync.state/at`, `integrity.state/at/attemptAt`, `dedup.ratio`).
- Janela do sample: o ciclo do daemon (backup + `copy` + retenção) mantém o
  lock dos repositórios por minutos; rode o `sample` FORA da janela do ciclo.
  Se rodar durante, o comando aguarda até 15 min pelo lock (`--retry-lock
15m`) antes de falhar.

## 4. Comandos manuais

No checkout revisado da VPS, com o arquivo de configuração privado:

```bash
# Sincronizar agora (copy + retenção nos dois destinos + retry de check).
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml \
  --profile operations run --rm operations src/server.mjs replicate

# Restore de amostra (validação de legibilidade nos DOIS destinos).
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml \
  --profile operations run --rm operations src/server.mjs sample
# Saída: OPS_SAMPLE_VERIFIED (ou OPS_SAMPLE_FAILED); relatório em
# /status/restore-sample.json. Recomendado: mensal, junto do ensaio, e fora
# da janela do ciclo do daemon (ver §3); falhas registram reason/detail.

# Check manual apenas do primário (o B2 é verificado pelo replicate).
docker compose --env-file /etc/stakeframe/deployment.env \
  -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml \
  --profile operations run --rm --entrypoint restic operations \
  check --read-data-subset 10%
```

## 5. Restauração a partir de cada destino

**Amostra (rápida, sem cluster):** comando `sample` acima. Lê o último snapshot
completo de cada destino, baixa `manifest.json`, `attachments.json` e um anexo,
e confere os checksums — prova que os dados de ambos os provedores estão
legíveis e íntegros.

**Ensaio completo (cluster isolado):**

- A partir do R2 (padrão): o timer mensal
  (`stakeframe-restore.timer`, dia 1 às 03:26 UTC) executa
  `scripts/restore-rehearsal.mjs` sem `RESTORE_SOURCE`, como hoje.
- A partir do B2 (execução manual autorizada):

```bash
sudo env \
  RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery \
  RESTORE_SOURCE=b2 \
  DOCKER_CONFIG=/etc/stakeframe/docker \
  /opt/stakeframe-tools/node/bin/node \
  /opt/stakeframe/scripts/restore-rehearsal.mjs \
  /etc/stakeframe/deployment.env
```

O procedimento, as salvaguardas e a limpeza são os mesmos do ensaio mensal
([OPERATIONS.md](../OPERATIONS.md) §"Recuperação e ensaio mensal"); a única
diferença é a fonte do snapshot (`RESTORE_SOURCE=b2`). O relatório inclui
`source` (`r2`/`b2`) e o resultado mais recente substitui
`restore-latest.json` — um ensaio do B2 passa a ser a evidência mais recente
de `restoreTest`.

## 6. Recuperação de chave perdida

Nenhuma chave fica no repositório. Cópias existem em dois lugares:

| Item                                                 | Na VPS (uso do serviço)         | Cópia sob custódia    |
| ---------------------------------------------------- | ------------------------------- | --------------------- |
| `recovery_key` (senha Restic)                        | `SECRET_DIRECTORY/recovery_key` | gerenciador de senhas |
| `b2_backup_account_id` / `b2_backup_application_key` | `SECRET_DIRECTORY/`             | gerenciador de senhas |

- Perda de uma cópia: restaurar do gerenciador (ou promover a cópia da VPS a
  referência e atualizar o gerenciador). Registrar a rotação.
- Perda total (VPS + gerenciador): os dados são irrecuperáveis por design
  (zero-knowledge). Não há backdoor — a única saída é o descarte.
- Rotação da Application Key B2: gerar key pair nova no provedor, restrita ao
  bucket, substituir os arquivos na VPS e reiniciar o serviço; a senha do
  Restic não muda.
- Troca da senha do Restic (somente com janela e ensaio): usar `restic key
add` no repositório primário e no espelho, validar o acesso com a senha
  nova e só então remover a antiga; atualizar o gerenciador. Nunca rotacionar
  a `recovery_key` sem revalidar restore.

## 7. Troubleshooting

- `backupSync` `failed`: conferir logs do serviço (`... logs operations`).
  Causas típicas: arquivos de secret ausentes/inválidos, bucket incorreto,
  daemon parado, saída de rede (`backup-egress`). Rodar o comando `replicate`
  manual para reproduzir.
- `backupSync` `warning` por deduplicação (`dedup.ratio < 1.05`): o espelho
  deixou de compartilhar dados entre ciclos (ex.: dumps não determinísticos).
  O valor cru está em `backup-dual.json`; investigar a mudança antes de agir.
- `backupIntegrity` `warning`/`failed`: o check semanal não completou ou
  falhou; o `replicate` re-tenta a cada 6 h. Se persistir, usar o check manual
  do §4 e registrar o incidente.
- Pausar o pipeline duplo: `BACKUP_READ_ONLY=true` no serviço desliga
  `copy`/`forget`/check (o backup primário de leitura continua). Reativar
  exige remover a variável e reiniciar — registrar em janela autorizada.

## 8. Evidências

- `operations-status/backup-dual.json` — sync, integridade e dedup.
- `operations-status/restore-sample.json` — amostra por destino.
- `operations-status/restore-latest.json` — último ensaio completo
  (com `source`).
- Monitor `/status` (worker) — histórico de assinaturas e horários.
- Pós-ativação, conferir: `OPS_REPLICATION_VERIFIED` no primeiro ciclo,
  `sync.state=ready` e `dedup.ratio` presentes, `sample` verde nos dois
  destinos e ausência de alertas novos no monitor.
