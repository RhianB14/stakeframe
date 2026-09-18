# STK-G0-19-R1 — Correção da homologação privada e saneamento da PR #136

## Why

A rodada privada RUN-013 (Bet365 + Superbet, OCR Azure primário + Google Vision fallback,
importação automática desativada) mediu a rota atual do candidato G0-19. A avaliação
offline expôs três defeitos de contrato que produziam erros ilegítimos ou induzidos:

- o avaliador comparava o conteúdo extraído de **negativos corretamente rejeitados**
  (rejeição cross-house), gerando 5 falsos erros essenciais na Bet365 e 2 na Superbet;
- o prompt do extrator continha um **exemplo sintético com `freebet:false`** que induzia
  o modelo a inventar `false` sem evidência (6 erros na Bet365; 10 na Superbet);
- eventos de tênis empilhados em linhas separadas eram transcritos literalmente, sem a
  forma canônica já decidida (D027), gerando 2 divergências reais na Bet365.

Além disso, a PR #136 permanecia `dirty` por carregar a cadeia histórica da #130, com
zero checks de CI, e o tipo da aposta (real × freebet) não era um contexto explícito do
envio — a importação automática recusava `freebet:null` semanticamente legítimo.

## What Changes

- `scripts/validation/corpus-core.mjs`: negativos corretamente rejeitados deixam de ser
  comparados por conteúdo; schema, vínculo de imagem/modelo e rejeição de layout
  continuam validados e o falso positivo cross-house continua bloqueando.
- `apps/worker/src/openrouter.ts` (prompt): regra `[Freebet]` (true/false somente com
  evidência explícita; ausência → null), exemplo sintético neutro (`"freebet":null`),
  regra `[Eventos empilhados]` (dois participantes em linhas separadas → "participante 1
  x participante 2" com grafia/ordem; jamais escolher x/v/vs; ambiguidade → warnings) e
  itens correspondentes na auto-verificação.
- `packages/shared/src/imports.ts`: `parseCaption` passa a exigir a terceira linha
  (`real` ou `freebet`); legado de duas linhas e valor ausente/desconhecido/ambíguo
  permanecem em revisão manual; novo motivo estável `FREEBET_CONFLICT`; `labels.kind`.
- `packages/db/src/automatic-import.ts`: o tipo informado é a fonte de verdade
  financeira; a IA apenas bloqueia conflito visual (`true` contra `real`, `false` contra
  `freebet`); `null` da IA não contradiz contexto explícito; nenhum envio antigo ou
  ambíguo pode ser importado automaticamente.
- Bancada de testes: RED→GREEN no avaliador (4 provas), prompt (regras verificáveis),
  `parseCaption` e fluxo de importação automática (contexto real/freebet e legado).
- PR #136: transplante do commit candidato sobre a `main` (`rebase --onto`), com o OCR
  da #134 como fonte de verdade e sem reintroduzir Google Document AI nem a cadeia #130.

## Impact

- Afetados: avaliação de corpus, prompt de extração, contrato da legenda, importação
  automática, UI de revisões e documentação (IMPORTS/PLAN/VALIDATION).
- Não afetados: schema do banco, rotas de API públicas (OpenAPI regenerado apenas para
  `labels.kind`/enum de motivo), gates financeiros, políticas e produção.
- `AUTOMATIC_IMPORT_ENABLED=false` permanece; nenhuma chamada paga nova; corpus,
  evaluações e ground truths preservados por SHA-256.
