# STK-G0-19-R8 — fonte canônica pós-importação e sincronização real Telegram ↔ web

## Por quê

O Codex confirmou que a R7 tornou o botão "Alterar Casa" operante apenas no
rascunho: depois da importação, a mudança não alcança a fonte financeira
(`finance.bet.bookmaker_id`), a inbox pode divergir da aposta, a outbox não
considera `bookmaker_override_id`, a mensagem resolve a casa só pela
legenda/OCR e o teste de sincronização não executa a outbox nem inspeciona o
texto final.

## O quê

- Fronteira explícita: antes da importação, o rascunho (inbox) é a fonte; depois
  de `imported_bet_id`, a fonte é `finance.bet`/`selection`/`freebet` + journals
  — nenhuma edição que afete a aposta grava só na inbox.
- Novos comandos financeiros canônicos: `bet.bookmaker` (troca de casa de
  aposta aberta com journal de reclassificação entre contas de casa; freebet
  exige crédito compatível na mesma operação ou recusa sanitizada) e
  `bet.origin` (real↔freebet com journals compensatórios e consumo/liberação
  atômica de crédito). Data de evento pós-importação usa o comando canônico de
  evento (`bet.update` montado no servidor por seleção).
- Rotas canônicas no Mini App/web (`POST /imports/:id/bookmaker|origin|event`)
  que roteiam pré (updateDraft) e pós (comandos financeiros), com versão
  otimista, idempotência determinística, auditoria sanitizada e sincronização
  do Telegram por outbox na mesma transação.
- Renderização canônica do Telegram: pós-importação a mensagem carrega aposta,
  casa, tipster, origem, seleções e datas das tabelas financeiras; pré-importação
  usa o rascunho (com a casa declarada).
- Testes RED→GREEN dos 20 itens obrigatórios, incluindo execução real da outbox
  com cliente Telegram mockado e inspeção do corpo de `editMessageText`.

## Impacto

- Sem migração nova (journals usam `kind` textual; `bookmaker_override_id` já
  existe desde a 0012).
- OpenAPI regenerado; contrato de detalhe ganha seleções/casa canônica do bet.
