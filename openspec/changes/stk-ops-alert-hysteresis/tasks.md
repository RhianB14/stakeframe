# Tasks — STK-OPS-01

- [x] 0. Preflight (main c26ae656, flag false, card, convenções) + Plugin Guard
- [x] 1. OpenSpec stk-ops-alert-hysteresis (antes da implementação)
- [x] 2. Hades: decomposição (sem subagentes — arquivo único + testes, sequencial)
- [x] 3. RED: 12 casos obrigatórios + contratos atualizados (histerese, retry)
- [x] 4. Implementação: colunas persistentes + regras de estabilidade/dedupe/retry + config
- [x] 5. GREEN: operations:test completo + casos novos
- [x] 6. Bateria: build/types, typecheck, lint, unit, integração, api:spec, format, git diff --check, monitor:check (operations:test 69/72 — 3 skipped pré-existentes; monitor.test.mjs 33/33; unit 233/233; integração 291/291; typecheck/lint/api:spec/format/git diff --check/monitor:check OK)
- [x] 7. diff-review + Snyk + commit/push/PR + CI 5/5 (diff-review 0 avisos em 5 arquivos +602/-49; Snyk SCA 1 High pré-existente fastify t_1c86aaf5 — manifests intocados; SAST SNYK-CODE-0005; PR #142 aberta; CI 5/5 success no head 03f9798)
- [x] 8. Devolutiva na PR e card t_f8bf7eda em REVIEW (nunca DONE) (devolutiva postada 2026-09-18T22:57:44Z na PR #142; validação pós-deploy em card de follow-up t_4bca9c5e — exige janela autorizada wrangler deploy --keep-vars)
