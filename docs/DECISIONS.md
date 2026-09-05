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

## D003 — Node.js 24 LTS com versão exata fixada

- **Contexto:** o plano define Node 24 LTS; o ambiente local ainda roda Node
  v22.23.2 (limitação registrada).
- **Decisão:** `.nvmrc` com `v24.20.0` (LTS "Krypton", primeira linha LTS da
  linha 24); CI executa com essa versão via `node-version-file`. `engines` em
  `package.json` exige `>=24.20.0`.
- **Consequências:** desenvolvimento local em Node 22 dispara aviso de engine
  (funcional, mas registrada a pendência de alinhar o ambiente local — ex. via
  nvm-windows/fnm/volta).

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
