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
