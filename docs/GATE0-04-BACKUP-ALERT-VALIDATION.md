# GATE0-04 — Validação do ensaio sintético de backup: alerta, dedup e recuperação

Registro de evidência da janela D3–D5 da STK-A4 (Gate 0 item 4), executada
em 25/09/2026 conforme o
[GATE0-04-BACKUP-ALERT-RUNBOOK.md](GATE0-04-BACKUP-ALERT-RUNBOOK.md) na `main`
desta PR. O ensaio reescreve apenas `cutoff`/`completedAt` do
`/status/backup.json` real, mantendo `state: 'ready'`; nenhuma alteração de
código, política, credencial ou cópia restic.

## 1. Provado nesta janela

- [x] **Alerta disparado em produção** — 3 observações `backup:failed` do
      monitor (cron `*/5`): 04:35Z/04:40Z/04:45Z (01:35/01:40/01:45 BRT) →
      mensagem 1 entregue e confirmada por escrito às **04:46Z (01:46 BRT)**
      (`Stakeframe precisa de atenção: backup. Confira o procedimento
operacional.`), T0+14–15 min dentro do limite T0+17 min.
- [x] **Deduplicação** — ≥ 10 min (04:46→05:00Z) sem re-disparo, sem re-assert
      ativo, com o arquivo ainda sintético na leitura das 04:55Z.
- [x] **Recuperação por ciclo real** — auto-sanitização às 05:00:02Z (cutoff
      reescrito pelo daemon, snapshot novo `b04feed5cc161d63`), 3 observações
      `ready` → mensagem 2 entregue e confirmada às **05:11Z (02:11 BRT)**
      (`Stakeframe: os sinais operacionais voltaram ao normal.`), dentro do
      orçamento ≤ 05:26Z.
- [x] **Injeção restrita e verificada** — `ONLY_CUTOFF_CHANGED=OK` (diff dos
      demais campos vazio) + `D3_VERIFY=INJECTED` pelo código real da imagem
      (volume montado `read-only`, sem rede): `state=ready`,
      `backupHealth={backup:overdue, retention:ready, lastRun:ready}`.
- [x] **Rollback do procedimento (§8, camada 2)** — a tentativa 1 (T0
      04:02:07Z, 7 s acima do limite da fronteira) foi revertida às 04:04:28Z
      (`ROLLBACK=RESTORED`, cópia `sha256 684eac17…4292`) **antes** da
      observação seguinte do monitor, sem disparo algum; janela reagendada
      para a fronteira 04:30Z (T0 definitivo 04:31:12Z, +1 min 12 s ✓).
- [x] **Backup real intacto durante a janela** — `OPS_BACKUP_VERIFIED` ×5 em
      2 h (ciclos 03:30/04:00/04:30/05:00Z + subida), **0**
      `OPS_BACKUP_FAILED`, **0** `OPS_REHEARSAL`; snapshots novos por ciclo
      (`3356088b` → `cc0c41f9` → `fab0e094` → `b04feed5`); container
      `Up (healthy)` `restart=0` o tempo todo.
- [x] **Whitelist de mensagens (§9.1)** — exatamente 2 mensagens, na ordem
      esperada; **nenhuma** ocorrência fora da lista (zero incidentes).
- [x] **Escopo mutacional contido** — `/etc/stakeframe/deployment.env`
      inalterado (hash `2864e85f749d74d7`, 5 pins); zero resíduo `.stk-a4`;
      cópia de rollback removida da VPS após o aceite (§8), ausência
      confirmada por `ls`.

## 2. Não exercitado nesta evidência

- [ ] Falha real do restic/R2 — fora do escopo por decisão (§13: provar isso
      desviaria o ciclo real e feriria "backup real intacto").
- [ ] Variante `state: 'failed'` — proibida pela decisão 9 (o ensaio usa
      `overdue` com `state: 'ready'`).
- [ ] Fallback de re-assert (§7.1) — não foi necessário: a tentativa 2 fechou
      alerta e dedup dentro da janela do primeiro ciclo.
- [ ] Leitura do `/status` do monitor com credencial — a prova principal roda
      sem leitura adicional (§11).
- [ ] Atraso **natural** do backup (não sintético) e alerta de expiração TLS —
      este último é objeto do
      [GATE0-03-TLS-VALIDATION.md](GATE0-03-TLS-VALIDATION.md).
- [ ] Regras/dedup por testes automatizados — cobertas pela evidência
      anterior da [STK-M0-69](M0-69-BACKUP-ALERT-PREFLIGHT.md), não por esta
      janela.

## 3. Evidências

- **Timeline e tabela completas**: seção 12 do
  [GATE0-04-BACKUP-ALERT-RUNBOOK.md](GATE0-04-BACKUP-ALERT-RUNBOOK.md)
  (T0 04:31:12Z / 01:31 BRT, alerta 04:46Z, dedup ≥ 10 min, auto-sanitização
  05:00:02Z, recuperação 05:11Z).
- **Hashes de rollback**: `684eac17…4292` (tentativa 1, restaurada) e
  `57637a48…b86bfe6` (tentativa 2; cópia removida após aceite).
- **Estado final do arquivo** (05:18:24Z): `state=ready`,
  `cutoff=2026-09-25T05:00:02.122Z`, `retention=true`, snapshot
  `b04feed5cc161d63`, `imageCount=24`.
- **Confirmação do proprietário**: por escrito, as 2 mensagens da §9.1 com
  horários (01:46 BRT e 02:11 BRT), ordem correta, zero ocorrências fora da
  lista.

## 4. Referências

- [GATE0-04-BACKUP-ALERT-RUNBOOK.md](GATE0-04-BACKUP-ALERT-RUNBOOK.md) —
  procedimento da janela (§5–§10) e registro da execução (§12).
- [M0-69-BACKUP-ALERT-PREFLIGHT.md](M0-69-BACKUP-ALERT-PREFLIGHT.md) —
  política, regra e testes de dedup anteriores.
- `apps/ops/src/config.mjs` (`readStatus`/`backupHealth`),
  `apps/api/src/operations.ts` (mapeamento `overdue → failed`),
  `infra/monitor/worker.mjs` (histerese, dedup e textos das mensagens).
