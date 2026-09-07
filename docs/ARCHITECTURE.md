# Arquitetura

> **Estado real:** base local do M0 implementada na STK-M0-07. Existem web,
> API, worker, contratos compartilhados e acesso PostgreSQL, além dos scripts
> de segurança de rede. A STK-M0-08 acrescenta autenticação Google restrita ao
> proprietário, ativada e validada localmente após autorização para configurar
> credenciais. Novos ambientes continuam desativados por padrão. Produção e
> operação real permanecem pendentes; o M0 não está concluído. A STK-M1-01
> acrescenta interface privada e núcleo financeiro locais (M1/M2), conforme D019.

## Implementação local

- `apps/web`: React, Vite, Tailwind, componentes Radix/shadcn e TanStack Query;
  entrada pública e interface privada de banca, apostas, financeiro e configurações.
- `apps/api`: Fastify, contratos Zod, `/health/live`, `/health/ready` e
  `/api/v1/system/status`. Exige runtime explícito `local` ou `production`; endpoints de produto
  inexistentes retornam 404. Erros têm código e UUID gerado pelo servidor.
- `apps/worker`: pg-boss, diagnóstico `system-probe` e runtime opt-in de
  Telegram/OpenRouter. A fila de extração não repete chamadas pagas.
- `packages/db`: pool PostgreSQL, Drizzle, inbox técnica e schema `finance`;
  lançamentos balanceados, auditoria, recibos de idempotência e unidades mensais.
- `packages/shared`: contratos de healthcheck, status, erro, autenticação,
  sessão, diagnóstico da fila, comandos financeiros e cálculo decimal exato.

O núcleo financeiro serializa as mutações pela versão do espaço do proprietário.
Lançamentos e estornos são imutáveis, com balanceamento imposto no PostgreSQL.
O worker e o acesso ao espaço asseguram a unidade mensal congelada.
Detalhes, limites e invariantes em [FINANCIAL-MODEL.md](FINANCIAL-MODEL.md).

A STK-M0-09 usa os schemas Zod na validação de entrada e na serialização de
respostas. `@fastify/swagger` e `fastify-type-provider-zod` geram OpenAPI 3.0.3
das mesmas rotas, sem consultar banco ou configuração privada. A especificação
versionada é comparada na CI. Contratos e comandos em [API.md](API.md).

A autenticação usa Better Auth, adapter Drizzle e tabelas no schema `auth`.
`/api/v1/me` exige sessão válida e identidade autorizada; login Google, callback
e logout são as únicas rotas de autenticação expostas. A interface permite
entrar/sair e trata falhas de sessão sem exibir conteúdo privado. Política e
configuração em [AUTHENTICATION.md](AUTHENTICATION.md).

`compose.local.yml` executa PostgreSQL 18.4, API, worker e Caddy com os assets
da web. O worker usa apenas a rede interna; a API também usa uma bridge de saída
para o Google, sem publicar portas no host. Web e PostgreSQL também usam
uma bridge para publicação exclusiva em loopback (8088 e 55432). O banco tem
volume persistente; API, worker e web usam filesystem somente leitura, usuário
sem root e capabilities removidas. No Caddy local, a capability do binário é
removida no build porque o listener utiliza 8080.

As imagens base estão fixadas por digest e publicam manifests AMD64/ARM64.
Execução validada inicialmente em Linux AMD64 via Docker Desktop; a existência
do manifest ARM64 não comprova execução na VPS. A STK-M0-11 separa API, worker
e migrações em pacotes de execução sem ferramentas de desenvolvimento, com
verificação de conteúdo e suíte da aplicação em AMD64/ARM64 na CI.
[RUNTIME-IMAGES.md](RUNTIME-IMAGES.md) descreve os artefatos e limites;
publicação e execução na VPS permanecem pendentes.

A STK-M0-12 prepara `compose.production.yml`: autenticação Google obrigatória,
origem HTTPS, segredos por arquivo, papel PostgreSQL sem superusuário, apenas
Caddy exposto e migração por perfil explícito. O target `web-production` guarda
certificados em volume. O ensaio local usa credenciais fictícias e CA interna
confiada somente pelo cliente do teste. Configuração e limites em
[PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md).

O worker cria automaticamente apenas o schema técnico `pgboss` no banco local.
Um serviço temporário `migrate` aplica as migrações Drizzle antes de iniciar a
API; o histórico fica no schema `drizzle`. A migração inicial cria o schema
`auth` e suas tabelas, sem remover dados existentes.
Credenciais de desenvolvimento são geradas em `.env.local` e excluídas do Git e
do contexto Docker. Não há autorização para usar este Compose em produção.

## Visão alvo completa (implementação parcial)

A STK-M0-17 acrescenta inbox e enqueue transacional, cotas compartilhadas e
recuperação de chamadas incertas. [INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md)
documenta configuração, testes e armazenamento provisório. Integrações continuam
desativadas nos Composes padrão; não houve implantação na VPS.

Monorepo TypeScript estrito com pnpm workspaces:

| Pacote planejado  | Responsabilidade                                         |
| ----------------- | -------------------------------------------------------- |
| `apps/web`        | React + Vite + Tailwind CSS + shadcn/ui, TanStack Query  |
| `apps/api`        | Fastify, contratos Zod/OpenAPI, autenticação Better Auth |
| `apps/worker`     | Processamento assíncrono com pg-boss (importações, jobs) |
| `packages/db`     | Drizzle ORM, migrações, acesso ao PostgreSQL 18          |
| `packages/shared` | Contratos compartilhados, tipos, utilitários de domínio  |

Infraestrutura de execução (VPS Oracle Always Free): Docker Compose com
aplicação, API, worker, PostgreSQL e Caddy (HTTPS). Gemini 3.8 Flash via OpenRouter,
chamada pelo worker com credencial privada, fila e limites por modelo;
decisão e etapas de validação em [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md). Backups
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

- `application-check`: tipos, lint, auditoria de dependências, validação e
  sincronização OpenAPI, unitários, build,
  Docker Compose real, integração PostgreSQL 18/pg-boss/Better Auth e E2E Chromium
  em desktop/mobile.
- `network-security-simulation`: simulações Python do guard de rede.
- `application-arm64-check`: mesma suíte da aplicação e inspeção das imagens
  executadas em runner Linux ARM64 nativo. O nome `application-check` continua
  identificando a execução AMD64; as proteções existentes são preservadas.
- `recovery-check`: dois clusters PostgreSQL descartáveis, dump custom e roles
  sem hashes de senha, snapshot Restic criptografado e restauração com conferência
  de dados, proprietários, permissões e falhas. Sem acesso à instância da aplicação;
  detalhes em [RECOVERY-DRILL.md](RECOVERY-DRILL.md).

O job de aplicação falha se a integração não puder executar. O comando
`test:integration` exige `TEST_DATABASE_URL`; não há fallback ou skip por falta
de banco. Testes usam um schema aleatório `stk_test_<uuid>` e removem somente
esse schema ao terminar. A suíte de autenticação usa um banco temporário
`stk_auth_test_<uuid>`, removido ao final, e simula apenas os endpoints Google;
exige conta local de teste com `CREATEDB`. As proteções de branch existentes não
foram alteradas.

## Decisões

Registradas em [docs/DECISIONS.md](DECISIONS.md).
