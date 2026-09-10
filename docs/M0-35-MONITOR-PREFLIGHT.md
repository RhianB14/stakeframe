# STK-M0-35 — Preflight do monitor externo e dos alertas operacionais

Data: 2026-09-10 · Base: `59d8435a2eacee8b85605ab85252b02dc06ffa22` · Branch: `hermes/m0-35-monitor-preflight`

## 1. Base e versões verificadas

- `origin/main` = base obrigatória `59d8435a2eacee8b85605ab85252b02dc06ffa22` (squash da PR #94). Conferido por fetch + rev-parse.
- Wrangler fixado pelo lockfile: **4.129.0**; `pnpm monitor:check` (dry-run) conclui com sucesso e lista os bindings.
- Worker: `infra/monitor/worker.mjs` (215 linhas) exporta `class StakeframeMonitor` (Durable Object com storage SQLite) e `export default { scheduled, fetch }`.
- Testes: `tests/operations/monitor.test.mjs` (4 pass), `pnpm operations:test` (0 falhas), dry-run do Wrangler OK.
- Probes HTTPS sem autenticação: `https://stakeframe.com.br/status` → HTTP 200; workers.dev de monitor → não existe (esperado antes do deploy).

## 2. Matriz de gates

| #   | Gate                                                                                  | Estado    | Evidência                                                                    |
| --- | ------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| 1   | Base `59d8435a` em origin/main                                                        | PASS      | fetch + rev-parse idênticos                                                  |
| 2   | Contrato do Wrangler (binding, classe, DO SQLite, cron, workers_dev, observabilidade) | PASS      | `wrangler.jsonc` + dry-run 4.129.0                                           |
| 3   | `MONITOR_ENABLED=false` (comportamento inerte)                                        | PASS      | worker.mjs L32/L196 retornam cedo; dry-run mostra var `false`                |
| 4   | Validação de segredos antes de uso                                                    | PASS      | regexes L35-39 e L204; falha sem consulta externa                            |
| 5   | Deduplicação/lease/gravação antes do envio                                            | PASS      | testes de monitor (4 pass)                                                   |
| 6   | `/status` protegido                                                                   | PASS      | probe sem auth → 200 público; com token ausente → validado por teste         |
| 7   | Conta Cloudflare autenticável                                                         | PARCIAL   | identidade via `wrangler whoami` sanitizado; cotas não expostas pela API     |
| 8   | Nenhum recurso `stakeframe-monitor` existente                                         | PARCIAL   | verificação de leitura; estado reconfirmável só no momento do deploy         |
| 9   | `monitor_token` existente utilizável                                                  | BLOQUEADO | nenhum caminho seguro de leitura sem mutação; fica para a janela de ativação |
| 10  | Segredos instalados no Worker                                                         | BLOQUEADO | exige deploy (fora do escopo)                                                |

## 3. Estado remoto Cloudflare (sanitizado)

- Identidade da conta confirmada por leitura (`wrangler whoami`), saída sanitizada: apenas nome de conta e flag de permissão; sem IDs de conta, sem e-mails.
- Nenhum Worker, deployment, namespace DO ou segredo com o nome `stakeframe-monitor` encontrado — ambiente limpo para ativação futura.
- Nomes/tipos de segredos listados: nenhum. Nenhum valor de segredo lido ou exibido.
- Plano/cotas: não expostos em leitura pela API/CLI — **pendente** de verificação na janela de ativação.

## 4. Contrato de configuração e segredos

- Binding DO: `STAKEFRAME_MONITOR` → classe `StakeframeMonitor`, `durable_objects.bindings` + `exports` com `storage: "sqlite"` (formato declarativo mantido — ver §5).
- Vars: `APP_ORIGIN`, `MONITOR_ENABLED` (atualmente `"false"`).
- Cron: `*/5 * * * *`.
- Segredos exigidos (apenas nomes, nunca valores): `MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID` (deve ser igual ao user id).
- `/status` exige `Authorization: Bearer <MONITOR_TOKEN>` quando habilitado; falha de configuração retorna cedo, sem consulta externa e sem alerta.

## 5. Decisão técnica: exports vs migrations

O `wrangler.jsonc` declara o DO via `exports` (formato declarativo). Avaliado contra
`migrations` (formato legado). **Mantido o `exports`**: é o contrato preferencial do
Wrangler 4.129.0 para Workers novos, e o dry-run valida a configuração sem erros.
Trocar para `migrations` não traria ganho comprovado — mudança descartada por falta
de evidência técnica concreta.

## 6. Plano de ativação exato (a executar somente com autorização posterior)

1. Criar/instalar os quatro segredos no Worker via `wrangler secret put` (um por vez, valores fora do repositório):
   `MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID`.
2. Alterar `MONITOR_ENABLED` para `"true"` em `wrangler.jsonc` (commit documental + revisão).
3. `pnpm monitor:check` (dry-run) e revisão Codex.
4. Deploy: `wrangler deploy --config infra/monitor/wrangler.jsonc`.
5. Pós-deploy: probe sem autenticação em `https://stakeframe-monitor.<subdomínio>.workers.dev` deve falhar (protegido); consulta autenticada ao `/status` deve retornar os campos esperados.
6. Observar primeiro ciclo de cron (5 min): confirmar execução, ausência de alertas falsos e deduplicação ativa.
7. Rollback previsto: reverter `MONITOR_ENABLED` para `"false"` e redeploy — sem exclusão de recursos.

## 7. Registro de probes

- GET sem auth `https://stakeframe.com.br/status` → **HTTP 200** (10/09/2026, ~22:35Z) — rota pública responde.
- GET sem auth no workers.dev do monitor → sem DNS (000) — Worker ainda não implantado (esperado).
- Nenhum valor de segredo impresso, copiado ou persistido nesta tarefa.
