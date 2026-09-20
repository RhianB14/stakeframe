# Tasks — STK-G0-22

- [x] 0. OpenSpec antes da implementação
- [x] 1. Testes RED do contrato neutro (F1); bookmaker do usuário/policy v2/financeiro nas fatias seguintes
- [x] 2. Prompt/contrato sem bookmaker (extração neutra) — F1
- [x] 3. Motor: casa do usuário resolve o catálogo; sem layoutId da IA; gates fail-closed — F2
- [x] 4. Policy v2 global (todas as casas ativas) + loader + checker — F3+F4
- [x] 5. Sincronização Telegram/MiniApp/Web para a mesma aposta — F4
- [x] 6. OpenAPI + documentação (IMPORTS/RUNTIME/DEPLOYMENT) — F4
- [x] 7. Bateria completa (typecheck, lint, unit, integração, E2E, api:spec, format, diff-check, rehearse, OpenSpec strict) — F1–F4
- [x] 8. Policy real preparada/documentada para /etc/stakeframe/automatic-import.json (instalação somente na janela autorizada — pendente)
- [x] 10. F5 — retorno por rótulo explícito, aviso conservador, segunda leitura de referência, separadores de data e auditoria RUN-015 (draft v2 + projeção local)
- [x] 12. F6 — auditoria do contrato v2/loader/checker; extensão mínima v3 com casas explícitas (aprovada/pendente/motivo/validade/digest/aprovação) + gate por casa no runtime (`BOOKMAKER_NOT_APPROVED`)
- [x] 13. F6 — policy candidata offline validada pelo checker (Bet365 aprovada; Superbet pendente com motivo; zero chamadas externas)
- [x] 14. F6 — documentação operacional (AUTOMATIC-IMPORT-POLICY.md; DEPLOYMENT/INTEGRATION-RUNTIME) — instalação na VPS fora do escopo
- [ ] 9. diff-review, Snyk, commit/push/PR e card em REVIEW — F5 (esta rodada)
- [ ] 11. Bateria completa da F5 (mesma lista da 7) + PR em REVIEW — esta rodada
- [ ] 15. F6 — bateria completa (mesma lista da 7 + deployment:rehearse) + PR em REVIEW — esta rodada
