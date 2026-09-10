# STK-M0-33 — Persistência segura do hardening IPv6 (aplicador de boot)

> **STATUS: IMPLEMENTAÇÃO PRONTA E NÃO INSTALADA.** Nenhuma operação foi
> executada na VPS, nenhuma unit foi instalada ou habilitada, nenhum firewall
> real foi alterado e nenhum reboot foi feito. Os únicos testes executados
> rodaram localmente e em containers descartáveis.

Issue: [#91](https://github.com/RhianB14/stakeframe/issues/91) · PR:
[#92](https://github.com/RhianB14/stakeframe/pull/92) · Branch:
`hermes/m0-33-ipv6-persistence` · Base: `2604fbef637ec4c45a383d5c6c2d9fef4e1b59ec`.

## 1. Objetivo

Reaplicar no boot, de forma versionada, idempotente e reversível, o delta IPv6
confirmado pela STK-M0-23 — sem capturar ou sobrescrever regras dinâmicas de
Docker/Fail2Ban e sem depender de `netfilter-persistent save`.

## 2. Decisão arquitetural

Aplicador de boot **próprio**, com unit systemd versionada. O delta é aplicado
como **uma única transação atômica** do backend `ip6tables-nft`, gerada em
memória e entregue por `stdin` a `ip6tables-restore --noflush`.

Não são usados, em nenhum ponto: `netfilter-persistent save`/`reload`, captura
integral de `ip6tables-save`, restauração integral do ruleset, `nft flush
ruleset`, sequências de comandos independentes que pudessem deixar metade do
delta aplicada, ou adoção de chain externa pelo nome.

Preservação garantida **por construção**: a transação nomeia apenas a chain
própria, o salto de `INPUT` e as políticas de `INPUT`/`FORWARD`. IPv4, IPv6
`OUTPUT`, NAT e as chains/regras de Docker, Fail2Ban e terceiros não são
citados na transação e não passam por flush.

## 3. Delta autorizado

| Elemento                     | Valor                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| Chain                        | `STK6_BOOT` (estável, exclusiva de `INPUT`, comentário `stk6:boot:v1`)   |
| Referência em `INPUT`        | exatamente uma, na posição 1                                             |
| Referências em outras chains | nenhuma (jump/goto, qualquer comentário, qualquer chain — inventariadas) |
| Loopback                     | permitido (`-i lo`)                                                      |
| Conntrack                    | `ESTABLISHED,RELATED` permitido                                          |
| ICMPv6                       | permitido (`-p ipv6-icmp`)                                               |
| TCP/22                       | permitido apenas `NEW`                                                   |
| Final da chain               | `DROP`                                                                   |
| Política `INPUT`             | `DROP`                                                                   |
| Política `FORWARD`           | `DROP`                                                                   |
| Política `OUTPUT`            | preservada                                                               |
| IPv4, NAT, Docker, Fail2Ban  | preservados por construção                                               |

A política declarativa em `policy_document()` espelha exatamente a matriz de
[NETWORK-SECURITY.md](NETWORK-SECURITY.md) e [M0-31-VALIDATION.md](M0-31-VALIDATION.md);
`policy_sha256` = `acbb3d3413614fda674577a6d4b8c3c269037a4f943f2eb62b5a02542e37bfd4`.

## 4. Contrato de ordenação systemd

```ini
After=netfilter-persistent.service
Before=docker.service network-online.target
```

- depois de `netfilter-persistent.service`: a persistência preexistente é
  carregada primeiro;
- antes de `docker.service`: as chains/saltos do Docker são criados depois do
  delta próprio;
- antes de `network-online.target`: **sem ciclo** no alvo revisado.

**Evidência.** `systemd-analyze verify` aprovado (rc 0) sobre a unit real, com
`netfilter-persistent.service` e `docker.service` presentes, em container
descartável Ubuntu 24.04. A checagem também roda na suíte
(`test_systemd_analyze_verify_accepts_the_unit`) e um teste estático garante que
`After` e `Before` não se sobrepõem.

A unit usa execução pelo caminho absoluto instalado, `Type=oneshot`,
`RemainAfterExit=yes` (coerente com `status`/`rollback`: o estado durável vem do
recibo, não de um processo vivo), `Restart=no`, `TimeoutStartSec=90`,
`CapabilityBoundingSet=CAP_NET_ADMIN` (validado em container: `NET_RAW` é
desnecessário), `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
`PrivateTmp`, `PrivateDevices`, `ProtectKernelTunables/Modules`,
`ProtectControlGroups`, `RestrictAddressFamilies`, `RestrictNamespaces`,
`LockPersonality` e `RuntimeDirectory`/`StateDirectory` privados em `0700`.
Nenhuma credencial ou variável privada aparece na unit.

A unit **não** usa `ConditionPathExists`. Um controlador ausente no caminho
instalado faz o `ExecStart` falhar com código não-zero (validado em container:
`exit 2`), deixando a unit `failed` e visível no journal — em vez de ser
silenciosamente ignorada.

## 5. Comportamento de falha no boot

**Não** é fail-closed e não é declarado como tal. Quatro situações distintas:

| Situação                                                      | Comportamento                                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Falha **antes** do commit do firewall                         | transação atômica não altera nada; o host permanece no estado da persistência preexistente; journal registra `failed`; falha visível                                                                        |
| Falha **pós-aquisição** com o estado próprio ainda comprovado | rollback automático **apenas** do delta próprio e restauração das políticas anteriores comprovadas; recibo `applied` é descartado; falha visível                                                            |
| **Deriva externa** ou perda de prova                          | nada é sobrescrito: journal registra `rollback_required` e a execução falha de forma visível                                                                                                                |
| **Crash** entre o commit e o recibo                           | nova execução no mesmo boot usa o journal (`applying`/`acquired`) correspondente para fazer rollback conservador e registrar `interrupted_rolled_back`; nunca adota o delta nem sintetiza recibo de sucesso |

Se a unit falhar, o boot continua; o host fica no estado fornecido pela
persistência preexistente (`netfilter-persistent` → `rules.v6`), tipicamente
IPv6 `INPUT`/`FORWARD` permissivos, **sem estado parcial**, com a falha visível
no `systemctl status` e no journal (`SyslogIdentifier=stk6-ipv6-boot`).
`Restart=no` evita repetição cega.

Como a persistência via unit **não modifica `rules.v4`/`rules.v6`**, um boot que
falhe deixa o IPv6 como o host já subia antes da STK-M0-33 — o delta deixa de
existir, não vira estado parcial.

## 6. Interface do controlador

`scripts/network_security/ipv6_persistence.py` (Python 3.11+, biblioteca
padrão, adaptador Linux injetável).

| Modo                                     | Comportamento                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `plan`                                   | somente leitura; contrato offline em JSON sanitizado; não cria diretório, não escreve, não acessa a rede |
| `apply-on-boot --execute-reviewed-linux` | aplicação real usada pela unit; transação atômica única                                                  |
| `status`                                 | somente leitura; recibo durável                                                                          |
| `rollback --execute-reviewed-linux`      | remove exclusivamente o delta adquirido e restaura as políticas anteriores comprovadas                   |

Contratos implementados: lock global exclusivo; caminhos e executáveis
absolutos; validação de Linux/root/backend (`Ubuntu 24.04 ARM64`,
`ip6tables 1.8.10 (nf_tables)`); diretórios `root:root 0700`; arquivos e recibos
`root:root 0600`; escrita atômica com `fsync`; identidade de boot registrada;
hash do controlador e da política; aquisição explícita; backup mínimo das
políticas anteriores; recibo terminal durável com sidecar de integridade; saída
sem host, endereço ou ruleset integral.

## 7. Máquina de estados e invariantes

| Situação                                                                                       | Resultado                          |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Estado limpo esperado                                                                          | aplica atomicamente                |
| Já exatamente aplicado, com recibo `applied` do próprio boot                                   | no-op                              |
| Chain `STK6_*` desconhecida                                                                    | recusa (nunca adota)               |
| Chain própria parcial ou com conteúdo divergente                                               | recusa                             |
| Salto ausente, duplicado ou em posição inválida                                                | recusa                             |
| Referência adicional por `-j`/`-g`, com outro comentário, em `FORWARD` ou em chain estrangeira | recusa antes de mutar              |
| Política divergente/inesperada                                                                 | recusa                             |
| Deriva de política **durante o rollback**                                                      | recusa antes de qualquer transação |
| Recibo de outro boot, hash divergente ou adulterado                                            | recusa                             |
| Journal ausente, adulterado, de outro boot ou com hash divergente, com o delta presente        | recusa sem mutação                 |
| Lock ocupado ou diretório de estado inseguro                                                   | recusa                             |
| Backend/ferramenta incompatível                                                                | recusa                             |
| Delta já presente em `rules.v4`/`rules.v6`                                                     | recusa                             |
| Falha antes do commit                                                                          | nenhuma alteração                  |
| Falha após aquisição comprovada                                                                | rollback apenas do delta próprio   |
| Rollback repetido após sucesso                                                                 | no-op comprovado                   |
| Regras estrangeiras                                                                            | nunca removidas nem reordenadas    |

**Inventário de referências.** Todas as referências jump/goto à chain própria,
em todas as chains da tabela `filter`, são inventariadas
(`references_to_owned_chain`). O único estado aplicado aceitável é: exatamente
uma referência total, origem `INPUT`, índice 0 e especificação integral igual ao
salto revisado. O mesmo predicado é usado na classificação, no no-op e antes do
rollback.

**Rollback conservador.** Antes de qualquer transação de remoção, o rollback
exige: conteúdo exato da chain própria, referência própria exata e políticas
`INPUT=DROP`/`FORWARD=DROP`. Qualquer deriva é recusada sem mutação.

## 8. Registros duráveis e recuperação após o commit

- Um journal durável é gravado **antes** da transação, identificando a
  tentativa: `schema`, `policy_version`, `boot_id`, hashes do controlador e da
  política, `chain`, `tag`, políticas anteriores e fase.
- Todas as etapas posteriores ao commit — readback, journal de aquisição,
  recibo, sidecar, `fsync` e `os.replace` — estão dentro do caminho de
  recuperação.
- O **recibo terminal é o marcador final de sucesso**: nenhuma operação falível
  necessária roda depois dele.
- Falha ao gravar metadados de recuperação nunca oculta o resultado do firewall
  nem produz alegação falsa de sucesso (o journal é atualizado em regime
  _best-effort_ e a falha primária permanece visível).
- Um recibo `applied` válido **não** sobrevive a um rollback executado por falha
  de persistência (o recibo e seu sidecar são descartados).
- Journal e recibo passam por **validação estrutural explícita** (objeto JSON,
  schema, versão, identidade, chain/tag, fase e políticas anteriores) antes de
  qualquer campo ser usado como prova de propriedade.

## 9. Testes e evidências

- `scripts/network_security/test_ipv6_persistence.py`: **69 testes**, com
  backend falso determinístico que reproduz a semântica atômica validada.
- Suíte completa de `network_security`: **199 testes**, `OK` (0 skips em Linux;
  5 skips no Windows, por semântica POSIX de symlink/permissão e ausência do
  `systemd-analyze`).
- **Injeções de falha comprovadamente após o commit**, cada uma separada:
  gravação de `receipt.json`; gravação do sidecar; `fsync`; `os.replace`;
  gravação do journal de aquisição. Em todas, o delta próprio é removido, as
  políticas anteriores são restauradas, nenhum recibo `applied` permanece e o
  journal termina em `failed_rolled_back`.
- **Deriva externa** após o commit (regra estrangeira adicionada à chain
  própria): recusa com `rollback_required`, sem sobrescrever nada.
- **Crash entre o commit e o recibo**, coberto por reinício com journal
  `applying` e com journal `acquired`: rollback conservador, journal em
  `interrupted_rolled_back`, sem recibo, e uma execução seguinte sobre o estado
  limpo aplica novamente com segurança.
- **Delta aplicado sem journal de recuperação correspondente**, journal de outro
  boot, journal com hash divergente, journal adulterado e journal em fase
  terminal: recusa sem mutação, com snapshot completo comparado antes/depois.
- **Registros inválidos**: JSON que não é objeto, `schema`/`policy_version`
  divergentes, identidade inválida, `boot_id` vazio, hashes malformados,
  `chain`/`tag` de outro recurso, fase inválida para o tipo de registro e
  sidecar ausente.
- **Deriva de política no rollback**: testes independentes para `INPUT` e
  `FORWARD`, cada um provando que o snapshot inteiro permanece idêntico após a
  recusa.
- **Referências estrangeiras**: comentário/tag estranho em `INPUT`, segunda
  referência em `INPUT`, referência em `FORWARD`, referência em
  `DOCKER-FORWARD`, referência por `-g` e referência residual sem a chain —
  todos recusados em apply e em rollback, sem mutação.
- **Container descartável (Ubuntu 24.04, `ip6tables v1.8.10 (nf_tables)`)**:
  controlador real executando `apply-on-boot` → `no-op` → `rollback` → `no-op`,
  depois um **E2E de recuperação após commit sem recibo** (delta removido,
  políticas restauradas, journal `interrupted_rolled_back`, recibo ausente,
  reaplicação segura e rollback final), com `DOCKER-FORWARD`/`f2b-sshd`,
  regra estrangeira em `INPUT` e regra em `OUTPUT` preservadas e arquivos de
  persistência byte-idênticos antes/depois.
- **Unit**: `systemd-analyze verify` rc 0; ausência de `ConditionPathExists`;
  controlador ausente ⇒ `ExecStart` falha com código não-zero.
- `plan` não cria diretório nem arquivos; a saída pública não contém endereços,
  regras nem identificadores de host.

## 10. Instalação futura (não executada nesta tarefa)

Procedimento previsto, **dependente de autorização posterior do Codex**:

1. instalar `ipv6_persistence.py` e a unit por staging + conferência de hashes
   (`9fc87d3ddb17fd008dd27fab803ee64efe7217523abf04c16ce2211b7f2c70f3` para o
   controlador; `bb448b8cd42b2654baee89892b28382907db0a92de6b8bafb3b89d6fbc45febd`
   para a unit);
2. manter backup privado dos artefatos substituídos;
3. validar a sintaxe/transação **sem alterar o firewall**
   (`ip6tables-restore --test`; note-se que `--test` valida a sintaxe e **não**
   detecta colisão com o ruleset vivo);
4. `daemon-reload` e `enable` apenas sob autorização futura, sem iniciar a unit
   no boot corrente;
5. reverter arquivos, enablement e estado ativo conforme o caso;
6. tratar o reboot de validação como operação separada;
7. nunca usar o run antigo da STK-M0-23 como recibo de propriedade do novo
   controlador. O controlador recusa qualquer chain `STK6_*` que não seja
   exatamente a sua.

## 11. Limitações explícitas

- **Implementação pronta não significa instalada.** Nada foi instalado,
  habilitado ou iniciado.
- **O delta atual continua não persistente**: após um reboot, a proteção IPv6
  descrita na STK-M0-23 não se reaplica sozinha até que a unit seja instalada e
  autorizada.
- **VPS, reboot e recuperação real não foram testados.** Os ensaios ocorreram em
  containers descartáveis e com backend falso; kernel, systemd real do host e
  conectividade da VPS não foram validados.
- Instalação, ativação e reboot exigem **autorização posterior**.
- A persistência via unit **não modifica `rules.v4`/`rules.v6`**; a ausência do
  delta nesses arquivos é verificada em leitura e bloqueia a aplicação.
- A falha da unit pode deixar o host no estado fornecido pela persistência
  preexistente (IPv6 `INPUT`/`FORWARD` permissivos), sem estado parcial.
