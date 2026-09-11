# STK-M0-43 — Observabilidade do cron do monitor (diagnóstico e correção)

Data: 2026-09-11. Base: `74d30971b47da90d1e8793f29feaf55905ff2283`
(squash da STK-M0-42/#105). Issue: [#106](https://github.com/RhianB14/stakeframe/issues/106).
Branch: `hermes/m0-43-monitor-cron-observability` (head registrado na PR
vinculada).

**Resultado em uma linha:** a causa da não comprovação da execução do cron é
uma **lacuna de código** — a trilha de execução não era registrada no Durable
Object e o `/status` não distinguia disparo, conclusão, falha e desconhecido
(§2.2); a configuração foi revalidada na M0-42 e não tem indício de problema
(§2.1); a correção mínima foi implementada e testada (§3–§5). A **execução
real do cron continua NÃO OBSERVADA** — a correção habilita a prova por
leitura autenticada única (§7). Nenhuma mutação operacional.

## 1. Relação com as tarefas anteriores

- **STK-M0-35** — preflight do monitor (contrato, testes e matriz de gates).
- **STK-M0-37** — ativação (registro privado): Worker, cron `*/5 * * * *`,
  binding Durable Object, quatro segredos e `MONITOR_ENABLED=true`.
- **STK-M0-38** — primeira tentativa de observação; bloqueada no gate de
  autenticação.
- **STK-M0-42** — revalidou a configuração por leitura autenticada; a
  observação de execuções não foi obtida na janela (estação bloqueada; painel
  dinâmico em branco; POSTs autenticados não executáveis pelos meios
  disponíveis). **A classificação PARCIAL da M0-42 permanece preservada, sem
  reescrita**; esta tarefa prepara a próxima observação e **não** declara a
  operação validada.

## 2. Causa identificada (código × configuração × limitação de observação)

### 2.1 Configuração (sem indício de problema)

- Cron `*/5 * * * *` registrado no recurso (M0-42, gate 5) e versionado em
  `infra/monitor/wrangler.jsonc`; binding `STAKEFRAME_MONITOR` e
  observabilidade habilitada presentes; `MONITOR_ENABLED=true` na versão
  ativa.
- Nenhum ajuste de trigger, cron ou configuração foi feito nesta tarefa; não
  há evidência de causa de configuração a corrigir.

### 2.2 Código (causa da não-comprovação pelo estado persistido)

1. O handler `scheduled()` não registrava o disparo em lugar algum — um cron
   ativo sem logs acessíveis era indistinguível de um cron não disparado.
2. Com `MONITOR_ENABLED != 'true'`, o `scheduled()` retornava cedo, sem
   deixar rastro algum.
3. Falha de configuração (`configuration()` lança) interrompia o `/check`
   sem registro e sem categoria.
4. O `catch {}` do health check não guardava categoria de erro sanitizada.
5. O estado só era gravado ao final (`checked_at`/`signature`/`delivery`):
   uma execução iniciada e interrompida não era distinguível de nenhuma
   execução.
6. O `/status` não expunha disparo, início, conclusão nem categoria de erro.

### 2.3 Limitação de observação (janela anterior)

- Na janela da M0-42, a prova dependia de logs/métricas do provedor,
  inacessíveis pela estação bloqueada. Após a correção, uma **única leitura
  autenticada do `/status`** passa a provar o disparo e a conclusão (ou
  falha) sem depender desses painéis.

## 3. Correção implementada (mínima)

Arquivos: `infra/monitor/worker.mjs`,
`tests/operations/monitor.test.mjs` (+ documentação).

- **Trilha no Durable Object** — colunas aditivas com migração em vigor para
  bases legadas (`PRAGMA table_info` + `ALTER TABLE` por coluna ausente):
  `fired_at` (último disparo recebido), `started_at` (início da execução),
  `completed_at` + `result` (conclusão) e `error` (categoria sanitizada).
- **`scheduled()`** — todo disparo chega ao Durable Object (inclusive com o
  monitor desabilitado) e um `/check` recusado vira invocação com falha
  observável (o erro não é engolido).
- **`/check`** — registra o disparo antes de qualquer avaliação; a recusa de
  configuração é registrada como `result='failed'` + `error='configuration'`
  e responde 500; o claim do lease grava `started_at`.
- **Semântica** — `result` ∈ {`ready`, `attention`, `failed`};
  `error` ∈ {`configuration`, `health_check`, `null`}. Somente categorias
  fixas — nenhum valor privado ou mensagem de erro bruta.
- **Entrega Telegram** — comportamento preservado
  (`delivery` `uncertain` → `confirmed`; sem reenvio automático).

## 4. Novo contrato do `/status` (aditivo)

| Campo             | Origem    | Significado                                                       |
| ----------------- | --------- | ----------------------------------------------------------------- |
| `lastCheckedAt`   | existente | horário da última verificação concluída                           |
| `state`           | existente | `ready` / `attention` / `unknown`                                 |
| `delivery`        | existente | `uncertain` / `confirmed` / `null`                                |
| `lastFiredAt`     | **novo**  | último disparo recebido pelo Durable Object                       |
| `lastStartedAt`   | **novo**  | início da última execução (claim)                                 |
| `lastCompletedAt` | **novo**  | conclusão da última execução                                      |
| `lastResult`      | **novo**  | `ready` / `attention` / `failed` / `null`                         |
| `lastError`       | **novo**  | categoria sanitizada (`configuration` / `health_check`) ou `null` |

Interpretação (distinções exigidas pela tarefa):

- **Cron recebido:** `lastFiredAt` atualizado dentro do intervalo esperado
  (≤ ~6 min do relógio de referência).
- **Check concluído:** `lastCompletedAt >= lastStartedAt` com `lastResult`
  em `ready`/`attention`.
- **Check falhou:** `lastResult = 'failed'` — `lastError = 'health_check'`
  para falha do próprio check; `'configuration'` para configuração recusada.
- **Desconhecido / sem execução:** `lastFiredAt = null` (nenhum disparo
  registrado desde a migração) ou `lastFiredAt > lastCompletedAt` (disparo
  sem conclusão: em andamento, interrompido ou bloqueado por lease ativo).
- Bearer obrigatório; resposta sem segredos; campos anteriores inalterados
  (compatibilidade aditiva).

## 5. Testes

Comando: `pnpm operations:test` (inclui `tests/operations/monitor.test.mjs`;
os testes usam SQLite real em memória via `node:sqlite`).

| Área exigida                        | Testes                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disparo agendado                    | `routes every scheduled fire to the Durable Object and surfaces check failures`; `records fire, start and conclusion of a healthy check`                    |
| Execução bem-sucedida               | `records fire, start and conclusion of a healthy check`; `stays quiet while healthy, reports a backup incident once, then recovery`                         |
| Falha do health check               | `serializes overlapping probes and treats malformed private output as an incident`                                                                          |
| Falha de entrega Telegram           | `claims before delivery and does not resend an uncertain message after restart`                                                                             |
| Ausência de configuração            | `records a refused configuration as a sanitized failed execution`; `records fires while disabled without starting a check`                                  |
| Concorrência/lease                  | `serializes overlapping probes and treats malformed private output as an incident`; `records a fire during an active lease without starting a second check` |
| Persistência e leitura de `/status` | `keeps the private status endpoint behind the exact bearer and exposes no secrets`; `migrates a legacy monitor database without losing the stored trail`    |

## 6. Verificações executadas (ambiente local, 2026-09-11)

- `pnpm build:types` → rc 0; `pnpm typecheck` → rc 0.
- `pnpm lint` (`eslint .`) → sem achados.
- `pnpm operations:test` → **46 pass / 0 fail / 3 skipped** (skips
  pré-existentes por plataforma; inclui os 10 testes do monitor).
- `pnpm monitor:check` (wrangler dry-run) → OK (8,90 KiB; bindings
  `STAKEFRAME_MONITOR`, `APP_ORIGIN`, `MONITOR_ENABLED` conferidos).
- Formatter (`prettier --check`) nos arquivos alterados → ok;
  `git diff --check` → vazio; varredura de segredos na diferença → nenhum
  achado.
- A CI da PR (cinco checks) fica registrada na PR vinculada.

## 7. Procedimento exato para a próxima observação real do cron

Pré-requisitos: autorização específica; bearer (`MONITOR_TOKEN`) disponível
por procedimento privado aprovado; janela com a estação desbloqueada.

1. Ler `GET /status` do Worker com `Authorization: Bearer <token>`
   (uma leitura já prova o disparo; duas leituras separadas por ≥ 5 minutos
   provam o ciclo completo).
2. Registrar de forma sanitizada: `lastFiredAt`, `lastStartedAt`,
   `lastCompletedAt`, `lastResult`, `lastError`, `lastCheckedAt`, `state`,
   `delivery` e o horário local da leitura.
3. Critérios de prova: **disparo** = `lastFiredAt` recente em relação ao
   relógio; **conclusão** = `lastCompletedAt` avança entre as leituras com
   `lastResult` coerente.
4. Se `lastFiredAt` avançar sem `lastCompletedAt`, classificar como
   pendente/interrompida e investigar; se nada avançar, conferir
   `MONITOR_ENABLED` e o trigger antes de qualquer conclusão.
5. Não imprimir/copiar/expor o bearer; nenhuma mutação.

## 8. Limitações restantes

- A execução real do cron segue **não observada**; esta correção **não**
  declara o cron corrigido/validado — a prova depende da janela do §7.
- A prova por `/status` depende do bearer e de o Worker estar operacional.
- Alerta e recuperação continuam **pendentes** (nenhum incidente natural
  observado).
- A migração de schema ocorre na primeira carga do Durable Object após o
  deploy (idempotente; preserva o estado existente).

## 9. Confirmação de zero mutações e de segredos

- Nenhuma operação em Cloudflare (deploy, trigger, secrets), VPS, Telegram
  ou OpenRouter; nenhum merge; nenhuma exposição de segredos (nenhum valor
  lido, registrado ou copiado; categorias apenas).
- Alterações exclusivamente de código, testes e documentação no repositório.
