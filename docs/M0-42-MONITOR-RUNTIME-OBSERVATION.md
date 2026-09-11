# STK-M0-42 — Validação da execução real do monitor externo (observação autenticada)

Data: 2026-09-11. Base: `7965bb52f0ccfe721958a414f7a445a497052862`
(squash da STK-M0-41/#103). Issue: [#104](https://github.com/RhianB14/stakeframe/issues/104).
Branch: `hermes/m0-42-monitor-runtime-observation` (head registrado na PR
vinculada).

**Resultado em uma linha:** a implantação e a configuração do monitor foram
**revalidadas por leitura autenticada** (todos os gates de recurso
confirmados); a **execução do cron não foi observada**: a estação de trabalho
permaneceu **bloqueada** durante toda a janela de tentativa; a aplicação
dinâmica do painel foi observada em branco/não hidratada; os POSTs
autenticados de métricas/observabilidade não puderam ser executados pelos
meios disponíveis — classificação **PARCIAL**, com o monitor **não** declarado
operacionalmente validado.

## 1. Relação com STK-M0-35, M0-37 e M0-38

- **STK-M0-35** — preflight do monitor no repositório (contrato, testes,
  matriz de gates); referência de comportamento esperado.
- **STK-M0-37** — ativação executada fora de sessão (registro privado):
  Worker, cron `*/5 * * * *`, binding Durable Object, quatro segredos e
  `MONITOR_ENABLED=true`. **Não revalidada localmente na época.**
- **STK-M0-38** — primeira tentativa de observação, **bloqueada no gate de
  autenticação** (`wrangler` sem credencial). Este documento é a **retomada
  autorizada** com a sessão Cloudflare do navegador; o bloqueio histórico da
  M0-38 é preservado sem reescrita.

## 2. Método autenticado usado

- Sessão Cloudflare do proprietário, no perfil de navegador correto (conta
  confirmada na leitura), em modo **somente leitura**.
- As leituras usaram navegação direta a rotas internas do painel
  (`/api/v4/...`), cujo retorno é JSON textual, lido pela árvore de
  acessibilidade — nenhum valor secreto, cookie ou credencial foi lido.
- A interação por teclado/mouse não esteve disponível nesta sessão (a
  estação permaneceu bloqueada — §4); as leituras por URL direta foram
  realizadas sem interação.
- A observação de execução (Cron Events / métricas / observabilidade) não foi
  alcançada pelos meios disponíveis nesta sessão: a aplicação dinâmica do
  painel foi observada em branco/não hidratada e os POSTs autenticados
  (GraphQL/telemetria) não puderam ser executados.

## 3. Gate inicial autenticado (resultado)

| #   | Gate                                        | Resultado                                                                                                                                    |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Conta correta                               | **PASS** — 1 conta, do proprietário (criada 2026-09-06); sem outras contas.                                                                  |
| 2   | Worker `stakeframe-monitor` existente       | **PASS** — criado 2026-09-11 12:21:25Z (deployments a partir de 12:21Z).                                                                     |
| 3   | Deployment/versão ativa                     | **PASS** — deployment `3ff85667…` (13:48:24Z) → versão **`026b0662…` @ 100%**.                                                               |
| 4   | Horário da versão ativa                     | **PASS** — versão ativa criada 13:48:23Z (10 versões entre 12:21Z e 13:48Z, fontes `wrangler` e `dash`).                                     |
| 5   | Cron `*/5 * * * *` registrado no recurso    | **PASS** — criado no recurso em 2026-09-11 13:58:51Z.                                                                                        |
| 6   | Binding Durable Object `STAKEFRAME_MONITOR` | **PASS** — binding `durable_object_namespace`.                                                                                               |
| 7   | Classe `StakeframeMonitor` + SQLite         | **PASS** — `named_handlers` + `exports` (`durable-object`, `storage: sqlite`).                                                               |
| 8   | `MONITOR_ENABLED=true` na versão ativa      | **PASS** — variável `plain_text` na versão ativa.                                                                                            |
| 9   | `APP_ORIGIN` para a origem esperada         | **PASS** — `plain_text` = `https://stakeframe.com.br`.                                                                                       |
| 10  | Quatro segredos por nome/tipo               | **PASS** — `MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_CHAT_ID` (`secret_text`; **nenhum valor lido**). |
| 11  | Observabilidade habilitada (pré-requisito)  | **PASS** — observability `enabled`, logs persistidos com `invocation_logs`; traces desabilitados.                                            |

Nenhum gate de recurso em estado ausente ou divergente: não houve condição de
fail-closed neste ponto.

## 4. Janelas do cron (execuções agendadas)

**0 janelas obtidas — não houve evidência suficiente para determinar qual
cenário ocorreu:** (a) cron disparado sem logs acessíveis; (b) cron não
disparado; (c) execução com erro.

Contexto observado durante a janela de tentativa (≈18:38Z–19:00Z): a estação
de trabalho permaneceu **bloqueada (tela de bloqueio do Windows)**; a
aplicação dinâmica do painel foi observada **em branco/não hidratada**; os
POSTs autenticados de métricas/observabilidade **não puderam ser executados
pelos meios disponíveis nesta sessão**. O orçamento de observação de 40
minutos não foi consumido em espera ativa nesta janela.

Leituras realizadas (registro): rotas JSON internas do painel (usadas para a
configuração do §3); abertura de janelas da rota do serviço e de
observabilidade/eventos (aplicação dinâmica em branco); GraphQL por GET
(recusado pelo provedor: "request must be a POST"); POST autenticado por
interação: não executável pelos meios disponíveis.

## 5. Estado persistido e `/status`

- **`/status` autenticado: NÃO EXECUTADO.** O bearer (`MONITOR_TOKEN`) segue
  indisponível por procedimento privado aprovado nesta sessão; conforme a
  regra da tarefa, não foi pedido, extraído ou substituído.
- Consequência: **estado do Durable Object não comprovado**; **silêncio
  saudável não comprovado**; **alerta e recuperação não comprovados**
  (nenhum incidente natural foi observado).

## 6. Endpoints públicos da aplicação (sem autenticação)

Consultados às ≈18:47Z, conforme as rotas documentadas em [API.md](API.md):

| Rota                                     | Resultado                         |
| ---------------------------------------- | --------------------------------- |
| `https://stakeframe.com.br/`             | HTTP **200**                      |
| `https://stakeframe.com.br/health/live`  | HTTP **200** `{"status":"alive"}` |
| `https://stakeframe.com.br/health/ready` | HTTP **200** `{"status":"ready"}` |

Esses endpoints **não** são o `/status` do Worker e não comprovam execução do
monitor.

## 7. Classificação final (separada)

| Item                                | Estado                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Implantação ativa                   | **COMPROVADA** (leitura autenticada)                       |
| Cron registrado                     | **COMPROVADO** (leitura autenticada)                       |
| Execuções agendadas observadas      | **NÃO OBSERVADAS** — sem evidência suficiente (§4)         |
| Consulta da aplicação comprovada    | **NÃO COMPROVADA** — dependente da execução                |
| Estado do Durable Object comprovado | **NÃO COMPROVADO** — sem `/status`/bearer                  |
| Silêncio saudável comprovado        | **NÃO COMPROVADO**                                         |
| Alerta comprovado                   | **PENDENTE** — nenhum incidente natural ocorrido/observado |
| Recuperação comprovada              | **PENDENTE**                                               |

**Classificação global: PARCIAL.** A configuração foi revalidada ponta a
ponta; a **operação segue não validada** — não há evidência suficiente de
execução recente nem de estado persistido coerente. Nenhuma afirmação além
da evidência.

## 8. Limitações

- Nesta janela não houve leitura de execuções do cron pelos meios
  disponíveis; a retomada da observação permanece pendente e pode ser
  tentada com a estação desbloqueada e/ou conforme as condições de
  desbloqueio já registradas na M0-38. A STK-M0-43 ampliou a trilha do cron
  no Durable Object e no `/status` autenticado (disparo, início,
  conclusão/falha e categoria sanitizada) para permitir a prova por leitura
  única — a classificação **PARCIAL** desta janela permanece preservada e a
  nova observação segue pendente
  ([M0-43](M0-43-MONITOR-CRON-OBSERVABILITY.md)).
- "0 janelas" **não** significa ausência de execução: não houve evidência
  suficiente para distinguir os cenários do §4 (disparo sem logs acessíveis;
  não disparo; execução com erro).
- O histórico do provedor não é inferível pelas rotas públicas da aplicação.
- Sem bearer do `/status`, o estado persistido permanece desconhecido.

## 9. Confirmação de zero mutações

- **Cloudflare:** apenas leituras (GETs autenticados). Nenhum deploy,
  rollback ou edição; nenhum trigger, binding, variável, observabilidade ou
  segredo criado/alterado; nenhum valor secreto revelado, copiado ou
  registrado.
- **VPS/worker:** nenhuma interação nesta tarefa (a VPS não foi consultada);
  não houve operação de reativação do `worker`; o último estado comprovado
  (STK-M0-41) era `stopped`, e o estado atual da VPS/worker **não foi
  revalidado** nesta tarefa.
- **Telegram/OpenRouter:** nenhuma mensagem; nenhuma chamada.
- **Local:** as janelas de navegador abertas exclusivamente para leitura
  foram fechadas ao final da verificação; nenhum login novo, nenhum token
  criado, nenhuma instalação; captura e leitura com sanitização (sem
  e-mails, identificadores de conta, tokens ou conteúdo privado no
  documento).
