-- STK-F2-03: índice composto de cobertura para o rollup de seleções usado pelo relatório,
-- pelo dashboard e pelos 12 splits. O EXPLAIN (ANALYZE, BUFFERS) local troca o
-- "Seq Scan on selection" por "Index Only Scan using selection_organization_bet_rollup_idx"
-- (medido em 6 das 26 consultas semeadas com 10.001 apostas), e o custo total caiu.
-- A chave lidera por organização (isolamento multi-tenant) e o INCLUDE cobre as colunas
-- agregadas pelo rollup. drizzle-orm 0.45.2 não modela INDEX ... INCLUDE, por isso a
-- migração é escrita à mão e não entra no snapshot do drizzle-kit.
-- IF NOT EXISTS porque os testes de replay reexecutam este arquivo.
CREATE INDEX IF NOT EXISTS "selection_organization_bet_rollup_idx" ON "finance"."selection" USING btree ("organization_id","bet_id") INCLUDE ("position","event","sport","market","event_date","date_status");
