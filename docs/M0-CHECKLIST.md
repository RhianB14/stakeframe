# Checklist do M0 — Setup

Tarefa atual: **STK-M0-01** (bootstrap, configuração do GitHub, diagnóstico).
O M0 só é considerado concluído quando todos os itens abaixo estiverem
verificados e o Codex autorizar o avanço.

## Concluído nesta tarefa (STK-M0-01)

- [x] Inspeção do ambiente local (Git, gh, Node, pnpm, Docker) e da conta
      GitHub (`RhianB14`), sem exposição de segredos.
- [x] Verificação de que `RhianB14/stakeframe` não existia antes da criação.
- [x] Bootstrap mínimo: README real, LICENSE (MIT, Rhian Batista, 2026),
      `.gitignore`, `.editorconfig`, Prettier 3.9.6, workflow de CI.
- [x] Node.js v24.20.0 fixado (`.nvmrc`, `engines`), pnpm 11.24.0
      (`packageManager`), lockfile versionado.
- [x] Repositório público criado; `main` publicada com commit único de
      bootstrap (exceção autorizada); CI executada com sucesso.
- [x] Configuração do repo: descrição, issues on, wiki/discussions off,
      somente squash, exclusão de branch pós-merge, auto-merge off,
      secret scanning + push protection + dependabot security updates.
- [x] Proteção da `main`: PR obrigatória, check `format-check` obrigatório
      (strict), enforce_admins, histórico linear, force-push/exclusão
      bloqueados, conversas obrigatórias.
- [x] Documentação: AGENTS.md, PLAN.md, ARCHITECTURE.md, DECISIONS.md,
      DEVELOPMENT.md, GOVERNANCE.md, DEPLOYMENT.md, RECOVERY.md, `.env.example`.
- [x] Templates de issue (bug/feature) e de PR.
- [x] Milestones M0–M6, labels (tipo/prioridade/etapa), issue da tarefa
      STK-M0-01 aberta e vinculada à PR.
- [x] Diagnóstico do restante do M0 (abaixo).

## Pendências do M0 (fora do escopo do STK-M0-01)

### Ambiente local

- [ ] Alinhar Node local para v24.20.0 (atual: v22.23.2) — via nvm-windows,
      fnm ou volta. CI já usa a versão correta.

### VPS Oracle Always Free

- [ ] Confirmar acesso SSH à VPS (somente leitura nesta fase) e registrar
      sistema operacional e arquitetura (A1 Flex ARM x2 OCPU/12 GB ou E2.1
      Micro AMD x2 — a definir pela disponibilidade real da tenancy).
- [ ] Inventariar CPU, memória, disco e serviços existentes na VPS.
- [ ] Verificar Docker + Docker Compose na VPS (versões).
- [ ] Definir e documentar política de recuperação de instâncias ociosas.

### Domínio

- [ ] Consultar disponibilidade e preço de `stakeframe.com.br` (decisão de
      compra é do proprietário, com autorização do Codex).

### Integrações

- [ ] Google OAuth: criar credenciais restritas à identidade do proprietário
      (credenciais fora do repo; configurar em segredos de ambiente).
- [ ] Telegram: criar bot restrito ao chat do proprietário.
- [ ] Cloudflare R2: criar conta/buckets privados separados (anexos e
      backups) e credenciais de escopo mínimo.

### OmniRoute na VPS

- [ ] Planejar instância Docker independente do computador pessoal; inventariar
      provedores disponíveis, limites e custos; validar suporte a imagens e
      saída estruturada antes de depender deles.

### Infraestrutura e operação

- [ ] Docker Compose inicial (app, api, worker, PostgreSQL, Caddy, OmniRoute)
      com volumes e redes internas.
- [ ] HTTPS com Caddy + renovação; DNS do domínio.
- [ ] Backups externos criptografados (R2) a cada 30 min + alerta de atraso;
      teste de restauração demonstrado (RPO 1h / RTO 4h).
- [ ] Monitoramento externo de disponibilidade e alertas deduplicados.
- [ ] Procedimentos documentados de deploy, migração e rollback
      ([docs/DEPLOYMENT.md](DEPLOYMENT.md) — hoje apenas esqueleto honesto).

## Registro de decisões pendentes para o Codex

- Escolha da shape da VPS (A1 ARM vs. E2.1 Micro) conforme disponibilidade
  real da tenancy.
- Ordem das integrações (R2 → OAuth → Telegram → OmniRoute) após o domínio.
- Critério de quando instalar o Postgres na VPS vs. desenvolver com Docker
  local primeiro.
