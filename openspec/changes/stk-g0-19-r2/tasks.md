## 1. Descoberta

- [x] 1.1 Ler AGENTS.md, PLAN.md, plano master, VALIDATION.md, DECISIONS, IMPORTS.md e a change stk-g0-19-r1
- [x] 1.2 Plugin Guard dos plugins da rodada
- [x] 1.3 Diagnóstico dos seis bloqueios (SQL, prompt, parser, GT, decisão)

## 2. Implementação

- [x] 2.1 Casa informada como verdade (null aceitável; outra casa; não resolvido; sem cópia)
- [x] 2.2 potentialReturnLabels digest-bound + contexto ao modelo + OCR fail-closed
- [x] 2.3 Parser textual Superbet + 4ª linha da legenda + reconciliação de instante
- [x] 2.4 Referência vazia sem valor sintético (schema aceita ''; dedup bloqueia)
- [x] 2.5 Isolamento da deduplicação (precedência) + testes cross-tenant/in-org
- [x] 2.6 Ground truth Superbet v6 após inspeção visual (v5 preservado)
- [x] 2.7 Avaliação de decisão offline (core + CLI + testes + script)

## 3. Validação

- [x] 3.1 OpenSpec strict (valido); build:types; typecheck; lint; unit (205/205)
- [x] 3.2 Integração completa (216/216); testes de corpus (45/45); avaliação de decisão (10/10; B365/SB gates 0; SB com layout textual 9 autoimportaveis)
- [x] 3.3 api:spec OK; format OK; git diff --check OK; deployment rehearsal PASSED (stk-deploy-e57bf90d164b48efa955585404c88fa3)
- [x] 3.4 Dry-run 25/25 por casa (zero rede/chamadas/escrita/custo); diff-review (0 avisos reais); Snyk (somente fastify pre-existente, t_1c86aaf5)

## 4. Entrega

- [ ] 4.1 Commit e push na PR #136; devolutiva na PR e no card (REVIEW)
