# STK-M0-35 — Preflight do monitor externo e dos alertas operacionais

Data: 2026-09-10 · Base: `59d8435a2eacee8b85605ab85252b02dc06ffa22` · Branch: `hermes/m0-35-monitor-preflight`

## 1. Base e versões verificadas

- `origin/main` = base obrigatória `59d8435a2eacee8b85605ab85252b02dc06ffa22` (squash da PR #94). Conferido por fetch + rev-parse.
- Wrangler fixado pelo lockfile: **4.129.0**; `pnpm monitor:check` (dry-run) conclui com sucesso e lista os bindings.
- Worker: `infra/monitor/worker.mjs` (215 linhas) exporta `class StakeframeMonitor` (Durable Object com storage SQLite) e `export default { scheduled, fetch }`.
- Testes: `tests/operations/monitor.test.mjs` (4 pass), `pnpm operations:test` (0 falhas), dry-run do Wrangler OK.
- Probes HTTPS sem autenticação: `https://stakeframe.com.br/status` → HTTP 200, que é **HTML público da aplicação** — **não é o `/status` do Worker** e não comprova sua proteção. O `/status` do monitor **não foi testado remotamente** porque o Worker ainda não existe (ver §7).

## 2. Matriz de gates

| #   | Gate                                                                                  | Estado    | Evidência                                                                                                                     |
| --- | ------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Base `59d8435a` em origin/main                                                        | PASS      | fetch + rev-parse idênticos                                                                                                   |
| 2   | Contrato do Wrangler (binding, classe, DO SQLite, cron, workers_dev, observabilidade) | PASS      | `wrangler.jsonc` + dry-run 4.129.0                                                                                            |
| 3   | `MONITOR_ENABLED=false` (comportamento inerte)                                        | PASS      | worker.mjs L32/L196 retornam cedo; dry-run mostra var `false`                                                                 |
| 4   | Validação de segredos antes de uso                                                    | PASS      | regexes L35-39 e L204; falha sem consulta externa                                                                             |
| 5   | Deduplicação/lease/gravação antes do envio                                            | PASS      | testes de monitor (4 pass)                                                                                                    |
| 6   | `/status` protegido (validação local do código/teste)                                 | PASS      | teste automatizado: requisição sem bearer ao handler externo retorna 404. **Probe remoto não executado** (Worker inexistente) |
| 7   | Conta Cloudflare autenticável                                                         | BLOQUEADO | `wrangler whoami` → "You are not authenticated"; não existe `CLOUDFLARE_API_TOKEN` no ambiente desta máquina                  |
| 8   | Nenhum recurso `stakeframe-monitor` existente                                         | PENDENTE  | não verificável sem autenticação Cloudflare; **sem inferência por DNS**; revalidar por leitura autenticada                    |
| 9   | `monitor_token` existente utilizável                                                  | BLOQUEADO | nenhum caminho seguro de leitura sem mutação; fica para a janela de ativação                                                  |
| 10  | Segredos instalados no Worker                                                         | BLOQUEADO | exige deploy (fora do escopo)                                                                                                 |

## 3. Estado remoto Cloudflare (sanitizado)

- **Identidade Cloudflare: NÃO verificada.** `wrangler whoami` (4.129.0) respondeu
  "You are not authenticated" e não há `CLOUDFLARE_API_TOKEN` no ambiente desta
  máquina. Nenhum comando de leitura remota pôde ser executado nesta tarefa.
- **Worker/deployment/namespace DO `stakeframe-monitor`: PENDENTE** — não verificável
  sem autenticação; **sem inferência por DNS** (DNS ausente não comprova ausência de
  recurso). Revalidar na janela de ativação (`wrangler deployments list`, listagem de
  DO) antes de qualquer `secret put`.
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

## 6. Sequência normativa única de ativação (nenhuma etapa executada)

Sequência obrigatória para a janela autorizada; cada mutação só ocorre após o gate
imediatamente anterior:

a. **Leitura autenticada:** validar identidade (`wrangler whoami`) e listar
Worker/deployments/namespace/segredos `stakeframe-monitor` (apenas nomes) e
plano/cotas.
b. **Recurso preexistente:** se algo já existir com o nome `stakeframe-monitor`,
**não exigir "inexistência" cegamente**: comparar identidade, configuração e
propriedade com o repositório. Recurso desconhecido ou divergente → **BLOQUEIA a
mutação** e retorna ao Codex.
c. **Gate G0 (antes da primeira mutação):** credencial com permissão mínima válida;
`pnpm monitor:check` verde; `MONITOR_ENABLED=false` na config; valores dos 4
segredos prontos **fora do Git**; plano de rollback (§9) lido.
d. **Primeiro deploy inerte:** `wrangler deploy` com `MONITOR_ENABLED=false`;
**registrar o version ID inerte**; registrar a criação/reconciliação do ciclo de
vida do DO SQLite (o primeiro deploy cria o DO — não há versão remota anterior).
Verificação V1: probe workers.dev **sem auth** → recusa; cron registrado e
inerte; nenhuma mensagem.
e. **Segredos:** `wrangler secret put` ×4, **interativo**, um por vez, sem valores
em argumentos, logs gravados ou Git.
f. **Presença:** confirmar apenas a presença dos nomes (readback do provedor: nome +
timestamp/versão).
g. **Validação privada dos valores:** conferir formato (regexes do worker) e
igualdade (`TELEGRAM_OWNER_CHAT_ID == TELEGRAM_OWNER_USER_ID`) por leitura
privada, emitindo **somente PASS/FAIL**. Ler as regexes do código não valida
valores reais.
h. **Commit do enable:** commit separado alterando `MONITOR_ENABLED="true"` → CI
5/5 → revisão do Codex.
i. **Deploy habilitado — ponto de ativação:** a partir daqui o cron executa
automaticamente a cada 5 minutos. A ativação é **reversível** via rollback
(§9).
j. **Verificação V2:** probes pós-deploy e observação do primeiro ciclo (≤5 min):
silêncio saudável; consulta autenticada somente leitura ao `/status` (token em
memória de sessão); logs sem aviso.

## 7. Registro de probes

- GET sem auth `https://stakeframe.com.br/status` (10/09/2026, ~22:35Z) → HTTP 200.
  **Prova apenas que a rota pública da aplicação responde** — o retorno é HTML da
  aplicação, **não o `/status` do Worker**; não comprova a proteção do monitor.
- **Probe remoto do `/status` do monitor: NÃO EXECUTADO** — o Worker ainda não
  existe (sem deploy). Será executado na janela de ativação.
- **Sem inferência por DNS:** sem autenticação Cloudflare, subdomínio, Worker,
  deployment e namespace permanecem **PENDENTES** de leitura autenticada; ausência
  de DNS não comprova ausência de recurso.
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
- Portanto **"deploy concluído" nunca implica "Telegram tocado"**. A prova de
  silêncio esperado é: **estado do DO sem entrega + logs do ciclo + observação do
  chat pelo proprietário**. `getMe` valida apenas a identidade do bot (se
  necessário); **não informa mensagens**. Não usar `getUpdates` de forma que
  interfira no consumidor Telegram existente.

## 9. Plano de rollback por versão

- **Comando válido (Wrangler 4.129.0):** `wrangler rollback <VERSION_ID> --config
infra/monitor/wrangler.jsonc`.
- **Incidente após o enable:** rollback operacional primário = **promoção imediata
  do version ID inerte** registrado no primeiro deploy (§6-d) — retorno mais rápido
  ao estado inerte conhecido.
- **Reconciliação do Git:** após o rollback remoto, abrir **PR própria** revertendo
  `MONITOR_ENABLED` (ou o ajuste necessário), com CI e revisão; o Git volta a ser a
  fonte da verdade.
- **Ciclo de vida do DO:** o primeiro deploy cria/reconcilia o Durable Object
  SQLite; **não existe versão remota anterior** que desfaça a criação. O rollback de
  versão afeta código/config do Worker, não o armazenamento do DO.
- **O rollback não remove nada:** um rollback de versão **não** remove DO, namespace
  nem segredos. Exclusão desses recursos é **operação destrutiva separada**, com
  autorização específica.
- **Pós-rollback (obrigatório):** probe sem auth → recusa; `wrangler deployments
list` provando a versão ativa; zero mensagens durante um ciclo observado.

## 10. Teste controlado de falha, recuperação e deduplicação (desenho)

Não executado nesta tarefa (envio de mensagem é proibido aqui). **Sem
indisponibilizar a aplicação, sem rota unhealthy e sem induzir incerteza de entrega
em produção** — a falha de entrega incerta permanece comprovada **somente pelo
teste automatizado**. Sequência com autorização específica:

1. Substituir temporariamente o `MONITOR_TOKEN` **somente no monitor** por um valor
   **inválido**; o valor correto permanece preservado em custódia privada.
2. Aguardar um ciclo: o monitor registra incidente (falha de verificação) →
   **1 mensagem** de incidente; registrar o `message_id` em evidência privada.
3. Aguardar outro ciclo com a mesma falha: **nenhuma mensagem adicional**
   (deduplicação).
4. Restaurar o token correto no monitor.
5. Aguardar um ciclo: **1 mensagem** de recuperação; estado volta a "quiet while
   healthy".
6. Confirmar silêncio posterior: estado do DO + logs do ciclo + observação do chat.

## 11. Custos e cotas: comprovados vs não comprovados

- **Comprovado nesta tarefa:** apenas o comportamento local (dry-run, testes). O
  dry-run não consulta cotas.
- **Não comprovado (verificar com leitura autenticada na janela de ativação):** plano
  da conta (free/paid) e seus limites de requests Workers; quota de Durable Objects
  (requests, duration, storage SQLite); invocações de cron; limites de subrequests;
  custo/retenção de logs de observabilidade.
- **Nenhum número de cota é afirmado aqui** — valores de plano variam por conta e
  devem ser lidos da API/CLI na janela, com saída sanitizada.

## 12. Evidências privadas a reter fora do Git (checklist da janela de ativação)

A evidência privada guarda **apenas metadados e resultados — nunca valores de
segredos** (estes permanecem somente nos locais de custódia aprovados e nos secret
stores necessários):

- Nomes dos segredos; presença, timestamps e versões retornados pelo provedor.
- Identidade sanitizada da conta e do Worker; subdomínio real do Worker; IDs.
- Version IDs e logs sanitizados; hashes dos artefatos deployados.
- Resultados PASS/FAIL das validações da §6-g.
- Message IDs dos testes autorizados da §10, sem tokens ou conteúdo privado.
- Destino: diretório privado na máquina do proprietário + `SHA256SUMS` (padrão já
  usado nas evidências da M0-33/M0-34). **Nunca** no repositório, PRs, issues ou
  comentários.

## 13. Limitação de runtime local

- Projeto fixa Node `v24.20.0` (`.nvmrc`, `engines >=24.20.0 <25`) e
  `pnpm@11.24.0`. A máquina local está em Node v22.23.2 — os testes locais passaram
  mesmo assim, mas a prova do runtime fixado é a **CI** (que executa no runtime
  exigido e passou 5/5). Registrado como limitação de ambiente local, não de gate.
