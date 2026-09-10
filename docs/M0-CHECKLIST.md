# Checklist do M0 — Setup

STK-M0-17 — runtime de integrações e inbox transacional — foi integrada pela
[PR #35](https://github.com/RhianB14/stakeframe/pull/35), com cinco checks
aprovados na `main` `5921bcc` e issue #34 encerrada. A implementação local
integrou M1/M2 ([PR #38](https://github.com/RhianB14/stakeframe/pull/38)),
M3 ([PR #39](https://github.com/RhianB14/stakeframe/pull/39)) e
M4 ([PR #41](https://github.com/RhianB14/stakeframe/pull/41)), com CI aprovada
após cada integração. M5 foi integrado pela [PR #43](https://github.com/RhianB14/stakeframe/pull/43)
e a preparação de validação M6 pela [PR #45](https://github.com/RhianB14/stakeframe/pull/45),
com CI aprovada na `main` após cada integração. STK-M0-18 foi integrada pela
[PR #47](https://github.com/RhianB14/stakeframe/pull/47), com cinco checks aprovados
na `main` `576c831` e issue #46 encerrada. STK-M0-19 foi integrada pela
[PR #49](https://github.com/RhianB14/stakeframe/pull/49), com CI aprovada na
`main` `1382348` e dez arquivos OCI verificados em runners AMD64/ARM64.
STK-M0-20 foi concluída pela [PR #51](https://github.com/RhianB14/stakeframe/pull/51):
os cinco índices ARM64 foram publicados e a leitura anônima foi verificada na
VPS, conforme autorização do proprietário; [PUBLICATION.md](PUBLICATION.md).
STK-M0-21 ([issue #52](https://github.com/RhianB14/stakeframe/issues/52)) criou
as quatro credenciais R2 privadas, com 34 verificações de escopo aprovadas;
a instalação na VPS permanece pendente.
O piloto ARM64 foi executado em 07/09/2026 após a publicação #10: os cinco
serviços foram atualizados por digest, a migração retornou `MIGRATIONS_COMPLETE`
e todos os serviços ficaram saudáveis. A evidência está em
[M0-24-VALIDATION.md](M0-24-VALIDATION.md). Após a correção do registro A,
o Caddy obteve o certificado Let's Encrypt e os probes públicos passaram; o
início do fluxo OAuth, o callback seguro e a recusa sem sessão foram
verificados, mas o login real do proprietário permanece pendente.
STK-M0-25 ([issue #67](https://github.com/RhianB14/stakeframe/issues/67))
reconciliou o estado operacional: backup externo R2 ativo desde 07/09/2026,
permissões do diretório de segredos corrigidas e cópia redundante aninhada
removida ([M0-25-VALIDATION.md](M0-25-VALIDATION.md)).
STK-M0-29 concluiu o primeiro restore isolado com produção intacta; em seguida,
STK-M0-30 ([issue #86](https://github.com/RhianB14/stakeframe/issues/86)) instalou
e habilitou o timer mensal e validou uma execução inicial supervisionada. O
timer está ativo para 01/10/2026 às 03:26 UTC; evidências em
[M0-30-VALIDATION.md](M0-30-VALIDATION.md).
STK-M0-31 ([issue #11](https://github.com/RhianB14/stakeframe/issues/11))
reconciliou a documentação com a janela IPv6 executada e confirmada em
07/09/2026 e registrou o aborto seguro do preflight de 10/09/2026, sem mutação
([M0-31-VALIDATION.md](M0-31-VALIDATION.md)). STK-M0-32
([issue #89](https://github.com/RhianB14/stakeframe/issues/89)) removeu o
rollback do checkout retido pela STK-M0-29 sob autorização destrutiva específica
do proprietário, após conferir identidade, ausência de uso e integridade do
checkout ativo ([M0-32-VALIDATION.md](M0-32-VALIDATION.md)).
STK-M0-33 ([issue #91](https://github.com/RhianB14/stakeframe/issues/91))
implementou a persistência segura do hardening IPv6 no boot: aplicador próprio com
transação atômica única, unit systemd versionada com ordenação verificada e
suíte dedicada. A unit foi instalada e habilitada em 10/09/2026 (staging com
hashes conferidos, `ip6tables-restore --test` sem mutação, `systemd-analyze
verify` rc 0, `daemon-reload` e `enable` sem `--now`) e um reboot controlado
único validou a primeira aplicação real pelo boot: delta `STK6_BOOT` exato,
idempotência `no-op`, arquivos de persistência preservados, serviços e
containers saudáveis, sem segundo reboot e sem rollback. O gate de recuperação
fora de banda foi apenas parcialmente validado (lado guest preparado; nenhuma
sessão OCI independente estabelecida ou mantida) e a disponibilidade de
recuperação continua não comprovada para futuras janelas críticas
([M0-33-VALIDATION.md](M0-33-VALIDATION.md)). O registro documental é a
STK-M0-34 ([issue #93](https://github.com/RhianB14/stakeframe/issues/93)).
O avanço ocorre por determinação
do proprietário (D019), preservando recuperação integral/failover, alertas,
monitor e release como pendências. STK-M0-16 foi
integrada pela [PR #33](https://github.com/RhianB14/stakeframe/pull/33), com
cinco checks aprovados na `main` `f5e6a59`. STK-M0-15 foi
integrada pela [PR #31](https://github.com/RhianB14/stakeframe/pull/31), com
CI aprovada na `main` `71928cc`. STK-M0-14 foi
integrada pela [PR #29](https://github.com/RhianB14/stakeframe/pull/29), com
CI aprovada na `main` `a907626`. STK-M0-12 e
STK-M0-13 foram integradas pelas
[PR #25](https://github.com/RhianB14/stakeframe/pull/25) e
[PR #27](https://github.com/RhianB14/stakeframe/pull/27), com CI aprovada na
`main` após cada integração. STK-M0-11 foi
integrada pela [PR #23](https://github.com/RhianB14/stakeframe/pull/23), com
CI aprovada em AMD64 e ARM64 nativo na `main` `183bd9b`. Base local,
autenticação e OpenAPI (STK-M0-07 a STK-M0-09) integrados à `main` pelas
[PR #15](https://github.com/RhianB14/stakeframe/pull/15),
[PR #17](https://github.com/RhianB14/stakeframe/pull/17) e
[PR #19](https://github.com/RhianB14/stakeframe/pull/19), com CI aprovada após
cada integração. O ensaio de recuperação foi integrado pela
[PR #21](https://github.com/RhianB14/stakeframe/pull/21).

O código da reconciliação foi integrado pela
[PR #13](https://github.com/RhianB14/stakeframe/pull/13), com os comentários
de revisão resolvidos e CI aprovada na `main`. O run legado foi encerrado
administrativamente na STK-M0-22, sob autorização de Rhian, em 07/09/2026:
units removidas, apontador arquivado e bundle original intacto. A lacuna
histórica IPv4 permanece registrada; [M0-22-VALIDATION.md](M0-22-VALIDATION.md).
A janela IPv6 da [issue #11](https://github.com/RhianB14/stakeframe/issues/11)
foi executada e **confirmada em 07/09/2026**; o plano que a antecedeu permanece
como registro histórico em [NEXT-NETWORK-WINDOW.md](NEXT-NETWORK-WINDOW.md) e o
resultado está em [M0-31-VALIDATION.md](M0-31-VALIDATION.md). As integrações das
PRs não autorizam deploy, migração ou nova janela de rede.

Histórico: STK-M0-05 registrou a recuperação administrativa
([ACCESS-RECOVERY.md](ACCESS-RECOVERY.md) §9; issue #9, referenciando a issue #7).
STK-M0-02 foi concluída pela PR #4, integrada por squash na `main` em
`666f915ab0c94eeef3f792f5eed88809a049297e`. STK-M0-03 foi concluída pela
[PR #6](https://github.com/RhianB14/stakeframe/pull/6), integrada por squash
na `main` em `ea14692f6a15fb33b1189638e674ac5571f5eb86`, com CI verde e a
issue #5 fechada. Na STK-M0-03-R2, a inspeção OCI
realizada pelo Codex em 05/09/2026 foi incorporada por retransmissão do
proprietário, somando-se à coleta guest da R1. O caminho do console foi
identificado naquela etapa; IAM, serial e recuperação administrativa do Ubuntu
foram posteriormente validados no teste pontual da STK-M0-05. A janela IPv6
da STK-M0-06 está registrada abaixo; a STK-M0-07 não executa ações remotas.
O M0 ainda está em andamento e só é considerado concluído quando todos os
itens abaixo estiverem verificados e o Codex autorizar o avanço.

## Resumo de reconciliação — 2026-09-08

Auditoria dos checkboxes rastreados nos quatro documentos de checklist
([M0-CHECKLIST.md](M0-CHECKLIST.md), [DEPLOYMENT.md](DEPLOYMENT.md),
[NETWORK-SECURITY.md](NETWORK-SECURITY.md), [RECOVERY.md](RECOVERY.md)),
conferidos contra a evidência real na `main` (`5a84beb`, PRs #64, #65 e #66
integradas) e nas janelas STK-M0-25A/25B
([M0-25-VALIDATION.md](M0-25-VALIDATION.md)):

| Documento           | Concluídos | Abertos | Total   | Percentual |
| ------------------- | ---------- | ------- | ------- | ---------- |
| M0-CHECKLIST.md     | 76         | 14      | 90      | 84%        |
| DEPLOYMENT.md       | 6          | 3       | 9       | 67%        |
| NETWORK-SECURITY.md | 5          | 6       | 11      | 45%        |
| RECOVERY.md         | 0          | 3       | 3       | 0%         |
| **Total**           | **87**     | **26**  | **113** | **77%**    |

Em relação à auditoria de 2026-09-07 (83/109, 76%), foram adicionados quatro
estados concluídos (ativação comprovada nas janelas STK-M0-25A/25B) e quatro
divisões de denominador: pendências antes agregadas em itens compostos foram
explicitadas como itens próprios, sem ocultar pendências.

Percentual calculado como concluídos / total. Esta contagem **não substitui os
critérios de aceite**: percentual alto não autoriza operação, deploy, release
ou janela de rede; cada item exige a evidência descrita.

> **Nota (STK-M0-31, 10/09/2026):** esta tabela é um retrato datado de
> 08/09/2026, anterior à execução da janela IPv6. A janela foi executada e
> confirmada em 07/09/2026 e os gates de execução de
> [NETWORK-SECURITY.md](NETWORK-SECURITY.md) §7 foram fechados; a contagem acima
> não foi recalculada nesta tarefa
> ([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §7).

> **Nota (STK-M0-32, 10/09/2026):** o rollback do checkout retido pela STK-M0-29
> foi **removido** sob autorização destrutiva específica do proprietário, após
> conferência de identidade, ausência de uso e integridade do checkout ativo.
> Nenhum outro diretório, staging, bundle, journal, archive ou recurso foi
> removido ([M0-32-VALIDATION.md](M0-32-VALIDATION.md)).

## Concluído nesta tarefa (STK-M0-01)

- [x] Inspeção do ambiente local (Git, gh, Node, pnpm, Docker) e da conta
      GitHub (`RhianB14`), sem exposição de segredos.
- [x] Verificação de que `RhianB14/stakeframe` não existia antes da criação.
- [x] Bootstrap mínimo: README real, LICENSE (MIT, Rhian Batista, 2026),
      `.gitignore`, `.editorconfig`, Prettier 3.9.6, workflow de CI.
- [x] Node.js v24.20.0 fixado (`.nvmrc`, `engines`), pnpm 11.24.0
      (`packageManager`), lockfile versionado.
- [x] Repositório público criado; `main` publicada com commit único de
      bootstrap (exceção autorizada); CI executada com sucesso.
- [x] Configuração do repo: descrição, issues on, wiki/discussions off,
      somente squash, exclusão de branch pós-merge, auto-merge off,
      secret scanning + push protection + dependabot security updates.
- [x] Proteção da `main`: PR obrigatória, check `format-check` obrigatório
      (strict), enforce_admins, histórico linear, force-push/exclusão
      bloqueados, conversas obrigatórias.
- [x] Documentação: AGENTS.md, PLAN.md, ARCHITECTURE.md, DECISIONS.md,
      DEVELOPMENT.md, GOVERNANCE.md, DEPLOYMENT.md, RECOVERY.md, `.env.example`.
- [x] Templates de issue (bug/feature) e de PR.
- [x] Milestones M0–M6, labels (tipo/prioridade/etapa), issue da tarefa
      STK-M0-01 aberta e vinculada à PR.
- [x] Diagnóstico do restante do M0 (abaixo).
- [x] STK-M0-01 concluído pela [PR #2](https://github.com/RhianB14/stakeframe/pull/2), integrada por squash no commit `8be12104f52c06eb7d1456ad9e87895434507ceb`.

## Execução atual e pendências do M0

### Ambiente local

- [x] Runtime local alinhado: execução isolada com Node v24.20.0 e pnpm
      11.24.0 em `dev\tools\stakeframe` (zip oficial do nodejs.org com SHA-256
      conferido + pnpm standalone oficial). Verificado: `node --version` =
      v24.20.0, `pnpm --version` = 11.24.0, `pnpm exec node --version` =
      v24.20.0. Procedimento em [docs/DEVELOPMENT.md](DEVELOPMENT.md). CI já
      usava a versão correta.

### VPS Oracle Always Free

- [x] Confirmar acesso de leitura à VPS e inventariar a VPS existente
      informada pelo proprietário: **2 CPU, 12 GB RAM, 50 GB**. A conexão
      confirmou Ubuntu 24.04.4 LTS, `aarch64`/ARM64 e 2 CPUs. Inspeção do
      Codex retransmitida na R2 confirmou `VM.Standard.A1.Flex`, 2 OCPUs,
      12 GB RAM, 2 Gbps e boot volume 50 GB (detalhes em NETWORK-SECURITY).
- [x] Inventariar CPU, memória, swap, disco, inodes, relógio, containers,
      serviços, listeners e firewall local na VPS; evidência sanitizada em
      [docs/INFRASTRUCTURE-INVENTORY.md](INFRASTRUCTURE-INVENTORY.md).
- [x] Verificar Docker + Docker Compose na VPS: Docker 29.7.2, API 1.55 e
      Compose v5.5.0; daemon disponível, zero containers e zero projetos Compose.
- [x] Definir e documentar política de recuperação de instâncias ociosas em
      [FIRST-DEPLOYMENT.md](FIRST-DEPLOYMENT.md); operação real e RTO seguem
      pendentes de validação, sem geração artificial de carga.
- [x] Registrar o diagnóstico e as pendências restantes de acesso em
      [docs/INFRASTRUCTURE-INVENTORY.md](INFRASTRUCTURE-INVENTORY.md).
- [x] STK-M0-02 concluída pela [PR #4](https://github.com/RhianB14/stakeframe/pull/4),
      integrada na `main` em `666f915ab0c94eeef3f792f5eed88809a049297e`.

### STK-M0-03 — Revisão de rede e preparação da segurança

- [x] Completar leitura somente leitura da rede convidada: backend efetivo
      `iptables-nft`, IPv4/IPv6, NAT, Docker, Fail2Ban, persistência, rotas,
      DNS/NTP, campos efetivos de SSH e `rpcbind`/RPC/NFS. Revalidar contexto
      `Match Host` do cliente antes da janela; limitação do coletor R1 registrada
      em `docs/NETWORK-SECURITY.md`.
- [x] Incorporar inspeção OCI do Codex retransmitida pelo proprietário:
      shape, volumes, VNIC, subnet, rotas, Security List, NSG e regras stateful.
      Sem IPv6 público, regras ou rotas IPv6; não pedir repetição do painel.
- [x] Identificar caminho instância → OS Management → Console connection;
      nenhuma conexão existente exibida e nenhum botão acionado.
- [x] Validar IAM, transporte serial e login/recuperação do Ubuntu em tarefa
      separada; chave de transporte não equivale a login no guest. Preparação
      concluída na STK-M0-04 ([ACCESS-RECOVERY.md](ACCESS-RECOVERY.md));
      validação executada e registrada na STK-M0-05 (§9).
- [x] Substituir os exemplos R1 por implementação local única e proposta
      somente IPv6 INPUT/FORWARD ativo, sem persistência nesta janela, em
      [docs/NETWORK-SECURITY.md](NETWORK-SECURITY.md). IPv4, OUTPUT, Docker,
      Fail2Ban, SSH, rpcbind e OCI preservados.
- [x] Concluir preparação para execução: revisão do Codex, recuperação
      demonstrada e gates reais de janela; simulação não é teste na VPS.
      **Executada e concluída** — a preparação histórica e a janela IPv6 foram
      executadas (STK-M0-04/05/33/34). O gate OOB foi **apenas parcialmente
      validado** (verificação sem sessão OCI mantida, [M0-33-VALIDATION.md
      §10](M0-33-VALIDATION.md)); a disponibilidade OOB **continua não comprovada
      para futuras janelas críticas**.
- [x] Preparar implementação única em `scripts/network_security/ipv6_guard.py`,
      com runbook referenciado, sintaxe/CLI offline e 51 testes simulados
      aprovados localmente. CI inclui job separado de simulação, sem comandos
      reais de firewall/systemd. Isso não valida o runtime da VPS.
- [x] Revisar dependências de `rpcbind`: somente `portmapper` foi retornado,
      não há montagem NFS e nenhum consumidor NFS/RPC ativo foi observado.
      Eventual desativação de serviço/socket continua sendo tarefa separada.
- [x] Autorização específica do Codex para a aplicação, com recuperação
      validada, cópia no servidor/externa, timer monotônico e lock
      ([M0-31-VALIDATION.md](M0-31-VALIDATION.md)).
- [x] Após as alterações, segunda conexão SSH independente aberta e probes
      executados; confirmação sem rollback iniciado. OCI sem mudanças.

### STK-M0-04 — Preparar validação de recuperação de acesso

- [x] Leitura focada somente leitura do guest via SSH existente, com
      verificação de identidade do host (`known_hosts` anterior; chave nova
      não aceita) e comandos por stdin, sem arquivos no guest: console serial
      (`ttyAMA0`), getty serial ativo, autenticação PAM do console, estado das
      contas (sem ler/copiar hashes), sudo existente e contextos `sshd -T`
      com a identidade real do cliente.
- [x] Contexto `sshd -T -C host=` validado com a tupla real observada pelo
      servidor (`SSH_CONNECTION`) e campos de autenticação registrados;
      configuração carregada verificada (include único, nenhuma linha `Match`
      nos arquivos carregados). Prova por configuração, não por igualdade de
      saídas; `sshd -T` requer sudo para ler chaves de host.
- [x] Preparar [docs/ACCESS-RECOVERY.md](ACCESS-RECOVERY.md): estado
      observado, pré-requisitos não comprovados, sequência A–F do teste
      futuro, mutações previstas com impacto/limpeza e critérios de
      sucesso/interrupção/evidências. Não confunde saída serial com
      recuperação nem recuperação de acesso com restauração de banco
      ([RECOVERY.md](RECOVERY.md)). Revisão R1: credencial reclassificada de
      desbloqueio para **definição** (nenhuma conta pertinente tem hash);
      operação responsável pelo segredo documentada sem senha em
      argumentos/histórico/logs; limpeza cobre falhas desde a criação da
      conexão OCI; separação explícita entre teste pontual concluído e
      recuperação pronta para janela futura.
- [x] Consultas adicionais de painel sinalizadas ao Codex em
      ACCESS-RECOVERY §6; inspeção OCI anterior permanece válida; painel não
      repetido.
- [x] Executar o teste de recuperação (fases A–F) — executado e verificado na
      STK-M0-05 dentro da janela autorizada (registro em
      [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md) §9); a preparação histórica
      deste bloco permanece como registro.

### STK-M0-05 — Registrar a validação executada

- [x] IAM e transporte validados pelo Codex (Cloud Shell; conexão anterior
      excluída automaticamente) e autenticação realizada pelo proprietário,
      com o segredo restrito à digitação própria.
- [x] Provas executadas pelo Codex no serial: `tty` = `/dev/ttyAMA0`,
      `id -un` = conta padrão, `sudo -n id -u` = `0`.
- [x] Restauração verificada pelo Hermes às 23:26:28 UTC: campo de senha da
      conta padrão de volta à forma sem hash, `lastchg` restaurado (20695) e
      demais metadados idênticos à linha de base; root inalterado; SSH + sudo
      operantes.
- [x] Encerramento confirmado pelo Codex: logout serial e exclusão da conexão
      (`DELETED` às 23:32:58 UTC; tabela vazia; Cloud Shell encerrado).
- [ ] Descarte da chave temporária da integração — **não comprovado**:
      pendência explícita; não afirmar limpeza integral nem supor que um
      arquivo existiu; a inspeção do Cloud Shell comum não estabelece
      equivalência com o ambiente da integração serial.
- [x] Recuperação administrativa **validada como teste pontual concluído** —
      sem marcar recuperação pronta para janela futura; qualquer janela de
      firewall exige console independente estabelecido e mantido durante a
      janela (ACCESS-RECOVERY §5 e §9). M0 permanece em andamento.

### STK-M0-06 — Janela IPv6 executada e correção do guard

- [x] Primeira janela registrada: apply do delta IPv6, confirmação recusada,
      rollback automático com fase `rollback_incomplete`; firewall restaurado
      e verificado externamente, sem novo apply nesta correção.
- [x] Observação reproduzida: `GetUnit` retornou `unit not loaded` para unidade
      inativa durante a verificação; horários systemd verificados na evidência
      privada: início `07:50:09 UTC`, parada `07:58:46 UTC`.
- [x] Correção validada em simulação e em systemd real descartável Ubuntu 24.04,
      systemd 255, sem firewall: mensagem real `Unit … not loaded.` classificada
      somente para a unidade consultada; `infinity` é ausência de próximo
      disparo; prazo futuro, campo ausente ou saída inválida não confirmam
      timer parado; timestamp positivo anterior não é apagado por zero, inclusive
      quando o D-Bus responde com sucesso.
- [x] Complemento do Codex: 73 testes simulados e 5 cenários do controlador com
      systemd real em container descartável; referência D-Bus contínua durante
      confirmação, worker concorrente e perda de conexão verificados com
      firewall simulado.
- [x] Janela de aplicação executada e **confirmada em 07/09/2026**: delta IPv6
      ativo (INPUT/FORWARD `DROP`, OUTPUT preservado), confirmação sem corrida e
      sem rollback, timer desarmado, segunda conexão SSH com probes aprovados e
      produção intacta ([M0-31-VALIDATION.md](M0-31-VALIDATION.md)).
- [x] Encerramento administrativo do run legado `f15efb347860c80f9271`,
      executado em **07/09/2026 às 11:03:23 UTC** (`administratively_closed`):
      as duas units do run legado foram removidas, o apontador ativo foi
      arquivado com os mesmos bytes e o journal original foi preservado em
      `rollback_incomplete`. A evidência registra
      `prior_ipv4_preservation_proven: false`, e esse encerramento **não** aplicou
      hardening nem alterou firewall, persistência, DNS, OCI, SSH ou credenciais
      ([M0-22-VALIDATION.md](M0-22-VALIDATION.md)).
- [x] Persistir o delta IPv6 — **concluído e comprovado**: STK-M0-33/STK-M0-34
      instalaram a unit systemd de persistência, habilitaram-na e validaram um
      reboot controlado único com primeira aplicação real pelo boot
      (`active/exited`, `Result=success`), idempotência `no-op` e **unit
      habilitada** com delta aplicado **no único boot validado**; a reaplicação
      futura decorre da configuração instalada, **sem segundo reboot observado**
      ([M0-33-VALIDATION.md](M0-33-VALIDATION.md) §10, atualizado pela
      [PR #94](https://github.com/RhianB14/stakeframe/pull/94)). A recuperação
      fora de banda (OOB) **continua não comprovada** para futuras janelas
      críticas: o gate foi apenas parcialmente validado (lado guest preparado;
      nenhuma sessão OCI independente estabelecida ou mantida durante o reboot).
- [ ] Descarte da chave temporária da integração serial — **não comprovado**
      (pendência herdada da STK-M0-05); não é resolvido pela janela executada.

> As units preservadas do run confirmado `53a5b43c1bd6049fe497` **não** são as
> do run legado: as do run confirmado permanecem em `/run/systemd/system`,
> carregadas (`LoadState=loaded`) e inativas, como registro da janela executada
> ([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §4).

- [x] Acesso serial/Cloud Shell encerrado conforme repasse: logout concluído,
      conexões vazias e Cloud Shell fechado; descarte da chave temporária segue
      não comprovado.

### Domínio

- [x] Consultar disponibilidade e preço de `stakeframe.com.br`: ISAVAIL
      retornou `ST 0` em 2026-09-05 e a página oficial informa R$ 40,00 por
      um ano. Nenhuma compra foi realizada; a decisão continua do proprietário.
- [x] Atualização de 2026-09-06: proprietário informou a compra de
      `stakeframe.com.br` pela HostGator. O registro A foi corrigido para
      `129.146.113.111` e o HTTPS foi verificado no piloto de M0-24: o Caddy
      obteve o certificado Let's Encrypt e os probes públicos passaram
      ([M0-24-VALIDATION.md](M0-24-VALIDATION.md)).

### STK-M0-07 — Base local da aplicação

- [x] Monorepo pnpm com TypeScript estrito; `apps/web`, `apps/api`,
      `apps/worker`, `packages/db` e `packages/shared`.
- [x] Tela React/Vite/Tailwind/TanStack Query de preparação, responsiva e com
      consulta real do estado da conexão, sem dados financeiros fictícios.
- [x] API Fastify com contratos Zod, liveness, readiness dependente do banco,
      erros sanitizados e execução restrita à configuração local.
- [x] PostgreSQL 18 via Drizzle e worker pg-boss com job técnico persistente,
      payload validado e retries limitados. Sem tabelas de domínio.
- [x] Compose local com quatro serviços, Caddy HTTP em loopback, volume do
      banco e credenciais geradas fora do Git/contexto de build.
- [x] Verificações de tipos, lint, unitários, build, integração PostgreSQL real
      e navegador desktop/mobile adicionadas à CI como `application-check`.
- [x] STK-M0-08: código Google OAuth/Better Auth, identidade única por `sub`
      e e-mail verificado, sessão no PostgreSQL, logout e migração local.
      [Issue #16](https://github.com/RhianB14/stakeframe/issues/16).
- [x] Validar autenticação local com credenciais e conta Google reais após
      autorização específica: login, recarga, logout e recusa por identidade.
      Evidência em [M0-08-VALIDATION.md](M0-08-VALIDATION.md). Consulte
      [AUTHENTICATION.md](AUTHENTICATION.md).
- [x] STK-M0-09: OpenAPI gerado dos schemas de entrada/resposta, erros estáveis
      e validação de sincronização na CI. [API.md](API.md) e
      [M0-09-VALIDATION.md](M0-09-VALIDATION.md).
- [x] Schema de produto e componentes Radix/shadcn da interface privada
      implementados em M1/M2; migrações de produto validadas somente em ambientes locais/CI.
- [x] STK-M0-11: imagens separadas de API, worker e migrações, limitadas aos
      arquivos e dependências de execução, com verificação de conteúdo.
      [RUNTIME-IMAGES.md](RUNTIME-IMAGES.md).
- [x] Configurar a suíte da aplicação e inspeção das imagens em runner ARM64
      nativo na CI (STK-M0-11); resultados por head registrados na PR.
- [x] Validar execução ARM64 na VPS; o piloto de 07/09/2026 atualizou os cinco
      serviços por digest e executou a migração. O manifest multiarch das
      imagens base não substitui essa execução.

### Integrações

- [x] Google OAuth local: cliente web em projeto de desenvolvimento, escopos
      básicos, credenciais fora do repositório e identidade restrita no servidor.
- [x] STK-M0-14: projeto e cliente web de produção separados, callback HTTPS
      cadastrado, três escopos básicos e credenciais privadas fora do Git,
      após autorização específica. [M0-14-VALIDATION.md](M0-14-VALIDATION.md).
- [ ] Validar login Google real de produção após implantação autorizada;
      configuração do cliente não comprova o fluxo em HTTPS público.
- [x] STK-M0-15: bot Telegram criado, grupos bloqueados, token privado,
      associação do chat/usuário por desafio e resposta de teste ao proprietário.
      [TELEGRAM.md](TELEGRAM.md) e [M0-15-VALIDATION.md](M0-15-VALIDATION.md).
- [x] Consumidor Telegram implementado com recusa de outras identidades antes
      de baixar anexos, persistir mensagens ou enfileirar processamento.
      Inbox/enqueue transacional e testes em [INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md).
- [ ] Ativar e validar o consumidor contínuo com configuração privada na VPS.
- [x] Cloudflare R2 ativado; buckets privados separados de anexos e backups
      criados. Token de ensaio restrito ao bucket de backups, autorizado por
      30 dias, com segredos fora do Git. [R2.md](R2.md), STK-M0-13.
- [x] Quatro credenciais R2 de produção criadas com escopos exclusivos de
      leitura e escrita para cada bucket; custódia privada e 34 testes
      aprovados, STK-M0-21 ([issue #52](https://github.com/RhianB14/stakeframe/issues/52)).
- [x] Credencial R2 de backup instalada e validada pelos ciclos: 36 ciclos com
      retenção ativa e `state=ready` desde 07/09/2026
      ([M0-25-VALIDATION.md](M0-25-VALIDATION.md)).
- [ ] Validar reader/writer de anexos com operação real (com `imageCount=0`
      não há validação de anexos) e instalar/validar as credenciais de
      restauração (`r2_backup_restore_*`) no ensaio de restauração; não
      reutilizar automaticamente o token temporário de ensaio.

### IA direta com Gemini

- [x] Provedor e modelos selecionados pelo proprietário após comparação;
      cotas gratuitas observadas na conta. OmniRoute dispensado na VPS.
      [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md), decisão D017 substituída por D018.
- [x] Gemini 3.8 Flash via OpenRouter escolhido após ensaio privado: chave
      dedicada com USD 5 mensais, configuração privada preparada e teste
      conferido. [OPENROUTER.md](OPENROUTER.md). Integração contínua ainda pendente.
- [x] Backup criptografado do OmniRoute local e restauração de arquivos/banco
      verificados, preservando a instalação existente. Limpeza das cópias
      temporárias privadas bloqueada pela revisão automática; não concluída.
- [x] Prova real limitada de imagem fictícia e saída estruturada pelo
      `gemini-3.1-flash-lite`, com 8/8 campos conferidos. 3.5 Flash-Lite e
      3.8 Flash retornaram 503; não validados. [M0-16-VALIDATION.md](M0-16-VALIDATION.md).
- [ ] Medir precisão com bilhetes privados das três casas; validar campos,
      omissões e casos que exigem revisão do proprietário.
- [x] Runtime OpenRouter no worker, fila persistente e cotas transacionais;
      chamadas incertas preservadas sem repetição automática (STK-M0-17).
- [x] Interface de reprocessamento explícito com confirmação, versão e idempotência em M3.
- [ ] Operação contínua das integrações na VPS sem o PC.

### Infraestrutura e operação

- [x] STK-M0-12: configuração de produção com autenticação obrigatória, segredos
      por arquivo, banco sem superusuário na aplicação, HTTPS e ensaio local
      descartável com persistência após reinício. O deploy foi registrado à
      parte no piloto de M0-24 e a operação contínua permanece pendente de
      autorização.
      [PRODUCTION-CONFIGURATION.md](PRODUCTION-CONFIGURATION.md) e
      [M0-12-VALIDATION.md](M0-12-VALIDATION.md).
- [x] Docker Compose inicial (app, api, worker, PostgreSQL, Caddy)
      com volumes e redes internas.
      Base local disponível na STK-M0-07; configuração de produção
      preparada na STK-M0-12; piloto ARM64 executado em M0-24.
- [x] DNS corrigido para `129.146.113.111`, HTTPS ativo e certificado
      Let's Encrypt emitido pelo Caddy, conforme o piloto de M0-24
      ([M0-24-VALIDATION.md](M0-24-VALIDATION.md)).
- [ ] Renovação automática do certificado comprovada em operação; a emissão
      inicial não comprova o ciclo de renovação do Caddy.
- [x] Backups externos criptografados (R2) a cada 30 min: ativos desde
      07/09/2026, 36 ciclos verificados, retenção ativa e estado `ready`
      ([M0-25-VALIDATION.md](M0-25-VALIDATION.md)).
- [ ] Alerta de atraso de backup ativo — **pendente**; preflight do monitor
      externo concluído na STK-M0-35 (deploy e ativação dependem de janela
      autorizada).
- [ ] Teste de restauração demonstrado com dados de produção e RPO 1h / RTO 4h
      medidos.
- [x] STK-M0-10: ensaio isolado de dump completo PostgreSQL e roles sem hashes
      de senha, criptografia Restic e restauração em outro cluster, conferindo
      dados, proprietários, ACLs, recusas e limpeza. Sem acesso ao banco real.
      [RECOVERY-DRILL.md](RECOVERY-DRILL.md) e [M0-10-VALIDATION.md](M0-10-VALIDATION.md).
      Não valida R2, agendamento nem os objetivos RPO/RTO de produção.
- [x] STK-M0-13: backup fictício criptografado enviado ao R2 e restaurado em
      cluster novo com a origem parada; acesso ao bucket de anexos recusado,
      dados/ACLs conferidos e chave preservada fora da VPS.
      [M0-13-VALIDATION.md](M0-13-VALIDATION.md). Não ativa backups reais.
- [ ] Monitoramento externo de disponibilidade e alertas deduplicados —
      **pendente**; Worker e testes prontos e pré-checados na STK-M0-35
      ([M0-35-MONITOR-PREFLIGHT.md](M0-35-MONITOR-PREFLIGHT.md)), aguardando
      janela autorizada para deploy, segredos e ativação.
- [x] Procedimentos documentados de deploy, migração e rollback
      ([docs/DEPLOYMENT.md](DEPLOYMENT.md) — preparados na STK-M0-12 e
      exercitados no piloto M0-24; a reversão real ainda não foi executada).

## Registro de decisões pendentes para o Codex

- Inspeção OCI concluída pelo Codex e retransmitida na R2; pendência de
  recuperação IAM/serial/Ubuntu, não de repetir o painel. Inventário histórico
  STK-M0-02 é complementado por NETWORK-SECURITY §3.
- Primeira janela proposta somente IPv6 ativo; persistência e publicação de
  aplicação fora do escopo, sujeitas a tarefas/autorização separadas.
- Ordem das integrações (R2 → OAuth → Telegram → Gemini direto) após o domínio.
- Desenvolvimento começou com Docker local na STK-M0-07; instalação do
  PostgreSQL na VPS será tratada junto à preparação de produção.
