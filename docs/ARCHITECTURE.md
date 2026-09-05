# Arquitetura

> **Estado real:** o projeto está no bootstrap (M0). A única infraestrutura de
> código existente é a verificação de formatação com Prettier e o workflow de
> CI. A arquitetura abaixo é a **meta definida no plano mestre** — não está
> implementada. Cada componente será registrado como implementado apenas quando
> existir de fato no repositório.

## Visão alvo (não implementada ainda)

Monorepo TypeScript estrito com pnpm workspaces:

| Pacote planejado  | Responsabilidade                                         |
| ----------------- | -------------------------------------------------------- |
| `apps/web`        | React + Vite + Tailwind CSS + shadcn/ui, TanStack Query  |
| `apps/api`        | Fastify, contratos Zod/OpenAPI, autenticação Better Auth |
| `apps/worker`     | Processamento assíncrono com pg-boss (importações, jobs) |
| `packages/db`     | Drizzle ORM, migrações, acesso ao PostgreSQL 18          |
| `packages/shared` | Contratos compartilhados, tipos, utilitários de domínio  |

Infraestrutura de execução (VPS Oracle Always Free): Docker Compose com
aplicação, API, worker, PostgreSQL, Caddy (HTTPS) e OmniRoute (IA). Backups
externos criptografados no Cloudflare R2.

## Princípios de dados e interfaces (vinculantes desde já)

- Valores monetários e odds com aritmética decimal explícita; decimais como
  strings nos contratos JSON.
- API versionada em `/api/v1`; listagens paginadas e filtros consistentes.
- Idempotência em operações repetíveis; proteção contra efeitos financeiros
  duplicados independentemente da fila.
- Transações curtas; chamadas de IA e buscas externas fora das transações
  financeiras.
- Erros com código estável e identificador de requisição.

## Verificações ativas hoje

- `format-check`: Prettier sobre todo o repositório
  ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), Node.js v24.20.0
  fixado em [.nvmrc](../.nvmrc).

As próximas verificações (lint, tipos, testes unitários, integração com
PostgreSQL real, build, E2E, migrações, análise de dependências) serão
acrescentadas conforme os componentes forem introduzidos — cada check com nome
único e sem sinalizar sucesso quando uma etapa obrigatória for omitida.

## Decisões

Registradas em [docs/DECISIONS.md](DECISIONS.md).
