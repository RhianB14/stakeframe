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
      de uma aposta confirmada passa a levar apenas o que o usuário NÃO mexeu
      (metadados + campos iguais ao registro) e nunca um campo alterado —
      `eventAt` e `sport` ficam de fora por terem linha de base de rascunho
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
- [x] 16. Regressão de CI encontrada e corrigida: no head `48d1f93` os jobs
      `application-check` e `application-arm64-check` falharam só em
      `product.test.ts:1399` ("preserva quando salvo sem mudança"), porque o
      PATCH tinha deixado de levar os campos inalterados. Corrigido para
      enviá-los iguais e continuar omitindo os alterados; origem/crédito/data
      passaram a abrir pelo registro em vez da inbox (`bet.origin` não atualiza
      a inbox). Falhas de `onboarding:232` (flake de 30 s, já conhecido) e
      `product:238` (passou no x86, só no emulador ARM64) são preexistentes

## R2 — versão do PATCH após os comandos canônicos

Contexto: a revisão mostrou que `save()` mandava o PATCH com a versão capturada
quando o PLANO foi montado (`version: detail.item.version`), ignorando a versão
devolvida pelo último comando canônico. Como cada comando avança a inbox, o
PATCH chegava obsoleto e o servidor recusava por `VERSION_CONFLICT`
(`telegram-sync.ts`: `row.version !== patch.version`) — a troca de casa ficava
persistida e o rascunho não: salvamento parcial no botão "Salvar e confirmar
aposta".

- [x] 17. Causa-raiz confirmada no código: `planConfirmedSave` recebia
      `version: detail.item.version` e o resultado era enviado direto
      (`sender(plan.patch)`), enquanto a variável local `version` já tinha
      avançado com o retorno de cada comando canônico
- [x] 18. O plano deixou de carregar `version`: `ConfirmedSaveInput` e
      `DraftPatch` não têm mais o campo e o chamador injeta a versão no ENVIO
      (`sender({ ...plan.patch, version })`) — quem envia é quem sabe a versão
- [x] 19. Retry/recuperação usam a versão alcançada: o PATCH, a confirmação da
      aposta e a alteração de status passam todos a ler a mesma variável local,
      que parte de `recovery.version` quando há falha parcial anterior
- [x] 20. Testes E2E do CLIQUE REAL (desktop + mobile, 6 cenários x 2 projetos =
      12): troca de casa, origem/crédito e data com o PATCH na versão devolvida;
      duas alterações canônicas encadeando 2->3->4 até o PATCH; falha após o
      primeiro comando com alteração parcial, Mini App aberto e retry sem
      duplicar; versão concorrente obsoleta recusada sem falso sucesso
- [x] 21. Integração contra o servidor real (3 cenários): a sequência do botão
      com o PATCH recusado na versão do plano (409 `VERSION_CONFLICT`) e aceito
      na versão devolvida (200), com a casa na Web, `tournamentOverride` gravado
      e `edit_result_message` enfileirado; encadeamento de dois comandos; e o
      fechamento da sequência após falha parcial sem re-aplicar o comando e sem
      segundo efeito financeiro
- [x] 22. Bateria R2: typecheck, lint, unit 306/306, arquivo
      `telegram-miniapp-actions.test.ts` 47/47, E2E `product.test.ts` 68/68
      (desktop + mobile), build, OpenAPI, formatação, diff-check, OpenSpec strict
- [x] 23. E2E local DESTRAVADO: o bloqueio era a CDN do Chromium
      (`chromium_headless_shell-1243`, que a CI baixa). `PLAYWRIGHT_CHANNEL`
      (navegador do sistema) + `E2E_BASE_URL` apontando para um estático do
      `apps/web/dist` fazem os dois projetos rodarem localmente — o E2E deixou
      de ser só da CI

## Fora desta change

- [ ] Decisão de produto pendente: comando canônico para alterar valor apostado
      e odd total de aposta confirmada (hoje bloqueio explícito, sem comando
      inventado)
- [ ] Remover o tipster de uma aposta confirmada não tem comando canônico

Obs.: a abertura desta change ocorreu **após** a implementação (a moldura do
repositório prefere abertura antes); registrado aqui em vez de simular ordem.
