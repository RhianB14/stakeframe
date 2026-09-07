# Guia de desenvolvimento

As imagens da aplicação e do migrador contêm pacotes de execução separados.
Depois de `pnpm local:up`, execute `pnpm images:check` para conferir conteúdo,
arquitetura e dependências. Detalhes em [RUNTIME-IMAGES.md](RUNTIME-IMAGES.md).

`pnpm deployment:rehearse` verifica a configuração de produção em projeto
descartável, com credenciais fictícias e HTTPS confiado somente pelo teste.
Requer Compose ≥2.24.4 para a substituição explícita de portas; não usa a VPS.
Procedimento em [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md).

## Pré-requisitos

| Ferramenta | Versão                 | Observação                                         |
| ---------- | ---------------------- | -------------------------------------------------- |
| Node.js    | v24.20.0               | Fixado em `.nvmrc`; CI usa exatamente esta versão  |
| pnpm       | 11.24.0                | Declarado em `packageManager`                      |
| Git        | 2.x                    | Identity configurada para commits                  |
| Docker     | 29.x + Compose ≥2.24.0 | PostgreSQL e `env_file` opcional para autenticação |

## Runtime isolado do projeto (Windows)

O runtime do sistema/Hermes usa Node v26.7.0 e o `pnpm.ps1` do PATH resolve o
`node.exe` do próprio Hermes — o projeto **não deve depender do PATH global**.
A execução correta é feita com ferramentas isoladas em `dev\tools\stakeframe`:

- `node.exe` v24.20.0 — zip oficial do nodejs.org, SHA-256 conferido contra o
  `SHASUMS256.txt` oficial da distribuição.
- `pnpm.exe` 11.24.0 — binário standalone oficial da release do GitHub do
  pnpm (asset `pnpm-win32-x64.zip`); binário obtido da release oficial e
  validado funcionalmente. Não foi realizada verificação independente de
  checksum do pnpm.

### Procedimento reproduzível

1. Baixar `node-v24.20.0-win-x64.zip` e `SHASUMS256.txt` de
   `https://nodejs.org/dist/v24.20.0/` para `dev\tools\stakeframe\` e conferir
   o SHA-256 do zip contra o `SHASUMS256.txt`.
2. Extrair para `dev\tools\stakeframe\node-v24.20.0-win-x64\`.
3. Baixar `pnpm-win32-x64.zip` da release `v11.24.0` do pnpm no GitHub e
   extrair para `dev\tools\stakeframe\pnpm\` (contém `pnpm.exe`).
4. Em cada sessão, preceder o PATH (git-bash):
   ```bash
   export PATH="/c/Users/Rhian Batista/dev/tools/stakeframe/node-v24.20.0-win-x64:/c/Users/Rhian Batista/dev/tools/stakeframe/pnpm:$PATH"
   ```
   (PowerShell equivalente: `$env:Path = "C:\Users\Rhian Batista\dev\tools\stakeframe\node-v24.20.0-win-x64;C:\Users\Rhian Batista\dev\tools\stakeframe\pnpm;$env:Path"`.)
5. Confirmar `node --version` → `v24.20.0` e `pnpm --version` → `11.24.0`
   antes de rodar qualquer comando do projeto.

Não instalar Node/pnpm globalmente nem alterar o runtime interno do Hermes ou
de outros projetos.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm local:init
pnpm local:up
```

Abra [http://127.0.0.1:8088](http://127.0.0.1:8088). A primeira execução baixa
as imagens e compila a aplicação. O comando aguarda os quatro serviços ficarem
saudáveis; o serviço temporário `migrate` deve concluir com código 0 antes da
API. O worker inicializa o schema técnico da fila no PostgreSQL local.
Além do diagnóstico, o worker possui runtime opt-in Telegram/OpenRouter,
desativado nos Composes padrão. Configuração e testes em
[INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md). O worker também verifica a
unidade mensal; a migração financeira é aplicada antes da API e do worker.
Os saldos começam em zero e somente o proprietário autenticado pode confirmar
os valores iniciais. [FINANCIAL-MODEL.md](FINANCIAL-MODEL.md) descreve os fluxos.

`local:init` gera uma senha aleatória em `.env.local`, sem imprimir seu valor
e sem sobrescrever um arquivo existente. Não use `.env.example` como arquivo
do Compose: ele documenta também integrações futuras. O ambiente local não
precisa de Google, Telegram, R2 ou Gemini para iniciar.

Para autenticação, consulte [AUTHENTICATION.md](AUTHENTICATION.md): o arquivo
opcional `.env.auth.local` fornece somente a configuração da API. O login
permanece fechado sem ativação explícita e configuração completa. A migração
local é aplicada mesmo com autenticação desativada, preservando dados e volume.

As portas padrão são 8088 (web) e 55432 (PostgreSQL), restritas a `127.0.0.1`.
Se estiverem ocupadas, altere `LOCAL_WEB_PORT`/`LOCAL_DB_PORT` no `.env.local`
antes de subir. API e worker não publicam portas no host. A senha precisa
permanecer a mesma enquanto o volume existir; alterar `.env.local` não troca
a senha de um banco já inicializado. Não remova o volume para corrigir erros.

Use `pnpm local:down` para parar e remover os containers preservando o volume.
O nome padrão do projeto Compose é `stakeframe-local`; em checkouts simultâneos,
defina `COMPOSE_PROJECT_NAME` e portas diferentes por sessão. Não suba dois
checkouts sobre o mesmo projeto/volume. Nenhum comando deste fluxo atua na VPS.

## Comandos

| Comando                 | O que faz                                                          |
| ----------------------- | ------------------------------------------------------------------ |
| `pnpm format:check`     | Verifica formatação (CI executa este comando)                      |
| `pnpm format`           | Corrige formatação                                                 |
| `pnpm typecheck`        | Verifica os cinco pacotes e os testes                              |
| `pnpm lint`             | Verifica TypeScript, React e scripts JavaScript                    |
| `pnpm test`             | Testa API e configuração sem banco externo                         |
| `pnpm api:spec`         | Gera OpenAPI a partir dos schemas das rotas                        |
| `pnpm api:spec:check`   | Valida OpenAPI e compara com o documento versionado                |
| `pnpm build`            | Compila pacotes e assets da web                                    |
| `pnpm local:status`     | Mostra o estado dos containers locais                              |
| `pnpm local:test-db`    | Testa PostgreSQL 18, fila e autenticação usando `.env.local`       |
| `pnpm test:integration` | Exige `TEST_DATABASE_URL` explícito para banco de teste            |
| `pnpm test:e2e`         | Testa a web já iniciada em desktop e mobile                        |
| `pnpm recovery:drill`   | Valida backup criptografado e restauração em clusters descartáveis |

### Testes de navegador

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Os E2E verificam status real, falha e recuperação da conexão, indisponibilidade
do banco, ausência de rotas de produto, erros JavaScript e overflow horizontal.
Screenshots ficam em `test-results/` e o relatório em `playwright-report/`,
ambos ignorados pelo Git. Para outra porta, defina `E2E_BASE_URL` na sessão.
Se o download do Chromium estiver indisponível, é possível testar com Chrome
já instalado definindo `PLAYWRIGHT_CHANNEL=chrome`; registre essa diferença
na evidência. A CI instala e usa o Chromium fixado pelo Playwright.

Os cenários visuais de login/logout usam respostas de API controladas pelo
Playwright. A suíte de integração valida o protocolo OAuth com Better Auth e
PostgreSQL reais, substituindo apenas os endpoints Google. Nenhuma dessas
suítes substitui a validação posterior com a conta real.

### Ensaio de recuperação

O ensaio `recovery:drill` é independente da aplicação local e dos arquivos de
credenciais dela. Pode ser executado com a aplicação aberta. Gera seu próprio
ambiente, testa a restauração e remove os recursos identificados por seu UUID.
Consulte [RECOVERY-DRILL.md](RECOVERY-DRILL.md).
O modo `pnpm recovery:r2 <diretório-privado>` acessa R2 real com dados fictícios
e exige a autorização específica descrita em [R2.md](R2.md). Não roda na CI.

### Ciclo de edição

Após alterar código, `pnpm local:up` reconstrói as imagens e atualiza os
containers. Para hot reload da web, execute
`pnpm --filter @stakeframe/web dev --host 127.0.0.1`; o proxy Vite espera uma API
em `127.0.0.1:3000`. Para iniciá-la fora do Docker, compile com `pnpm build:types`,
configure `STAKEFRAME_RUNTIME=local` e `DATABASE_URL` na sessão com a conexão
local e execute `node apps/api/dist/server.js`. Não imprima a conexão nem a
coloque em argumentos, histórico ou documentação.

## Fluxo de trabalho

1. Crie uma branch a partir da `main` atualizada; no Codex, use `codex/...`.
2. Faça alterações com commits convencionais
   (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`...).
3. Rode formatação, tipos, lint, testes, build e as integrações pertinentes antes do push.
4. Abra a PR para `main`. A CI executa `format-check`, `application-check` e
   `network-security-simulation`, além do ensaio `recovery-check`.
5. O merge é autorizado pelo Codex conforme [docs/GOVERNANCE.md](GOVERNANCE.md).

Regras:

- Push direto na `main` é bloqueado pela proteção da branch.
- Somente squash merge; a branch é excluída após o merge.
- Sem force-push e sem alterar histórico de PRs já revisadas sem nova
  autorização.
- Segredos e valores reais de ambiente nunca entram no repositório
  (`.env*` está ignorado, exceto `.env.example`).

## Versionamento de documentos

- Decisões técnicas: [docs/DECISIONS.md](DECISIONS.md).
- Arquitetura (estado real vs. meta): [docs/ARCHITECTURE.md](ARCHITECTURE.md).
- Governança e autorizações: [docs/GOVERNANCE.md](GOVERNANCE.md).
- Progresso do M0: [docs/M0-CHECKLIST.md](M0-CHECKLIST.md).
