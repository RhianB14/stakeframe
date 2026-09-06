# Imagens de execução

STK-M0-11 prepara imagens menores para a aplicação existente. O runtime continua
exigindo `STAKEFRAME_RUNTIME=local`; estas imagens não habilitam produção.

## Conteúdo e construção

O Dockerfile compila com Node 24.20.0 e pnpm 11.24.0. Copia explicitamente os
manifests, configurações, pacotes e aplicações necessários ao build. Arquivos
privados continuam excluídos por `.dockerignore`.

Após a instalação com lockfile congelado, `pnpm deploy --prod --legacy` produz
pacotes independentes. Os campos `files` limitam o código próprio a JavaScript
compilado; o pacote de banco também inclui SQL e o journal de migrações.
`scripts/check-deployed-versions.mjs` recusa qualquer versão de pacote ausente
da instalação congelada usada pelo build. O modo legacy mantém os links do
workspace atual e ainda precisa consultar metadados do registry; o build não
é offline. Referência: [pnpm deploy](https://pnpm.io/cli/deploy).

O empacotamento desativa `hoist-workspace-packages` para não gerar aliases
de pacotes não utilizados apontando ao workspace de build. O probe recusa
links externos ou quebrados. Evidências locais em [M0-11-VALIDATION.md](M0-11-VALIDATION.md).

| Target    | Conteúdo próprio                                               | Comando                    |
| --------- | -------------------------------------------------------------- | -------------------------- |
| `api`     | API e dependências de execução, incluindo banco e contratos    | `node dist/server.js`      |
| `worker`  | Worker e dependências de execução, incluindo banco e contratos | `node dist/server.js`      |
| `migrate` | Pacote de banco, SQL e journal                                 | `node dist/migrate-cli.js` |
| `web`     | Assets estáticos e configuração Caddy local                    | Comando da imagem Caddy    |

Os três targets Node usam `/app` e usuário `node`. O Compose mantém filesystem
somente leitura, capabilities removidas e `no-new-privileges`. O serviço
temporário `migrate` usa seu target próprio antes da API. O Dockerfile não
recebe credenciais por argumentos e não inclui testes, fontes TypeScript ou
arquivos de configuração privados nos pacotes de execução.

## Peers opcionais da autenticação

Better Auth 1.7.3 declara `drizzle-kit` e `vitest` como peers opcionais. No
workspace, esses vínculos faziam ferramentas de desenvolvimento permanecerem
na instalação `--prod`. O hook `.pnpmfile.cjs`, restrito a essa versão, remove
somente os dois vínculos e verifica que continuam opcionais. O gerador
Drizzle e o Vitest permanecem disponíveis nas dependências de desenvolvimento
do projeto. Não usamos as integrações de CLI/teste do Better Auth que precisam
desses peers; usamos o adapter Drizzle e nosso migrador diretamente.

Uma atualização do Better Auth deve reavaliar o hook. A verificação das imagens
recusa a presença das ferramentas mesmo que uma dependência futura volte a
introduzi-las. Tipos, testes de autenticação e migrações continuam obrigatórios.

## Verificação

Depois de construir a stack local:

```bash
pnpm local:up
pnpm images:check
```

O segundo comando inspeciona `stakeframe-local-api`, `stakeframe-local-worker`
e `stakeframe-local-migrate`. Aceita prefixo e arquitetura Node explícitos:

```bash
node scripts/check-runtime-images.mjs meu-prefixo arm64
```

Usa somente um contexto Docker com transporte local. Cada probe executa por
stdin em container próprio, sem rede, mounts ou portas, com filesystem somente
leitura, usuário não root e limites de memória/processos. Verifica arquitetura,
versão Node, comandos, arquivos, dependências portáveis e ausência de ferramentas
de desenvolvimento. A API responde por injeção interna com banco simulado; o
worker é importado sem abrir conexões; o target de migração confere SQL/journal.
O container é removido após confirmar nome e label exclusivos, inclusive em erro.
O comando não acessa a configuração privada nem os containers da aplicação.

A integração com PostgreSQL/pg-boss/Google simulado e os testes de navegador
continuam no job da aplicação, usando as imagens efetivamente construídas.
A CI executa a suíte em AMD64 (`application-check`) e ARM64 nativo
(`application-arm64-check`, runner `ubuntu-24.04-arm`). Consulte os
[runners oficiais do GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Limites

Build e testes ARM64 em outro host não validam firewall, armazenamento, memória,
DNS, HTTPS ou recuperação da VPS. Imagens e evidências não são uma release:
registro de imagens, digests publicados, política de atualização, segredos e
autorização de deploy seguem pendentes. Não executar o Compose local na VPS.
