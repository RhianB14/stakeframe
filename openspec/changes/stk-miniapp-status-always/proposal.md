# STK-MINIAPP-STATUS-ALWAYS — edição contínua do status

## Por quê

O proprietário precisa corrigir o resultado de um bilhete pelo Mini App sem voltar
à Web. A seção de status hoje desaparece quando a aposta está incompleta ou já
foi liquidada, e a limpeza do Telegram remove a mensagem que permitiria reabrir
o Mini App.

## O quê

- Manter a seção de status no editor completo do Mini App sempre que houver uma
  aposta canônica vinculada, inclusive depois de liquidada.
- Permitir correção de uma liquidação por reversão contábil auditada e nova
  transição na mesma transação; permitir voltar para Pendente com o estorno
  preservado no histórico.
- Continuar recusando efeitos financeiros sem stake/casa/odd suficientes e
  impedir reabertura de aposta cancelada.
- Na lista de apostas, exibir data/hora do jogo, evento, seleções, mercado,
  tipo, tipster, casa, stake, odd, retornos, status/resultado e ID; diferenciar
  Simples, Múltipla e BetBuild, usando o tipo como mercado para as duas últimas.
- Ao liquidar no Mini App, remover a foto original, a mensagem temporária e a
  resposta final do Telegram. A edição posterior continua disponível pela Web.

## Impacto

Sem migração de banco. A resposta de leitura da aposta passa a incluir o tipo do
bilhete e o último resultado financeiro. Usa o comando canônico
`settlement.reverse`, o ledger existente e a outbox do Telegram.
