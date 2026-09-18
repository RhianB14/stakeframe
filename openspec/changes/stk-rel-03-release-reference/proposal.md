# STK-REL-03 — finalização da referência da release beta

## Por quê

1. `docs/releases/v0.1.0-beta.1.md` mantém um SHA fixo no campo de commit-fonte
   (`30e2cf78…`). Como cada PR integrada gera um novo squash, qualquer SHA fixo
   se torna stale imediatamente (já ocorreu duas vezes: `964a3e2…` → `30e2cf78…`).
2. A referência correta é **dinâmica**: o commit-fonte é o commit alvo da tag
   `v0.1.0-beta.1`, definido e reconfirmado no momento da autorização da tag.

## O quê (MUST)

- Remover o SHA fixo do campo de commit-fonte nas notas e adotar redação
  explícita de que o SHA será o commit alvo da tag, definido/reconfirmado na
  autorização da tag.
- Atualizar o passo de publicação: tag no commit final da `main` validado pelo
  Codex; SHA confirmado nos gates imediatamente antes da criação da tag;
  GitHub Release usa a mesma tag; nenhum SHA antigo é o commit final da release.
- Auditar referências a `964a3e2…`, `30e2cf78…` e `fa99154c…`: remover apenas
  as operacionais stale; preservar referências históricas; confirmar que
  nenhuma outra documentação trata um desses SHAs como commit final.
- Manter versão `0.1.0-beta.1`, tag candidata `v0.1.0-beta.1`, declaração de
  release não publicada e conteúdo funcional das notas.

## O quê (MUST NOT)

- Tag, GitHub Release, publicação de imagens, `publish-candidate`, deploy,
  migração produtiva, ativação da importação automática, chamadas a
  Azure/Google Vision/OpenRouter/Telegram; segredos/PII/corpus/bilhletes.
