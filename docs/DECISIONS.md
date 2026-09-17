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

## D015 — Ensaiar a configuração de produção antes da VPS (2026-09-06)

- **Contexto:** imagens ARM64 validadas ainda dependiam do modo local, sem
  contrato de produção, segredos por arquivo ou persistência de certificados.
- **Decisão:** runtime `production` explícito, autenticação Google obrigatória,
  HTTPS com origem única, segredos por arquivo e papel de aplicação sem
  superusuário. Compose aponta imagens por digest e expõe somente Caddy.
- **Migração:** perfil separado e confirmação explícita, após autorização e
  backup verificado no ambiente real. O flag confirma intenção; não substitui
  autorização nem comprova backup. Não há reversão destrutiva automática.
- **Verificação:** ensaio descartável com o Compose de produção, alterando
  apenas portas para loopback e ACME para CA interna. Credenciais fictícias,
  cliente com confiança TLS restrita ao teste, papéis/migrações, recusa de
  acesso, cookies e persistência após reinício. CI em AMD64 e ARM64 nativo.
- **Limites:** nenhuma implantação, migração ou mudança de credencial/rede na
  VPS. Publicação dos digests, DNS/ACME, OAuth real de produção, R2 e recuperação
  operacional continuam em tarefas próprias. A autoria/verificação direta do
  Codex é registrada; não há alegação de revisão independente no GitHub.

## D016 — Validar R2 com credencial restrita e dados fictícios (2026-09-06)

- **Contexto:** o ensaio local já demonstra dump e restauração, mas não testa
  a conexão, a criptografia transmitida ou o acesso restrito no armazenamento externo.
- **Decisão:** buckets privados separados de anexos e backups; token de conta
  temporário com operações de objetos somente no bucket de backups, autorizado
  especificamente pelo proprietário. O ensaio usa o backend S3 nativo do Restic,
  endpoint HTTPS canônico e prefixo único; somente a ferramenta tem saída externa.
- **Custódia:** salvar a chave do repositório em diretório privado fora do Git
  antes do primeiro envio. Preservar snapshot fictício e chave após limpar os
  clusters locais, permitindo inspeção posterior. Nenhuma credencial vai para CI.
- **Verificação:** ler todos os packs remotos, exigir recusa no bucket de anexos,
  parar a origem antes de restaurar e comparar dados, proprietários e ACLs.
  Comandos de corrupção ficam restritos ao repositório local descartável.
- **Limites:** este ensaio não ativa backups reais, retenção, agendamento ou
  alertas, nem comprova RPO/RTO ou custódia da chave de produção. O token de
  preparação expira em 2026-10-06. Procedimento em [R2.md](R2.md).

## D017 — Consumir Gemini diretamente e preservar o OmniRoute local (2026-09-06)

> A escolha de provedor/modelo foi substituída por D018. O histórico do ensaio
> e a preservação do OmniRoute abaixo continuam válidos.

- **Contexto:** o proprietário já tem API Gemini gratuita e envia menos de 30
  bilhetes por dia normalmente, com picos de 45–60. Instalar outro serviço de
  roteamento não é necessário para esse provedor. A comparação e as cotas
  efetivas foram apresentadas, e o proprietário aprovou continuar com Gemini.
- **Decisão:** API direta pelo worker da VPS; principal inicial
  `gemini-3.1-flash-lite`, que passou na prova fictícia. O candidato original
  `gemini-3.5-flash-lite` e o candidato à segunda leitura `gemini-3.8-flash`
  retornaram HTTP 503 e permanecem sujeitos a revalidação. Respeitar cotas do projeto, fila e retentativas
  limitadas. Falhas preservam o trabalho para revisão/reprocessamento, sem
  recorrer automaticamente a cobrança ou outros planos.
- **Limite de evidência:** a prova de imagem fictícia valida o protocolo e os
  campos daquele exemplo. A escolha por precisão exige amostra privada das
  casas usadas. Não atribuir acesso genérico de produto à assinatura Go ou Pro.
- **Preservação:** backup Restic local do OmniRoute, com SQLite consistente,
  configuração, código e alterações locais; restauração de arquivos e material
  de decifragem verificada sem iniciar a cópia. A limpeza das duas pastas
  temporárias privadas foi bloqueada pela revisão automática e ficou pendente.
- **Operação:** sem instalação OmniRoute na VPS ou transferência de suas
  sessões. Segredo Gemini fora do Git; nível gratuito com suas condições de
  uso de conteúdo. Não há implantação ou processamento de bilhetes reais nesta
  decisão. [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md).

## D018 — Gemini 3.8 Flash via OpenRouter com orçamento mensal (2026-09-06)

- **Contexto:** o proprietário disponibilizou saldo OpenRouter, autorizou criar
  a chave e testar Gemini 3.8 Flash; depois aprovou o modelo para o projeto
  e pediu adequar a chave, após a proposta de orçamento de USD 5 mensais.
- **Decisão:** modelo exato `google/gemini-3.8-flash`, consumido pelo futuro
  worker da VPS. Chave dedicada `Stakeframe - Gemini 3.8 Flash`, limite remoto
  de USD 5 mensais com renovação no dia 1 em UTC, sem ativar recarga de saldo.
- **Configuração:** segredo em arquivo privado, schema JSON, até 2.048 tokens
  de saída, raciocínio baixo e timeout de 60 segundos. Sem troca automática
  de modelo/provedor ou repetição de resultados ambíguos. Falhas de saldo/cota
  preservam trabalho para revisão e posterior reprocessamento.
- **Evidência:** uma imagem privada semanticamente conferida em 22 campos,
  5.141 ms e USD 0,0023247675. Não é benchmark representativo. Configuração
  pública e evidências agregadas em [OPENROUTER.md](OPENROUTER.md).
- **Limites:** chave fora do Git, ainda não instalada na VPS; configuração
  preparada não implementa o importador contínuo nem autoriza deploy. O backup
  do OmniRoute permanece preservado, sem exigir sua instalação na VPS.

## D019 — Continuar a implementação local de todo o produto (2026-09-06)

- **Contexto:** o proprietário determinou que Codex continue toda a implementação
  do projeto sem parar, após integrar o runtime de Telegram e OpenRouter.
- **Decisão:** implementar e validar M1–M5 localmente, mantendo as pendências
  operacionais de M0 identificadas. Cada etapa continua com issue, PR, checks,
  autorização vinculada ao SHA/base e CI na main. Codex é autor direto e registra
  sua própria verificação sem apresentá-la como revisão independente.
- **Primeira entrega:** interface privada, contratos financeiros, auditoria,
  comandos idempotentes e unidade mensal no PostgreSQL. Modelo e evidências
  reproduzíveis em [FINANCIAL-MODEL.md](FINANCIAL-MODEL.md).
- **Limites:** continuidade de implementação não autoriza deploy, migração de
  produção, alteração de credenciais/proteções ou operações destrutivas.
  Preparar os artefatos concretos antes de pedir a autorização correspondente;
  somente um piloto real e os critérios do plano permitem declarar v1.0.0.

## D020 — Revisão transacional e acesso privado aos comprovantes (2026-09-07)

- **Decisão:** upload e Telegram compartilham armazenamento por hash, preservando
  entradas distintas. Confirmar uma importação, registrar a aposta e movimentar
  a banca ocorre na mesma transação, com versões e idempotência. Candidatos por
  imagem, referência ou valores/data exigem decisão explícita; nenhum bilhete
  semelhante é descartado automaticamente.
- **Privacidade:** a API entrega bytes após verificar a sessão em cada leitura,
  com `no-store` e sem URLs portadoras de credencial. Essa escolha substitui a
  previsão de URLs temporárias no plano e permite revogação imediata da sessão.
  R2 continua privado e usa credencial exclusiva do bucket de anexos.
- **Retenção:** aguardar 30 dias após todas as referências terminarem; preservar
  imagem enquanto houver aposta aberta ou revisão pendente. Exclusão externa
  recuperável, sem apagar histórico financeiro. Upload incerto mantém os bytes
  locais e a obrigação de verificar/excluir o possível objeto remoto.
- **Limites:** todos os layouts continuam sem validação representativa de piloto,
  portanto toda extração exige revisão. Integrações e armazenamento externo
  permanecem desativados nos Composes padrão. [IMPORTS.md](IMPORTS.md).

## D021 — Programação de eventos com fontes conferidas (2026-09-07)

- **Decisão:** conservar identidade das seleções, separar data civil de instante
  e preservar evidências. Datas parciais não recebem horário inventado. Mudanças
  de data/adiamento exigem comando versionado e justificativa; não liquidam apostas.
- **Fontes:** TheSportsDB gratuito e Tavily basic oferecem candidatos, sempre
  sujeitos à conferência. Timestamp sem offset e data de publicação não viram
  instante do evento. Consulta alguma sobrescreve informação manual confirmada.
- **Operação:** fila PostgreSQL durável, cache de 24 horas, atualização explícita,
  cotas persistidas antes de HTTP e nenhuma repetição automática de falha incerta.
  APIs permanecem desativadas até preparar configuração e autorização operacional.
- **Calendário:** agenda paginada por seleção, com contagem distinta de bilhetes
  e sem multiplicação financeira de múltiplas. [EVENTS.md](EVENTS.md).

## D022 — Pacote de recuperação com expiração seletiva (2026-09-07)

- **Decisão técnica:** preservar o backup lógico completo de D009 em um pacote
  Restic que separa imagens e metadados do dump PostgreSQL. Anexos expirados são
  removidos também dos snapshots históricos, preservando os registros financeiros.
  A API e a recuperação mensal usam chaves R2 de leitura com escopos próprios.
- **Recuperação:** restaurar somente em cluster novo, conferir manifestos,
  contagens, saldos, exposição e privilégios, revogar sessões e colocar o worker
  em quarentena até conferência explícita de dados e backlog.
- **Operação:** ciclos de 30 minutos, RPO medido pelo cutoff, retenção de 48 horas
  e 30 dias, ensaio mensal isolado e monitor externo com estado persistente.
  Orçamento OpenRouter desconhecido ou fora da política bloqueia novas extrações.
- **Limites:** implementação e ensaios fictícios não autorizam ativação, escrita
  ou poda de backups de produção, credenciais, timers ou mensagens externas.
  Evidências em [M0-18-VALIDATION.md](M0-18-VALIDATION.md).

## D023 — Candidato OCI verificável antes da publicação (2026-09-07)

- **Decisão:** gerar os cinco targets em runners nativos AMD64 e ARM64 a partir
  da main com CI aprovada, preservando arquivos OCI, hashes e proveniência.
  Validar origem, plataforma e conteúdo antes de emitir o manifesto completo.
- **Publicação:** os candidatos ficam em artifacts por um dia. Registry,
  permissões de escrita, deploy e migração dependem de autorização posterior
  vinculada aos digests; não reconstruir no momento da publicação/implantação.
- **Operação:** preparar o registro da primeira janela, revalidar rede e
  recuperação, preservar a referência histórica pendente da issue #11 e
  demonstrar backup externo/restore antes do aceite do piloto.
- **Limites:** um índice por arquitetura inclui a imagem e sua proveniência;
  não é índice multiarch nem assinatura independente. Política de perda do host
  e gates em [FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md).

## D024 — Restauração da dinâmica normal de papéis (2026-09-08)

- **Decisão:** encerrar em 08/09/2026 a diretriz temporária de 06/09/2026 que
  atribuía implementações diretas ao Codex. A divisão normal de papéis volta a
  valer integralmente em [AGENTS.md](../AGENTS.md) e [PLAN.md](PLAN.md).
- **Papéis restabelecidos:** Hermes Desktop implementa, verifica e executa as
  operações Git/GitHub autorizadas por tarefa; Codex planeja, revisa
  tecnicamente e emite as autorizações de merge, release, deploy, migração e
  operações destrutivas; o proprietário decide produto e faz a ponte entre os
  agentes.
- **Histórico:** as tarefas executadas sob a exceção não têm o registro
  reescrito — os documentos apenas indicam que a exceção terminou, e a autoria
  direta do Codex naquele período permanece identificada nos PRs.
- **Limites restabelecidos:** novo commit ou mudança de base invalida
  autorização anterior; CI verde não autoriza merge; merge, deploy, migração,
  credenciais, permissões e exclusões destrutivas continuam exigindo
  autorização específica. Origem: issues #70 e #72.

## D025 — Escopo de casas do corpus no beta inicial (2026-09-14)

- **Decisão do proprietário:** Novibet não faz parte desta rodada nem do escopo
  inicial do beta. O corpus do subgate de avaliação cobre somente Bet365 e
  Superbet, cada uma com layout próprio e ensaio independente.
- **Substituição:** a decisão posterior do proprietário substitui, para o beta
  atual, a lista original de três casas do plano mestre; o arquivo externo do
  plano não é reescrito. Quando a Novibet voltar ao escopo, exige o próprio
  ensaio com os mesmos mínimos de cobertura e aprovação.
- **Limites:** o allowlist técnico do avaliador continua aceitando as três
  casas; isso não é cobertura nem aprovação. O fechamento do subgate do corpus
  não fecha o Gate 0: as demais pendências herdadas permanecem independentes.

## D026 — Casa do bilhete como contexto confiável da importação (2026-09-15)

- **Decisão do proprietário:** o usuário informa explicitamente qual é a casa
  do bilhete. `bookmakerId` vem desse contexto confiável e é validado contra a
  casa cadastrada; a IA não substitui, infere ou sobrescreve esse contexto. O
  texto extraído pelo modelo é evidência, nunca fonte de verdade para a casa —
  um bookmaker inventado pelo modelo não é aceito.
- **Sem casa informada:** a importação permanece em revisão. A ausência de
  marca no print não gera bookmaker inventado nem descarta um bilhete válido;
  a aplicação preenche o bookmaker final a partir do contexto e mantém a
  origem rastreável (`bookmakerOrigin: 'context'`, com o layoutId visual
  registrado à parte como evidência).
- **Avaliação:** o ensaio distingue o caminho com casa informada
  (`bookmakerContext: 'user-informed'`) do diagnóstico de layout cross-house.
  Separadores isolados de confronto (`x`, `v`, `vs`, `-`, `–`, `—`) e glifos
  ordinais `º`/`°` em mercados são normalizados somente no comparador; nada
  mais é relaxado (odds, valores, datas, seleções, ordem e schema permanecem
  exatos). Falsos positivos cross-house e conflitos de casa continuam
  bloqueando a aprovação e são reportados separadamente.
- **Escopo:** Bet365 e Superbet seguem como as casas do beta atual; Novibet
  permanece fora (D025). A confirmação humana continua obrigatória antes de
  qualquer escrita financeira, e a importação automática segue desabilitada
  fora de política aprovada. Importação, contexto, revisão e escrita
  permanecem fail-closed: incerteza, contexto ausente ou conflito vão para
  revisão, sem bypass por request, cookie, localStorage ou variável externa.

## D027 — Retornos financeiros, eventos empilhados e erros residuais (2026-09-15)

- **Contexto:** a avaliação real de G0-07 mediu os erros residuais (Bet365 16;
  Superbet 6). As classes dominantes não são de classificação de casa
  (conflitos zero) e sim de transcrição/contrato: omissões de retorno visível
  (`0,00`), transcrição de rótulo não-Total, separadores empilhados
  não-determinísticos e leituras incertas de data/referência.
- **Decisão (retornos):** o prompt do extrator passa a exigir a leitura do
  bloco financeiro final do comprovante — transcrever o valor do rótulo de
  retorno exatamente como exibido (inclusive `0.00` visível), distinguir
  retorno, retorno potencial, prêmio e valor da aposta, não transformar
  ausência em zero e não derivar retorno do status. Nenhuma heurística inventa
  valores; normalização decimal e validação continuam determinísticas e
  fail-closed.
- **Decisão (datas e referências):** transcrever exatamente o visível, sem
  inferir ano, completar dígitos ou corrigir grafia; `null` quando a leitura
  não for confiável; ambiguidade permanece em revisão.
- **Eventos empilhados:** o comparador trata a estrutura estrita em que
  exatamente dois lados não vazios aparecem separados por quebra de linha como
  equivalente ao separador de confronto; a ausência total de separador
  permanece divergência e hífens/nomes permanecem exatos.
- **Respostas inválidas:** a investigação dos dois `AI_RESPONSE_INVALID`
  (G0-07) confirmou que o envelope estrito (finish_reason `stop`, modelo
  literal, recusa nula) é a fronteira correta de validação; nenhum conteúdo
  bruto é preservado e as falhas permanecem como revisão obrigatória, sem
  afrouxar o schema (JSON truncado, campos extras, campos ausentes, números em
  vez de strings e schema inválido continuam recusados, com testes).
- **Ground truth v5:** único ajuste — grafia de um sobrenome em que o modelo
  estava correto e o v4 tinha erro de transcrição (o caso pertence ao corpus
  Bet365); nenhum outro valor foi adaptado ao observado e nenhum erro
  confirmado existiu no corpus Superbet. A elegibilidade do subgate continua
  pendente de nova avaliação real autorizada.

## D028 — Fallback multimodelo com aprovação separada (2026-09-15)

- **Contexto:** mesmo com failover entre Google AI Studio e Vertex elegível, as
  avaliações privadas foram interrompidas por HTTP 429. Uma triagem autorizada
  comparou nove modelos multimodais em imagem sintética e sete finalistas em um
  caso Bet365 e um Superbet, sempre com o mesmo contrato e sem retry.
- **Decisão:** usar a ordem fixa `google/gemini-3.8-flash` →
  `qwen/qwen3-vl-32b-instruct` →
  `deepseek/deepseek-v4-flash-vision-exp`. Não usar alias, auto-router ou modelo
  fora da lista. A OpenRouter executa a cadeia dentro de uma única requisição;
  o worker registra o modelo/provedor retornado e não repete a chamada.
- **Parâmetros comuns:** schema JSON estrito, `seed: 0`, 4.096 tokens e
  `require_parameters=true`. Raciocínio e temperatura ficam ausentes porque
  excluiriam endpoints/modelos da cadeia.
- **Fail-closed automático:** políticas são específicas por modelo. Enquanto
  Qwen e DeepSeek não tiverem corpus individual aprovado, podem preservar uma
  extração para revisão, mas recebem `policyDigest=null` e nunca importam
  automaticamente usando a aprovação do Gemini.
- **Evidência comparativa:** Gemini teve 1/2 divergências nos dois casos; Qwen
  32B teve 3/schema inválido; DeepSeek Vision teve 4/3. A triagem escolhe
  contingência operacional, não comprova elegibilidade automática. OpenCode Go
  permanece fora do runtime de bilhetes por ser destinado a tráfego de agentes
  de programação.

## D029 — Qualificação independente por casa e modelo dos fallbacks

- **Contexto:** a cadeia fixa (Gemini → Qwen 3 VL 32B → DeepSeek V4 Flash
  Vision) pode servir qualquer um dos modelos; um fallback sem corpus próprio
  não pode herdar a política do Gemini (D028), e o digest de política é
  específico do modelo que o produziu.
- **Decisão:** cada combinação casa × modelo tem avaliação e política
  independentes (Bet365/Superbet × Gemini/Qwen/DeepSeek); a seleção explícita de
  um modelo existe apenas na ferramenta privada de avaliação (allowlist exata
  da cadeia, sem fallback entre modelos, sem seleção por request, payload,
  cookie, query string ou variável pública), que grava o modelo solicitado e o
  retornado e aborta de forma sanitizada em divergência; os artefatos ficam
  separados por rodada, casa e modelo. O runtime do worker continua usando
  exclusivamente a cadeia fixa.
- **Consequências:** aprovar um modelo com o corpus de outro é proibido; o
  layout validado declara o modelo a que pertence e o digest nunca atravessa
  modelos; mudança de modelo, prompt, schema ou normalização invalida a
  política correspondente; enquanto não houver corpus aprovado por combinação,
  a importação automática permanece desabilitada e todo resultado de fallback
  fica em revisão humana.

## D030 — OCR auxiliar com Google Document AI (2026-09-15)

> **Supersedida pela D031.** A integração foi removida antes de qualquer
> ativação operacional; nenhuma credencial Google permanece no runtime.

- **Contexto:** os erros residuais dos bilhetes incluem referências, datas,
  valores pequenos e caracteres que se beneficiam de texto e coordenadas
  independentes, mas a estrutura visual continua necessária para relacionar
  mercado, seleção e retorno.
- **Decisão:** adicionar uma integração opcional com o Google Document AI
  Enterprise OCR antes da chamada multimodal. O processor retorna texto,
  coordenadas, blocos, linhas, confiança e qualidade; a imagem original segue
  obrigatoriamente para Gemini/Qwen/DeepSeek.
- **Fail-closed:** OCR é contexto auxiliar, nunca fonte única. Falha do OCR
  aborta o job antes da chamada multimodal quando a camada estiver ativada;
  divergência OCR × modelo ou baixa confiança mantém revisão humana. O OCR
  não fornece `policyDigest` e não libera importação automática.
- **Segurança:** ativação explícita, projeto/localização/processor fixos e
  credencial OAuth de service account somente em arquivo privado. O OCR fica
  desligado por padrão; nenhuma credencial, imagem, texto ou resposta bruta
  entra no repositório, logs, PR ou Kanban.

## D031 — Azure Vision como provedor OCR planejado (2026-09-15)

- **Contexto:** o projeto precisa de OCR estruturado para apoiar a leitura de
  bilhetes, mas o projeto Google usado na prova de conceito não possui uma
  rota operacional de faturamento disponível.
- **Decisão:** remover a integração Google Document AI do runtime e preparar o
  contrato provider-neutral para Azure Vision. A configuração de endpoint e
  segredo será feita separadamente pelo proprietário.
- **Gates:** Azure permanece desligado até a credencial ser configurada, a
  conectividade ser verificada e o mesmo corpus privado medir os campos
  essenciais. Nenhum resultado OCR aprova importação sozinho.
- **Segurança:** chaves somente por arquivo/segredo privado; nenhum bilhete,
  texto OCR ou resposta bruta em Git, logs, PR ou Kanban; falha do provedor
  deve ser sanitizada e fail-closed.

## D032 — Azure Vision + Google Vision no candidato da homologação final (2026-09-17)

- **Contexto:** a homologação privada final da importação automática (G0-19)
  mede os campos essenciais pela rota atual — OCR estruturado (Azure primário,
  Google fallback) antes da extração multimodal — sobre o harness de
  replay/corpus desta linha, que ainda não chamava OCR.
- **Decisão:** portar os adaptadores finais da `main` (#134) para esta linha
  (candidato), fiar o OCR no replay (configuração por env, pacing entre
  chamadas, abortos fail-closed) e registrar a evidência OCR sanitizada no
  próprio `actual` do corpus (provedor efetivo, uso do fallback, latência e
  `ocrConsistent`).
- **Gates:** `AUTOMATIC_IMPORT_ENABLED=false`; nenhum resultado OCR aprova
  importação; falha de OCR não vira chamada paga sem OCR; configuração
  inválida falha antes de qualquer rede/escrita; corpus e política preservados
  por SHA-256. O candidato fica sujeito à revisão do Codex antes de qualquer
  integração.
- **Segurança:** chaves somente em arquivos privados; nenhum bilhete, imagem,
  texto OCR ou resposta bruta em Git, logs, PR ou Kanban.

## D033 — Fluxo definitivo de importação Telegram/Web (2026-09-17)

- **Contexto:** a homologação da PR #136 provou a extração e a decisão, mas o
  fluxo de produto ainda misturava responsabilidades: a legenda carregava o
  tipo financeiro e a data, a web e o Telegram não eram interfaces explícitas
  do mesmo registro e a limpeza do chat não era automática.
- **Decisão:** a legenda passa a conter apenas tipster + casa; a origem
  financeira (`real | freebet | null`) é declarada pelo usuário no Mini App ou
  no formulário web (nulo ⇒ nenhuma aposta é criada; freebet exige crédito
  explícito); o retorno potencial é calculado server-side (`stake × totalOdds`,
  decimal exato) com o valor visual apenas diagnóstico; as datas ganham
  semânticas separadas (`telegramReceivedAt` imutável, `placedAt`, `eventAt`
  nulo até confirmação, `eventDateStatus`); o banco é a fonte canônica única
  com outbox idempotente para o Telegram e limpeza automática da foto e da
  resposta quando a aposta deixa de estar pendente.
- **Gates:** `AUTOMATIC_IMPORT_ENABLED=false`; zero operação real no Telegram
  nesta fase (mocks do Bot API); migração 0011 aditiva local/CI, forward-only
  e compatível com registros existentes (sem migração em produção); nenhum
  identificador Telegram, token ou conteúdo privado em logs, PR, Kanban ou
  memória; a importação automática permanece desativada até política aprovada.
- **Segurança:** `initData` do Mini App validado no servidor (HMAC) e vinculado
  ao Telegram ID do proprietário; a web nunca chama o Telegram diretamente;
  auditoria sanitizada por edição.
