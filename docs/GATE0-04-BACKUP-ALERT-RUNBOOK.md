# GATE0-04 — Falha sintética do backup: alerta, deduplicação e recuperação (runbook STK-A4 D3–D5)

Registro e runbook da STK-A4 (Gate 0 item 4). O preflight read-only (D1) e o
dry-run sombra (D2) já foram executados (seção 3); este documento contém o
procedimento da janela de produção (D3–D5), que **não foi executada** — ela é
pendência do proprietário e só roda com autorização específica. Os resultados
do ensaio ficam **PENDENTE** até a fase 2B (seção 12).

## 1. Mapeamento do Gate 0 item 4

O Gate 0 exige provocar uma falha sintética e isolada do backup para provar em
produção: (1) alerta disparado; (2) deduplicação do alerta em ciclos
subsequentes; (3) recuperação quando a assinatura volta a `ready` — sem pausar
o backup real, sem alterar política de retenção e sem tocar cópias reais
(R2/Restic).

Fluxo real ponta a ponta (fase 1 da STK-A4, verificada no código):

1. **Daemon** — `apps/ops/src/server.mjs:136-145` roda `backup()` em ciclos de
   30 min alinhados a `:00`/`:30` UTC (`nextBackupAt`, `apps/ops/src/config.mjs:86-88`).
   Sucesso grava `state: 'ready'` + cutoff fresco via `saveStatus`
   (`apps/ops/src/backup.mjs:268-278`), que faz escrita atômica temp
   (`flag: 'wx'`, `mode: 0600`) + `rename` sobre `/status/backup.json`
   (`apps/ops/src/backup.mjs:72-77`).
2. **`backupHealth()`** (`apps/ops/src/config.mjs:114-124`) classifica
   `ready` se o cutoff tem menos de 1 h, senão `overdue`. `readStatus()`
   (`apps/ops/src/config.mjs:73-84`) valida `version`/`state` e cai em
   fallback `{state:'failed', retention:false}` em qualquer erro.
3. **API** — `apps/api/src/operations.ts:195-204` sonda
   `http://operations:9092/status` (interno, sem porta publicada) e define
   `checks.backup = (result.backup === 'ready' && result.lastRun !== 'failed')
? 'ready' : 'failed'` (`operations.ts:199-200`) com cache de 60 s
   (`operations.ts:121`); rota pública `/api/v1/operations/health` exige
   `MONITOR_TOKEN` (`operations.ts:248-278`).
4. **Monitor** — worker Cloudflare com cron `*/5 * * * *`
   (`infra/monitor/wrangler.jsonc:10`) sonda a API
   (`infra/monitor/worker.mjs:170`) e monta a assinatura concatenando
   `nome:estado` de todo check `warning|failed` (`worker.mjs:212-216`) — para
   este ensaio, exatamente `backup:failed`.
5. **Histerese/Dedup** — no Durable Object (`worker.mjs:384-491`): a
   candidata precisa de **3 observações consecutivas** para virar alerta
   (`hysteresisPolicy`, `worker.mjs:59-75`; attention=3) e a deduplicação é
   `notified !== candidate && cooldownOpen` (`worker.mjs:437-448`) — uma
   assinatura já notificada nunca re-dispara nos ciclos seguintes.
   Recuperação: candidata `ready` por 3 observações com
   `notified !== 'ready'` gera a nova tentativa (`worker.mjs:421-431`).
6. **Telegram** — `deliverNotification` (`worker.mjs:237-274`) envia para o
   chat privado do proprietário; textos literais em `notificationText`
   (`worker.mjs:228-235`), reproduzidos na seção 9.

O que **já** está provado por testes (26 pass, `docs/M0-69-BACKUP-ALERT-PREFLIGHT.md`):
a regra `ready→overdue`, a dedup e a recuperação em si. O que falta é a
observação **real** da transição — é o que D3–D5 entregam.

## 2. Decisões do orquestrador (fase 2A)

1. Ponto de injeção: reescrita atômica de `cutoff`/`completedAt` no
   `/status/backup.json` real, mantendo `state: 'ready'`, `retention: true` e
   metadados originais. **Proibido tocar `state`.**
2. Canal: Telegram real do proprietário, janela pré-anunciada. Nenhum código
   de rótulo de ensaio no monitor.
3. Janela D3–D5: ~50–60 min, alinhada logo após uma fronteira `:00`/`:30`
   UTC, proprietário presente. Nada é executado sem a janela ser agendada.
4. Bearer: permanece procedimento privado do proprietário. A prova principal
   roda **sem** bearer (arquivo + logs + confirmação Telegram); leitura com
   bearer é opcional (seção 11).
5. Recuperação: esperar o ciclo real reescrever o arquivo (prova o backup
   intacto). Restauração da cópia de rollback só se o cutoff original ainda
   tiver < 1 h.
6. Fallback de re-escrita: loop de re-assert com TTL duro de 25 min +
   rollback automático da cópia; após o TTL, abortar e reagendar.
7. Forma: runbook manual; zero código no repo além de docs.
8. `docs/M0-CHECKLIST.md` (item do alerta de backup) é fechado só na PR da
   evidência (fase 2B), não aqui.
9. Variante: `overdue` com `state: 'ready'` + cutoff velho (alinhado à
   M0-69). `state: 'failed'` proibido.

## 3. Preflight (D1) e dry-run (D2) — executados

### 3.1 D1 — preflight read-only (2026-09-25T00:21:58Z / 24/09 21:21 BRT)

Leitura única por SSH (`sudo bash -s`, host key verificada, zero mutação):

```
version=1 state=ready retention=true
cutoff=2026-09-25T00:00:02.432Z (idade 21 min < 50 min)
completedAt=2026-09-25T00:00:24.553Z  snapshot(trunc16)=6dfd458ae34fdbc2
arquivo=1000:1000 mode 600, 239 bytes
container stakeframe-production-operations-1: running, restart=0, health=healthy
imagem ghcr.io/rhianb14/stakeframe-operations@sha256:5e421eec7d36…
logs 2h: OPS_BACKUP_VERIFIED=4  OPS_BACKUP_FAILED=0  OPS_REHEARSAL=0
D1_RESULT: INTEGRO
```

Critérios de aborte nenhum violado (cutoff < 50 min, `state=ready`,
`retention=true`, cadência de 30 min confirmada, zero falhas e zero atividade
de ensaio na produção).

### 3.2 D2 — dry-run sombra (2026-09-25T00:26:36Z)

Container efêmero `docker run --rm -i --network none`, imagem de operações
pinada por digest (a mesma em execução), volume scratch com label
`io.stakeframe.operations-rehearsal=stk-a4-d2`, sem portas, sem segredos. O
código real (`/app/src/config.mjs`, import sem efeitos colaterais nem leitura
de credenciais) executou `readStatus()` + `backupHealth()` sobre o scratch:

```
baseline:   state=ready  backupHealth={backup:ready,    retention:ready, lastRun:ready}
sintético:  state=ready  backupHealth={backup:overdue,  retention:ready, lastRun:ready}   (cutoff now-2h)
restaurado: state=ready  backupHealth={backup:ready,    retention:ready, lastRun:ready}
escrita: sempre mode=600 uid=1000 gid=1000 (temp wx + rename, igual ao saveStatus)
D2_NODE_RESULT: ALL_PASS — volume e containers do ensaio removidos (zero restantes com a label)
container de produção intacto: stakeframe-production-operations-1 | Up (healthy)
```

Conclusão: o procedimento de escrita do runbook produz exatamente a
transição alvo (`backup:failed` isolado, `state` intocado) usando o mesmo
código que roda em produção.

## 4. Pré-condições comuns e critérios de aborte

Antes de qualquer estágio da janela, vale **tudo** abaixo; qualquer desvio →
parar, sem injeção (ou rollback, se já injetado), e reportar ao orquestrador:

- Janela agendada e anunciada ao proprietário, que está presente e ciente das
  duas mensagens esperadas (seção 9).
- Reexecutar o D1 (seção 3.1) e obter `INTEGRO` de novo. Critérios de aborte:
  cutoff com > 50 min; `state != ready`; `retention != true`; container
  `operations` não-`running`/não-`healthy`/restart > 0; menos de 3
  `OPS_BACKUP_VERIFIED` em 2 h; qualquer `OPS_BACKUP_FAILED` ou
  `OPS_REHEARSAL` em 2 h; qualquer mensagem de alerta recente no Telegram
  (incidente ativo); manutenção/em breve outra entrega na mesma janela.
- Estado do monitor sem incidente ativo: sem bearer, o proprietário confirma
  que não há mensagem de alerta pendente no chat; com bearer (opcional),
  `lastSignature: ready`.
- UMA janela por vez; UMA tarefa por vez (card `t_d8edb26e`); nada de merge
  nesta fase.

Abortes específicos por estágio estão em cada seção.

## 5. Estágio D3 — injecção e alerta

### 5.1 Momento

T0 deve cair **≤ 2 min após uma fronteira `:00`/`:30` UTC** em que o ciclo
real já concluiu (cutoff fresco verificado no D1). Assim o próximo ciclo real
só chega ~28 min depois — tempo suficiente para alerta (≤ 15 min) **e**
dedup (≥ 10 min) antes da reescrita natural.

### 5.2 Conexão (somente leitura até a etapa 5.4)

```
ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
  -i ~/.ssh/oracle/oracle-vps.key ubuntu@<vps> 'sudo bash -s'
```

IP/hostname não entram neste documento (regra do projeto). Todo comando abaixo
roda como `root` via `sudo bash -s`.

### 5.3 Pré-checagem imediata e cópia de rollback

```bash
set -euo pipefail
ST=/var/lib/stakeframe/operations-status
RB=/root/stk-a4-backup.json.rollback
date -u +%FT%TZ
jq -r '"cutoff=\(.cutoff) state=\(.state) retention=\(.retention)"' "$ST/backup.json"
# cutoff deve ter < 5 min de idade; state=ready; retention=true
CUT_AGE=$(( $(date +%s) - $(date -u -d "$(jq -r .cutoff "$ST/backup.json")" +%s) ))
[ "$CUT_AGE" -lt 300 ] || { echo "ABORT: cutoff $CUT_AGE s (>=300)"; exit 1; }
[ "$(jq -r .state "$ST/backup.json")" = ready ] || { echo "ABORT: state != ready"; exit 1; }
[ "$(jq -r .retention "$ST/backup.json")" = true ] || { echo "ABORT: retention != true"; exit 1; }
# cópia de rollback (fora do volume do daemon; raiz, 600)
install -o root -g root -m 600 "$ST/backup.json" "$RB"
sha256sum "$ST/backup.json" "$RB"
```

**Aborte:** qualquer `ABORT` acima → encerrar a janela sem tocar em nada.

### 5.4 Injeção (única mutação do ensaio)

```bash
set -euo pipefail
ST=/var/lib/stakeframe/operations-status
NEW=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)
jq --arg c "$NEW" '.cutoff=$c | .completedAt=$c' "$ST/backup.json" \
  > "$ST/.backup.json.stk-a4.tmp"
chown 1000:1000 "$ST/.backup.json.stk-a4.tmp"
chmod 600 "$ST/.backup.json.stk-a4.tmp"
mv -f "$ST/.backup.json.stk-a4.tmp" "$ST/backup.json"   # rename(2) atômico, mesmo diretório
```

Garantias do comando: `jq` altera **apenas** `cutoff` e `completedAt`
(`state`, `retention`, `snapshot`, contagens intactos — provado na etapa 5.5);
temp no mesmo filesystem + `mv` = leitura rasgada impossível; ownership/mode
finais idênticos aos do daemon (`1000:1000`, `600`).

### 5.5 Verificação obrigatória pós-escrita (antes de declarar injeção)

Roda o código real da imagem sobre o diretório real **montado read-only**
(sem rede, sem escrita possível):

```bash
set -euo pipefail
ST=/var/lib/stakeframe/operations-status
RB=/root/stk-a4-backup.json.rollback
IMG=$(grep -E '^OPERATIONS_IMAGE=' /etc/stakeframe/deployment.env | cut -d= -f2-)

# (a) prova de que só cutoff/completedAt mudaram
diff -u <(jq -S 'del(.cutoff,.completedAt)' "$RB") \
        <(jq -S 'del(.cutoff,.completedAt)' "$ST/backup.json") \
  && echo "ONLY_CUTOFF_CHANGED=OK"

# (b) readStatus() + backupHealth() do código de produção
docker run --rm -i --network none -v "$ST":/status:ro "$IMG" --input-type=module - <<'NODE'
import { readStatus, backupHealth } from '/app/src/config.mjs';
const s = await readStatus();
const h = backupHealth(s);
console.log('readStatus=' + JSON.stringify(s));
console.log('backupHealth=' + JSON.stringify(h));
const ok = s.state === 'ready' && h.backup === 'overdue'
        && h.retention === 'ready' && h.lastRun === 'ready';
console.log('D3_VERIFY=' + (ok ? 'INJECTED' : 'ABORT'));
process.exit(ok ? 0 : 1);
NODE
```

**Aborte:** `D3_VERIFY=ABORT` (ou diff ≠ vazio, ou exit ≠ 0) → rollback
imediato (seção 8) e fim da janela. Só `INJECTED` + `ONLY_CUTOFF_CHANGED=OK`
declararam a injeção concluída.

### 5.6 Observação do alerta (≤ 15 min)

A partir de T0, o monitor observa em até 5 min (cron `*/5`), precisa de 3
observações (até +15 min) e entrega no Telegram:

```
Stakeframe precisa de atenção: backup. Confira o procedimento operacional.
```

Acompanhamento (read-only, a cada minuto):

```bash
date -u +%FT%TZ
jq -r '"cutoff=\(.cutoff) state=\(.state) retention=\(.retention)"' \
  /var/lib/stakeframe/operations-status/backup.json
docker ps --filter name=stakeframe-production-operations-1 --format '{{.Names}} {{.Status}}'
docker logs --since 30m stakeframe-production-operations-1 2>&1 \
  | grep -E 'OPS_BACKUP|OPS_OPERATION' | tail -5
```

**Aborte D3:** sem a mensagem até T0+17 min (15 min + margem de cron) →
entrar em re-assert (seção 7.1) apenas se ainda couber no TTL de 25 min;
se T0+25 min sem alerta → rollback (seção 8) e reagendar. Se aparecer
`OPS_BACKUP_FAILED` ou mensagem com texto diferente da seção 9 → protocolo
de incidente real (seção 9.2).

## 6. Estágio D4 — deduplicação (≥ 10 min)

Com a mensagem de alerta entregue e o arquivo ainda sintético, o estado deve
permanecer por **≥ 2 ciclos de cron** sem nova mensagem. Sem bearer, a prova
é: (a) ≥ 10 min decorridos sem segunda mensagem (o proprietário confirma o
silêncio no chat); (b) o arquivo continua `overdue`/`state=ready`
(leitura acima); (c) logs seguem mostrando ciclos reais normais.

**Condição de saída:** ≥ 10 min após a mensagem 1, sem repetição → parar
qualquer re-assert **antes** da próxima fronteira `:00`/`:30` UTC.

**Aborte D4:** qualquer mensagem nova com texto fora da lista da seção 9 →
protocolo de incidente real; qualquer `OPS_BACKUP_FAILED` → abortar (pode
indicar falha real do backup durante a janela); cutoff já reescrito pelo
ciclo real sem termos encerrado o re-assert → não reescrever de novo,
seguir direto para D5.

## 7. Estágio D5 — recuperação (≤ 30 min após a dedup)

Sem re-assert ativo, o ciclo real seguinte (`:00`/`:30` UTC, ≤ 30 min depois)
reescreve `backup.json` com cutoff fresco — essa é a **recuperação por
auto-sanitização** que prova o backup intacto. O monitor precisa de 3
observações `ready` e então entrega a segunda mensagem:

```
Stakeframe: os sinais operacionais voltaram ao normal.
```

Verificação (read-only):

```bash
jq -r '"cutoff=\(.cutoff) state=\(.state) retention=\(.retention) snapshot=\(.snapshot[0:16])"' \
  /var/lib/stakeframe/operations-status/backup.json
docker logs --since 40m stakeframe-production-operations-1 2>&1 \
  | grep -c OPS_BACKUP_VERIFIED
```

Espera-se cutoff novo **e** `snapshot` diferente do registrado no D1 (novo
snapshot real criado durante a janela) **e** contagem de
`OPS_BACKUP_VERIFIED` seguindo a cadência.

**Aborte D5:** sem a mensagem de recuperação até 30 min após a dedup →
(1) arquivo já fresco: estado saudável, só a observação falhou → registrar,
encerrar a janela sem nenhuma mutação e escalar ao orquestrador (leitura
bearer opcional pode diagnosticar); (2) arquivo ainda sintético após a
fronteira do ciclo real → executar rollback (seção 8) e escalar.

### 7.1 Fallback de re-assert (somente se a timeline atrasar; TTL 25 min)

Usado apenas quando um ciclo real completa **antes** de o alerta/ dedup
fecharem (ex.: T0 fora da janela) e o arquivo voltou a `ready` cedo demais.
Reescreve o sintético a cada 60 s até o deadline:

```bash
set -uo pipefail
ST=/var/lib/stakeframe/operations-status
DEADLINE=$(( $(date +%s) + 1500 ))   # TTL duro: 25 min a partir do acionamento
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  C=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)
  jq --arg c "$C" '.cutoff=$c | .completedAt=$c' "$ST/backup.json" \
    > "$ST/.backup.json.stk-a4.tmp" \
    && chown 1000:1000 "$ST/.backup.json.stk-a4.tmp" \
    && chmod 600 "$ST/.backup.json.stk-a4.tmp" \
    && mv -f "$ST/.backup.json.stk-a4.tmp" "$ST/backup.json"
  sleep 60
done
echo "REASSERT_TTL_EXPIRED"
```

Notas: a escrita é sempre temp + rename (leitura rasgada impossível, mesmo
com o daemon escrevendo ao mesmo tempo — cada gravação é um JSON completo e
atômico; a última escrita vence); `jq` parte do arquivo atual, então um
`state` eventual do daemon não é sobrescrito. **Após o TTL: parar e fazer
rollback (seção 8) — abortar e reagendar, nunca estender.**

## 8. Rollback e auto-sanitização

Duas camadas, nesta ordem de preferência:

1. **Auto-sanitização (preferida, decisão 5):** basta não reescrever — o
   próximo ciclo real (≤ 30 min) regrava `backup.json` com cutoff fresco e
   `state: 'ready'`. Nenhuma ação necessária; observar (seção 7).
2. **Restauração da cópia (abortes):** só se o cutoff do original ainda tiver
   < 1 h (senão, esperar a camada 1):

```bash
set -euo pipefail
ST=/var/lib/stakeframe/operations-status
RB=/root/stk-a4-backup.json.rollback
AGE=$(( $(date +%s) - $(date -u -d "$(jq -r .cutoff "$RB")" +%s) ))
if [ "$AGE" -lt 3600 ]; then
  cp --preserve=mode,ownership "$RB" "$ST/.backup.json.stk-a4.tmp"
  chown 1000:1000 "$ST/.backup.json.stk-a4.tmp"
  chmod 600 "$ST/.backup.json.stk-a4.tmp"
  mv -f "$ST/.backup.json.stk-a4.tmp" "$ST/backup.json"
  echo "ROLLBACK=RESTORED age=${AGE}s"
else
  echo "ROLLBACK=DEFERRED_TO_NEXT_CYCLE age=${AGE}s (>=3600)"
fi
```

Verificação final de qualquer caminho: `jq -r .cutoff` novo (< 1 h),
`state=ready`, `retention=true`, sem `.stk-a4` sobrando em
`/var/lib/stakeframe/operations-status` (o único resíduo aceito é a cópia
`/root/stk-a4-backup.json.rollback`, removida pelo proprietário após o
aceite da evidência).

## 9. Protocolo das mensagens Telegram

### 9.1 Lista literal das únicas mensagens esperadas

Geradas por `notificationText` (`infra/monitor/worker.mjs:228-235`), assinaturas
`backup:failed` e `ready`:

1. Alerta (D3): `Stakeframe precisa de atenção: backup. Confira o procedimento operacional.`
2. Recuperação (D5): `Stakeframe: os sinais operacionais voltaram ao normal.`

Exatamente uma de cada durante a janela, nesta ordem.

### 9.2 Mensagem fora da lista = incidente real

Qualquer outra mensagem no chat durante a janela (inclusive texto de alerta
com outro check, ex.: `banco`, `processamento`) **não é do ensaio**:
parar imediatamente o estágio atual, executar rollback (seção 8) se houver
injeção ativa, e tratar como incidente real (contatar o orquestrador /
procedimento operacional). O ensaio só reagenda depois que o incidente real
for resolvido.

## 10. Timeline esperada (UTC / BRT = UTC−3)

Exemplo com T0 logo após a fronteira das 14:00 UTC (11:00 BRT):

| Hora (UTC)  | Hora (BRT)  | Evento                                                        |
| ----------- | ----------- | ------------------------------------------------------------- |
| 14:00       | 11:00       | ciclo real concluído (D1 atestado: cutoff fresco)             |
| 14:02       | 11:02       | **T0**: rollback copiado + injeção + verificação `INJECTED`   |
| ≤ 14:17     | ≤ 11:17     | 3 observações do monitor → **mensagem 1** (alerta, ≤15 min)   |
| 14:17–14:27 | 11:17–11:27 | **dedup**: ≥ 2 ciclos em silêncio, arquivo ainda sintético    |
| ≤ 14:27     | ≤ 11:27     | re-assert parado antes da próxima fronteira                   |
| ~ 14:30     | ~ 11:30     | ciclo real reescreve cutoff (auto-sanitização)                |
| ≤ 15:00     | ≤ 12:00     | 3 observações `ready` → **mensagem 2** (recuperação, ≤30 min) |

Limites orçamentários: alerta ≤ 15 min; dedup ≥ 10 min; recuperação ≤ 30 min
após o fim da dedup. Janela total ~50–60 min. Se a janela não puder ser
mantida por inteiro, não iniciar.

## 11. Evidências

**Sem bearer (prova principal — roda sempre):**

- Cópia sanitizada do `backup.json` antes / durante / depois (cutoff, state,
  retention, snapshot truncado a 16 chars) — nunca o arquivo inteiro se
  contiver mais que timestamps/hashes.
- Contagem e trechos de `OPS_BACKUP_VERIFIED`/`OPS_BACKUP_FAILED` do daemon
  durante toda a janela (backup real seguiu rodando).
- Confirmação do proprietário das duas mensagens com horário (UTC/BRT).
- Estado do container (`running`/`healthy`, restart 0) ao longo da janela.

**Bearer opcional (procedimento privado do proprietário):**

```
GET /status do worker do monitor (infra/monitor/wrangler.jsonc)
Authorization: Bearer $MONITOR_TOKEN      # valor nunca impresso, nunca no repo
```

Espera-se `lastSignature: ready → backup:failed → ready` com
`delivery: confirmed` e `lastFiredAt`/`lastCompletedAt` coerentes. O
`MONITOR_TOKEN` não entra em chat, docs, logs nem no repositório.

## 12. Resultados do ensaio — PENDENTE (fase 2B)

| Campo                             | Valor    |
| --------------------------------- | -------- |
| T0 (UTC/BRT)                      | PENDENTE |
| Mensagem 1 recebida (hora)        | PENDENTE |
| Janela de dedup observada (min)   | PENDENTE |
| Mensagem 2 recebida (hora)        | PENDENTE |
| Snapshot novo pós-ciclo (trunc16) | PENDENTE |
| Estado final do arquivo           | PENDENTE |
| Bearer (se houver): assinaturas   | PENDENTE |
| Confirmação do proprietário       | PENDENTE |
| Ocorrências fora da lista         | PENDENTE |

Será preenchido após a janela, com os artefatos sanitizados, e motivará o
fechamento do item no checklist (decisão 8 — PR separada da evidência).

## 13. Limites

- Nenhuma alteração de código, compose, imagem, banco, política de retenção,
  credenciais ou repositório restic neste item (decisão 7 — doc-only).
- O ensaio não exercita falha real do restic/R2: provar isso desviaria o
  ciclo real e feriria o escopo ("backup real intacto"); a prova de integridade
  do backup durante a janela é a cadência de `OPS_BACKUP_VERIFIED` + novo
  snapshot.
- Se o monitor não observar 3 vezes dentro da janela por motivo externo, o
  ensaio aborta e reagenda — nunca estende o TTL.
- Este runbook não autoriza merge nem a janela: ambos dependem do
  orquestrador/proprietário (CI verde ≠ autorização).

## 14. Referências

- `docs/M0-69-BACKUP-ALERT-PREFLIGHT.md` — política e preflight anteriores.
- `docs/GATE0-03-TLS-VALIDATION.md` — padrão de registro do Gate 0 item 3.
- `apps/ops/src/config.mjs` — `readStatus`/`backupHealth`/`nextBackupAt`.
- `apps/ops/src/backup.mjs` — `saveStatus` (escrita atômica) e ciclo.
- `apps/api/src/operations.ts` — mapeamento `overdue → checks.backup failed`.
- `infra/monitor/worker.mjs` — histerese, dedup e textos das mensagens.
- `infra/monitor/wrangler.jsonc` — cron `*/5` e rota `/status`.
