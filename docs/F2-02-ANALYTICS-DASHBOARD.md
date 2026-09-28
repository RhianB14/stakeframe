# STK-F2-02 — Dashboard analítico (ROI, P&L, yield e N juntos + aviso de baixa amostra)

Unidade STK-F2-02 do plano master 2026 (§8.5 Analytics, §15 Plano de testes).
Base: STK-F2-01 (shell visual/acessibilidade) e os dados financeiros já
existentes do produto. Nenhuma mudança de domínio, migração de schema ou
escrita financeira.

## 1. Objetivo

Exibir no dashboard os quatro indicadores juntos — ROI, P&L, yield e número de
apostas (`N`) — com `N` sempre visível ao lado de cada métrica derivada, aviso
de baixa amostra quando `N` estiver abaixo do limiar configurado e nenhuma
recomendação (nem leitura interpretativa) quando a amostra for pequena.

## 2. O que mudou

- **Novo endpoint `GET /api/v1/dashboard`** (`operationId: getAnalyticsDashboard`):
  uma única agregação sobre o mesmo population do relatório
  (`reportPopulation` + `reportMetricsSql`), devolvendo
  `AnalyticsDashboard = { generatedAt, version, filters, minSample, lowSample,
metrics }`. `lowSample` é calculado no servidor (`N < minSample`), para que o
  cliente não precise — nem possa — reinterpretar o limiar.
- **Nova métrica `yieldReal`**: `100 × resultado real / valor apostado real do
período` (freebets ficam fora do denominador, como no ROI). Base zero rende
  `null`, nunca `0`. Como o campo nasce do `reportMetricsSql`, relatório,
  dimensões e linha do tempo passam a carregá-lo também; ROI e yield deixam de
  ser confundidos — ROI usa o principal já encerrado, yield usa o volume
  apostado (inclui apostas ainda abertas no denominador).
- **Cache curto em memória** (`packages/db/src/ttl-cache.ts`): por processo, com
  chave `organização | versão financeira | filtros` e TTL configurável (padrão
  30 s). A versão financeira na chave invalida o cache a cada comando; o TTL
  cobre leituras repetidas do mesmo período. **Nenhuma materialized view** —
  §8.5 só as libera após medição real.
- **Configuração**: `DASHBOARD_MIN_SAMPLE` (padrão 30; 1..100000) e
  `DASHBOARD_CACHE_TTL_MS` (padrão 30000; 0..600000), lidos em
  `apps/api/src/config.ts` e validados em `createReportService` (chaves
  `INVALID_DASHBOARD_MIN_SAMPLE` / `INVALID_DASHBOARD_CACHE_TTL`).
- **Web** (`apps/web/src/product/dashboard.tsx`): painel no topo de `#analytics`
  com seis cards — P&L realizado, ROI real, Yield real, Apostas no período,
  Valor apostado real e Exposição atual. Cada card carrega uma linha
  `N = X apostas`. A lógica de apresentação é pura e testável em
  `apps/web/src/product/dashboard-metrics.ts`. O antigo `Summary` da página foi
  substituído pelo painel (stake e exposição permanecem como cards).
- **Aviso de baixa amostra**: quando `lowSample`, aparece um `role="status"`
  ("Baixa amostra · N = X apostas, abaixo do mínimo configurado de Y…") e os
  detalhes dos cards são reduzidos a números crus (valores, `N` e o estado
  `unknown` "Unidades a conferir") — nenhuma definição, comparação ou conselho.

## 3. Não-objetivos

- Os 12 splits por dimensão (STK-F2-03) e qualquer materialização de split.
- Recomendações, alertas de desempenho ou narrativa gerada por IA (§8.5/§8.6).
- Materialized view, novo índice ou migração de domínio: as consultas do
  dashboard reaproveitam os índices existentes do relatório
  (`bet_organization_id_id_idx`, `selection_bet_position_idx`,
  `settlement_bet_idx`, `bet_state_placed_idx`). Medição local em 28/09/2026
  (`EXPLAIN (ANALYZE, BUFFERS)`, banco semeado com 5.001 apostas): a agregação
  usou só varredura indexada — `Bitmap Index Scan` em `selection_bet_position_idx`
  e `settlement_organization_id_id_idx`, `Index Scan` em `bet_pkey` e
  `catalog_pkey`, sem sequential scan — 25.157 buffers e 22,2 ms de execução.
  Qualquer índice novo ou materialização exige medição em dados reais (§8.5),
  antes de existir.
- Alterações em `compose*` ou em produção (sem autorização de produção nesta
  unidade).

## 4. Preservação de `unknown`

`roiReal`, `yieldReal` e `profitUnits` continuam `null` quando a base é zero ou a
unidade falta; a UI mostra "Sem base" / "Unidades a conferir" — nunca `0`, que
seria um resultado financeiro inventado. O schema do payload torna esses campos
explicitamente anuláveis (`percent` nullable).

## 5. Testes

- `tests/unit/dashboard.test.ts` — cards juntos, `N` ao lado de cada métrica,
  `unknown` preservado, linha-régua de conteúdo em baixa amostra e o teste §15
  "Nenhuma recomendação enganosa em baixa amostra" (varredura de vocabulário de
  aconselhamento + exigência de que, com `lowSample`, toda linha de detalhe seja
  número, `N` ou estado `unknown`).
- `tests/unit/ttl-cache.test.ts` — expiração, isolamento de chaves, TTL 0,
  capacidade máxima e recusa de configuração inválida.
- `tests/integration/dashboard.test.ts` — precisão de ROI/yield/N no mesmo
  payload, arredondamento em duas casas, `null` (não `0`) sem base real,
  limiar configurável (inclusive `N == limiar` saindo do aviso), cache servido
  por identidade e invalidado por versão/filtro, e o caminho HTTP da rota (401
  sem sessão, 200 com sessão, 400 em intervalo invertido).
- `tests/e2e/product.test.ts` — mocks de `/api/v1/dashboard` e asserções de
  `Yield real`, `N = 8 apostas` ao lado das métricas e do aviso "Baixa amostra".

## 6. Segurança e privacidade

Mesma autorização e RLS dos relatórios (organização sempre vem da sessão); a
resposta global segue `cache-control: no-store` — o cache curto é interno ao
servidor e por organização+versão. Nenhum segredo, serviço externo ou dado novo
persistido; sem alteração de migração.
