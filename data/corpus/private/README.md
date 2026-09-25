# Corpus privado G0-01 — armazenamento

Este diretório recebe o corpus privado de bilhetes do gate G0-01. O contrato
completo (schema, regras de privacidade, checklist de captura e critérios de
aceitação) está em [`docs/corpus/G0-01-schema.md`](../../docs/corpus/G0-01-schema.md).

## Conteúdo

Somente estes três arquivos de estrutura são versionados:

- `.gitignore` — cobertura local (todo o restante deste diretório é ignorado).
- `README.md` — este arquivo.
- `manifest.template.json` — template do manifesto real.

Todo o restante permanece exclusivamente local (fora do Git):

- `raw/<casa>/<NNN>.<ext>` — evidência bruta; somente leitura após o hash.
- `sanitized/<casa>/<NNN>.<ext>` — derivado com redaction/blur irreversível.
- `manifest.json` — manifesto real (cópia preenchida de `manifest.template.json`).

Casas (slugs minúsculos): `bet365`, `superbet`, `novibet`.
Convenção: `<casa>/NNN` com `NNN` de `001` a `010` no mínimo
(ex.: `raw/bet365/001.png`).

## Regras

- `raw/` é somente leitura após o hash: jamais commitado, anexado ao Kanban,
  colado em logs ou usado em testes públicos.
- `sanitized/` aplica redaction/blur irreversível, remove metadados
  (EXIF etc.) e passa por revisão visual antes de ser registrado.
- Nada deste diretório além dos três arquivos de estrutura pode ser
  adicionado ao Git, a PRs, a cards do Kanban ou a logs.
- Em Linux/macOS: permissões `0700` (diretórios) e `0600` (arquivos); no
  Windows, ACL restrita ao usuário.

## Fluxo

1. `node scripts/validation/ingest-corpus.mjs data/corpus/private --init`
   cria a árvore de diretórios por casa (somente diretórios vazios).
2. Capturar os artefatos seguindo o checklist de captura do contrato.
3. Preencher o manifesto a partir de `manifest.template.json` → `manifest.json`.
4. `node scripts/validation/ingest-corpus.mjs data/corpus/private` valida o
   manifesto (schema, unicidade, convenção de paths, presença e hash dos
   arquivos, contagens por casa). O validador é somente leitura, não usa rede
   e nunca imprime conteúdo de bilhete.

A ingestão real dos 30 bilhetes aguarda o fornecimento dos artefatos pelo
proprietário; nenhum bilhete é inventado ou sintetizado como corpus.
