# STK-F2-03 — Analytics: 12 splits com filtros, N e unknown

Unidade STK-F2-03 do plano master 2026 (§8.5 Analytics, §15 Plano de testes).
Base: STK-F2-02 (dashboard analítico) e o modelo financeiro existente. Nenhuma
mudança de domínio, nenhum reprocessamento histórico e nenhuma escrita
financeira.

## 1. Objetivo

Exibir os 12 splits pedidos pelo §8.5 — esporte, liga/torneio, time, jogador,
tipo de aposta, mercado, casa, faixa de odd, dia da semana, hora, live/pré-jogo
e tipster — com ROI, P&L, yield e `N` juntos em cada linha, sobre os mesmos
filtros combináveis do relatório, `unknown` preservado e aviso de baixa amostra
por split.

## 2. O que mudou

- **Novo endpoint `GET /api/v1/analytics/splits`**
  (`operationId: getAnalyticsSplits`): um payload único `AnalyticsSplits =
{ generatedAt, version, filters, minSample, lowSample, metrics, dimensions[12] }`.
  Cada dimensão vem com `id`, `label`, `source` (origem técnica), `available`,
  `note` (nota factual de cobertura) e `rows[]`; cada linha traz `key`, `label`,
  `lowSample` e o mesmo `reportMetricsSchema` do relatório — ROI, P&L, yield e
  `N` juntos, calculados no servidor.
- **Mesma base do relatório**: `report-query.ts` foi fatiado em blocos
  compartilhados (`settlementRollupSql`, `populationFilterSql`, `eligibleSql`).
  O `reportPopulation` continua **byte a byte idêntico** ao da `main` (verificado
  por comparação de string), e os splits usam `splitPopulation`, que soma ao
  mesmo filtro os rollups de mercado, de contagem de seleções/eventos (tipo de
  aposta derivado) e a odd total. Os 8 filtros do relatório (`from`, `to`,
  `bookmakerId`, `tipsterId`, `sport`, `kind`, `state`, `includeEstimated`)
  valem para as 12 dimensões, combináveis entre si.
- **Uma consulta por dimensão** (12 por cache miss) sobre a mesma população,
  com `min(label)` agrupando variações de caixa; ordem natural para as
  dimensões ordenadas (faixa de odd, dia da semana, hora, tipo de aposta) e por
  volume (`N` desc) para as demais.
- **Cache curto** reutilizando `packages/db/src/ttl-cache.ts` da F2-02: chave
  `splits|organização|versão financeira|filtros`, mesmo TTL
  (`DASHBOARD_CACHE_TTL_MS`, padrão 30 s, `0` desliga), numa instância própria
  para o payload do split nunca colidir com o do dashboard. **Sem materialized
  view.**
- **Web** (`apps/web/src/product/splits.tsx` + `splits-metrics.ts`): painel
  "Comparação por dimensão" em `#analytics`, com seletor das 12 dimensões,
  tabela `P&L realizado | ROI real | Yield real | N`, a nota factual da origem
  da dimensão e o aviso de baixa amostra quando alguma linha tem `N` abaixo do
  limiar. A lógica de apresentação é pura e testável.
- **Migração preparada** (arquivo novo, item 6) — não executada em produção.

## 3. As 12 dimensões e o que falta no modelo

Mapeamento explícito exigido pela tarefa: o que existe hoje, o que é derivado e
o que **não existe** — sem reprocessar histórico em massa.

| #   | Dimensão       | Origem (`source`)                                                            | Estado        | O que falta                                                                                                                                                |
| --- | -------------- | ---------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Esporte        | `finance.selection.sport`                                                    | coluna        | —                                                                                                                                                          |
| 2   | Liga/torneio   | `integration.inbox.metadata.userOverrides.tournament`                        | parcial       | não há coluna de liga em `finance.selection`; só o torneio digitado manualmente na importação. Resto do histórico permanece `unknown`, sem reprocessamento |
| 3   | Time           | `unavailable`                                                                | **sem fonte** | `finance.selection` guarda o evento em texto livre; não há coluna de time                                                                                  |
| 4   | Jogador        | `unavailable`                                                                | **sem fonte** | não há coluna de jogador                                                                                                                                   |
| 5   | Tipo de aposta | `derived:finance.selection` (espelha `classifyTicketKind`) + override manual | derivado      | — (1 seleção = Simples, mesmo evento = BetBuild, eventos diferentes = Múltipla; o tipo manual da importação sobrepõe o derivado)                           |
| 6   | Mercado        | `finance.selection.market`                                                   | coluna        | — (bilhete com mercados diferentes vira `Múltiplos mercados`)                                                                                              |
| 7   | Casa           | `finance.bet.bookmaker_id`                                                   | coluna        | —                                                                                                                                                          |
| 8   | Faixa de odd   | `derived:finance.bet.odds`                                                   | derivado      | — faixas: abaixo de 1,50 · 1,50 a 1,99 · 2,00 a 2,99 · 3,00 a 4,99 · 5,00 a 9,99 · 10,00 ou mais · sem odd (`unknown`)                                     |
| 9   | Dia da semana  | `derived:finance.bet.placed_at@America/Sao_Paulo`                            | derivado      | — seg..dom, na ordem natural                                                                                                                               |
| 10  | Hora           | `derived:finance.bet.placed_at@America/Sao_Paulo`                            | derivado      | — 00..23, na ordem natural                                                                                                                                 |
| 11  | Live/pré-jogo  | `unavailable`                                                                | **sem fonte** | não existe flag live/pré-jogo em nenhuma tabela do modelo                                                                                                  |
| 12  | Tipster        | `finance.bet.tipster_id`                                                     | coluna        | — (`none` = "Sem tipster")                                                                                                                                 |

Dimensões sem fonte saem com `available: false`, `source: "unavailable"`, uma
nota dizendo exatamente o que falta e **uma única linha** `key: "unknown"` /
`label: "Sem base"` com as métricas da população filtrada inteira — o `N` é o
verdadeiro número de apostas daquele recorte, nunca zero inventado. O token de
análise (`kind=all|real|freebet`) continua sendo a separação financeira, e as
dimensões acima são recortes descritivos (Plano §8.6).

## 4. Não-objetivos

- Recomendações, alertas de desempenho ou narrativa gerada por IA (§8.5/§8.6).
- Materialized view: §8.5 só a libera após medição real; esta unidade mede com
  `EXPLAIN ANALYZE` e usa consulta indexada + cache curto.
- Reprocessamento de histórico para preencher liga/time/jogador/live: proibido
  pela tarefa; o dado ausente fica `unknown` e documentado.
- Novos campos de domínio, alteração de `compose*` ou operação em produção.

## 5. Preservação de `unknown`

- `roiReal`, `yieldReal` e `profitUnits` continuam `null` quando a base é zero
  ou a unidade falta; a interface mostra **"Sem base"** (nunca `0`, que seria um
  resultado financeiro inventado) — mesma regra da F2-02.
- Chave `unknown` com rótulo próprio em cada dimensão: "Esporte a conferir",
  "Mercado a conferir", "Torneio a conferir", "Sem tipster" (categoria real,
  não ausência) e "Sem base" nas dimensões sem fonte e na faixa de odd sem
  odd.
- `lowSample` é calculado por linha no servidor (`N < minSample`), então o
  cliente não precisa — nem pode — reinterpretar o limiar.

## 6. Índices compostos e performance (EXPLAIN ANALYZE)

**Migração preparada** — `packages/db/migrations/0019_selection_rollup_index.sql`
(mais `meta/_journal.json` e `meta/0019_snapshot.json`):

```sql
CREATE INDEX IF NOT EXISTS "selection_organization_bet_rollup_idx"
  ON "finance"."selection" USING btree ("organization_id","bet_id")
  INCLUDE ("position","event","sport","market","event_date","date_status");
```

- **Justificativa**: cobre as colunas agregadas pelo rollup de seleções
  (relatório, dashboard e os 12 splits), lidera por `organization_id`
  (isolamento multi-tenant) e entrega a ordenação por `bet_id` que o rollup
  precisa (`string_agg ... order by position`), eliminando o sort quando o
  planner escolhe o caminho.
- `drizzle-orm 0.45.2` não modela `INDEX ... INCLUDE`, então a migração é
  escrita à mão e não entra no snapshot do drizzle-kit (`npx drizzle-kit
generate` responde "No schema changes", ou seja, a cadeia de snapshots
  continua consistente e um `generate` futuro não tenta derrubar o índice).
  `IF NOT EXISTS` porque os testes de replay reexecutam a cadeia de migrações.
- **NÃO executada em produção.** A execução em VPS depende de autorização
  explícita (AGENTS.md, regra 7); sendo `CREATE INDEX` não concorrente dentro
  da migração transacional, a janela exige lock de escrita curto na tabela
  `finance.selection`.

**Medição local** (`scripts/validation/splits-explain.mjs`, evidência em
`.cache/validation/splits-explain.json`, gitignored):

- Fixture `fictional-10000-v1` (10.001 apostas, 9.000 no período), banco
  **descartável** criado e derrubado pelo harness (nunca o banco local
  compartilhado nem produção); Node v26.7.0, win32.
- 26 consultas por fase: relatório (base) + os 12 splits, sem filtro e com
  filtro de casa; fases mornas (segunda passada) para não medir cache frio.
- A fase "antes" remove o índice novo (a migração roda dentro de
  `migrateLocalDatabase`) e a fase "depois" reaplica o arquivo da migração —
  a evidência registra `pg_indexes` das duas fases.
- Resultado: **total 1.672,4 ms → 1.546,3 ms (−7,5 %)**; por consulta
  42,8–144,9 ms antes e 38,4–120,2 ms depois; os 12 splits sem filtro somam
  768,3 ms → 783,6 ms (ruído de ±2 %).
- **Mudança de plano demonstrada em 6 das 26 consultas**: `Seq Scan on
selection` vira `Index Only Scan using selection_organization_bet_rollup_idx`
  em `sport`, `market` `ticketKind` e nas três variantes com filtro de casa.
  Exemplos: `ticketKind` 136 → 120 ms, `market` 86 → 72 ms,
  `ticketKind + filtro casa` 145 → 118 ms, `market + filtro casa` 94 → 66 ms.
  Em `sport` sem filtro a consulta subiu (75 → 109 ms) — dentro do ruído da
  rodada, com os buffers praticamente iguais (27.485 → 27.351).
- `finance.bet` já é lido por índice (aparece como index scan, nunca seq scan).
  `finance.settlement` e `finance.settlement_reversal` seguem seq scan porque a
  agregação é total e as tabelas são pequenas no fixture.
- **Candidatos medidos e descartados** (nenhuma mudança de plano em nenhuma
  das 26 consultas): `settlement (organization_id, bet_id) INCLUDE (...)`,
  `inbox (organization_id, imported_bet_id)`,
  `bet (organization_id, bookmaker_id)`,
  `bet (organization_id, state, placed_at)` e
  `selection (organization_id, bet_id)` **sem** `INCLUDE` (sem cobertura não há
  index-only). Todos descartados da migração — só entra o que a medição mudou.

O `EXPLAIN ANALYZE` completo (planos com `Buffers`) fica no JSON de evidência;
o harness aceita o caminho da migração como argumento para repetir a comparação:

```bash
node scripts/validation/splits-explain.mjs packages/db/migrations/0019_selection_rollup_index.sql
```

## 7. Testes

- `tests/unit/splits.test.ts` (5): ROI, P&L, yield e `N` juntos em cada linha;
  `unknown` vira "Sem base" e nunca zero; aviso de baixa amostra por split
  (conta as linhas abaixo do limiar e não avisa com `N == limiar`); teste §15
  "nenhuma recomendação enganosa em baixa amostra" (varredura de vocabulário de
  aconselhamento + exigência de que, com `lowSample`, toda célula seja número,
  `N` ou estado `unknown`); payload sem campo narrativo.
- `tests/integration/splits.test.ts` (17): um cenário por dimensão (12),
  combinatória de filtros (casa + esporte + situação + tipster + origem +
  recorte de período, com `N` coerente em todas as dimensões), `unknown`
  (esporte sem informar, torneio sem override, faixa sem odd, dimensões sem
  fonte), baixa amostra e limiar configurável, cache (identidade, invalidação
  por versão/filtro, TTL 0) e caminho HTTP (401/200/400 + `no-store`).
- `tests/e2e/product.test.ts`: fixture + rota de `/api/v1/analytics/splits` no
  `enabledProduct` e asserções do painel (seletor, `N`, `unknown` visível e
  troca de dimensão). As duas asserções que passam a ter dois candidatos no
  DOM (`Yield real`, `Baixa amostra`) agora usam `.first()` — o painel do
  dashboard continua sendo o primeiro da página.
- Regressão: unit 401/401; integração 386/386 (26 arquivos); `tenant-registry` ajustado de 14
  para 15 migrações reexecutadas (0006..0019) e
  `import-action-atomicity` de 6 para 7 migrações replayadas (0013..0019) —
  únicos testes sensíveis à contagem de migrações.

## 8. Verificação local

- **Stack local no modo staged**: `docker compose --env-file <checkout
principal>/.env.local -f compose.local.yml --profile staged up -d --build
--wait` a partir do worktree (o worktree não tem `.env.local` próprio e a
  flag `--profile` vem antes de `up`; nenhum arquivo `compose*` foi alterado).
  Serviços `postgres`, `migrate`, `api`, `worker` e `web` **healthy**; o serviço
  `migrate` aplicou a 0019 apenas no banco local.
- **Smoke**:
  - `GET /api/v1/analytics/splits?from=…&to=…` responde **503** (a mesma trava
    de auth local sem `.env.auth.local` que o `/api/v1/dashboard` devolve);
    uma rota inexistente responde **404**, então a rota nova está registrada na
    API construída do worktree;
  - `GET /` responde **200**;
  - o bundle servido (`/srv/assets/analytics-*.js` no container `web`)
    contém `Comparação por dimensão` (painel novo) e `Baixa amostra` (F2-02).
- **`pnpm validation:performance`** (mesmo fixture de 10.001 apostas, banco
  descartável): `splits-12-dimensions` com cache frio **mediana 1.384,56 ms /
  p95 1.619,04 ms / orçamento 4.000 ms (passou)**, além das reconciliações —
  12 dimensões, cada uma somando 9.000 apostas, `lowSample=false` — e os
  orçamentos pré-existentes (report 829,64 ms / 2.000 ms) todos verdes.
- **E2E**: 137 aprovados + 1 pulado (`PLAYWRIGHT_CHANNEL=chrome`) contra a
  stack local, incluindo as novas asserções do painel.

## 9. Segurança e privacidade

Mesma autorização, organização de sessão e RLS dos relatórios (a organização
sempre vem do usuário autenticado); a resposta segue `cache-control: no-store` —
o cache curto é interno ao servidor, por organização + versão + filtros. A
consulta de `integration.inbox` (torneio/tipo manual) usa o mesmo predicado de
organização de `finance-read.ts`. Nenhum segredo, serviço externo ou dado novo
persistido; nenhum arquivo de `compose*` alterado.
