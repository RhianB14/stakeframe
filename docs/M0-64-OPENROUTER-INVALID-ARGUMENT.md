# STK-M0-64 — Diagnóstico e correção do `INVALID_ARGUMENT`

Data: 2026-09-13. Base: `5bf5b136378853a40fa16f7edbcd8bc8b9d46ea0`.

**Classificação: CORREÇÃO IMPLEMENTADA; validação operacional pendente.** A
única tentativa da STK-M0-63 chegou ao OpenRouter, foi encaminhada ao Google
Vertex e recebeu HTTP 400 em 1,1 s, com a resposta sanitizada
`INVALID_ARGUMENT`. Houve uma tentativa, sem fallback. Isso exclui timeout,
falha de transporte, autenticação e indisponibilidade como classificação
daquela resposta.

## Causa comprovada e limite da evidência

O código classificava todo HTTP não allowlisted como
`AI_PROVIDER_UNAVAILABLE`, ocultando a recusa de argumento. O provedor não
informou qual argumento foi recusado. Portanto, não se atribui a falha a um
campo específico.

O payload continha um JSON Schema gerado diretamente pelo Zod, com metadado de
draft e várias restrições aninhadas. A documentação do Google registra que um
schema válido, porém complexo, pode ser recusado com HTTP 400. A correção reduz
somente o schema enviado ao provedor à estrutura necessária. A validação local
completa pelo Zod permanece obrigatória antes de qualquer persistência.

## Correção

- remove recursivamente do schema do provedor `$schema`, `minLength`,
  `maxLength`, `pattern`, `minItems` e `maxItems`;
- preserva tipos, propriedades, campos obrigatórios, enums,
  `additionalProperties: false` e a estrutura aninhada;
- mantém a validação local integral de todos os limites e padrões;
- classifica HTTP 400/422 como `AI_REQUEST_INVALID`, sem persistir corpo,
  URL, credencial, imagem ou identificador do provedor;
- não adiciona retry automático e mantém uma única tentativa.

## Validação pendente

Código e testes não provam aceitação pelo provedor. Uma nova inferência ou o
reprocessamento do item preservado exigem autorização operacional explícita.
Até essa janela, a STK-M0-63 permanece PARCIAL e o item continua intacto em
`failed`.
