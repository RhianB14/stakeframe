# Stakeframe

Aplicação pessoal para registro de apostas esportivas, controle de banca e
acompanhamento de resultados.

> **Estado atual: base local do M0.** Web, API, worker e PostgreSQL executam
> em Docker Compose. O login Google restrito ao proprietário está implementado,
> aguardando configuração e validação com a conta real. Funcionalidades de apostas
> ainda não estão implementadas. Consulte [docs/PLAN.md](docs/PLAN.md)
> para o plano mestre e [docs/M0-CHECKLIST.md](docs/M0-CHECKLIST.md) para o
> progresso do setup.

## Objetivo

Registrar apostas via Telegram, upload de imagem e cadastro manual; controlar
banca (reserva + saldos por casa + principal em apostas abertas); acompanhar
resultados com liquidação manual e auditoria completa.

## Pilares

- Monorepo TypeScript estrito, Node.js 24 LTS, pnpm.
- Interface React + Vite + Tailwind CSS + shadcn/ui.
- API Fastify + contratos Zod/OpenAPI.
- PostgreSQL 18 com Drizzle ORM.
- Processamento assíncrono com pg-boss.
- Hospedagem em VPS Oracle Always Free (Docker Compose + Caddy).
- IA via OmniRoute em Docker na VPS.

## Desenvolvimento

Pré-requisitos: Node.js 24 LTS, pnpm 11.x, Docker com Compose 2.24.0 ou superior.

```bash
pnpm install --frozen-lockfile
pnpm local:init         # gera .env.local privado, sem imprimir a senha
pnpm local:up           # compila e aguarda os serviços ficarem saudáveis
pnpm local:test-db      # integração com PostgreSQL e worker reais
pnpm test              # testes unitários
pnpm typecheck
pnpm lint
pnpm build
```

Abra [http://127.0.0.1:8088](http://127.0.0.1:8088). Para encerrar preservando o
banco, execute `pnpm local:down`. Instruções de E2E, portas e configuração em
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Autenticação fica desativada por padrão e não concede acesso privado nesse
estado. Configuração, migrações e limites em [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

O fluxo de trabalho exige PR com CI verde para integrar na `main` (veja
[docs/GOVERNANCE.md](docs/GOVERNANCE.md)).

## Operação

Execução limitada ao computador local. Deploy, HTTPS, integrações externas e
recuperação de banco continuam pendentes no M0. O Compose local não constitui
uma configuração de produção; veja [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Licença

[MIT](LICENSE)
