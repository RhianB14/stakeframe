# STK-G0-23 — confiabilidade do salvamento no Mini App

## Por quê

O caminho Telegram -> Mini App -> "Salvar e confirmar aposta" aceitava uma
edição de aposta JÁ CONFIRMADA com `200`, gravando apenas a inbox (rascunho).
A aposta financeira (`finance.bet`/`finance.selection`) e a mensagem do
Telegram — que leem o canônico — ficavam com os valores antigos. Resultado:
três fontes divergentes (rascunho, aposta financeira, mensagem) anunciando
"salvo".

Evidência do diagnóstico (fixture sintética, aposta completa, PATCH com
stake 250,00 / odd 3,50 / casa Superbet / seleção C x D):

- resposta do servidor: `200 {"version":4,...}`
- `finance.bet`: `stake=100.00 odds=2.0000 bookmaker=Bet365`
- `finance.selection`: `A x B`
- `detail.stakeOverride=250.00`, `detail.oddsOverride=3.50` (o que a tela mostra)
- mensagem do Telegram: `stake: canonical.stake` -> `100.00`

Segundo defeito reproduzido: na reabertura o editor inicializava os campos a
partir dos **overrides do rascunho** antes do registro canônico, exibindo
casa/tipster/valor/odd/seleções vigentes em desacordo com o que a mensagem
mostrava.

## O quê

- Fail-closed no servidor: `applyDraftUpdate` lê a aposta **antes** de gravar a
  inbox; quando `completion_state='complete'`, qualquer divergência em valor,
  odd, casa, tipster, crédito, origem, seleções, data ou esporte é recusada com
  `409 STATE_CONFLICT` e a transação inteira é abortada (nada de rascunho
  gravado em estado mentiroso). Um valor **igual** ao vigente não é divergência,
  então um PATCH idêntico continua sendo aceito.
- Mensagem precisa no Mini App para `STATE_CONFLICT`, deixando explícito que
  nada foi salvo.
- Precedência do canônico na inicialização do editor (reabertura), cobrindo
  valor, odd, casa, tipster e seleções.

## Fora de escopo / bloqueio

Alterar **valor** ou **odd total** de uma aposta já confirmada continua sem
comando financeiro canônico (`bet.origin`, `bet.bookmaker` e `bet.update` não
cobrem stake/odd total). Permitir isso exige um novo comando com efeito
contábil (exposição, retorno, estorno se liquidada) — decisão de produto e
mudança de contrato, devolvida ao Codex em STK-G0-23.
