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

| Elemento                    | Valor                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Chain                       | `STK6_BOOT` (estável, exclusiva de `INPUT`, marcada por comentário `stk6:boot:v1`) |
| Referência em `INPUT`       | exatamente uma, na posição 1                                                       |
| Loopback                    | permitido (`-i lo`)                                                                |
| Conntrack                   | `ESTABLISHED,RELATED` permitido                                                    |
| ICMPv6                      | permitido (`-p ipv6-icmp`)                                                         |
| TCP/22                      | permitido apenas `NEW`                                                             |
| Final da chain              | `DROP`                                                                             |
| Política `INPUT`            | `DROP`                                                                             |
| Política `FORWARD`          | `DROP`                                                                             |
| Política `OUTPUT`           | preservada                                                                         |
| IPv4, NAT, Docker, Fail2Ban | preservados por construção                                                         |

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

## 5. Comportamento de falha no boot

**Não** é fail-closed e não é declarado como tal.

- Se a unit falhar **antes** do commit, a transação atômica não altera nada: o
  host permanece exatamente no estado fornecido pela persistência preexistente
  (`netfilter-persistent` → `rules.v6`), tipicamente `INPUT ACCEPT` /
  `FORWARD ACCEPT`. O boot continua; a unit fica em `failed`, visível no
  `systemctl status` e no journal (`SyslogIdentifier=stk6-ipv6-boot`).
- Se a unit falhar **depois** de uma aquisição comprovada, o controlador remove
  exclusivamente o delta próprio e restaura as políticas anteriores registradas.
  Regras estrangeiras nunca são removidas nem reordenadas.
- `Restart=no` evita repetição cega; uma falha permanece falha até intervenção.
- Como a persistência via unit **não modifica `rules.v4`/`rules.v6`**, um boot
  que falhe deixa IPv6 `INPUT`/`FORWARD` permissivos tal como o host já subia
  antes da STK-M0-33 — o delta deixa de existir, não vira estado parcial.

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

## 7. Máquina de estados

| Situação                                         | Resultado                        |
| ------------------------------------------------ | -------------------------------- |
| Estado limpo esperado                            | aplica atomicamente              |
| Já exatamente aplicado pelo próprio controlador  | no-op                            |
| Chain `STK6_*` desconhecida                      | recusa (nunca adota)             |
| Chain própria parcial ou com conteúdo divergente | recusa                           |
| Salto ausente, duplicado ou em posição inválida  | recusa                           |
| Política divergente/inesperada                   | recusa                           |
| Recibo de outro boot ou hash divergente/truncado | recusa                           |
| Lock ocupado ou diretório de estado inseguro     | recusa                           |
| Backend/ferramenta incompatível                  | recusa                           |
| Delta já presente em `rules.v4`/`rules.v6`       | recusa                           |
| Falha antes do commit                            | nenhuma alteração                |
| Falha após aquisição comprovada                  | rollback apenas do delta próprio |
| Rollback repetido após sucesso                   | no-op comprovado                 |
| Regras estrangeiras                              | nunca removidas nem reordenadas  |

## 8. Testes e evidências

- `scripts/network_security/test_ipv6_persistence.py`: **37 testes novos**, com
  backend falso determinístico que reproduz a semântica atômica validada.
  Cobrem os 23 itens da §7 do prompt, incluindo `plan` sem escrita, aplicação
  limpa, idempotência, rollback normal e repetido, lock/concorrência, chain
  externa com mesmo prefixo, chain parcial, salto duplicado/deslocado, política
  inesperada, preservação de Docker/Fail2Ban, IPv4 e `OUTPUT`, falha atômica sem
  estado parcial, recibo truncado/adulterado, hash do controlador divergente,
  `boot_id` divergente, permissões e symlinks recusados, executável/backend
  incompatível, saída sem ruleset/IP/identificador sensível e reinício simulado
  com estado persistente anterior.
- Suíte completa de `network_security`: **167 testes**, `OK` (0 skips em Linux;
  5 skips no Windows, por semântica POSIX de symlink/permissão e ausência do
  `systemd-analyze`).
- **Container descartável (Ubuntu 24.04, `ip6tables v1.8.10 (nf_tables)`)**:
  controlador real executando `apply-on-boot` → `no-op` → `rollback` → `no-op`
  contra o backend real, com chains `DOCKER-FORWARD`/`f2b-sshd`, regra
  estrangeira em `INPUT` e regra em `OUTPUT` preservadas; políticas restauradas;
  arquivos de persistência byte-idênticos antes/depois.
- **Atomicidade**: transação inválida não deixa estado parcial (nenhuma chain,
  política intacta); `-N` duplicado falha limpo.
- **Privilégio e ordenação**: `CAP_NET_ADMIN` suficiente; `systemd-analyze
verify` rc 0 na unit real.
- `plan` não cria diretório nem arquivos; a saída pública não contém endereços,
  regras nem identificadores de host.

## 9. Instalação futura (não executada nesta tarefa)

Procedimento previsto, **dependente de autorização posterior do Codex**:

1. instalar `ipv6_persistence.py` e a unit por staging + conferência de hashes
   (`121124f94414340ef9f74ff4bb3c16790c10b20c054e33337753929672c7b465` para o
   controlador; `0ae86a23bc6e6269b392efdcc4e25b5bc29cdeb0cf395849548a37afdbf8f258`
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

## 10. Limitações explícitas

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
