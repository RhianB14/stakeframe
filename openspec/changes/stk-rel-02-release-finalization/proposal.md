# STK-REL-02 — finalização das notas da release beta

## Por quê

1. `docs/releases/v0.1.0-beta.1.md` registra como commit-fonte
   `964a3e2fed6048a021d5c240a4f5aad33467f35d`; após a integração da STK-REL-01 a
   `main` avançou para o squash `30e2cf78bb5fd82553a73be3d1d0096a64689668`
   (registrado como pendência explícita no merge da PR #137).
2. O fluxo de release exige que a tag `v0.1.0-beta.1` aponte para um commit da
   `main` com CI verde e que as notas registrem o commit-fonte correto.

## O quê (MUST)

- Atualizar em `docs/releases/v0.1.0-beta.1.md` somente as referências que
  afirmam ser `964a3e2…` o commit-fonte da release (tabela e passo de tag).
- Auditar o repositório por referências ao SHA antigo, separando referências
  históricas legítimas (registros de rodadas/PRs/documentação histórica) das
  referências operacionais stale — atualizar apenas as operacionais.
- Confirmar que as notas continuam declarando: tag não criada, GitHub Release
  não criada, imagens não publicadas, deploy não executado, migrações
  produtivas não aplicadas e importação automática desligada; release
  **preparada, não publicada**; versão da fonte única (`package.json` raiz).
- Não alterar a versão `0.1.0-beta.1` nem o conteúdo funcional das notas além
  do necessário.

## O quê (MUST NOT)

- Tag, GitHub Release, publicação de imagens, `publish-candidate`, deploy,
  migração produtiva, ativação da importação automática, chamadas a
  Azure/Google Vision/OpenRouter/Telegram.
- Segredos, PII, corpus ou bilhetes em commit, PR, card ou logs.
