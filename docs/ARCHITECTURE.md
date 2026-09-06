# Arquitetura

> **Estado real:** base local do M0 implementada na STK-M0-07. Existem web,
> API, worker, contratos compartilhados e acesso PostgreSQL, além dos scripts
> de segurança de rede. Autenticação e funcionalidades do produto permanecem
> pendentes; o M0 não está concluído.

## Implementação local

- `apps/web`: React, Vite, Tailwind e TanStack Query; tela de preparação que
  consulta o estado real do banco pela API. Sem login simulado, apostas ou saldos.
- `apps/api`: Fastify, contratos Zod, `/health/live`, `/health/ready` e
  `/api/v1/system/status`. Exige `STAKEFRAME_RUNTIME=local`; endpoints de produto
  inexistentes retornam 404. Erros têm código e UUID gerado pelo servidor.
- `apps/worker`: pg-boss, fila técnica `system-probe`, payload UUID validado,
  resultado persistido e até duas tentativas adicionais. Nenhum job de produto.
- `packages/db`: pool PostgreSQL e Drizzle. Não há tabelas ou migrações de domínio.
- `packages/shared`: contratos de status, erro e diagnóstico da fila.

`compose.local.yml` executa PostgreSQL 18.4, API, worker e Caddy com os assets
da web. API e worker usam apenas a rede interna. Web e PostgreSQL também usam
uma bridge para publicação exclusiva em loopback (8088 e 55432). O banco tem
volume persistente; API, worker e web usam filesystem somente leitura, usuário
sem root e capabilities removidas. No Caddy local, a capability do binário é
removida no build porque o listener utiliza 8080.

As imagens base estão fixadas por digest e publicam manifests AMD64/ARM64.
Execução validada inicialmente em Linux AMD64 via Docker Desktop; a existência
do manifest ARM64 não comprova execução na VPS. Imagens locais de API/worker
ainda contêm as dependências de desenvolvimento; redução da imagem e política
de publicação ficam para a preparação do deploy.

O worker cria automaticamente apenas o schema técnico `pgboss` no banco local.
Credenciais de desenvolvimento são geradas em `.env.local` e excluídas do Git e
do contexto Docker. Não há autorização para usar este Compose em produção.

## Visão alvo completa (implementação parcial)

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
externos criptografados no Cloudflare R2 (dumps lógicos do banco e cópias de
recuperação de anexos imutáveis, com manifesto e checksums —
[docs/RECOVERY.md](RECOVERY.md)).

## Princípios de dados e interfaces (vinculantes desde já)

- Valores monetários e odds com aritmética decimal explícita; decimais como
  strings nos contratos JSON.
- API versionada em `/api/v1`; listagens paginadas e filtros consistentes.
- Idempotência em operações repetíveis; proteção contra efeitos financeiros
  duplicados independentemente da fila.
- Transações curtas; chamadas de IA e buscas externas fora das transações
  financeiras.
- Erros com código estável e identificador de requisição.

## Verificações ativas

- `format-check`: Prettier sobre todo o repositório
  ([.github/workflows/ci.yml](../.github/workflows/ci.yml)), Node.js v24.20.0
  fixado em [.nvmrc](../.nvmrc).

- `application-check`: tipos, lint, unitários, build, Docker Compose real,
  integração PostgreSQL 18/pg-boss e E2E Chromium em desktop/mobile.
- `network-security-simulation`: simulações Python do guard de rede.

O job de aplicação falha se a integração não puder executar. O comando
`test:integration` exige `TEST_DATABASE_URL`; não há fallback ou skip por falta
de banco. Testes usam um schema aleatório `stk_test_<uuid>` e removem somente
esse schema ao terminar. As proteções de branch existentes não foram alteradas.

## Decisões

Registradas em [docs/DECISIONS.md](DECISIONS.md).
