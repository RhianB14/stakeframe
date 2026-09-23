# Tasks — STK-G0-23

## R0 — confiabilidade do salvamento

- [x] 0. Preflight: main remota confirmada (`dc0e6907b1cfc09f681018e6d81f83f1a6c7a744`),
      worktree isolado em `.worktrees/t_a38c0fef`, AGENTS.md e contratos lidos
- [x] 1. Reconciliação da PR #161 por comportamento (4 classificações + evidências)
- [x] 2. Diagnóstico ponta a ponta do Mini App com evidência de três fontes divergentes
- [x] 3. Fail-closed em `applyDraftUpdate` para aposta completa (RED->GREEN)
- [x] 4. Mensagem precisa do Mini App para `STATE_CONFLICT`
- [x] 5. Precedência do registro canônico na reabertura do editor
- [x] 6. Testes: recusa sem 200 falso, PATCH idêntico aceito, casa canônica
      refletida, versão stale, falha parcial em incompleta, estorno auditável,
      reabertura com resultado vigente, repetição idempotente, persistência vs
      entrega Telegram
- [x] 7. Bateria R0 (typecheck/lint/unit/integração/build/api:spec:check/
      format/diff-check/OpenSpec strict) e diff-review
- [x] 8. Devolutiva R0 na PR #187

## R1 — edição de aposta confirmada pelos comandos canônicos

Contexto: a revisão mostrou que o fail-closed do R0 impedia o falso "salvo, mas
também recusava casa, tipster, origem/crédito e data — campos que **já têm**
comando canônico. O formulário mandava tudo pelo PATCH do rascunho, que não é
capaz de atualizar o registro financeiro.

- [x] 9. Matriz campo->comando: casa, tipster, origem/crédito e data roteiam
      pelos comandos canônicos com as versões retornadas em sequência; o PATCH
      de uma aposta confirmada passa a levar só metadados (torneio, país, tipo)
- [x] 10. Valor apostado e odd total bloqueados na interface, cada um com a
      explicação do próprio limite — sem dizer que todo o formulário é imutável
- [x] 11. Recusa ANTES de gravar o rascunho, nomeando apenas os campos sem
      caminho canônico (valor, odd, seleções, esporte, limpar tipster)
- [x] 12. Falha parcial: informa o que foi salvo e o que não foi, não anuncia
      sucesso total, não fecha o Mini App e retoma sem repetir ação já
      persistida (nenhum efeito financeiro duplicado)
- [x] 13. Testes RED->GREEN: unit do planejamento campo->comando (7) e
      integração do encaminhamento pelo caminho HTTP real (6) — casa/tipster no
      registro canônico + Web + mensagem do Telegram, origem/crédito e data sem
      efeito duplicado, recusa de valor/odd sem gravar rascunho, edição sem
      mudança salvável, versão obsoleta e falha parcial
- [x] 14. Bateria R1: typecheck, lint, unit 305/305, arquivo completo
      `telegram-miniapp-actions.test.ts` 44/44, build, OpenAPI, formatação,
      diff-check, OpenSpec strict
- [x] 15. Diff-review dos 6 arquivos alterados (883 inserções / 26 remoções)

## Fora desta change

- [ ] E2E desktop+mobile: bloqueado localmente pela CDN do Chromium; a CI roda
      os dois no mesmo head (gate `application-check`) — decidido na R0 e
      mantido na R1
- [ ] Decisão de produto pendente: comando canônico para alterar valor apostado
      e odd total de aposta confirmada (hoje bloqueio explícito, sem comando
      inventado)

Obs.: a abertura desta change ocorreu **após** a implementação (a moldura do
repositório prefere abertura antes); registrado aqui em vez de simular ordem.
