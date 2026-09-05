# Checklist do M0 — Setup

Tarefa atual: **STK-M0-02** (inventário da VPS e preparação dos acessos).
STK-M0-02 está em andamento; o inventário remoto aguarda a identificação
inequívoca do destino e do usuário SSH.
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
- [x] STK-M0-01 concluído pela [PR #2](https://github.com/RhianB14/stakeframe/pull/2), integrada por squash no commit `8be12104f52c06eb7d1456ad9e87895434507ceb`.

## Execução atual e pendências do M0

### Ambiente local

- [x] Runtime local alinhado: execução isolada com Node v24.20.0 e pnpm
      11.24.0 em `dev\tools\stakeframe` (zip oficial do nodejs.org com SHA-256
      conferido + pnpm standalone oficial). Verificado: `node --version` =
      v24.20.0, `pnpm --version` = 11.24.0, `pnpm exec node --version` =
      v24.20.0. Procedimento em [docs/DEVELOPMENT.md](DEVELOPMENT.md). CI já
      usava a versão correta.

### VPS Oracle Always Free

- [ ] Confirmar acesso de leitura à VPS e inventariar a VPS existente
      informada pelo proprietário: **2 CPU, 12 GB RAM, 50 GB**; shape e
      arquitetura ainda não verificadas. A chave local foi localizada, mas
      host e usuário SSH ainda faltam; nenhuma conexão foi tentada.
- [ ] Inventariar CPU, memória, disco e serviços existentes na VPS.
- [ ] Verificar Docker + Docker Compose na VPS (versões).
- [ ] Definir e documentar política de recuperação de instâncias ociosas.
- [x] Registrar o diagnóstico parcial e as pendências de acesso em
      [docs/INFRASTRUCTURE-INVENTORY.md](INFRASTRUCTURE-INVENTORY.md).

### Domínio

- [x] Consultar disponibilidade e preço de `stakeframe.com.br`: ISAVAIL
      retornou `ST 0` em 2026-09-05 e a página oficial informa R$ 40,00 por
      um ano. Nenhuma compra foi realizada; a decisão continua do proprietário.

### Integrações

- [ ] Google OAuth: criar credenciais restritas à identidade do proprietário
      (credenciais fora do repo; configurar em segredos de ambiente).
- [ ] Telegram: criar bot restrito ao chat do proprietário.
- [ ] Cloudflare R2: criar conta/buckets privados separados (anexos e
      backups) e credenciais de escopo mínimo.

### OmniRoute na VPS

- [ ] Planejar instância Docker independente do computador pessoal; inventariar
      provedores disponíveis, limites e custos; validar suporte a imagens e
      saída estruturada antes de depender deles. - [x] Referência local consultada: OmniRoute `3.8.50`; manifesto oficial
      da imagem `3.8.50` reportou `linux/amd64` e `linux/arm64`. - [ ] Arquitetura da VPS e compatibilidade do destino ainda não verificadas.

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

- Inventário da VPS: confirmar shape e arquitetura (spec informada:
  2 CPU / 12 GB / 50 GB; shape e arquitetura não verificadas).
- Ordem das integrações (R2 → OAuth → Telegram → OmniRoute) após o domínio.
- Critério de quando instalar o Postgres na VPS vs. desenvolver com Docker
  local primeiro.
