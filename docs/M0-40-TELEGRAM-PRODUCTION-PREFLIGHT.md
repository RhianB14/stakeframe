# STK-M0-40 — Preflight do consumidor Telegram contínuo em produção

Data: 2026-09-11. Base: `6320e38fe51c4729d443d93a5902a360d8db57f6`.
Execução **somente leitura** pelo Hermes (SSH com identidade de host
conhecida); nenhuma mutação, nenhum segredo lido, nenhum `getUpdates`.

**Classificação:** a ativação do consumidor Telegram contínuo está
**mecanicamente presente** em produção, mas **não era previamente autorizada**
(o registro do [M0-24](M0-24-VALIDATION.md) exclui expressamente ativação do
Telegram e operação contínua das integrações) e **não foi operacionalmente
validada** (zero persistência; nenhuma chamada de IA registrada na base até a
leitura; consumo de updates comprovado apenas pelo avanço de cursor, cuja
natureza é desconhecida). Esta reconciliação não transforma retroativamente a
ativação em ação autorizada.

## 1. Cronologia sanitizada

| Momento (UTC)          | Evento observado                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 07/09/2026 15:35       | Container PostgreSQL criado (janela do piloto M0-24).                                                                                                                                                                                                                               |
| 07/09/2026 19:09       | API, worker, web e operações criados **com `compose.integrations.yml` em uso** (label `com.docker.compose.project.config_files`), com `TELEGRAM_ENABLED=true`, `AI_ENABLED=true` e os segredos de Telegram/OpenRouter/R2 montados desde a criação.                                  |
| 07/09/2026             | Migração aplicada (5 entradas no journal; até `0004_event_calendar`).                                                                                                                                                                                                               |
| 09/09/2026 ~17:30      | Checkout de `/opt/stakeframe` trocado; marcador `.stakeframe-revision` (0444) aponta `36c0e638…` — STK-M0-28 (#84). O diretório não contém `.git`; a revisão não é pinável por git no host.                                                                                         |
| 10/09/2026 21:41       | Contêineres **reiniciados** (mesma janela do reboot da STK-M0-33); worker voltou `healthy` e registrou apenas `WORKER_READY` desde então (sem códigos de falha).                                                                                                                    |
| 11/09/2026 16:47–17:05 | Preflight M0-40 somente leitura: consumidor **ativo** descoberto (lock e cursor). Nenhuma nova persistência ou chamada de IA foi observada; **não foi possível determinar, sem consumir ou expor updates, se o cursor avançou durante todo o intervalo** (única leitura do cursor). |

## 2. Evidência observada (sanitizada)

### 2.1 Overlays e estados booleanos

Os quatro contêineres principais foram criados com os arquivos
`compose.production.yml` + `compose.integrations.yml` +
`compose.operations.yml` (PostgreSQL apenas com o de produção).

| Contêiner | Estados booleanos observados                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| worker    | `TELEGRAM_ENABLED=true`, `AI_ENABLED=true`, `R2_ATTACHMENTS_ENABLED=true`, `THESPORTSDB_ENABLED=true`, `AUTOMATIC_IMPORT_ENABLED=false`, `MONITORING_ENABLED=true` |
| api       | `AUTH_ENABLED=true`, `R2_ATTACHMENTS_ENABLED=true`, `THESPORTSDB_ENABLED=true`, `MONITORING_ENABLED=true`                                                          |

Readiness do worker: HTTP `200` `{"status":"ready"}`.

### 2.2 Lock e cursor

- **Advisory lock do consumidor presente:** consulta **somente leitura** a
  `pg_locks` (`locktype='advisory'`, `classid=0`, `objid=782341094`) mostrou o
  advisory lock `782341094` mantido por outro backend (a sessão do worker) —
  era a única entrada de lock advisory no cluster na leitura; nenhuma função
  de aquisição de lock foi chamada pelo preflight.
- **Cursor `integration.cursor` (`name='telegram'`) presente e `nonzero`** —
  updates já foram consumidos em algum momento; rejeições avançam o cursor sem
  persistir conteúdo (contrato do código).
- Cursor `recovery-quarantine` ausente (guard de startup satisfeito).

### 2.3 Contagens sanitizadas (somente `SELECT`)

| Item                                       | Valor                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration.inbox`                        | 0 linhas                                                                                                                                           |
| `integration.extraction_request`           | 0 linhas                                                                                                                                           |
| `integration.attachment`                   | 0 linhas                                                                                                                                           |
| `pgboss.job` por estado                    | vazio (nenhum job em qualquer estado)                                                                                                              |
| Filas `pgboss.queue`                       | `system-probe`, `ticket-extraction`, `__pgboss__send-it`                                                                                           |
| `integration.ai_usage_day`                 | 0 linhas / 0 requisições — nenhuma chamada registrada **nesta base** até a leitura; o histórico do provedor não é inferível apenas por esta tabela |
| Migrações (`drizzle.__drizzle_migrations`) | 5 aplicadas; data da última: 07/09/2026                                                                                                            |

### 2.4 Artefatos de produção

- Revisão do checkout: `36c0e638…` (STK-M0-28, 09/09) — marcador 0444; árvore
  sem `.git`.
- Imagens em execução (prefixos de 12; digests completos coincidem com os
  registrados no M0-24): api `da62896345ae…`, worker `cbe6b61a5c5d…`, web
  `066ee861c447…`, operações `8f9e5f34e74e…`, PostgreSQL pinado no compose.
- Label de implantação `stk-prod-2…` presente nos cinco contêineres.

### 2.5 Segredos — apenas metadados

Os oito arquivos exigidos estão **presentes**, como arquivos regulares
(nenhum symlink), tamanho compatível (≤ 4 KiB e > 0):

`telegram_bot_token`, `telegram_owner_user_id`, `telegram_owner_chat_id`,
`openrouter_api_key`, `r2_reader_access_key`, `r2_reader_secret_key`,
`r2_writer_access_key`, `r2_writer_secret_key`.

Permissões: diretório `root:root 0700`; arquivos `0640` com proprietário
operacional (não-root); `deployment.env` `root:root 0600`. Nenhum conteúdo foi
lido, copiado, hasheado ou registrado. A existência do arquivo **não** foi
usada para inferir validade de credencial; o worker em execução aceitou o
contrato de startup (formato, igualdade configurada entre user ID e chat ID e
presença dos arquivos), mas isso **não confere os valores instalados contra a
identidade privada autorizada na STK-M0-15** (ver gate 5).

## 3. Matriz dos gates

| #   | Gate                                          | Estado                | Observação                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Base e artefatos de produção identificados    | PASS                  | Revisão `36c0e638…`, digests por prefixo e label de implantação; sem `.git` no host.                                                                                                                                                                                                                                               |
| 2   | Worker e overlays efetivamente usados         | PASS                  | Três composes nos labels de criação; rede `provider-egress` existente.                                                                                                                                                                                                                                                             |
| 3   | Migrações exigidas presentes                  | PASS                  | 5 aplicadas (até `0004`), em 07/09.                                                                                                                                                                                                                                                                                                |
| 4   | Segredos presentes com permissões corretas    | PASS                  | Metadados apenas; dentro do canônico (dir 0700; arquivos 0640; sem symlink).                                                                                                                                                                                                                                                       |
| 5   | Identidade Telegram configurada e coerente    | PARCIAL               | O startup comprova apenas formato aceito, igualdade configurada entre user ID e chat ID e presença dos arquivos; **não comprova que os valores instalados correspondem à identidade privada autorizada na STK-M0-15** — a conferência privada dos valores de produção continua necessária antes de qualquer reativação autorizada. |
| 6   | Estado atual de `TELEGRAM_ENABLED`            | PASS                  | Conhecido: **ativo** (`true`).                                                                                                                                                                                                                                                                                                     |
| 7   | Estado atual de `AI_ENABLED`                  | PASS                  | Conhecido: **ativo** (`true`).                                                                                                                                                                                                                                                                                                     |
| 8   | Credenciais R2 de anexos presentes            | PASS                  | Reader/writer/backup presentes e montados onde esperado.                                                                                                                                                                                                                                                                           |
| 9   | Cursor e backlog avaliados sem consumo        | PENDENTE              | Cursor avaliado; backlog local = 0; **backlog do lado Telegram não é observável sem `getUpdates`**, excluído da autorização.                                                                                                                                                                                                       |
| 10  | Filas e inbox em estado seguro para ativação  | PASS (reinterpretado) | Inbox/filas vazios e estáveis; a pergunta "seguro para ativação" perdeu sentido — a ativação já ocorreu sem autorização.                                                                                                                                                                                                           |
| 11  | Capacidade de interrupção e rollback definida | PASS (documento)      | Plano de contenção (§5) e reativação (§6); execução exige autorização própria.                                                                                                                                                                                                                                                     |
| 12  | Efeitos externos discriminados                | PASS (reclassificado) | Efeitos **já habilitados**: consumo/avanço de cursor comprovado; zero mensagens ou anexos persistidos na base; zero chamadas de IA registradas na base; **conteúdo e natureza dos updates consumidos desconhecidos**.                                                                                                              |
| 13  | Nenhum segredo ou conteúdo privado exposto    | PASS                  | Apenas metadados, booleanos, contagens e digests truncados.                                                                                                                                                                                                                                                                        |

## 4. Riscos atuais

1. **Consumo de updates:** qualquer mensagem nova ao bot é processada agora
   (texto é descartado; imagem da identidade autorizada é aceita).
2. **Persistência:** imagens aceitas são gravadas no PostgreSQL (limite 8 MiB
   por imagem; capacidade 2.000 entradas/1 GiB) e ficam candidatas à revisão.
3. **Chamada paga de IA:** com `AI_ENABLED=true`, uma imagem admitida pode
   gerar extração OpenRouter (cota 60/dia, 1.500/mês; teto USD 5) — **zero
   chamadas registradas nesta base até a leitura**; o histórico do provedor
   não é inferível apenas pela tabela local.
4. **Divergência documental:** `TELEGRAM.md` e `INTEGRATION-RUNTIME.md`
   registravam produção desativada; corrigidos para distinguir configuração
   padrão do estado observado.
5. **Sem alerta específico** para a ativação inesperada: o monitoramento
   externo cobre a aplicação, não o modo do consumidor.
6. **Não autorizada e não validada:** não houve janela de validação
   operacional (nenhum recebimento ponta a ponta observado).

## 5. Plano de contenção reversível (NÃO EXECUTADO — exige autorização)

Primeira opção: **parar somente o contêiner `worker`**, preservando banco,
volumes, configuração, cursor e demais serviços.

Pré-condições (provar antes de qualquer parada):

1. Nenhum job ativo ou pendente: `pgboss.job` sem estados `created`/`retry`/
   `active`; `integration.inbox` sem linhas `processing`;
   `integration.extraction_request` vazio.
2. Registrar horário UTC e o estado anterior: cinco contêineres `healthy`,
   lock presente, cursor (zero/nonzero), contagens do §2.3.

Passo único:

- `docker compose --env-file /etc/stakeframe/deployment.env -f compose.production.yml -f compose.integrations.yml -f compose.operations.yml stop worker`
  (o conjunto de arquivos idêntico ao da criação). `stop` preserva o
  contêiner parado, volumes, redes, segredos e cursor; a parada manual é
  respeitada pelo `restart: unless-stopped` inclusive após reboot do host.

Proibições durante a contenção: remover contêiner/volume/segredo/dado; `down`
ou `rm`; alterar `deployment.env`; alterar `TELEGRAM_ENABLED`/`AI_ENABLED`;
enviar mensagens Telegram; chamar OpenRouter.

Verificações posteriores:

- lock `782341094` ausente (a sessão do worker cai com a parada);
- `worker` em `exited`; api/web/PostgreSQL/operações seguem `healthy`;
- backups do contêiner de operações seguem ativos;
- nenhuma linha nova em inbox/`ai_usage_day`.

Efeitos colaterais aceitos: as demais tarefas do mesmo contêiner (consumidor
da fila de probe, dispatcher de extração, unidades mensais, verificador de
anexos e busca de eventos) ficam suspensas junto.

Reversão: `docker compose … start worker` — **somente** em reativação
autorizada separada (§6).

## 6. Reativação autorizada e validação operacional (plano posterior)

1. Autorização própria do Codex, com janela e escopo.
2. Pré-checagens na janela: backlog do lado Telegram (procedimento privado
   com `getUpdates` autorizado **ou** decisão explícita de descarte por
   offset), identidade (coerência `user`/`chat` por procedimento privado),
   R2 (bucket e credenciais por procedimento privado), política de IA
   (cota/custo) e estados atuais.
3. Reativar e observar N ciclos: logs estáveis, cursor avançando de forma
   controlada, nenhum item inesperado.
4. Validação ponta a ponta com uma mensagem de teste autorizada do
   proprietário, conferindo admissão e limites; registrar efeitos (inclusive
   a extração paga, se incluída no escopo da janela).
5. Registrar em documento próprio; somente então o item de checklist pode
   receber `[x]` com validação.

## 7. Limitações

- O backlog do lado Telegram não é observável sem `getUpdates` (excluído da
  autorização); a retenção do Telegram também limita a janela (≈24 h).
- A conferência dos valores de identidade contra a identidade privada
  autorizada não foi feita (valores não lidos); o contrato de startup aceito
  pelo worker comprova apenas formato, igualdade configurada user/chat e
  presença dos arquivos — a conferência privada segue necessária antes de
  qualquer reativação autorizada (gate 5).
- Não houve segunda leitura do cursor em horário distinto que comprovasse
  ausência de avanço durante o intervalo de observação.
- O checkout do host não tem `.git`; a revisão é registrada pelo marcador
  `.stakeframe-revision`.

## 8. Confirmações desta execução

Zero mutações: nenhum contêiner iniciado/parado/recriado; nenhum segredo
criado/alterado/lido; `getUpdates`/`setWebhook`/`deleteWebhook` não
executados; nenhuma mensagem Telegram; nenhuma chamada OpenRouter; cursor,
filas e banco intocados (apenas `SELECT`). Nenhum valor de segredo, conteúdo
privado, IP ou hostname registrado.
