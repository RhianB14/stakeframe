# Tasks — STK-G0-20

- [x] 0. Preflight (main f29b38d, card t_29b51a01, convenções, skills) + Plugin Guard
- [x] 1. OpenSpec stk-g0-20-telegram-import-flow (antes da implementação) + Hades (decomposição)
- [x] 2. B1 Mensagens: foto sem legenda + mensagem de processamento (texto exato, UUID) + mensagem final (formato exato com emojis) + remoção da processamento (fatia 1 — commit 09a0287)
- [x] 3. B2 Financeiro: modalidades real/freebet/híbrida + retorno potencial + exibição nas três superfícies (f1: real/freebet + aritmética; f2: híbrida completa — 0014, guards, create/settle/outbox)
- [x] 4. B3 Casa/Tipster: botões + listas de ativos por organização + atualização da aposta/Web/Telegram (fatia 2)
- [x] 5. B4 Botões/Callbacks: Editar (MiniApp preenchido); Alterar Status (teclado inline exclusivo); Alterar Casa/Tipster (ativos); Excluir (Web + foto/mensagens); Cashout (seção própria com valor informado) — fatia 3
- [x] 6. B5 Status: teclado (7 opções) + limpeza ao sair de Pendente (foto, processamento, final) — fatia 3 (callbacks + API + MiniApp)
- [x] 7. B6 MiniApp/Sync: edição completa + sincronização bidirecional + versão otimista/idempotência — fatia 3 (tipster/status/cashout; odd/stake de aposta registrada fora do escopo — limitação registrada)
- [x] 8. RED→GREEN: cenários obrigatórios + suítes existentes atualizadas (f1+f2+f3; ver seções por fatia)
- [x] 9. Bateria: typecheck, lint, unit, integração, E2E desktop+mobile, api:spec:check, format, git diff --check, OpenSpec strict, deployment:rehearse
- [x] 10. diff-review + Snyk + Plugin Guard
- [x] 11. Commit/push + PR + CI completa 5/5 + card em REVIEW + devolutiva

## Fatia 2 — B2b (híbrida completa) + B3 (Casa e Tipster)

- [x] F2.1 B2b servidor: migração 0014 (inbox_bet_origin_check aceita 'hibrida'; recibo aceita 'tipster'), guards de origem no rascunho (crédito de valor DIFERENTE da stake), bet.create (parte real exposta + crédito distinto), bet.origin generalizado por `deriveBetOrigin`, invariante de exposição e bet.settle (parte real da híbrida), import.confirm canonical estendido
- [x] F2.2 B2b contratos/exibição: draftUpdateSchema/importOriginAction/Result + bet.origin/import.confirm (shared), outbox canônico com `deriveBetOrigin` + `freebetAmount`, rota origin e cliente/MiniApp/Web (radios Híbrida)
- [x] F2.3 B3 Telegram: botões `🏠 Casa de aposta` e `🗣️ Tipster` (callbacks `sf:v1:bookmaker|tipster`, seleção com id do cadastro), teclados inline com ATIVOS da organização + Voltar, handlers no callback (abrir/selecionar/voltar), `applyTipster` canônico (bet.update com versão otimista + recibo), sync pela outbox
- [x] F2.4 RED→GREEN: híbrida (criação com crédito distinto, liquidação win/void, recusa de crédito igual, isolamento por organização) + B3 (teclados só ativos, isolamento, seleção casa/tipster, idempotência, Voltar) — RED 12 falhas → GREEN (callbacks 11/11; miniapp-actions 18/18; conjunto telegram 97/97)
- [x] F2.5 Bateria da fatia: unit 233/233; integração completa; typecheck; lint; api:spec (regenerado); format; git diff --check; OpenSpec strict valid; diff-review; Snyk; Plugin Guard — registrados na devolutiva da PR

## Fatia 3 — B4 (botões e status) + B5 (MiniApp)

- [x] F3.1 B4 teclado da mensagem final: `✏️ Editar` (Mini App preenchido), `📚 Alterar Status` (callback → teclado inline próprio, NUNCA o Mini App), `🏠 Alterar Casa`/`🗣️ Alterar Tipster` (callbacks → teclados dos cadastros ATIVOS), `💸 Cashout` (seção própria do Mini App), `🗑️ Excluir` (confirmação em dois toques)
- [x] F3.2 B4 status: parser `sf:v1:status:<win|loss|pending|half_win|half_loss|void>` (revalidação no servidor); transição pelo comando canônico com versão otimista; `⏳ Pendente` no-op informativo; sair de Pendente enfileira a limpeza (foto, processamento, final) na MESMA transação; repetição converge sem efeito novo
- [x] F3.3 B4 exclusão: importação não importada → descarte com limpeza COMPLETA do Telegram (antes editava a mensagem); aposta registrada → cancelamento canônico (`bet.cancel`, chave determinística) com limpeza; repetição idempotente; aposta liquidada não é revertida (resposta sanitizada)
- [x] F3.4 B4 cashout: seção própria no Mini App (total/parcial, valor recebido INFORMADO — nunca derivado), rota `/status` estendida (`returnAmount`/`closedPrincipal` com validação), `setStatus` canônico (total encerra tudo; parcial encerra a parte declarada), limpeza só na liquidação total
- [x] F3.5 B5 MiniApp: seções `tipster` (cadastros ATIVOS separados das casas — bug do detalhe corrigido: `bookmakers` não filtrava `kind`), `status` completa (6 transições) e `cashout`; `tipsterId/tipsterName` no detalhe; sync Web/Telegram pela outbox; versão otimista + recibo idempotente; `Enviado em` imutável e `Evento em` editável (f1/f2)
- [x] F3.6 RED→GREEN: unit (layout dos botões + teclado de status + parser: RED 3 → GREEN 22/22); callbacks (status/exclusão: RED 5 → GREEN 15/15); miniapp-actions (tipster/cashout/status: 25/25); E2E desktop+mobile
- [x] F3.7 Bateria da fatia: typecheck, lint, unit, integração completa, E2E, api:spec regenerado, format, git diff --check, OpenSpec strict, diff-review, Snyk, Plugin Guard — registrados na devolutiva da PR
