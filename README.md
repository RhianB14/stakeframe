# Stakeframe

Aplicação pessoal para registro de apostas esportivas, controle de banca e
acompanhamento de resultados.

> **Estado atual: bootstrap.** Nenhuma funcionalidade do produto implementada
> ainda. O projeto está na fase M0 (setup). Consulte [docs/PLAN.md](docs/PLAN.md)
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

Pré-requisitos: Node.js 24 LTS, pnpm 11.x, Docker.

```bash
pnpm install            # instalar dependências
pnpm format:check       # verificação de formatação (única verificação ativa)
pnpm format             # corrigir formatação
```

O fluxo de trabalho exige PR com CI verde para integrar na `main` (veja
[docs/GOVERNANCE.md](docs/GOVERNANCE.md)).

## Operação

Ainda não aplicável — infraestrutura será provisionada em etapas posteriores do
M0, com procedimentos documentados em `docs/DEPLOYMENT.md` quando
implementados.

## Licença

[MIT](LICENSE)
