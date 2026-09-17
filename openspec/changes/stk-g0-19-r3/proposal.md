# STK-G0-19-R3 — Avaliação fiel ao fluxo e remoção da data do evento

## Why

Decisão de produto do proprietário: `placedAt` (registro da aposta) e a
data/hora do evento são coisas distintas. A data do evento não pertence à
extração automática desta fase — não deve autorizar nem bloquear importação,
não deve ser comparada como campo essencial, não deve ser persistida como data
estimada e será obtida depois por enriquecimento de eventos. Além disso, a
avaliação de decisão precisa reproduzir a ordem real do fluxo (layout, modelo,
política/digest, contexto, casa, tipo, placedAt, financeiro, duplicidade,
persistido) e o contexto privado precisa ser explícito e ligado por
`imageSha256`.

## What Changes

- `eventDateText` vira campo reservado/depreciado: sempre `null` no prompt,
  ignorado pela importação, removido dos campos essenciais do corpus e nunca
  convertido em data (função `automaticEventDate` removida).
- Toda seleção criada pela importação automática nasce `eventDate: null`,
  `eventAt: null`, `dateStatus: 'pending'` (enriquecimento posterior).
- `validation:decision` na ordem real do fluxo: layout selecionado, modelo
  aprovado, política/digest (fluxo real), OCR, contexto, casa/aliases, tipo,
  placedAt, financeiro, duplicidade (imagem e tupla casa+stake+odds+data SP) e
  dados efetivamente persistidos; métricas separadas
  (`unsafeAutoImport`, `wrongPersistedData`, `conflictAccepted`,
  `layoutOrPolicyBypass`, `crossTenantLeak`, `conservativeReview`,
  `eventEnrichmentPending`, qualidade, fidelidade do retorno).
- Contexto privado explícito (`homologationContextSchema`) por `imageSha256`.
- `potentialReturnLabels` obrigatório em toda política nova/aprovada.
- Corpus deixa de comparar `eventDateText`; cobertura de ausências passa a usar
  `placedAtText`, `potentialReturn` e `reference`.

## Impact

Sem produção, sem migração, sem policy, sem chamada paga
(OpenRouter/Azure/Google) e com `AUTOMATIC_IMPORT_ENABLED=false`. O contrato de
extração mantém `eventDateText` temporariamente por compatibilidade; a remoção
definitiva do campo fica planejada como unidade separada.
