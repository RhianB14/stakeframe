# STK-G0-19-R9 — idempotência real, créditos por casa de destino e bloqueio após liquidação parcial

## Why

A R8 introduziu as rotas `/imports/:id/bookmaker|origin|event`, mas a idempotência
efetiva ainda está acoplada ao alvo da operação: retries legítimos do mesmo pedido
colidem com a versão otimista da inbox e devolvem `VERSION_CONFLICT`, enquanto
repetições do mesmo valor (A→B→A→B) reutilizam a chave interna do comando. Além
disso, o Mini App só recebe créditos freebet da casa do rascunho (impedindo trocar
uma aposta freebet de casa pela interface), e aposentar uma aposta com
`partial_cashout` continua com `state='open'` — permitindo relabelar exposição já
liquidada.

## What Changes

- Idempotência por operação do cliente nas três rotas: header `idempotency-key`
  (UUID) obrigatório; recibo próprio por organização+chave com hash do pedido e
  resultado sanitizado; replay devolve o mesmo resultado ANTES de qualquer
  checagem de versão; mesma chave com corpo diferente ⇒ `IDEMPOTENCY_CONFLICT`;
  chave nova ⇒ executa normalmente (inclusive para valores já usados).
- Tabela de recibos `integration.import_action_receipt` (migração aditiva 0013).
- Rota autenticada `GET /api/v1/imports/:id/credits?bookmakerId=<uuid>`: créditos
  válidos POR CASA DE DESTINO (organização, casa, valor exato da stake,
  disponível, não expirado em São Paulo), quantidade limitada.
- Mini App: créditos carregados/filtrados pela casa escolhida; sem crédito
  compatível a confirmação de freebet não habilita; falha de leitura bloqueia a
  gravação (nunca reutiliza lista anterior).
- `bet.bookmaker` e `bet.origin` recusam quando existir QUALQUER settlement da
  aposta (inclusive `partial_cashout` e o revertido — fato histórico preservado)
  ou quando `remaining !== stake`; recusa sem nenhum efeito parcial.
- Nenhum journal financeiro vazio: trocas não monetárias (freebet→freebet) ficam
  registradas por auditoria/recibo, sem poluir o ledger.
- Testes: ciclos A→B→A→B, real↔freebet, D1→D2→D1; replay sem efeito duplicado;
  conflito de corpo; renderização do Telegram mockado por etapa; bloqueio de
  liquidação parcial.

## Impact

- Specs: `stk-g0-19-r9` (delta própria). Código: `packages/db` (migração 0013,
  recibos, comandos, serviço), `packages/shared`, `apps/api` (rotas), `apps/web`.
- Migração nova: 0013 aditiva (`integration.import_action_receipt`), local/CI.
- Sem mudanças de produção; PR #136 permanece não autorizada para merge.
