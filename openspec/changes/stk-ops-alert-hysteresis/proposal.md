# STK-OPS-01 — eliminar alertas flapping do monitor operacional

## Por quê

O monitor externo (`infra/monitor/worker.mjs`) notifica em TODA mudança de
assinatura de sinais (`changed = signature !== última`), sem debounce/histerese.
Sinais que oscilam entre `ready` e atenção (retenção, processamento, orçamento
de IA) em ciclos de poucos minutos geram mensagens alternadas repetidas no
Telegram. Além disso, entrega incerta (`delivery=uncertain`) nunca é
reenviada — um alerta real pode ser perdido por falha transitória do Telegram.

## O quê (MUST)

- Transições com estabilidade configurável: `ready → atenção` somente após N
  observações consecutivas (default 3); `atenção → ready` somente após N
  observações consecutivas de recuperação; cadência de coleta inalterada.
- Uma notificação por transição estável: a mesma condição não gera mensagem a
  cada polling; recuperação somente após uma atenção previamente notificada;
  novo ciclo de atenção após recuperação volta a poder alertar.
- Assinatura normalizada (categoria:severidade, ordenada) com deduplicação de
  alertas idênticos; piora real (categoria nova ou escalada warning→failed)
  não é suprimida; cooldown configurável para alertas diferentes não-piores.
- Retry de entrega incerta: falha de envio Telegram não perde o alerta e não
  marca sucesso indevido; a confirmação continua exigindo o ack autenticado do
  provedor (`/check/confirm-delivery`).
- Estado persistente no Durable Object (migração idempotente por PRAGMA),
  sobrevivendo a reinício do worker; concorrência serializada
  (transactionSync + lease) sem mensagens duplicadas entre instâncias.
- Observabilidade sanitizada: `/status` aditivo (`lastStableSignature`), sem
  segredos, tokens, PII ou conteúdo privado em logs/métricas.

## O quê (MUST NOT)

- Alterar a cadência do cron, o contrato do endpoint privado de saúde, o fluxo
  de fotos/importação/Mini App/edição de apostas, autenticação ou isolamento.
- Deploy, migração produtiva, release, tag ou publicação — código e testes
  apenas; produção intocada nesta tarefa.

## Impacto

- `infra/monitor/worker.mjs` (estado + regras), `infra/monitor/wrangler.jsonc`
  (vars de configuração), `tests/operations/monitor.test.mjs` (contratos novos
  - 12 casos obrigatórios). Sem mudança de schema público; sem migração de banco.
