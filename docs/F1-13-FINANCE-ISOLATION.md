# STK-F1-13 — Isolamento multi-tenant do núcleo financeiro

Unidade do Plano Master 2026 que remove a limitação single-tenant do núcleo financeiro e
substitui a solução temporária de organização âncora introduzida pela STK-F1-09.

## Objetivo

Cada organização autenticada passa a ter o seu próprio espaço financeiro (catálogo, contas,
diários, apostas, freebets, unidades, relatórios, anexos e importações). Nenhuma leitura ou
escrita atravessa a fronteira da organização, mesmo quando o cliente apresenta identificadores
válidos de outra organização; a organização nunca é aceita do cliente como fonte de autoridade.

## Desenho

1. **Coluna de organização** — `organization_id uuid NOT NULL` em todas as tabelas privadas do
   schema `finance` e em `integration.inbox`, `integration.attachment`,
   `integration.extraction_request` e `integration.event_search`. As tabelas de infraestrutura
   do worker (`integration.cursor`, `integration.ai_usage_day`) permanecem globais por serem
   dados operacionais, não de negócio.
2. **Default contextual** — o default das colunas é
   `current_setting('app.organization_id', true)::uuid`: todo `INSERT` herda a organização da
   transação autenticada e um `INSERT` sem contexto falha (fail-closed), sem qualquer caminho
   que permita escrever na organização errada.
3. **Contexto** — `withOrganizationTransaction` grava o contexto com
   `SELECT set_config('app.organization_id', …, true)` (local à transação) logo após o `BEGIN`;
   o pool nunca carrega contexto residual entre conexões. As leituras usam snapshot
   `REPEATABLE READ` (nunca `READ ONLY`, que rejeita `SET LOCAL`); as escritas permanecem
   `READ COMMITTED` para preservar a serialização de chaves idempotentes.
4. **Predicado explícito** — toda consulta dos serviços carrega
   `organization_id = current_setting($$app.organization_id$$, true)::uuid`. O RLS com
   `ENABLE ROW LEVEL SECURITY` e a política `organization_isolation` (`nullif(…, '')` para
   falhar fechada) é mantido como defesa para papéis futuros sem privilégios; `FORCE` é
   deliberadamente ausente porque o ciclo de backup/restore do projeto usa um único papel
   proprietário — o `FORCE` faria o `COPY` do restore violar o `WITH CHECK` sem contexto. A
   defesa efetiva hoje são os predicados por organização.
5. **Chaves e índices** — índices únicos passam a incluir a organização: `settings(organization_id)`
   única, `catalog_alias(organization_id, kind, alias)`, `account(organization_id, bookmaker_id)`,
   `account(organization_id, kind)` (contas de sistema), `freebet(organization_id, used_by)`,
   `selection(organization_id, bet_id, position)`, `journal(organization_id, reversal_of)`,
   `command_receipt(organization_id, key)` (recibos idempotentes por organização),
   `monthly_unit(organization_id, month)` e as chaves primárias compostas de `posting`.
6. **Integridade referencial** — as referências internas do finance viraram chaves estrangeiras
   compostas `(organization_id, …)` sobre alvos únicos `(organization_id, id)`, impedindo no
   banco que uma conta, aposta, freebet, journal, posting, settlement, seleção ou anexo aponte
   para outra organização. As transferências de referências exigidas pelas FKs compostas usam
   `MATCH SIMPLE`, preservando o comportamento de colunas opcionais (`tipster_id`, `freebet_id`).
7. **Provisionamento** — o primeiro acesso autenticado de cada usuário provisiona a organização,
   o membership `owner` e o espaço financeiro (linha de `settings`, contas de sistema e catálogo
   padrão com contas de casa), de forma idempotente e serializada por advisory lock por usuário.
   É o mesmo seed que a migração 0002 aplicou à organização fundadora.

## Migração 0010 e backfill

`0010_finance_tenant_isolation.sql` é forward-only, aplicada somente em local/CI:

- **Com organização fundadora** (memberships existentes): o `ADD COLUMN` avalia o default
  contextual com o contexto definido pela própria migração — a organização `owner` mais antiga,
  critério determinístico — e a totalidade dos dados existentes é carimbada sem nenhum `UPDATE`,
  o que preserva os gatilhos de imutabilidade (`journal`, `posting`, `settlement`,
  `settlement_reversal`, `audit`, `command_receipt`, `monthly_unit`). O re-point de linhas
  órfãs é aplicado apenas às tabelas mutáveis quando o replay reconstrói o `core`.
- **Sem organização fundadora** (banco recém-migrado, nenhum cliente): o seed intocado da 0002
  é removido para que as colunas possam ser adicionadas sobre tabelas vazias; qualquer histórico
  operacional nesse estado aborta a migração (`STK-F1-13: financial history without a founding
organization`), nunca o contrário.
- **Replay-safe**: colunas com `IF NOT EXISTS`, constraints recriadas de forma condicional
  (`pg_constraint`), políticas RLS recriadas e `NO FORCE` temporário no início da migração —
  o harness `tenant-registry` reconstrói o `core` e reaplica 0005+ sem reescrever história.
- **Ensaio local**: banco descartável clonado do banco de desenvolvimento, migrado e validado
  com duas organizações reais (provisionamento, comandos e bloqueio de acesso cruzado). Nada é
  aplicado em produção por esta unidade.

## Onboarding sem âncora

O `finish` e o `statusFor` do onboarding consultam diretamente o núcleo financeiro da
organização autenticada (banca da própria organização e apostas da própria organização). A
função de organização âncora foi removida; a etapa da primeira aposta continua exigindo
decisão explícita (`registered` verificado contra `finance.bet` da organização, ou `deferred`).

## Testes

- `tests/integration/finance-tenant-isolation.test.ts` — duas organizações: provisionamento
  isolado, leitura cruzada (404 `NOT_FOUND`), liquidação/cancelamento/reversão cruzados,
  catálogos/aliases/freebets, recibos idempotentes por organização, constraints compostas
  (23503), fail-closed sem contexto, onboarding por organização sem âncora, relatórios e
  importações isolados, precisão decimal, exportação CSV/JSON cross-org (sem `cursor` e
  `ai_usage_day`), dispatch de `extraction_request` por tenant, dedupe de `sourceKey`/hash por
  organização, calendário e paginação cross-org, imagem de importação cross-org (UUID válido),
  retenção de anexos por organização, cache de busca de eventos por organização (fingerprint
  idêntico) e o registro de que nenhuma tabela usa `FORCE RLS` (o isolamento não depende dele).
- `tests/integration/tenant-registry.test.ts` — migração fresh, replay e abort fail-closed;
  verifica `finance.settings.organization_id` `NOT NULL` (coluna e dados) após o replay.
- `tests/integration/import-review.test.ts` — o caso de upgrade legado (0002 → atual) prova o
  backfill: as linhas legadas ganham a organização fundadora sem perder bytes.
- Suítes unit, integração e e2e do repositório permanecem verdes.

## Auditoria SQL (revisão R2)

Varredura mecânica de toda referência a `finance.*`/`integration.*` em `packages/db/src`,
`apps/api/src`, `apps/worker/src` e `apps/ops/src` (201 referências). Classificação:

- **Predicado explícito de organização** (`organization_id=current_setting('app.organization_id', true)::uuid`
  ou correlacionada via `a.organization_id`): toda leitura/escrita privada de runtime — inclusive
  joins, CTEs e subconsultas de calendário, relatórios, retenção, eventos, importação e exportação.
- **INSERTs que usam o `DEFAULT` org-scoped da coluna** (falha fechado sem contexto, pois a coluna é
  `NOT NULL`): journal, posting, monthly_unit, account, bet, freebet, settlement, command_receipt,
  event_search, extraction_request. Todos os call sites rodam dentro de uma transação de organização.
- **Fluxos operacionais globais explícitos** (preservados por contrato): `integration.cursor` e
  `integration.ai_usage_day` (infraestrutura sem dono); a leitura de cotas de provedor de eventos
  em `integration.event_search` (`usage()`) — intencionalmente global, pois os limites protegem o
  consumo real compartilhado do TheSportsDB/Tavily (documentado em `docs/EVENTS.md`); e as rotinas
  de backup/bundle/restore de `apps/ops` — que varrem todas as organizações de propósito e usam a
  expressão de retenção correlacionada pelo dono (`a.organization_id`), sem depender do contexto
  de sessão.

Nenhuma consulta privada ficou sem predicado ou justificativa após a varredura.

## Limitações conhecidas

- O papel de conexão atual é proprietário/superusuário do banco; o RLS é defesa em profundidade
  para o dia em que houver um papel de aplicação sem privilégios (fora do escopo desta unidade,
  que não altera credenciais nem permissões).
- O consumidor Telegram opera em nome da organização fundadora (o binding por organização do
  Telegram é unidade futura); os workers de retenção e de busca de eventos iteram todas as
  organizações, cada uma dentro do próprio contexto.
- As cotas de provedores externos de busca de eventos são globais por provedor: a contagem soma
  as buscas de todas as organizações para proteger o limite real compartilhado (fila, cache,
  resultados e histórico continuam privados por organização).
