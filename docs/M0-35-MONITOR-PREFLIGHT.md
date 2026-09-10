# STK-M0-35 — Preflight do monitor externo e dos alertas operacionais

Data: 2026-09-10 · Base: `59d8435a2eacee8b85605ab85252b02dc06ffa22` · Branch: `hermes/m0-35-monitor-preflight`

## 1. Base e versões verificadas

- `origin/main` = base obrigatória `59d8435a2eacee8b85605ab85252b02dc06ffa22` (squash da PR #94). Conferido por fetch + rev-parse.
- Wrangler fixado pelo lockfile: **4.129.0**; `pnpm monitor:check` (dry-run) conclui com sucesso e lista os bindings.
- Worker: `infra/monitor/worker.mjs` (215 linhas) exporta `class StakeframeMonitor` (Durable Object com storage SQLite) e `export default { scheduled, fetch }`.
- Testes: `tests/operations/monitor.test.mjs` (4 pass), `pnpm operations:test` (0 falhas), dry-run do Wrangler OK.
- Probes HTTPS sem autenticação: `https://stakeframe.com.br/status` → HTTP 200; workers.dev de monitor → não existe (esperado antes do deploy).

## 2. Matriz de gates

| #   | Gate                                                                                  | Estado    | Evidência                                                                                                    |
| --- | ------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Base `59d8435a` em origin/main                                                        | PASS      | fetch + rev-parse idênticos                                                                                  |
| 2   | Contrato do Wrangler (binding, classe, DO SQLite, cron, workers_dev, observabilidade) | PASS      | `wrangler.jsonc` + dry-run 4.129.0                                                                           |
| 3   | `MONITOR_ENABLED=false` (comportamento inerte)                                        | PASS      | worker.mjs L32/L196 retornam cedo; dry-run mostra var `false`                                                |
| 4   | Validação de segredos antes de uso                                                    | PASS      | regexes L35-39 e L204; falha sem consulta externa                                                            |
| 5   | Deduplicação/lease/gravação antes do envio                                            | PASS      | testes de monitor (4 pass)                                                                                   |
| 6   | `/status` protegido                                                                   | PASS      | probe sem auth → 200 público; com token ausente → validado por teste                                         |
| 7   | Conta Cloudflare autenticável                                                         | BLOQUEADO | `wrangler whoami` → "You are not authenticated"; não existe `CLOUDFLARE_API_TOKEN` no ambiente desta máquina |
| 8   | Nenhum recurso `stakeframe-monitor` existente                                         | PENDENTE  | não verificável sem autenticação Cloudflare; revalidar na janela de ativação                                 |
| 9   | `monitor_token` existente utilizável                                                  | BLOQUEADO | nenhum caminho seguro de leitura sem mutação; fica para a janela de ativação                                 |
| 10  | Segredos instalados no Worker                                                         | BLOQUEADO | exige deploy (fora do escopo)                                                                                |

## 3. Estado remoto Cloudflare (sanitizado)

- **Identidade Cloudflare: NÃO verificada.** `wrangler whoami` (4.129.0) respondeu
  "You are not authenticated" e não há `CLOUDFLARE_API_TOKEN` no ambiente desta
  máquina. Nenhum comando de leitura remota pôde ser executado nesta tarefa.
- **Worker/deployment/namespace DO `stakeframe-monitor`: PENDENTE** — não verificável
  sem autenticação; revalidar na janela de ativação (`wrangler deployments list`,
  KV/DO listing) antes de qualquer `secret put`.
- Segredos: nada listado, nada lido; nenhum valor impresso, copiado ou persistido.
- Plano/cotas: **pendente** — não expostos sem autenticação.

## 4. Contrato de configuração e segredos

- Binding DO: `STAKEFRAME_MONITOR` → classe `StakeframeMonitor`, `durable_objects.bindings` + `exports` com `storage: "sqlite"` (formato declarativo mantido — ver §5).
- Vars: `APP_ORIGIN`, `MONITOR_ENABLED` (atualmente `"false"`).
- Cron: `*/5 * * * *`.
- Segredos exigidos (apenas nomes, nunca valores): `MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID` (deve ser igual ao user id).
- `/status` exige `Authorization: Bearer <token>` quando habilitado; falha de configuração retorna cedo, sem consulta externa e sem alerta.

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

- GET sem auth `https://stakeframe.com.br/status` → **HTTP 200** (10/09/2026, ~22:35Z e ~22:36Z) — rota pública responde.
- GET sem auth no workers.dev do monitor → sem DNS (000) — Worker ainda não implantado (esperado).
- GET sem auth `https://stakeframe-monitor.example.workers.dev` → 000 (DNS inexistente; confirma que não há Worker público com esse subdomínio de exemplo — prova negativa de superfície).
- Nenhum valor de segredo impresso, copiado ou persistido nesta tarefa.

## 8. Distinção entre deploy do Worker e envio real de mensagem Telegram

- **Deploy do Worker** = publicar código/config no Cloudflare. Por si só **não envia
  mensagem nenhuma**: com `MONITOR_ENABLED=false` o cron retorna cedo (worker.mjs
  L196) e o handler recusa operação; sem chamadas externas, sem Telegram.
- **Mensagem Telegram real** = efeito somente quando **todas** as condições coexistem:
  `MONITOR_ENABLED=true` + os quatro segredos válidos + incidente detectado (ou teste
  com autorização específica). Cada envio é gravado antes da tentativa (lease no DO)
  e é deduplicado; mensagem "incerta" não é reenviada após restart (provado por
  teste).
- Portanto **"deploy concluído" nunca implica "Telegram tocado"**. A prova de não-envio
  em uma janela é: logs do cron sem incidente + estado do DO sem entrega + `getMe`
  (somente leitura) da Bot API sem novas mensagens.

## 9. Sequência atômica proposta para implantação posterior (nenhum passo executado)

1. **Fase 0 — leitura:** revalidar identidade (`wrangler whoami`), inexistência de
   recursos `stakeframe-monitor` (`wrangler deployments list`, listagem de DO),
   segredos existentes (apenas nomes), plano/cotas (leitura autenticada).
2. **Gate G0 (obrigatório antes da primeira mutação):** credencial com permissão
   mínima válida; nenhum recurso preexistente; `pnpm monitor:check` verde;
   `MONITOR_ENABLED=false` na config; valores dos 4 segredos prontos **fora do Git**;
   plano de rollback (§10) lido.
3. **Fase 1 — deploy inerte:** `wrangler deploy` com `MONITOR_ENABLED=false`.
   Ponto de verificação V1: probe workers.dev **sem auth** → recusa (rota protegida);
   cron registrado mas inerte; nenhuma mensagem.
4. **Fase 2 — segredos:** `wrangler secret put` × 4, um por vez, valores nunca em
   terminal gravado/Git; readback = apenas nomes + timestamps.
5. **Gate G1 (antes de habilitar):** 4 segredos presentes (por nome); validação de
   formato pelo código (regexes) confirmada por leitura; autorização do Codex para o
   enable.
6. **Fase 3 — enable (ponto de não-retorno):** commit alterando
   `MONITOR_ENABLED="true"` → CI 5/5 → revisão Codex → deploy habilitado. A partir
   daqui o cron roda a cada 5 min por conta própria.
7. **Verificação V2:** primeiro ciclo (≤5 min): "quiet while healthy" (nenhuma
   mensagem sem incidente); consulta autenticada somente leitura ao `/status`
   (token em memória de sessão, nunca persistido); logs sem aviso.

## 10. Plano de rollback por versão

- **Primário:** reverter no Git (`MONITOR_ENABLED="false"`) → CI → deploy da versão
  inerte. Fonte da verdade é o repositório; não usar `versions rollback` como
  primeira opção porque preservaria config divergente do Git.
- **Contingência (Git indisponível):** `wrangler versions rollback <version>` para a
  última versão inerte conhecida; depois conciliar o Git.
- **Pós-rollback (obrigatório):** probe sem auth → recusa; leitura de
  `wrangler deployments list` provando a versão ativa; zero mensagens durante a
  observação de um ciclo.
- **Rollback nunca** exclui DO/namespace/segredos — estado preservado para auditoria;
  exclusão de recursos é operação separada com autorização específica.

## 11. Teste controlado de falha, recuperação e deduplicação (desenho para a janela autorizada)

Não executado nesta tarefa (envio de mensagem é proibido aqui). Cenários mínimos,
na ordem, com autorização específica para cada mensagem:

1. **Falha:** aplicação inacessível (ex.: rota de teste autorizada retornando
   unhealthy) → incidente gravado → **1 mensagem** de incidente → nova varredura
   **não** reenvia enquanto o incidente persistir (deduplicação).
2. **Recuperação:** aplicação volta → **1 mensagem** de recuperação → estado volta a
   "quiet while healthy".
3. **Reinício sob incerteza:** interromper entrega (ex.: revogar rede momentânea sob
   autorização) e reiniciar o Worker → mensagem incerta **não** é reenviada
   (comportamento já provado em teste automatizado; validar também em produção).
4. Cada envio: registrar em evidência privada timestamp, chat (via `getMe`/readback),
   texto sanitizado e estado do DO. Nenhum conteúdo privado em logs públicos.

## 12. Custos e cotas: comprovados vs não comprovados

- **Comprovado nesta tarefa:** apenas o comportamento local (dry-run, testes). O
  dry-run não consulta cotas.
- **Não comprovado (verificar com leitura autenticada na janela de ativação):** plano
  da conta (free/paid) e seus limites de requests Workers; quota de Durable Objects
  (requests, duration, storage SQLite); invocações de cron; limites de subrequests;
  custo/retenção de logs de observabilidade.
- **Nenhum número de cota é afirmado aqui** — valores de plano variam por conta e
  devem ser lidos da API/CLI na janela, com saída sanitizada.

## 13. Evidências privadas a reter fora do Git (checklist da janela de ativação)

- Subdomínio workers.dev real do Worker; ID de conta Cloudflare; saída completa de
  `wrangler whoami`; logs de deploy (contêm IDs); versões/timestamps de deployment;
  hashes dos artefatos deployados.
- Valores dos 4 segredos (`MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID`) — gerados/obtidos fora do Git;
  readbacks apenas com nome + timestamp.
- Registros dos testes da §11: timestamps, mensagens enviadas (ids), estado do DO.
- Destino sugerido: diretório privado na máquina do proprietário + `SHA256SUMS`
  (padrão já usado nas evidências da M0-33/M0-34). **Nunca** no repositório, PRs,
  issues ou comentários.

## 14. Limitação de runtime local

- Projeto fixa Node `v24.20.0` (`.nvmrc`, `engines >=24.20.0 <25`) e
  `pnpm@11.24.0`. A máquina local está em Node v22.23.2 — os testes locais passaram
  mesmo assim, mas a prova do runtime fixado é a **CI** (que executa no runtime
  exigido e passou 5/5). Registrado como limitação de ambiente local, não de gate.
