# STK-G0-19-R6 — Correções pós-revisão da PR #136

## Why

A revisão do Codex no head `17600ad` apontou quatro bloqueios antes de qualquer
autorização de merge: (1) o GET do detalhe não aceitava o `initData` do Mini
App; (2) os botões da resposta final não tinham comportamento real; (3) o
retorno visual ainda funcionava como gate da importação; (4) a escolha de
freebet no rascunho não validava casa, valor, política e concorrência.

## What Changes

- **Autenticação de leitura**: o GET `/api/v1/imports/:id` aceita sessão web OU
  `Telegram.WebApp.initData` validado no servidor (mesmo autorizador do PATCH);
  `validateTelegramInitData` recusa parâmetros sensíveis duplicados, `auth_date`
  muito antigo ou no futuro além de uma tolerância pequena (120 s) e usuários
  sem id positivo seguro. Testes de rota REAIS contra o app completo.
- **Botões funcionais**: 'Editar' abre o Mini App por botão `web_app` com URL
  HTTPS validada (`TELEGRAM_MINIAPP_URL`) e o UUID opaco do registro; 'Alterar
  Status'/'Alterar Casa' respondem pelo vínculo canônico (chat + id da
  mensagem) e re-sincronizam a mensagem; 'Excluir' exige confirmação explícita
  (dois toques) e executa o descarte idempotente. `callback_query` entra em
  `allowed_updates`; remetente/chat são validados; nenhum identificador viaja
  no payload de callback.
- **Retorno visual sem gate**: o candidato automático não bloqueia por
  divergência do retorno visual; a concordância OCR↔modelo deixa de considerar
  `potentialReturn` essencial; a decisão offline trata divergência como
  diagnóstico de fidelidade separado (`returnFidelityMismatch`).
- **Freebet completa no rascunho**: créditos listados já filtrados por casa
  resolvida, stake, validade, disponibilidade e política aprovada; o PATCH
  repete a validação completa sob lock; o consumo segue validado e serializado
  na transação financeira (um crédito → uma importação).

## Impact

Zero Telegram real (mocks), zero chamadas pagas, zero produção, sem migração,
`AUTOMATIC_IMPORT_ENABLED=false`, sem merge. O novo commit invalida a revisão
anterior.
