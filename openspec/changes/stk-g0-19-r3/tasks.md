## 1. Descoberta

- [x] 1.1 Leitura de AGENTS.md, PLAN.md, plano master, VALIDATION.md, DECISIONS e OpenSpecs R1/R2
- [x] 1.2 Plugin Guard dos plugins da rodada (achados inalterados em relação às rodadas anteriores)
- [x] 1.3 Mapeamento de automaticEventDate, eventDateText, dateStatus e do contrato do corpus

## 2. Implementação

- [x] 2.1 eventDateText reservado/depreciado (prompt, schema, corpus essencial, docs, fixture)
- [x] 2.2 automaticEventDate removido do caminho automático; seleções nascem pending
- [x] 2.3 potentialReturnLabels obrigatório na política
- [x] 2.4 homologationContextSchema (contexto privado por imageSha256)
- [x] 2.5 validation:decision na ordem real do fluxo + contexto + metricas separadas
- [x] 2.6 Testes RED->GREEN dos 16 criterios (decisao, unit, integracao, corpus)

## 3. Resultado privado

- [x] 3.1 Contexto privado explicito por imageSha256 criado na area privada (sha256 453f56e8...; 40 entradas; variante what-if rotulada separada bff5b890...)
- [x] 3.2 Avaliacao corrigida por casa com gates TODOS zero: BET365 0 autoimportaveis/25 revisao (sem placedAt 20; tipo nao declarado 17); SUPERBET 0/25 (tipo 14; freebet 6); as-saved idem; what-if SB 9 autoimportaveis/16 revisao
- [x] 3.3 Bet365 nao homologada (dependente de placedAt real); Superbet avaliada separadamente (placedAt 20/20 pelo parser textual)

## 4. Verificações

- [x] 4.1 OpenSpec strict (valido); build:types; typecheck; lint; unit 206/206; integracao 216/216; corpus 56/56; decision 20/20; api:spec OK; format OK; git diff --check OK; rehearsal PASSED (stk-deploy-baa93a0d0c0f42c98539e1d49d817e6e); dry-run 25/25 por casa (calls 0/custo 0)
- [ ] 4.2 diff-review (0 avisos reais; incremento R3 21 arquivos); Snyk (limitacao: token OAuth expirado 401/400 nesta janela; lockfile identico a varredura valida de hoje — fastify pre-existente permanece o unico achado, t_1c86aaf5); commit/push na PR #136; devolutiva na PR e no card (REVIEW)
