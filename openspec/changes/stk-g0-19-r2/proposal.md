# STK-G0-19-R2 — Correções bloqueantes da revisão da PR #136

## Why

A revisão do Codex na PR #136 bloqueou a integração com seis exigências: (1) o
bookmaker informado pelo usuário precisa ser a fonte de verdade mesmo com marca
ausente na imagem; (2) os rótulos financeiros variam por casa e devem virar
política digest-bound do layout (o prompt atual proíbe `PRÊMIO`, causa de cinco
das seis omissões Superbet); (3) a data da aposta exige parser do formato
textual Superbet e uma quarta linha opcional na legenda; a referência ausente
Bet365 não pode ser inventada; (4) a consulta de duplicatas tem bug de
precedência (`org AND imagem OR referência OR similaridade`) que anula o
isolamento nas duas últimas cláusulas; (5) o ground truth Superbet precisa de
v6 após inspeção visual (corte real, período ao vivo, separadores permitidos,
erro de referência preservado); (6) a homologação precisa de uma avaliação
offline orientada à decisão real de importação.

## What Changes

- `automatic-import.ts`: casa informada como verdade (null aceitável, outra
  casa bloqueia, texto não resolvido fail-closed, sem copiar contexto para a
  extração); reconciliação de data imagem × 4ª linha (mesmo instante); referência
  vazia permitida sem valor sintético.
- `packages/shared`: `potentialReturnLabels` opcional e digest-bound no layout;
  quarto campo `date` na legenda; `parseAutomaticPlacedAt` ganha o formato
  textual (`br-textual-sao-paulo`, meses PT-BR, separadores hifen/en/em-dash
  apenas entre data e hora).
- `openrouter.ts`: rótulos autorizados no contexto dos layouts enviado ao
  modelo; regra de retorno reescrita; verificação OCR detecta rótulo autorizado
  visível sem valor e valor sem rótulo autorizado.
- `import-review.ts`: precedência corrigida — `organization_id` cobre imagem,
  referência E similaridade; testes cross-tenant e in-org.
- `scripts/validation`: nova avaliação de decisão offline (AUTO_IMPORT_EXPECTED
  × MANUAL_REVIEW_EXPECTED, gates de segurança, métricas de qualidade
  separadas) com CLI e testes; `validation:decision`.
- Ground truth Superbet v6 na área privada (v5 preservado por SHA-256),
  criado somente após inspeção visual.
- PR #136: mesmo branch; novo commit invalida a revisão anterior.

## Impact

- Sem produção, sem migração, sem policy, sem chamada paga nova em nenhum
  provedor (OpenRouter/Azure/Google). `AUTOMATIC_IMPORT_ENABLED=false`.
