# Tasks — STK-G0-19-R10

- [x] 0. OpenSpec r10 (antes da implementação)
- [x] 1. Testes RED (atomicidade, retry, contrato, receipt tipado)
- [x] 2. Refatorar updateDraft para operação interna por cliente/transação
- [x] 3. Três ações de rascunho atômicas (lock+replay+efeito+recibo na mesma tx)
- [x] 4. Retry do frontend para NETWORK_ERROR com a mesma chave
- [x] 5. Headers no schema das rotas + openapi regenerado + contrato
- [x] 6. Schema Drizzle de import_action_receipt + 0013 (jsonb/checks) + snapshot
- [ ] 7. Bateria completa + migrações (replay/upgrade/drift) + mutações
- [ ] 8. diff-review, Snyk, commit/push/CI, devolutiva e card em REVIEW
