# STK-G0-19-R5 — Fluxo definitivo de importação Telegram/Web

## Why

A homologação privada provou a extração e a decisão, mas o produto ainda não
tinha o fluxo coerente ponta a ponta: a foto chega, uma mensagem temporária
confirma o recebimento, o rascunho é analisado, o usuário confirma a origem
financeira e a data do jogo (Mini App ou web) e as duas interfaces refletem o
MESMO registro canônico. A origem financeira deixa de vir da legenda/imagem/IA
e passa a ser declaração explícita do usuário (`betOrigin`), o retorno
potencial passa a ser calculado no servidor (`stake × totalOdds`, decimal
exato) com o valor visual apenas diagnóstco, as datas ganham semânticas
separadas e o Telegram ganha outbox idempotente com limpeza automática quando
a aposta deixa de estar pendente.

## What Changes

- Legenda canônica = `tipster` + `casa` apenas; sem tipo, data ou valor.
- `betOrigin` (real|freebet|null) declarado pelo usuário; `null` ⇒ nenhuma
  aposta financeira é criada (fail-closed) e a automação fica em revisão.
- `potentialReturn = stake × totalOdds` calculado server-side; valor visual é
  diagnóstico de fidelidade; stake/odd suspeitos ⇒ revisão.
- Datas com semânticas separadas: `telegramReceivedAt` (imutável),
  `placedAt`, `eventAt` (null até confirmação) e `eventDateStatus`
  (pending|confirmed); persistir UTC, exibir no fuso.
- Fonte canônica única (banco) com duas interfaces (Telegram e web); toda
  edição: autenticação+organização, versão otimista, derivação de valores,
  auditoria sanitizada e outbox idempotente.
- Identificadores Telegram privados por importação (chat, origem,
  processamento, resposta; estado e versão de sincronização); nunca em logs,
  PR, kanban ou API pública.
- Outbox `integration.telegram_outbox` com operações
  send/edit/delete (processamento, resposta, foto), retry com backoff só em
  falhas transitórias, `retry_after` em 429, 400/403 permanentes sem loop e
  regra de que evento antigo nunca sobrescreve versão nova.
- Limpeza automática ao sair de `pending` (ganha/perdida/meio/cashout/
  reembolsada/anulada ou qualquer outro estado): exclui foto, resposta final
  e temporária sobrevivente; exclusão nunca desfaz o financeiro e mensagem
  ausente é sucesso idempotente.
- Migração aditiva 0011 (colunas no inbox + outbox), forward-only e
  compatível com registros existentes; nenhuma migração em produção.

## Impact

Zero Telegram real, zero OpenRouter/Azure/Google, zero produção/deploy/release,
`AUTOMATIC_IMPORT_ENABLED=false`, sem merge. Mocks do Bot API nos testes.
