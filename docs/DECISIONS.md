# Registro de decisões

Formato resumido: contexto → decisão → consequências. Decisões revogadas
recebem status `Superseded` e apontam a substituta.

## D001 — Repositório público único com governança de protocolo

- **Contexto:** projeto pessoal com repositório público; uma única identidade
  GitHub (`RhianB14`) é usada tanto para implementar quanto para revisar.
- **Decisão:** repositório público `RhianB14/stakeframe`, licença MIT; a
  exigência de PR e CI é técnica, e a revisão independente do Codex é
  protocolar (registrada por retransmissão), porque o GitHub não permite
  autoaprovação.
- **Consequências:** proteções da `main` não exigem contagem de aprovações
  formais; a trilha de autorização fica nos comentários da PR e nos relatórios.
  Bilhetes, saldos e credenciais nunca entram no repositório.

## D002 — Bootstrap com commit direto na main, uma única vez

- **Contexto:** proteções da `main` só podem ser criadas depois que a branch
  existe e o check tem nome registrado.
- **Decisão:** autorizada no STK-M0-01 a publicação inicial da `main` por push
  direto (commit `4ff1d1e4e127d4b540fd7b48908d3be0f53e55f3`), como exceção de
  bootstrap. Depois disso, toda alteração entra exclusivamente por PR.
- **Consequências:** a exceção é única e documentada; qualquer push futuro
  direto à `main` é violação de protocolo (e será bloqueado pela proteção).

## D003 — Node.js 24 LTS com versão exata fixada e runtime isolado no Windows

- **Contexto:** o plano define Node 24 LTS; o runtime do sistema/Hermes roda
  Node v26.7.0 e o `pnpm.ps1` do PATH do Windows resolve o `node.exe` do
  próprio Hermes, misturando runtimes entre projetos.
- **Decisão:** `.nvmrc` com `v24.20.0`; CI executa com essa versão via
  `node-version-file`; `engines` em `package.json` exige `>=24.20.0 <25`. No
  Windows, o projeto usa um **runtime isolado** em `dev\tools\stakeframe`
  (Node v24.20.0 do zip oficial + pnpm standalone 11.24.0), precedido no PATH
  por sessão — sem alterar o runtime global do Hermes ou de outros projetos.
  Procedimento reproduzível em [docs/DEVELOPMENT.md](DEVELOPMENT.md).
- **Consequências:** execução local validada em 2026-09-05 com `node
--version` = v24.20.0, `pnpm --version` = 11.24.0 e `pnpm exec node
--version` = v24.20.0. Gerenciadores de versão (nvm-windows/fnm/volta)
  continuam opcionalmente adequados; o PATH global não é fonte de verdade
  para este projeto.

## D004 — pnpm como gerenciador de pacotes

- **Contexto:** monorepo TypeScript planejado com workspaces.
- **Decisão:** pnpm (versão exata `11.24.0` declarada em `packageManager`),
  lockfile versionado, `--frozen-lockfile` na CI.
- **Consequências:** npm/yarn não devem ser usados no projeto.

## D005 — Prettier como primeira verificação real

- **Contexto:** a CI de bootstrap precisa verificar algo verdadeiro, sem testes
  fictícios ou scripts de sucesso vazio.
- **Decisão:** Prettier 3.9.6 sobre todo o repositório, check `format-check`,
  único check obrigatório da `main` até que novas verificações existam.
- **Consequências:** novas verificações (lint, tipos, testes, build) serão
  adicionadas como checks com nomes únicos conforme os componentes surgirem.

## D006 — Proteções da main com administração inclusiva

- **Contexto:** repositório de uma pessoa, com agentes executando operações.
- **Decisão:** PR obrigatória, check `format-check` obrigatório com
  atualização obrigatória em relação à base, resolução de conversas, histórico
  linear, force-push e exclusão bloqueados, proteções aplicadas também a
  administradores (`enforce_admins`), somente squash merge, exclusão
  automática de branch, auto-merge desativado.
- **Consequências:** o próprio proprietário/administrador segue o fluxo de PR;
  merges ficam sujeitos à autorização protocolar do Codex.

## D007 — Actions fixadas por SHA completo

- **Contexto:** workflows usam actions de terceiros; tags são mutáveis.
- **Decisão:** toda action externa é fixada por SHA completo de commit, com a
  versão em comentário; workflows com permissão mínima (`contents: read`) e
  `persist-credentials: false` no checkout.
- **Consequências:** atualização de action é commit explícito e revisável.

## D008 — Wiki e Discussions desativadas

- **Contexto:** concentrar decisões em documentação versionada e issues.
- **Decisão:** Wiki e Discussions desativadas; documentação em `docs/`,
  decisões neste arquivo, trabalho rastreado em issues e milestones.
- **Consequências:** discussões técnicas ficam em issues ou na PR
  correspondente.

## D009 — Recuperação por dump lógico completo, sem PITR no M0

- **Contexto:** a estratégia inicial "dump lógico + WAL" misturava dois
  mecanismos; PITR exige arquivamento contínuo de WAL, que não será
  implementado no M0 ([referência](https://www.postgresql.org/docs/current/continuous-archiving.html)).
- **Decisão:** recuperação por backups **lógicos completos** (`pg_dump -Fc`,
  a cada 30 minutos, criptografados antes de sair da VPS, enviados ao bucket
  privado de backups no R2). Na restauração, as roles referenciadas são
  recriadas previamente e o banco de destino é preparado com credenciais
  fornecidas fora do repositório; em seguida, o dump é restaurado com
  `pg_restore --exit-on-error` por uma conta com permissões para restaurar
  objetos, proprietários e ACLs, que são conferidos ao final. Sem PITR; backup
  físico com arquivamento de WAL fica para decisão futura. Anexos: objetos com
  identificadores únicos, sem sobrescrita, com cópia de recuperação no bucket
  de backups, manifesto com checksums e política de exclusão aplicada também
  às cópias.
- **Consequências:** o RPO de 1 hora depende da cadência dos dumps completos
  (idade do snapshot recuperável ≤ 1 hora, a medir na validação). A duração
  da restauração e o atendimento ao RTO de 4 horas serão demonstrados no teste
  real; esta decisão não presume desempenho relativo a PITR nem declara o RTO
  atendido.

## D010 — Base executável local antes da publicação (2026-09-06)

- **Contexto:** o M0 precisa de uma aplicação executável para validar o
  caminho web → API → PostgreSQL e o processamento assíncrono; integrações e
  operação na VPS ainda têm pendências independentes.
- **Decisão:** implementar a STK-M0-07 com Compose local, credenciais aleatórias
  fora do Git, endpoints técnicos e fila de diagnóstico. Autenticação ausente
  é apresentada explicitamente; não existe modo de usuário autenticado falso.
  API e worker exigem runtime `local`. As portas publicadas são de loopback.
- **Compatibilidade:** Node 24.20.0 e pnpm 11.24.0 mantidos. TypeScript 6.0.3
  atende ao intervalo de suporte do typescript-eslint 8.69.0 (`<6.1`); a versão
  7 não foi adotada por incompatibilidade com essa ferramenta. Dependências
  diretas usam versões exatas e lockfile. Vite 8, Fastify 5, React 19 e
  pg-boss 12 foram verificados com os tipos e builds instalados.
- **Banco:** PostgreSQL 18.4 e Drizzle; pg-boss inicializa o schema técnico
  local, sem migrações de produto. O volume usa `/var/lib/postgresql`, conforme
  a [imagem oficial PostgreSQL 18](https://hub.docker.com/_/postgres).
- **Rede:** publicação local por bridge e comunicação dos serviços por rede
  interna, seguindo a [separação de redes do Docker](https://docs.docker.com/engine/network/).
  Caddy usa 8080 e remove a capability embutida do binário durante o build,
  permitindo `cap_drop: ALL` e usuário sem root; o comportamento da imagem
  oficial está descrito em [caddy-docker #396](https://github.com/caddyserver/caddy-docker/issues/396).
- **Consequências:** esta base não conclui M0/M1, não autoriza deploy e não
  usa o domínio comprado. Google OAuth/Better Auth, Telegram, R2, OmniRoute,
  OpenAPI, migrações, imagens de produção e backup/restore seguem pendentes.

## D011 — Google por identidade fixa e sessão persistida (2026-09-06)

- **Contexto:** o único proprietário precisa de autenticação antes das rotas
  privadas de produto. A infraestrutura de produção permanece pendente.
- **Decisão:** Better Auth 1.7.3 com adapter Drizzle da mesma versão e schema
  próprio. Exigir `sub` fixo e e-mail Google verificado; validar criptograficamente
  o ID token no callback antes de aceitar o perfil. Expor somente entrada Google,
  callback, logout e DTO mínimo da sessão. Sem vinculação de contas ou senha.
- **Sessões:** persistidas, expiração absoluta de 12 horas, sem cache de cookie
  nem renovação automática; identidade revalidada no banco a cada acesso privado.
  Tokens do provedor não são persistidos. Rate limit em memória serve somente
  à instância local; produção terá revisão própria de rede e proxy confiável.
- **Dependências:** a [release 1.7.3](https://github.com/better-auth/better-auth/releases/tag/v1.7.3)
  e os fontes instalados foram revisados, incluindo restauração do schema de
  conta e correção do cache de sessão desativado. Exceções de idade mínima no
  pnpm limitam-se aos oito pacotes Better Auth na versão exata 1.7.3; não há
  liberação geral. Vitest 4.1.11 atende ao peer suportado pela biblioteca.
- **Ferramentas de migração:** Drizzle Kit 0.31.10 fixado; geração e migrador
  validados. Override restrito `@esbuild-kit/core-utils>esbuild: 0.25.12` elimina
  a dependência vulnerável ao [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
  `pnpm audit` sem alertas após a correção; dois loaders transitivos depreciados
  permanecem dependências upstream. Scripts de build permitidos explicitamente
  apenas para esbuild e Tailwind oxide pelo mecanismo `allowBuilds` do pnpm 11.
- **Consequências:** migração local aditiva aplicada antes da API; login fica
  desativado até configuração autorizada. Testes de protocolo usam PostgreSQL
  real e endpoints Google simulados. A ativação autorizada subsequente validou
  a conta Google real em ambiente local, com evidências separadas dos testes
  automatizados em [M0-08-VALIDATION.md](M0-08-VALIDATION.md). A decisão atualiza
  a pendência de código OAuth/migrações da D010 e mantém produção fechada.

## D012 — Contratos executáveis e OpenAPI gerado (2026-09-06)

- **Contexto:** os DTOs existentes precisam ser aplicados pela API e publicados
  em uma especificação verificável antes das funcionalidades de produto.
- **Decisão:** usar Zod 4 na validação e serialização Fastify 5, com
  `fastify-type-provider-zod` 7.0.0 e `@fastify/swagger` 9.8.1. Gerar OpenAPI
  3.0.3, suportado pelo parser de validação 13.0.0, das mesmas rotas. A CI
  compara o documento versionado com a geração determinística e resolve somente
  referências internas. O exportador não depende de banco ou credenciais.
- **Autenticação:** o adaptador converte respostas JSON da biblioteca em objetos
  validados; erros públicos recebem código estável e UUID, preservando status e
  cabeçalhos de controle. Redirects OAuth preservam Location/cookies sem corpo
  JSON. Corpos ausentes continuam aceitos; a obrigatoriedade na especificação
  é derivada do schema Zod, corrigindo a suposição padrão do gerador Fastify.
- **Consequências:** uma resposta incompatível falha com 500 sanitizado e campos
  extras são removidos. Healthcheck indisponível e redirecionamentos mantêm seus
  contratos específicos. A D010 fica atualizada quanto à pendência OpenAPI;
  schema de produto, produção e integrações remanescentes continuam pendentes.

## D013 — Demonstrar recuperação em ambiente descartável (2026-09-06)

- **Contexto:** o M0 exige restauração comprovada. Antes de credenciais R2 e
  ativação de backups reais, é necessário exercitar o mecanismo com PostgreSQL
  e falhas reais, mantendo a aplicação e seus dados isolados.
- **Decisão:** ensaio com dois clusters PostgreSQL 18.4 e Restic 0.19.1 fixados
  por digest. Dump custom e roles sem hashes de senha ficam temporariamente em
  `tmpfs`; somente o snapshot criptografado vai para o volume de backup. O fluxo
  confere integralmente o repositório, restaura por ID completo, valida checksums
  e manifesto e aplica SQL com interrupção em erro, em um banco novo.
- **Papéis:** manter o mesmo nome de administrador inicial nos dois clusters,
  com credenciais independentes. PostgreSQL 18 preserva o grantor de associações
  de roles; nomes distintos reproduziram a restrição descrita na
  [discussão oficial](https://www.postgresql.org/message-id/CA%2BC_kKWHMP4c56jx1BPvP1jmjp2pmBu0Cw07fPVECUmkJSnT4w%40mail.gmail.com).
  Remover somente a criação redundante desse papel na cópia de trabalho do SQL,
  preservando atributos/grants e sem ignorar falhas. Conferir ACLs, default
  privileges e grants, além dos dados restaurados.
- **Isolamento:** transporte Docker local, projeto e labels por UUID, rede
  interna sem portas publicadas, segredos efêmeros fora do Git e limpeza restrita
  aos recursos identificados. Relatório contém apenas resultados e tempos.
- **Consequências:** a implementação valida a parte PostgreSQL da D009 em
  ambiente de teste. R2, custódia durável da chave, agendamento, retenção, alertas,
  anexos, OmniRoute e validação completa RPO/RTO permanecem pendentes. Restic é
  a ferramenta escolhida para o ensaio; a operação externa terá validação própria.

## D014 — Separar artefatos de execução e validar ARM64 (2026-09-06)

- **Contexto:** copiar o workspace completo para cada serviço mantinha
  compiladores, ferramentas de teste e código sem uso nas imagens. A VPS usa
  ARM64, mas a aplicação só tinha sido executada em AMD64.
- **Decisão:** usar pacotes portáveis de `pnpm deploy --prod --legacy`, com
  arquivos próprios limitados por `files`, e imagem exclusiva para migrações.
  A instalação inicial usa lockfile congelado; a embalagem recusa versões
  diferentes das presentes nessa instalação. A publicação segue separada.
- **Dependências:** remover, por hook restrito ao Better Auth 1.7.3, somente
  os peers opcionais `drizzle-kit` e `vitest`, cujas integrações não usamos.
  Isso evita transportar ferramentas de desenvolvimento para a API. Manter
  os pacotes como dependências de desenvolvimento nos locais pertinentes.
  Revalidar o hook em upgrades e repetir toda a suíte de autenticação.
- **Verificação:** probes em containers locais sem rede conferem conteúdo,
  arquitetura e ausência de ferramentas; CI repete a aplicação completa em
  AMD64 e ARM64 nativo. A execução ARM64 em outro host não substitui a
  validação operacional da VPS. Detalhes em [RUNTIME-IMAGES.md](RUNTIME-IMAGES.md).
