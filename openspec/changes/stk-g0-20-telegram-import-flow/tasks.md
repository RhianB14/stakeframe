# Tasks — STK-G0-20

- [x] 0. Preflight (main f29b38d, card t_29b51a01, convenções, skills) + Plugin Guard
- [x] 1. OpenSpec stk-g0-20-telegram-import-flow (antes da implementação) + Hades (decomposição)
- [x] 2. B1 Mensagens: foto sem legenda + mensagem de processamento (texto exato, UUID) + mensagem final (formato exato com emojis) + remoção da processamento (fatia 1 — commit 09a0287)
- [x] 3. B2 Financeiro: modalidades real/freebet/híbrida + retorno potencial + exibição nas três superfícies (f1: real/freebet + aritmética; f2: híbrida completa — 0014, guards, create/settle/outbox)
- [x] 4. B3 Casa/Tipster: botões + listas de ativos por organização + atualização da aposta/Web/Telegram (fatia 2)
- [ ] 5. B4 Botões/Callbacks: Editar (MiniApp preenchido); Alterar Status (teclado inline exclusivo); Alterar Casa (ativas); Excluir (Web + foto/mensagens); Cashout (preservar/corrigir)
- [ ] 6. B5 Status: teclado (7 opções) + limpeza ao sair de Pendente (foto, processamento, final)
- [ ] 7. B6 MiniApp/Sync: edição completa + sincronização bidirecional + versão otimista/idempotência
- [ ] 8. RED→GREEN: 18 cenários obrigatórios + suítes existentes atualizadas
- [ ] 9. Bateria: typecheck, lint, unit, integração, E2E desktop+mobile, api:spec:check, format, git diff --check, OpenSpec strict, deployment:rehearse
- [ ] 10. diff-review + Snyk + Plugin Guard
- [ ] 11. Commit/push + PR + CI completa 5/5 + card em REVIEW + devolutiva

## Fatia 2 — B2b (híbrida completa) + B3 (Casa e Tipster)

- [x] F2.1 B2b servidor: migração 0014 (inbox_bet_origin_check aceita 'hibrida'; recibo aceita 'tipster'), guards de origem no rascunho (crédito de valor DIFERENTE da stake), bet.create (parte real exposta + crédito distinto), bet.origin generalizado por `deriveBetOrigin`, invariante de exposição e bet.settle (parte real da híbrida), import.confirm canonical estendido
- [x] F2.2 B2b contratos/exibição: draftUpdateSchema/importOriginAction/Result + bet.origin/import.confirm (shared), outbox canônico com `deriveBetOrigin` + `freebetAmount`, rota origin e cliente/MiniApp/Web (radios Híbrida)
- [x] F2.3 B3 Telegram: botões `🏠 Casa de aposta` e `🗣️ Tipster` (callbacks `sf:v1:bookmaker|tipster`, seleção com id do cadastro), teclados inline com ATIVOS da organização + Voltar, handlers no callback (abrir/selecionar/voltar), `applyTipster` canônico (bet.update com versão otimista + recibo), sync pela outbox
- [x] F2.4 RED→GREEN: híbrida (criação com crédito distinto, liquidação win/void, recusa de crédito igual, isolamento por organização) + B3 (teclados só ativos, isolamento, seleção casa/tipster, idempotência, Voltar) — RED 12 falhas → GREEN (callbacks 11/11; miniapp-actions 18/18; conjunto telegram 97/97)
- [x] F2.5 Bateria da fatia: unit 233/233; integração completa; typecheck; lint; api:spec (regenerado); format; git diff --check; OpenSpec strict valid; diff-review; Snyk; Plugin Guard — registrados na devolutiva da PR
