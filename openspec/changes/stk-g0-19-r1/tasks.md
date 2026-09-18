## 1. Descoberta e diagnóstico

- [x] 1.1 Ler AGENTS.md, PLAN.md, plano master, VALIDATION.md, DECISIONS (D025-D032), IMPORTS.md
- [x] 1.2 Ler openrouter.ts, imports.ts, automatic-import.ts, corpus-core.mjs e testes associados
- [x] 1.3 Plugin Guard (CLI) dos plugins da rodada e registro no card t_d6b7a3c1
- [x] 1.4 Diagnóstico da rodada RUN-013 (Bet365 13 erros; Superbet 21 erros; classes por campo)

## 2. Preservar RUN-013

- [x] 2.1 Aguardar a janela Superbet terminar sem interromper nem alterar código
- [x] 2.2 Auditoria sanitizada (chamadas, falhas, custo, OCR, hashes) e manifesto RUN-013-HASHES.txt
- [x] 2.3 Avaliação offline inicial sem policy; nenhuma chamada paga nova

## 3. Sincronização da branch (PR #136)

- [x] 3.1 `git rebase --onto origin/main 5cd6f98` da branch `hermes/stk-g0-19-ocr-homologation`
- [x] 3.2 Resolver conflitos preservando o OCR da #134; sem Google Document AI nem histórico #130
- [x] 3.3 Portar superfícies de configuração coerentes com o runtime final (http.ts, env/compose/config, worker package.json)
- [x] 3.4 Diff final contendo apenas o delta G0-19/R1 sobre a main

## 4. Avaliador de negativos (RED→GREEN)

- [x] 4.1 Quatro provas novas em corpus.test.mjs (rejeição sem erros; FP bloqueia; schema/hash/model; cobertura)
- [x] 4.2 RED registrado (32/35, 65/70 erros falsos) e GREEN após correção (35/35)
- [x] 4.3 Reavaliação offline: Bet365 13→8 (5 falsos removidos) e Superbet 21→19 (2 falsos removidos)

## 5. Contrato freebet e contexto real|freebet

- [x] 5.1 Prompt: regra [Freebet], exemplo neutro e auto-verificação
- [x] 5.2 parseCaption com terceira linha fail-closed; motivo estável FREEBET_CONFLICT; labels.kind
- [x] 5.3 Importação automática: contexto como verdade, conflito visual bloqueia, null não contradiz
- [x] 5.4 UI: hint/placeholder da legenda, rótulo do motivo e exibição do tipo informado

## 6. Eventos empilhados

- [x] 6.1 Regra determinística no prompt (forma canônica, sem escolher separador, ambiguidade em warnings)
- [x] 6.2 Testes verificáveis do prompt

## 7. Validação

- [x] 7.1 build:types, typecheck, lint, unit (203/203), integration (209/209)
- [x] 7.2 validation:test-corpus (35/35) e api:spec:check (OPENAPI_VALID_AND_CURRENT)
- [x] 7.3 format:check com o mesmo critério da CI e git diff --check (OK)
- [x] 7.4 Deployment rehearsal (PASSED, stk-deploy-670d7001f8cb47c28c01e06e84da0d4b)
- [x] 7.5 Dry-run 25/25 por casa (zero rede, chamadas, escrita e custo)

## 8. Segurança e entrega

- [x] 8.1 diff-review integral do delta contra a main (0 avisos no incremento R1; 1 console.log de CLI no harness)
- [ ] 8.2 Snyk SCA (SAST se disponível)
- [ ] 8.3 Commit e push --force-with-lease (lease 8f64bae) na mesma branch/PR #136
- [ ] 8.4 Devolutiva no card t_d6b7a3c1 e na PR; card em REVIEW (nunca DONE)
