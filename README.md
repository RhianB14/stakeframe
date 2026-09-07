# Stakeframe

Aplicação pessoal para registro de apostas esportivas, controle de banca e
acompanhamento de resultados.

> **Estado atual: base local do M0.** Web, API, worker e PostgreSQL executam
> em Docker Compose. O login Google restrito ao proprietário está implementado
> e validado com a conta real no ambiente local. Funcionalidades de apostas
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
- IA com Gemini 3.8 Flash via OpenRouter, pelo worker na VPS (planejada).

## Desenvolvimento

Pré-requisitos: Node.js 24 LTS, pnpm 11.x, Docker com Compose 2.24.0 ou superior.

```bash
pnpm install --frozen-lockfile
pnpm local:init         # gera .env.local privado, sem imprimir a senha
pnpm local:up           # compila e aguarda os serviços ficarem saudáveis
pnpm local:test-db      # integração com PostgreSQL e worker reais
pnpm recovery:drill     # ensaio isolado de backup criptografado e restauração
pnpm images:check       # confere imagens construídas, isolamento e dependências
pnpm deployment:rehearse # ensaio HTTPS da configuração de produção em Docker local
pnpm test              # testes unitários
pnpm typecheck
pnpm api:spec:check    # valida OpenAPI e sincronização com os schemas da API
pnpm lint
pnpm build
```

Abra [http://127.0.0.1:8088](http://127.0.0.1:8088). Para encerrar preservando o
banco, execute `pnpm local:down`. Instruções de E2E, portas e configuração em
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Autenticação fica desativada por padrão e não concede acesso privado nesse
estado. Configuração, migrações e limites em [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md).

Contratos, rotas e erros em [docs/API.md](docs/API.md). A especificação gerada
fica em [docs/openapi.json](docs/openapi.json) e em `/api/openapi.json` na aplicação.

O fluxo de trabalho exige PR com CI verde para integrar na `main` (veja
[docs/GOVERNANCE.md](docs/GOVERNANCE.md)).

## Operação

Execução limitada ao computador local. Deploy, HTTPS, integrações externas e
recuperação completa continuam pendentes no M0. O Compose local não constitui
uma configuração de produção; veja [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

O [ensaio de recuperação](docs/RECOVERY-DRILL.md) valida PostgreSQL com dados
descartáveis; backups externos e recuperação completa ainda não estão ativos.
O [ensaio R2](docs/R2.md) usa credencial autorizada e dados fictícios para
verificar armazenamento externo; sua execução é separada da CI e da produção.

A [seleção de IA](docs/AI-MODEL-SELECTION.md) usa Gemini 3.8 Flash via
[OpenRouter](docs/OPENROUTER.md), com limite de USD 5 mensais; o
[ensaio de imagem](docs/AI-PROBE.md) é limitado a um bilhete fictício e sua
execução real é separada da CI. Preservação do OmniRoute local e evidências em
[M0-16-VALIDATION.md](docs/M0-16-VALIDATION.md).

O [cliente Google de produção](docs/M0-14-VALIDATION.md) está preparado em
projeto separado, com callback HTTPS e credenciais privadas. O login nesse
ambiente será validado após a implantação autorizada.

O [bot Telegram](docs/TELEGRAM.md) foi criado com grupos bloqueados e teve
uma resposta de teste entregue ao proprietário. O processamento contínuo
e a importação de apostas ainda não estão ativos.

## Licença

[MIT](LICENSE)
