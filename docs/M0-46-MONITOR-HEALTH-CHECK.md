# STK-M0-46 — Investigação da falha `health_check` do monitor

## 1. Objetivo e autorização

Investigar a falha `health_check` observada no monitor externo (versão Cloudflare
`949e31cd-9ee1-4061-aaa8-7fbafa0a06d3`, falha registrada por volta de
`2026-09-12T12:34:34Z`), distinguindo falha real da aplicação, timeout, resposta
inválida, autenticação, worker parado e defeito no monitor; corrigir em código o
que a evidência comprovar; e avaliar a exposição de categoria sanitizada no
`/status`.

Escopo executado: inspeção do código; leituras Cloudflare somente leitura
(versões, schedules, settings, `wrangler tail` ao vivo) usando a sessão já
autenticada; sondas públicas à aplicação; documentação e operações Git da tarefa.
O `/status` autenticado **não foi fornecido** nesta janela e não foi acessado. O
conteúdo de segredos não foi lido. Nenhum deploy, restart, edição de recurso ou
mensagem foi executado.

## 2. Ponto de partida e método

- Base: `origin/main` em `7a921a906bc7f6f535ff847d7e0454001d77058c` (STK-M0-43),
  confirmada por `git fetch` antes da branch.
- Leituras autenticadas: `wrangler whoami`/`versions list`/`deployments list`/
  `versions view`, API de `schedules`, `settings` e `wrangler tail --format json`
  ao vivo. O download do código implantado (`/content`) retornou `405 Method not
allowed for this authentication scheme` — limitação registrada.
- Sondas públicas sem autenticação: `/health/live`, `/health/ready` e
  `/api/v1/operations/health`.

## 3. Mecanismo da categoria `health_check` (revisão de código)

No monitor (`infra/monitor/worker.mjs`), `lastError=health_check` é produzido
quando a verificação falha **por inteiro** — assinatura `application:failed` — e
não por um dos doze checks. Qualquer um destes caminhos leva a ela:

1. o `fetch` de `GET {APP_ORIGIN}/api/v1/operations/health` rejeita (rede) ou
   atinge o teto `AbortSignal.timeout(10_000)`;
2. a resposta chega com status não-2xx;
3. a leitura/leitura do corpo falha (limite de 8 KiB, JSON inválido);
4. o corpo não passa da validação (frescor de `checkedAt`, valores permitidos,
   conjunto exato dos doze checks, consistência entre `status` e os checks).

Quando a resposta **é válida** e algum check está degradado, o resultado é
`attention` com assinatura nomeada (`nome:estado`), `lastError=null` e alerta
deduplicado por mudança de assinatura. Ou seja: `health_check` exclui, por
construção, "um check específico falhou sem afetar a resposta".

## 4. Evidência autenticada (somente leitura)

- Versão ativa `949e31cd` criada **2026-09-12T12:27:51.833Z** (upload; sem tag),
  compatibilidade `2026-09-07`, handlers `scheduled` e `fetch`.
- Bindings da versão ativa: `APP_ORIGIN=https://stakeframe.com.br`,
  `MONITOR_ENABLED=true`, Durable Object `STAKEFRAME_MONITOR`/`StakeframeMonitor`,
  quatro segredos **por nome** (`MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID`); observabilidade e logs
  habilitados. Nenhum valor de segredo lido.
- Schedule implantado: **`*/5 * * * *`** (único).
- `wrangler tail` ao vivo nesta janela (execução conectada durante os disparos)
  capturou **oito execuções do check em quatro marcas de cinco minutos**
  (`12:50`, `12:55`, `13:00` e `13:05`), cada marca com duas entregas do
  agendador (≈`:01,5` e ≈`:37`); em **todas**, `scheduled` ok em ≲0,8 s e a
  invocação `/check` do Durable Object terminou com **`wallTime≈10000 ms`**
  (única variação: `10021 ms` em `13:00:01`), outcome ok, sem exceções nem
  logs; também apareceu uma requisição pública `GET` no subdomínio `workers.dev`
  no intervalo (resposta 404 esperada do handler sem bearer; sem efeito).
- Leitura do proprietário (evidência da tarefa): `lastResult=failed`,
  `lastError=health_check`, `state=attention`, `delivery=uncertain`,
  `lastCompletedAt` ≈ `12:34:34Z`.

O `wallTime` de ~10.000 ms em **todas as oito execuções do check** observadas
coincide com o teto do `AbortSignal.timeout(10_000)` do próprio monitor: o
fetch autenticado não completa dentro do orçamento — de forma persistente,
não intermitente. O horário das duas entregas por marca é comportamento do
agendador do provedor; o Durable Object registra cada disparo com o mesmo
resultado e o lease evita execuções sobrepostas.

## 5. Sondas públicas (sem autenticação, 12:40Z)

| Rota                            | Resultado                                   |
| ------------------------------- | ------------------------------------------- |
| `GET /health/live`              | 200 `{"status":"alive"}` em 0,62 s          |
| `GET /health/ready`             | 200 `{"status":"ready"}` em 0,56 s          |
| `GET /api/v1/operations/health` | **401 em 0,56 s** (rota viva; exige bearer) |

A aplicação, o banco (readiness real) e a rota de saúde respondem rápido pela
mesma borda pública que o monitor usa. "Aplicação fora do ar" e "rota ausente"
não explicam a falha.

## 6. Análise: comprovado, excluído e remanescente

**Comprovado:** o fetch autenticado do monitor não conclui dentro do teto de
10 s, em todas as execuções observadas; a falha é de tempo, não de recusa
rápida.

**Excluídos com evidência:**

- _Falha real da aplicação / indisponibilidade_: sondas públicas saudáveis e
  rápidas; `/health/ready` exercita o banco.
- _Recusa de configuração_: registraria `error=configuration`; bindings e
  segredos presentes e válidos na versão ativa.
- _Autenticação/HTTP/payload rápidos_: uma resposta 401/5xx/corpo inválido
  encerraria o check em ≪10 s; o Durable Object terminou exatamente no teto.
- _Worker parado como causa direta_: produziria resposta válida com assinatura
  `worker:failed,...` (`attention`), não `health_check`.
- _Defasagem de código da aplicação_: `apps/api/src` é **idêntico** entre o
  commit candidato do deploy em produção (`317ec268`, 07/09) e o `HEAD`;
  `readSecret` não deixa whitespace no token; o pool tem tetos (conexão 3 s,
  `statement_timeout` 3 s, `query_timeout` 5 s) e as sondas internas têm teto de
  5,5 s.
- _Defeito identificável no monitor_: a lógica de check, validação e entrega
  segue o contrato documentado; a versão implantada está corretamente
  configurada.

**Remanescente (não distinguível nesta janela):** a origem exata dos 10 s —
(i) tempo acumulado dentro do `read()` da aplicação acima do teto nominal
(nenhum passo ilimitado identificado no código, mas um comportamento de
runtime não coberto pelos testes não pode ser excluído por leitura estática) ou
(ii) atraso/estenose no caminho de entrega Cloudflare→origem específico da
requisição do monitor. A discriminação exige uma **ação operacional separada**
autorizada: leitura do `/status` pós-correção (classe sanitizada + assinatura),
logs da API na VPS (a requisição chega? quanto demora? qual status?) e/ou
reprodução autenticada controlada. Nada disso foi executado aqui.

## 7. Impacto de `delivery=uncertain`

A tentativa de alerta é gravada **antes** do envio externo; resultado não
confirmado permanece `uncertain` e **não é reenviado automaticamente**. Como a
assinatura está estável em `application:failed`, não há nova tentativa enquanto
o conjunto não mudar; uma recuperação (ou nova mudança) gerará novo envio. Não
é possível afirmar entrega ou não entrega do alerta — a conferência do chat do
proprietário é a fonte adequada. Nenhum reenvio manual foi feito nem deve ser
inferido deste registro.

## 8. Correção implementada (código)

1. **Monitor** (`infra/monitor/worker.mjs`): a categoria sanitizada de falha do
   check foi refinada — `health_check_timeout`, `health_check_network`,
   `health_check_http`, `health_check_payload` (`health_check` genérico
   preservado como fallback) — e o `/status` passou a expor `lastHttpStatus`
   (código HTTP observado; nulo sem resposta) e `lastSignature` (conjunto
   sanitizado dos checks degradados, ou `application:failed`). Migração aditiva
   de coluna (`http_status`). Alertas, deduplicação e semântica de
   `delivery=uncertain` inalterados.
2. **Aplicação** (`apps/api/src/operations.ts`): a leitura do endpoint de saúde
   ganhou **limite total de tempo** (6,5 s por padrão, parametrizável): check
   interno que não responde permanece `failed` e a resposta é produzida dentro
   do orçamento — em vez de segurar a resposta e estourar o teto do monitor.

Testes adicionados/atualizados: classes de falha do monitor (timeout, rede,
HTTP com código), exposição de `lastSignature`/`lastHttpStatus`, migração da
coluna e o limite da leitura da API (sonda pendurada responde em ~50 ms com
`worker:failed`). **Deploy não executado** — depende de autorização posterior.

## 9. Verificações executadas

- Testes do monitor: 13/13; `pnpm operations:test`: 49 aprovados, 0 falhas
  (3 skips de plataforma); unitários `tests/unit/operations.test.ts`: 10/10.
- Lint, typecheck, build, Prettier (conteúdo LF), `git diff --check` e varredura
  de segredos/identificadores: resultados registrados na PR.

## 10. Zero mutações e limitações

Nenhuma mutação: Cloudflare somente leituras (sem `secret list`, sem edição,
sem deploy); VPS e contêineres não consultados nem tocados (worker segue parado
desde a STK-M0-41); nenhuma mensagem Telegram; nenhuma chamada OpenRouter;
nenhum login novo. Limitações: `/status` sem bearer nesta janela; `/content`
indisponível para o esquema OAuth; painel dinâmico não utilizado.

## 11. Recomendações objetivas

1. **Revisão e (se aprovada) deploy** desta correção: o PR cobre monitor e
   aplicação; a ordem sugerida é monitor primeiro — a leitura seguinte do
   `/status` já discrimina a classe da falha e a assinatura.
2. **Rodada operacional separada (autorizada)** na VPS: logs da API para o
   caminho `/api/v1/operations/health` (chegada, tempo, status), estado do pool
   e locks — com o deploy do monitor antes, essa leitura confirma ou refuta a
   hipótese remanescente.
3. **Conferência no chat do proprietário** para datar o primeiro alerta
   recebido (a primeira mudança para `application:failed` dispara tentativa).
4. Não reenviar alerta manualmente; aguardar a próxima mudança natural de
   assinatura.
