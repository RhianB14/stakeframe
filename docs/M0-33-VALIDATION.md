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

**Não** é fail-closed e não é declarado como tal. O estado final depende do
ponto exato da falha:

| Ponto de falha                                      | Estado final declarado                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antes do commit do firewall                         | estado preexistente **preservado** (persistência `rules.v6` anterior); journal `failed`                                                            |
| Pós-commit com delta próprio **exato e comprovado** | rollback automático **apenas** do delta próprio; políticas anteriores restauradas; journal `failed_rolled_back` ou `interrupted_rolled_back`       |
| Deriva do delta ou readback **indisponível**        | estado final **não declarado** como restaurado; nada sobrescrito; journal `rollback_required` com `state=unknown`; intervenção necessária          |
| Crash após o commit com **journal válido**          | rollback conservador na execução seguinte (`interrupted_rolled_back`); execução termina em falha visível; nunca adota o delta nem sintetiza recibo |
| Crash após o commit **sem prova válida**            | recusa sem mutação; estado **não declarado** como limpo                                                                                            |

Uma falha **antes** do commit preserva o estado fornecido pela persistência
preexistente (`netfilter-persistent` → `rules.v6`), tipicamente IPv6
`INPUT`/`FORWARD` permissivos, **sem estado parcial**. Uma falha **após** o
commit pode deixar o delta ativo quando a prova se perde (`rollback_required`);
nesse caso o host **não** está no estado preexistente, o estado não é declarado
restaurado e a falha é visível no journal
(`SyslogIdentifier=stk6-ipv6-boot`). `Restart=no` evita repetição cega.

Como a persistência via unit **não modifica `rules.v4`/`rules.v6`**, um boot
que falhe **antes do commit** deixa o IPv6 como o host já subia antes da
STK-M0-33 — o delta deixa de existir, não vira estado parcial.

## 6. Interface do controlador

`scripts/network_security/ipv6_persistence.py` (Python 3.11+, biblioteca
padrão, adaptador Linux injetável).

| Modo                                     | Comportamento                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `plan`                                   | somente leitura; contrato offline em JSON sanitizado; não cria diretório, não escreve, não acessa a rede |
| `apply-on-boot --execute-reviewed-linux` | aplicação real usada pela unit; transação atômica única                                                  |
| `status`                                 | somente leitura; recibo durável e/ou journal de recuperação                                              |
| `rollback --execute-reviewed-linux`      | remove exclusivamente o delta adquirido e restaura as políticas anteriores comprovadas                   |

Contratos implementados: lock global exclusivo; caminhos e executáveis
absolutos; validação de Linux/root/backend (`Ubuntu 24.04 ARM64`,
`ip6tables 1.8.10 (nf_tables)`); diretórios `root:root 0700`; arquivos e recibos
`root:root 0600`; escrita atômica com `fsync`; identidade de boot registrada;
hash do controlador e da política; aquisição explícita; backup mínimo das
políticas anteriores; recibo terminal durável com sidecar de integridade; saída
sem host, endereço ou ruleset integral.

## 7. Máquina de estados e invariantes

| Situação                                                                                                            | Resultado                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Estado limpo esperado                                                                                               | aplica atomicamente                                                                                                            |
| Já exatamente aplicado, com recibo `applied`/`applied` do próprio boot                                              | no-op                                                                                                                          |
| Chain `STK6_*` desconhecida                                                                                         | recusa (nunca adota)                                                                                                           |
| Chain própria parcial ou com conteúdo divergente                                                                    | recusa                                                                                                                         |
| Salto ausente, duplicado ou em posição inválida                                                                     | recusa                                                                                                                         |
| Referência adicional por `-j`/`-g`, outro comentário, `FORWARD` ou chain estrangeira                                | recusa antes de mutar                                                                                                          |
| Política divergente/inesperada                                                                                      | recusa                                                                                                                         |
| Deriva de política **durante o rollback**                                                                           | recusa antes de qualquer transação                                                                                             |
| Recibo de outro boot, hash divergente (controlador ou política), `phase`/`state` contraditórios, ou `state` ausente | recusa                                                                                                                         |
| Recibo ausente, truncado, sem sidecar, com sidecar divergente ou JSON não-objeto                                    | nunca é sucesso; com journal `applying`/`acquired` válido ⇒ rollback conservador; sem journal ⇒ recusa sem mutação             |
| Journal ausente, adulterado, de outro boot ou com hash divergente, com o delta presente                             | recusa sem mutação                                                                                                             |
| Escrita do journal ou do recibo **entre o commit e o recibo**                                                       | dentro do caminho de recuperação; recibo é o último marcador                                                                   |
| Lock ocupado ou diretório de estado inseguro                                                                        | recusa                                                                                                                         |
| Backend/ferramenta incompatível                                                                                     | recusa                                                                                                                         |
| Delta já presente em `rules.v4`/`rules.v6`                                                                          | recusa                                                                                                                         |
| Falha antes do commit                                                                                               | nenhuma alteração                                                                                                              |
| Falha após aquisição comprovada                                                                                     | rollback apenas do delta próprio                                                                                               |
| Snapshot pós-commit persistente indisponível                                                                        | `rollback_required` (sem rollback cego), estado `unknown`                                                                      |
| Rollback repetido após sucesso                                                                                      | no-op comprovado                                                                                                               |
| `rolling_back` pendente do mesmo boot (não reconciliado)                                                            | `apply_on_boot` recusa (`run rollback`) — nunca no-op/applied; `rollback()` reconcilia                                         |
| Retry de rollback com delta ainda exato ativo                                                                       | executa o rollback                                                                                                             |
| Retry de rollback com delta ausente e políticas anteriores comprovadas                                              | finaliza como `rolled_back`, **sem nova mutação**                                                                              |
| Retry de rollback com deriva ou estado não comprovável                                                              | `rollback_required`, sem sobrescrever                                                                                          |
| Acknowledgement perdido / readback indisponível / morte após o commit do rollback                                   | nunca deixam `status()` declarar `applied`; `rolling_back`/`rollback_required` com `state=unknown`                             |
| Morte entre o commit do rollback e os registros terminais (inclusive com o recibo removido)                         | retry reconcilia via journal `rolling_back` validado, finaliza `rolled_back` **sem nova transação** de firewall                |
| Journal terminal `rolled_back` gravado e recibo ausente/parcial                                                     | recibo terminal completado sem mutação (`no-op`); nunca declara `applied`                                                      |
| Journal terminal `rolled_back` correspondente + recibo `applied` **stale** (delta recriado)                         | journal prevalece: recusa sem mutação e sem sobrescrever; `apply_on_boot` nunca declara no-op/applied com base no recibo stale |
| Par terminal interrompido (`journal.json`/`terminal.json` com JSON íntegro e sidecar stale)                         | o JSON íntegro é prova **somente-leitura** de reconciliação; nenhuma mutação se baseia nele; retry completa os registros       |
| Regras estrangeiras                                                                                                 | nunca removidas nem reordenadas                                                                                                |

**Inventário de referências.** Todas as referências jump/goto à chain própria,
em todas as chains da tabela `filter`, são inventariadas
(`references_to_owned_chain`). O único estado aplicado aceitável é: exatamente
uma referência total, origem `INPUT`, índice 0 e especificação integral igual ao
salto revisado. O mesmo predicado é usado na classificação, no no-op e antes do
rollback.

**Rollback conservador.** Antes de qualquer transação de remoção, o rollback
exige, com identidade completa do recibo (schema, versão, `boot_id`, hashes do
controlador e da política, chain, tag, `phase`/`state`, `before_policies`):
conteúdo exato da chain própria, referência própria exata e políticas
`INPUT=DROP`/`FORWARD=DROP`. Qualquer deriva é recusada sem mutação.

**Protocolo durável do rollback (`rolling_back`).** Depois de validar
integralmente o recibo e **antes de qualquer snapshot ou transação** que possa
participar da mutação, o rollback grava um journal durável `rolling_back` com
`state=unknown` e identidade completa; se essa gravação falhar, o firewall não é
tocado. A transação, o acknowledgement e o readback do rollback ficam todos
dentro do caminho de recuperação: acknowledgement perdido, readback indisponível
ou morte do processo após o commit **nunca** deixam `status()` declarar
`applied`. Após resultado incerto, o journal permanece `rolling_back` (delta
ainda exatamente ativo — um retry executa o rollback) ou vira
`rollback_required` (`state=unknown`, nada sobrescrito). Uma repetição de
`rollback()` reconcilia: delta ativo exato ⇒ executa; delta ausente com
políticas anteriores comprovadas ⇒ finaliza como `rolled_back` **sem nova
mutação**; deriva ⇒ `rollback_required`.

## 8. Registros duráveis e recuperação após o commit

- Um journal durável é gravado **antes** da transação, identificando a
  tentativa: `schema`, `policy_version`, `boot_id`, hashes do controlador e da
  política, `chain`, `tag`, políticas anteriores e fase.
- O journal **nunca é reescrito entre o commit e o evento terminal** (não há
  fase `acquired` reescrita): o par `journal.json`/`.sha256` permanece o
  registrado antes da transação, eliminando a janela de destruição de prova por
  crash durante uma regravação.
- Todas as etapas posteriores ao commit — readback, recibo, sidecar, `fsync` e
  `os.replace` — estão dentro do caminho de recuperação.
- O **recibo terminal é o marcador final de sucesso**: nenhuma operação falível
  necessária roda depois dele.
- Um recibo ilegível (truncado, sem sidecar, sidecar divergente, JSON
  não-objeto) nunca é aceito como sucesso e nunca bloqueia a recuperação por
  journal: com delta exato e journal `applying`/`acquired` válido, o journal
  autoriza apenas o rollback conservador; sem journal, recusa sem mutação.
- Um recibo legível deve ser **coerente**: `phase="applied"` somente com
  `state="applied"` e `phase="rolled_back"` somente com `state="clean"`;
  `state` é obrigatório e qualquer combinação contraditória é recusada antes de
  mutação.
- Falha ao gravar metadados de recuperação nunca oculta o resultado do firewall
  nem produz alegação falsa de sucesso (o journal é atualizado em regime
  _best-effort_ e a falha primária permanece visível).
- Após um rollback comprovado, o rollback tenta **descartar duravelmente** o
  recibo antigo (com verificação e `fsync` do diretório quando aplicável) antes
  de gravar o recibo terminal. **Quando essa remoção funciona, o recibo antigo é
  eliminado**; **se a invalidação falhar** (por exemplo, falha de armazenamento),
  o journal terminal ou de recuperação **prevalece** e impede que `status()`
  declare `applied`. Nada é declarado fisicamente removido em todos os casos:
  uma falha de armazenamento pode impedir a remoção, e é exatamente por isso que
  a precedência do journal é a garantia, não a ausência física do arquivo.
- **A transição terminal é à prova de crash.** O journal terminal
  (`rolled_back`/`clean`) é persistido e confirmado **antes** de o recibo stale
  ser tocado, e só depois o recibo terminal é gravado. Uma morte do processo
  entre o commit do rollback e os registros terminais — inclusive depois da
  remoção do recibo, ou com remoção parcial do par `receipt.json`/`.sha256` —
  nunca perde a prova: o retry usa o journal `rolling_back` integralmente
  validado e correspondente (mesmo boot/controlador/política) quando o recibo
  está ausente ou ilegível, finaliza como `rolled_back` **sem nova transação de
  firewall** e, com journal terminal já persistido, apenas completa o recibo
  (`no-op` sem mutação).
- **O journal terminal prevalece sobre recibo `applied` stale.** Tanto
  `rollback()` quanto `apply_on_boot()` leem e validam o journal antes de usar
  qualquer recibo: um `rolled_back`/`clean` correspondente impede que um recibo
  `applied` remanescente autorize nova mutação ou um no-op/applied. Em
  `rollback()`: delta ausente e políticas anteriores comprovadas ⇒ registros
  terminais completados sem transação; delta presente, referências presentes ou
  políticas divergentes ⇒ recusa sem sobrescrever o journal e sem mutação
  (snapshot integral idêntico). Em `apply_on_boot()`: estado aparentemente
  aplicado com journal terminal correspondente ⇒ recusa (`refuse adoption`),
  nunca no-op/applied.
- **O registro terminal tem slot próprio (`terminal.json` + sidecar).** A
  finalização nunca sobrescreve a última prova válida: o documento terminal é
  gravado por inteiro (JSON + sidecar + `fsync`) no slot enquanto o journal
  `rolling_back` permanece intocado; só depois o recibo stale é tocado e a
  remoção do journal superado é limpeza não crítica. Uma interrupção no meio do
  duplo replace do slot deixa, no pior caso, o slot incompleto — o journal
  permanece íntegro e suficiente para reconciliar. **Par interrompido:** quando
  o JSON de um registro de recuperação está íntegro mas o sidecar está
  stale/ausente (duplo replace interrompido, inclusive no layout legado do
  `journal.json`), o documento é aceito como prova **somente-leitura** para
  reconciliar (completar registros/recusar); **nenhuma mutação de firewall** é
  autorizada com base nele, e a precedência é resolvida entre as provas válidas
  (`terminal.json` ⇒ `journal.json` ⇒ recibo).
- `status()` prioriza o journal de recuperação (`rolling_back`, `failed`,
  `failed_rolled_back`, `rollback_required`, `interrupted_rolled_back`,
  `rolled_back_unrecorded`, `rolled_back`) sobre qualquer recibo antigo: o
  sistema **nunca** declara `applied` depois de ter iniciado ou comprovado um
  rollback.
- `rolling_back` e `rollback_required` significam **estado não comprovado**
  (`state=unknown`); `status()` nunca os converte em `clean`. O estado só é
  declarado `clean` depois de rollback comprovado ou ausência do delta
  comprovada (com as políticas anteriores restauradas).
- O snapshot pós-commit é adquirido dentro do próprio caminho de recuperação:
  se o estado ativo não puder ser provado, não há rollback cego — registra-se
  `rollback_required` (`state=unknown`) e a falha permanece visível.

## 9. Testes e evidências

- `scripts/network_security/test_ipv6_persistence.py`: **127 testes**, com
  backend falso determinístico que reproduz a semântica atômica validada.
- Suíte completa de `network_security`: **257 testes**, `OK` (0 skips em Linux;
  6 skips no Windows, por semântica POSIX de symlink/permissão, `fsync` de
  diretório e ausência do `systemd-analyze`).
- **Janelas de crash da escrita do recibo** (cada uma com teste dedicado):
  depois do replace de `receipt.json` e antes do sidecar; depois do replace do
  sidecar (no-op durável); sidecar ausente; sidecar antigo/divergente; recibo
  JSON não-objeto — todas com journal válido ⇒ rollback conservador
  (`interrupted_rolled_back`), e sem journal ⇒ recusa sem mutação com snapshot
  integral comparado antes/depois.
- **Coerência de recibo**: `state` ausente e combinações
  `phase`/`state` contraditórias recusadas; combinação válida aceita.
- **Rollback com `policy_sha256` divergente**: recusa antes de mutação, com
  sidecar recalculado e snapshot integral idêntico após a recusa.
- **Snapshot pós-commit**: falha persistente ⇒ `rollback_required` com
  `state=unknown`, sem rollback cego e sem overwrite; falha transitória ⇒
  rollback normal (`failed_rolled_back`).
- **Falhas terminais do rollback** (JSON, sidecar, `fsync` de arquivo,
  `fsync` de diretório, `replace`, remoção do recibo): o firewall já está
  rollbacked, `status()` nunca declara `applied` (prioriza o journal
  `rolled_back_unrecorded`/`rolled_back` com `state=clean`), e a execução
  seguinte consolida o estado.
- **Protocolo `rolling_back`** (cada cenário com teste dedicado): falha ao
  gravar o intent ⇒ firewall intacto; falha da transação antes do commit ⇒
  `rolling_back` preservado e retry executa; acknowledgement perdido ⇒
  finalização comprovada como `rolled_back`; readback indisponível após o commit
  ⇒ `rollback_required`/`unknown`; morte após o commit ⇒ `apply_on_boot` recusa
  e o retry reconcilia; retry com delta ausente ⇒ finaliza **sem nova mutação**
  (contagem de transações inalterada); retry com deriva ⇒ `rollback_required`
  sem sobrescrever; `status()` imediatamente após cada cenário.
- **Janela terminal do rollback** (à prova de crash): morte entre o commit e os
  registros terminais, inclusive com o recibo removido — o retry, **em nova
  instância do controlador**, finaliza `rolled_back` sem nova transação de
  firewall (contagem de transações inalterada) e grava o recibo terminal;
  remoção parcial do par `receipt.json`/`.sha256` (sidecar sem JSON e JSON sem
  sidecar) reconciliada pelo journal `rolling_back`; journal terminal
  `rolled_back` com recibo ausente ⇒ recibo completado com `no-op` sem mutação;
  journal terminal com delta presente ⇒ recusa sem mutação.
- **Precedência do journal terminal sobre recibo stale** (novos testes): com
  journal terminal correspondente e recibo `applied` remanescente, o delta
  recriado externamente nunca é removido pelo recibo stale — `rollback()` e
  `apply_on_boot()` recusam, o journal não é sobrescrito, o snapshot e a
  contagem de transações permanecem inalterados; políticas divergentes e
  referência remanescente também são recusadas sem mutação.
- **Slot terminal e duplo replace interrompido** (novos testes): nova instância
  após commit do rollback + `journal rolling_back` válido + `journal.json`
  substituído pelo conteúdo terminal + morte antes do sidecar ⇒ reconcilia para
  `rolled_back` sem nova transação, recibo terminal completado, `status()`
  nunca `applied`, delta recriado recusado sem mutação; o mesmo cenário no slot
  `terminal.json` (JSON íntegro, sidecar ausente) ⇒ reconciliado; injeções de
  falha de escrita, `fsync`, `replace` e sidecar do registro terminal ⇒ a prova
  anterior (`rolling_back`) permanece íntegra e o retry converge (ou o JSON
  íntegro do slot é usado como prova somente-leitura), sempre sem nova
  transação.
- **Registros malformados**: JSON sintaticamente inválido e bytes UTF-8
  inválidos, com sidecar válido e journal correspondente ⇒ rollback
  conservador; os mesmos casos sem journal ⇒ recusa sem mutação; `OSError` na
  leitura do recibo com journal legível ⇒ rollback conservador; nenhuma exceção
  bruta de parser escapa da camada de armazenamento.
- **Matriz explícita de `phase`/`state` do journal**: combinações aceitas e
  recusadas testadas uma a uma; `status()` nunca converte `rolling_back` ou
  `rollback_required` em `clean`; o journal é validado por completo antes de sua
  fase ser consultada no caminho de estado limpo com recibo inválido.
- **Container descartável (Ubuntu 24.04, `ip6tables v1.8.10 (nf_tables)`)**: E2E
  real com `apply-on-boot` → `no-op` → `rollback` → `no-op` (com
  `DOCKER-FORWARD`/`f2b-sshd`, regra estrangeira em `INPUT` e regra em `OUTPUT`
  preservadas); **E2E de crash durante a escrita do recibo** (delta removido,
  políticas restauradas, journal `interrupted_rolled_back`, recibo ausente,
  reaplicação segura); **E2E de snapshot indisponível após o commit do apply**
  (`rollback_required`, delta não sobrescrito, `state=unknown`); **E2E de
  acknowledgement perdido no rollback** (a transação real confirma e a exceção é
  levantada em seguida: finaliza `rolled_back/clean` via readback comprovado);
  **E2E de readback indisponível após o commit do rollback** (`rollback_required`
  /`unknown`, delta removido); **E2E de retry de `rolling_back`** (delta
  removido ⇒ finaliza; delta ativo ⇒ executa; `apply_on_boot` recusa o pendente);
  **E2E da janela terminal** (morte após o commit e a remoção do recibo, antes do
  journal terminal: nova instância do controlador finaliza `rolled_back` sem
  nenhuma nova transação de firewall — contagem zero; remoção parcial com apenas
  o sidecar reconciliada pelo journal); **E2E do recibo stale** (journal terminal
  - recibo `applied` remanescente + delta exato recriado externamente: nova
    instância recusa `rollback()` e `apply_on_boot()`, journal preservado,
    snapshot e contagem de transações inalterados); **E2E do duplo replace
    interrompido do slot terminal** (JSON íntegro do `terminal.json` sem sidecar:
    nova instância reporta `rolled_back/clean` e reconcilia com `no-op`, contagem
    de transações zero, recibo terminal completado); arquivos de persistência
    byte-idênticos antes/depois.
- **Unit**: `systemd-analyze verify` rc 0; ausência de `ConditionPathExists`;
  controlador ausente ⇒ `ExecStart` falha com código não-zero.
- `plan` não cria diretório nem arquivos; a saída pública não contém endereços,
  regras nem identificadores de host.

## 10. Instalação futura (não executada nesta tarefa)

Procedimento previsto, **dependente de autorização posterior do Codex**:

1. instalar `ipv6_persistence.py` e a unit por staging + conferência de hashes
   (`67051815e9a5967c69d3406c04e1050bd9f2e13b5bda0d169fa9322961e60a49` para o
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
- A falha da unit antes do commit preserva o estado fornecido pela persistência
  preexistente (IPv6 `INPUT`/`FORWARD` permissivos), sem estado parcial; uma
  falha após o commit com deriva ou perda de prova deixa o estado **não
  declarado** como restaurado (`rollback_required`), exigindo intervenção.
