## 1. Descoberta

- [x] 1.1 Leitura de AGENTS.md, PLAN.md, plano master, VALIDATION.md, DECISIONS, IMPORTS e OpenSpecs R1-R4
- [x] 1.2 Plugin Guard dos plugins da rodada
- [x] 1.3 Diagnostico do fluxo atual (inbox/worker/Telegram/revisao web/decisoes/importacao)

## 2. Contrato e migracao

- [x] 2.1 Migracao 0011 aditiva (inbox: bet_origin, freebet_id, event_at, event_date_status, IDs/estado/versao/edicao/exclusao Telegram; outbox idempotente) + journal/snapshot + testes
- [x] 2.2 parseCaption tipster+casa; draftUpdateSchema; importDetail com origem/datas/creditos

## 3. Implementacao

- [x] 3.1 Recebimento/processamento Telegram (vinculo privado + temporaria imediata + resposta final antes da limpeza)
- [x] 3.2 Confirmacao real/freebet (fail-closed) no rascunho e no comando
- [x] 3.3 Mini App (initData validado no servidor) e web (mesmo canônico; web nao chama Telegram)
- [x] 3.4 Outbox idempotente (retry/backoff/429/400-403/versao antiga) + mensagem final do bot
- [x] 3.5 Datas (telegramReceivedAt imutavel, eventAt/eventDateStatus) e retorno calculado
- [x] 3.6 Limpeza automatica ao sair de pending (ganha/perdida/cashout/cancelamento)

## 4. Testes e resultado

- [x] 4.1 Testes unitarios (cliente, initData, mensagem, contrato)
- [x] 4.2 Testes de integracao (rascunho canonico, importacao, outbox mockada, limpeza, isolamento)
- [x] 4.3 E2E web e Mini App (desktop/mobile quando aplicavel)
- [ ] 4.4 Reavaliacao privada da RUN-014 com validation:decision atualizado
- [ ] 4.5 Bateria completa + diff-review + Snyk + commit/push + devolutiva
