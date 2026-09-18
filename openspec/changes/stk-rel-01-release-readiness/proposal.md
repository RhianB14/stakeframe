# STK-REL-01 — auditoria e preparação da primeira release beta

## Por quê

1. A primeira release beta (`v0.1.0-beta.1`) precisa de auditoria técnica antes de
   qualquer tag, GitHub Release ou publicação: versão, notas, pipeline de release,
   os cinco artefatos, migrações pendentes e procedimento de rollback.
2. Não existe changelog oficial (`docs/releases/` ausente) — as notas da primeira
   release precisam ser criadas a partir de fatos verificáveis do histórico da main.
3. O pipeline de release (candidato → registro aprovado → publicação) e o
   procedimento de rollback foram construídos em unidades anteriores (STK-M0) e
   nunca passaram por uma auditoria de prontidão dedicada à release.

## O quê (MUST)

- Auditar a versão: fonte única na raiz (`0.1.0-beta.1`), ausência de versões
  conflitantes em workspaces/manifests/docs/código, correspondência com o
  `releaseInfo` exposto pelo runtime (`STAKEFRAME_VERSION` → `/api/v1/system/status`).
- Criar `docs/releases/v0.1.0-beta.1.md` com fatos verificáveis: resumo, features
  entregues (Fase 1, STK-M0, STK-G0-01, STK-G0-19), limitações conhecidas,
  importação automática desligada, OCR sem ativação produtiva, migrações não
  aplicadas em produção e passos necessários para publicação/deploy futuro.
- Auditar o pipeline: `release-candidate.yml`, `publish-candidate.yml`, `ci.yml`,
  `scripts/release/*`, `infra/release/*`, `Dockerfile`, composes — source SHA
  imutável, versão do commit revisado, data UTC única, cinco artefatos corretos,
  labels OCI (versão/commit/data), consumo por digest, ausência de `latest`,
  autorização explícita em publish/deploy, sem segredos, permissões mínimas,
  branch arbitrária recusada.
- Matriz dos cinco artefatos (`api`, `worker`, `migrate`, `web`/`web-production`,
  `operations`): target, labels, runtime, healthcheck, dependências, compatibilidade
  com `deployment.env`, rollback por digest, sem `latest`, sem segredo embutido.
- Auditar migrações (somente leitura): listar, identificar incluídas nesta main,
  comparar com o estado documentado da produção, listar pendentes, verificar
  forward-only, compatibilidade código↔schema, ordem e backup/rollback.
- Auditar rollback: por digest, current×previous, os cinco serviços, recusa de
  `deployment.env` incompleto, pins duplicados, modo full×parcial, proibição de
  `latest`, comportamento com imagem ausente.
- Executar as verificações locais disponíveis (build/typecheck/lint/testes/
  integração/spec/format/deployment/images/rollback/testes de release/OpenSpec/
  diff-review/Snyk), separando falhas ambientais de falhas da branch.

## O quê (MUST NOT)

- Criar tag Git, GitHub Release, publicar imagem, executar publish-candidate,
  fazer deploy, migrar produção, alterar credenciais/proteções/permissões, ativar
  `AUTOMATIC_IMPORT_ENABLED`, chamar OpenRouter/Azure/Google/Telegram.
- Incluir segredos, PII, bilhetes ou corpus privado em commit, PR, card ou logs.
- Declarar a release como publicada ou migração como aplicada sem evidência.

## Impacto

- Somente aditivo: notas de release em `docs/releases/` e correções pontuais
  (se encontradas) na branch `hermes/stk-rel-01-release-readiness`.
- Nenhuma mudança de runtime; nenhuma migração nova; nenhum artefato publicado.
