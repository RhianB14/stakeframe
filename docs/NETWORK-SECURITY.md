# STK-M0-03-R2 — Rede e preparação de hardening IPv6

Estado em 07/09/2026: o run legado foi encerrado administrativamente sob
autorização de Rhian, preservando a lacuna histórica IPv4 e o bundle original.
[Resultado M0-22](M0-22-VALIDATION.md) e [preparo da próxima janela](NEXT-NETWORK-WINDOW.md).
As seções de R1/R2 e da primeira janela abaixo são registros históricos;
não representam autorização ou recuperação disponível para nova aplicação.

> **PR #6: draft. Preparação local; nenhuma aplicação autorizada.**
> A leitura do guest foi realizada pelo Hermes na R1. A inspeção OCI foi
> realizada pelo Codex em **05/09/2026** e **retransmitida pelo proprietário**
> na R2. Não é uma inspeção do painel realizada pelo Hermes.
>
> Base: `666f915ab0c94eeef3f792f5eed88809a049297e`.
> Head anterior revisado: `cd1a9d5024c32e1e36271acf5b455eb197021057`.
>
> IP público, OCIDs, fingerprints, usuário, chave, domínio interno e capturas
> integrais ficam fora do repositório. `<VCN_CIDR>` é um placeholder privado.

## 1. Estado, escopo e proveniência

- **Guest observado pelo Hermes/R1:** coleta SSH não interativa somente leitura;
  saída bruta mantida privadamente fora do repositório.
- **OCI inspecionada pelo Codex/retransmitida:** resultados do painel abaixo.
  A leitura do painel está concluída; não é necessário repeti-la para resolver
  o antigo bloqueador de sessão do navegador do Hermes.
- **Proposta R2:** scripts locais e testes com substitutos inofensivos.
  Nenhum SSH, upload para a VPS, firewall real ou systemd real nos testes R2.
- **Pendente:** validar IAM, transporte serial e login/recuperação do Ubuntu
  ([ACCESS-RECOVERY.md](ACCESS-RECOVERY.md)) e obter revisão/autorização
  específica de aplicação.

Esta revisão substitui os blocos de aplicação/rollback da R1. Há uma única
implementação em [scripts/network_security](../scripts/network_security/),
referenciada por este runbook; não copiar os exemplos antigos da PR.
O plano mestre não foi alterado. M0 e a preparação para execução não estão
concluídos enquanto a recuperação e os gates abaixo permanecerem abertos.

## 2. Estado atual do guest — evidência da R1

Esta seção preserva a origem histórica da coleta; a R2 não fez novas consultas
à VPS nem reaplicou comandos de diagnóstico.

### Firewall, Docker e Fail2Ban

- `iptables`/`ip6tables` `1.8.10 (nf_tables)`, `nft` `1.0.9`; Docker informa
  backend `iptables`. As tabelas de compatibilidade representam o mesmo backend
  nftables, não dois firewalls independentes.
- IPv4: `INPUT ACCEPT`, `FORWARD DROP`, `OUTPUT ACCEPT`; aceita loopback,
  `ESTABLISHED,RELATED`, ICMP, TCP novo em 22/80/443, com rejeição final de
  entrada e tratamento `InstanceServices` na saída. **Nada disso será editado.**
- IPv6: `INPUT ACCEPT` sem filtro equivalente ao IPv4, `FORWARD ACCEPT` com
  saltos Docker e `OUTPUT ACCEPT`.
- NAT IPv4 com masquerade Docker; nenhuma publicação de porta de aplicação no
  snapshot. Foram consultadas também as tabelas mangle/raw/security e IPv6.
- Chains `DOCKER`, `DOCKER-BRIDGE`, `DOCKER-CT`, `DOCKER-FORWARD`,
  `DOCKER-INTERNAL` e `DOCKER-USER` presentes. Nenhum container/projeto Compose
  ativo. Não apagar chains pelo fato de estarem sem consumidores naquele instante.
- Fail2Ban ativo, jail `sshd`, tabela nft `inet f2b-table` e rejeição dinâmica
  de TCP/22. O conjunto observado usa endereços IPv4; não inferir proteção de
  todas as famílias apenas pela presença da tabela `inet`.
- UFW indisponível; nenhum pacote será instalado para substituir o backend.

### Persistência e boot

A R1 identificou `netfilter-persistent.service` habilitado/`active exited`,
plugins `15-ip4tables` e `25-ip6tables`, com destinos `/etc/iptables/rules.v4`
e `/etc/iptables/rules.v6`. Configuração selecionada registrada:

```text
FLUSH_ON_STOP=0
IPTABLES_TEST_RULESET=yes
IP6TABLES_TEST_RULESET=yes
IPTABLES_RESTORE_NOFLUSH=yes
IP6TABLES_RESTORE_NOFLUSH=yes
```

`nftables.service` inativo/desabilitado; seu arquivo contém `flush ruleset`.
Não iniciar esse serviço nem usar save/reload do `netfilter-persistent` nesta
janela. A futura preparação deve confirmar existência/conteúdo/permissões dos
arquivos de persistência com leitura fresca e backup privado antes de qualquer
mudança; o estado `active exited` isoladamente não comprova conteúdo salvo.

A STK-M0-33 (implementação pronta, **não instalada**) adiciona um aplicador de
boot próprio com transação atômica única e unit versionada, sem usar
`netfilter-persistent save`, captura integral de `ip6tables-save` ou restauração
integral do ruleset. O delta permanece **não persistente** até a instalação
autorizada; detalhes, evidências e limitações em [M0-33-VALIDATION.md](M0-33-VALIDATION.md).

### Interfaces e serviços

- `enp0s6` routable/configured, MTU 9000, DHCPv4 por `systemd-networkd`;
  rota default IPv4 via DHCP e regras de roteamento padrão.
- IPv6 no guest somente link-local, além de loopback; `docker0` sem carrier.
- `systemd-resolved` ativo em modo stub, DNS recebido na interface; NTP
  habilitado/sincronizado, timezone UTC. Egress permanece inalterado.
- SSH, Docker/containerd, Fail2Ban, agentes Oracle/monitoramento, `iscsid`,
  `systemd-networkd`, resolved e timesyncd ativos na coleta.
- Listeners TCP 22 e TCP/UDP 111 nas duas famílias; DNS local, DHCPv4;
  nenhum TCP 80/443, nenhum UDP 22.

### SSH e RPC/NFS

Configuração selecionada registrada na R1: porta 22 nas duas famílias,
`PubkeyAuthentication yes`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `UsePAM yes`, `MaxAuthTries 6`,
`PermitRootLogin without-password`, `X11Forwarding yes`. A consulta contextual
registrada na R1 usou hostname do servidor no argumento `host`; ela não comprova
a avaliação de eventuais `Match Host` relativos ao cliente. Antes da futura
janela, o preflight deve usar o contexto correto do cliente autorizado (incluindo
`user`, `addr`, `host`, `laddr`, `lport`); não adivinhar o hostname do cliente.
A R2 não fez nova consulta nem modifica SSH. Preservar o acesso por chave,
sem restringir ao IP momentâneo do operador.

`rpcbind.service` e `.socket` ativos/habilitados; consultadas dependências
**diretas e reversas**. Serviço depende do socket e tem relação com
`remote-fs-pre.target`/`rpcbind.target`; reversas por targets de boot. O socket
é requerido pelo serviço e desejado por `sockets.target`.
`rpcinfo` retornou somente portmapper; nenhuma montagem NFS nos probes;
`nfs-server.service` apareceu `not-found`, auxiliares NFS inativos e
`rpc-statd-notify` `active exited`. Isso não prova inexistência de todo consumidor
possível. **Manter serviço e socket; não desativar, reconfigurar ou reiniciar.**

Comando ausente/erro de coleta não significa ausência de serviço. As chains
antigas `DOCKER-ISOLATION-STAGE-*` não encontradas não apagam a evidência das
chains Docker efetivamente retornadas. O erro de quoting do probe de montagens
na R1 foi corrigido e a consulta foi repetida.

## 3. OCI — inspeção do Codex retransmitida pelo proprietário

**Fonte:** leitura direta do painel pelo Codex em 05/09/2026, encaminhada pelo
proprietário na tarefa R2. Não foram exportados cookies, tokens ou capturas.

### Instância, armazenamento e rede

- Shape `VM.Standard.A1.Flex`: **2 OCPUs, 12 GB RAM, 2 Gbps**.
- Imagem Ubuntu 24.04 Minimal `aarch64`; metadata service somente **V2**.
- Boot volume **50 GB**, criptografia em trânsito habilitada; nenhum block
  volume adicional listado.
- Uma VNIC principal; IPv4 público **efêmero**; subnet pública regional.
- VCN **sem prefixo IPv6**; nenhum IPv6 atribuído exibido na VNIC.
- VNIC, IP principal e subnet utilizam a mesma tabela de rotas.
- Uma rota estática `0.0.0.0/0` para Internet Gateway **Available/Enabled**.
- Nenhuma regra ou rota IPv6.

### Security List e NSG associados

Uma Security List associada à subnet, **todas as regras stateful**:

| Direção | Origem/destino | Protocolo | Porta destino / tipo e código | Porta de origem |
| ------- | -------------- | --------- | ----------------------------- | --------------- |
| Ingress | `0.0.0.0/0`    | TCP       | 22                            | Todas           |
| Ingress | `0.0.0.0/0`    | TCP       | 80                            | Todas           |
| Ingress | `0.0.0.0/0`    | TCP       | 443                           | Todas           |
| Ingress | `0.0.0.0/0`    | ICMP      | Tipo 3, código 4              | Não aplicável   |
| Ingress | `<VCN_CIDR>`   | ICMP      | Tipo 3                        | Não aplicável   |
| Egress  | `0.0.0.0/0`    | Todos     | Todas                         | Todas           |

Um NSG associado à VNIC, também **stateful**:

- Egress de todos os protocolos para `0.0.0.0/0`.
- **Nenhuma regra ingress.**

### Permissão OCI não é serviço acessível

A política efetiva combina Security List e NSG pela união das permissões;
a ausência de ingress no NSG **não nega** os ingress 22/80/443 da Security List
([referência OCI](https://docs.oracle.com/iaas/Content/Network/Concepts/securityrules.htm)).

- **TCP 22:** permitido pela OCI e pelo guest; listener presente; SSH já
  exercitado na R1. Não se afirma acesso testado de todas as origens.
- **TCP 80/443:** permitido na OCI e nas regras IPv4 do guest, mas sem listener
  na R1; **não há HTTP/HTTPS funcional demonstrado**.
- **TCP/UDP 111:** listener no guest, mas nenhuma permissão ingress OCI nas
  regras relatadas; listener não equivale a serviço público acessível.
- **5432/6379/admin OmniRoute:** sem ingress correspondente nas regras OCI
  relatadas e sem listener observado; manter publicação direta proibida.
- **IPv6:** não há IPv6 público configurado. O hardening do guest é defesa
  adicional, não correção de exposição pública IPv6 demonstrada.

**Nenhuma mudança OCI é proposta nesta primeira janela.** Não abrir portas,
remover NSG, editar Security List, trocar rotas, criar IPv6 ou alterar IP público.

## 4. Delta fechado — aplicado e confirmado na janela de 07/09/2026

> **Estado atual: aplicado e confirmado.** O delta abaixo deixou de ser
> proposta: foi executado em 07/09/2026, a confirmação encerrou sem rollback e o
> timer de recuperação está desarmado. Escopo normalizado, estado terminal e
> limitações em [M0-31-VALIDATION.md](M0-31-VALIDATION.md). A tabela preserva a
> descrição aprovada do delta.

Somente hardening **ativo** de `INPUT/FORWARD` IPv6 por `ip6tables-nft`.
A ausência atual de IPv6 público reduz urgência operacional, mas não torna
adequado deixar políticas guest implicitamente abertas para mudanças futuras.

| Objeto                            | Antes observado                  | Proposta                                                                         |
| --------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| IPv6 `INPUT`                      | `ACCEPT`                         | Chain exclusiva preparada integralmente, um salto identificado e política `DROP` |
| IPv6 `FORWARD`                    | `ACCEPT`, com saltos Docker      | Política `DROP`, preservando todas as regras/saltos existentes                   |
| IPv6 `OUTPUT`                     | `ACCEPT`                         | Sem alteração                                                                    |
| IPv4 completo, NAT, egress Oracle | Estado R1                        | Sem alteração                                                                    |
| Docker/Fail2Ban                   | Gerenciados dinamicamente        | Sem edição, flush, restauração ou restart                                        |
| SSH/rpcbind                       | Estado R1                        | Serviços/configurações preservados                                               |
| OCI e 80/443                      | Estado §3                        | Sem alteração/publicação de serviço nesta janela                                 |
| Persistência                      | `netfilter-persistent` existente | Sem escrita/save/reload; mudança somente ativa                                   |

A chain de INPUT preserva loopback, conexões `ESTABLISHED,RELATED`, ICMPv6 e
TCP/22 novo. ICMPv6 é mantido para descoberta de vizinhos, MTU e diagnóstico,
sem habilitar IPv6 público. Não há nova permissão web/RPC; a chain termina
com DROP para o tráfego não permitido, sem RETURN antecipado ou regras
inalcançáveis. FORWARD mantém os saltos Docker na mesma ordem;
nenhuma promessa sobre futuras publicações Docker substitui revisão do Compose.

**Persistência deliberadamente fora desta janela:** a alteração não é durável
após reboot. Não reiniciar para testar nesta tarefa. Uma tarefa futura de
persistência precisa revisar o conteúdo nativo, evitar captura indiscriminada de
chains dinâmicas e possuir backup/restore próprio. Não adicionar `save` manual
entre aplicação e confirmação. Se arquivo persistente mudar inesperadamente,
falhar o gate e restaurar o delta ativo; não chamar isso de sucesso nem carregar
um ruleset inteiro. Se em extensão futura a própria tarefa escrever persistência,
o rollback terá de restaurar automaticamente seu estado anterior antes de
concluir, para impedir reintrodução da mudança no boot.

## 5. Runbook e implementação única

A implementação revisável é
[`ipv6_guard.py`](../scripts/network_security/ipv6_guard.py), com a suíte
[`test_ipv6_guard.py`](../scripts/network_security/test_ipv6_guard.py) e contrato
operacional em [`scripts/network_security/README.md`](../scripts/network_security/README.md).
As sequências abaixo especificam o contrato operacional; não duplicam uma
implementação shell em Markdown. Aplicação, confirmação, rollback e unidades
usam o mesmo código versionado. Todos os comandos de aplicação exigem
autorização separada. Nenhum artefato foi transferido para o servidor na R2.

### Preparação anterior à janela (executada em 07/09/2026)

1. Codex revisa head/base, scripts, testes e este delta e emite autorização
   explícita de aplicação, retransmitida pelo proprietário, após validação da
   recuperação do §6. Combinar a janela operacional não substitui essa autorização.
2. Reconfirmar em leitura versão/backend, políticas, ruleset IPv6, persistência,
   boot e ausência de alterações concorrentes. Se houver drift, abortar.
3. Gerar identificador exclusivo; recusar colisão de diretório de execução,
   chain, unidade ou estado anterior. Respeitar o limite de nome do backend.
4. Preparar script, estado anterior, registro privado, backup de persistência
   e unidades no **servidor**, root-only, antes de qualquer DROP. Também guardar
   cópia privada **fora** do servidor com hashes. Snapshot apenas no computador
   não permite rollback autônomo depois de perder SSH.
5. Manter sessão original aberta. Janela sem reboot e sem outros operadores
   mudando firewall/persistência; Docker/Fail2Ban continuam donos de suas chains.

### Aplicação, confirmação e rollback

- O mesmo lock compartilhado serializa aplicação, confirmação e rollback.
  Estado anterior e intenções de mudança são gravados privadamente antes das
  operações; a evidência não depende da memória do processo.
- O timer usa `OnActiveSec`. Validar **NextElapseUSecMonotonic**, com a base
  monotônica do host, unidade ativa e prazo futuro; `NextElapseUSecRealtime`
  não valida esse tipo de agendamento.
- Criar e completar a chain antes de conectá-la a INPUT e antes de DROP.
  Qualquer falha interrompe aplicação e inicia recuperação delimitada.
  Depois da última alteração e gravação do estado aplicado, reler timer,
  service, jobs e recibo antes de retornar. Rollback iniciado/queued exige
  liberar o lock, aguardar o worker e retornar falha, nunca sucesso de apply.
- Depois das alterações, abrir **segunda conexão SSH independente** e executar
  probes de leitura de políticas/regras, listeners, rotas, DNS/NTP, Docker,
  Fail2Ban e serviços. Uma conexão prévia ou apenas formato válido de um arquivo
  não prova conectividade pós-mudança; a atestação precisa de evidência privada
  da execução real, vinculada à execução e posterior à mudança.
- Confirmar somente com política/delta corretos, sem alteração persistente,
  evidência pós-mudança válida e rollback não iniciado. Parar **somente timer**
  e verificar estado/jobs/registros da service sob o protocolo de lock.
- Inspecionar `ActiveState`, `SubState`, `Result`, `ExecMainStatus`, timestamp
  monotônico de início e registro de rollback. `activating`, `deactivating`,
  `failed` ou execução já encerrada não equivalem a "nunca iniciou".
- **Nunca `systemctl stop` na service de rollback.** Se começou, soltar o lock
  quando necessário para ela progredir, aguardar término, reler o estado e
  retornar aplicação **não confirmada**. Timeout/falha exige recuperação; não
  matar o processo nem declarar sucesso com base no timer parado.
  A espera revalida políticas tocadas, ausência dos recursos próprios e bundle
  sob o lock; journal de sucesso não substitui o readback ativo.
- Rollback restaura primeiro as políticas anteriores realmente modificadas
  (incluindo intent pendente de verificação); confirmar readback de todas antes
  de remover regras que preservam acesso. Tentar outras restaurações seguras
  mesmo se uma falhar; retornar erro agregado, manter recursos necessários e
  permitir repetição.
- Só retirar o salto/chain cuja propriedade pertence à execução. Colisão ou
  alteração externa não autoriza apagar recursos. Não restaurar snapshot global,
  não tocar OUTPUT, IPv4, NAT ou recursos Docker/Fail2Ban.
  Remover regras exatas tagged com `-D`, em ordem inversa, sem `-F` nem mesmo
  na chain própria. `-X` deve falhar se houver conteúdo/referência externa
  inserida concorrentemente; preservar esse recurso e reportar recuperação
  incompleta. A remoção parcial própria pode ser repetida.
- Em rollback incompleto, preservar timer **ainda pendente** até confirmar
  políticas e retirada das restrições próprias: ACCEPT na política não neutraliza
  uma chain terminal DROP que continua conectada. Timer já disparado não promete
  nova tentativa. Falha ao gravar recibo/journal não impede outras ações seguras
  de recuperação, mas impede reportar conclusão íntegra.
- Hash idêntico de uma unidade preexistente não prova aquisição pela execução.
  Recusar colisões sem parar/adotar unidades externas; registrar aquisição e
  validar o `FragmentPath` carregado antes de parar o timer próprio.

### Registro da janela confirmada (STK-M0-23, 07/09/2026)

A janela autorizada foi executada e **confirmada** no mesmo dia, na base
`afc07b5e0af65c179123946282f5ff9989fd5604`:

- run `53a5b43c1bd6049fe497`, fase terminal `confirmed`, `rollback_actions` vazio;
- `authorization_ref` = `user-confirmed-apply-STK-M0-23-2026-09-07`;
- guard e manifest do run idênticos aos hashes aprovados;
- atestações de preflight e de post com todos os checks aprovados, `source`
  operador-observado e sessão serial registrada;
- segunda conexão SSH independente aberta **após** a alteração, com probes reais;
- cronologia: prepare `14:07:26Z` → apply `14:43:08Z` → confirm `14:44:06Z`;
  monotônicos `659217693954012` → `661360313857059` → `661417668880919`, com
  apply → confirm de 57,355 s e 542,645 s de margem na janela de 600 s;
- estado terminal: as duas unidades permanecem `LoadState=loaded` a partir de
  `/run/systemd/system`, porém `inactive`/`dead`, `static`, sem job e sem
  próximo disparo (`NextElapseUSecMonotonic=infinity`);
- delta ativo e **não persistido** — política e chain valem até um reboot, como
  aprovado; nada foi escrito em persistência.

O recurso temporário de console foi encerrado ao fim da janela. O descarte da
chave temporária da integração serial **continua não comprovado** e não é
resolvido por esta reconciliação. Detalhamento em
[M0-31-VALIDATION.md](M0-31-VALIDATION.md).

### Registro da primeira janela (STK-M0-06, 06/09/2026)

Resultado real da primeira execução autorizada (base `4a09c4f…`, persistência
`unchanged-active-only`): apply concluído com delta DROP em INPUT/FORWARD e
timer armado; uma falha de verificação interrompeu a confirmação e o caminho
de recuperação restaurou o firewall, mantendo o encerramento interno incompleto.

- Causa observada na execução: `GetUnit` retornou `unit not loaded` para uma
  unidade inativa durante a verificação do rollback. Essa é a observação
  reproduzida e registrada; a explicação causal sobre GC/recarregamento é uma
  hipótese operacional ainda não demonstrada em systemd real neste ambiente.
- Horários systemd verificados na evidência privada: início do timer às
  `07:50:09 UTC` e parada às `07:58:46 UTC`.
- Correção (nesta revisão): classificar a recusa por identidade
  (`UnitNotLoaded`) e resolver o timer parado por readback quiescente —
  `NextElapseUSecMonotonic=infinity` significa ausência de próximo disparo;
  prazo positivo, campo ausente ou saída inválida não confirmam parada. Um
  timestamp de execução positivo já observado é preservado; zero após recarga
  não prova que a service nunca iniciou. Falha D-Bus desconhecida continua
  recusa dura. A confirmação retém referências ao timer e à service numa
  conexão D-Bus contínua, adquirida antes de validar o timer armado e mantida
  durante a parada, o marcador e as leituras finais. Perda da conexão recusa
  confirmação. Jobs/estados seguem revalidados sob o lock.
- Resultado de segurança inalterado: firewall restaurado e verificado por
  evidência externa independente — políticas ACCEPT, chain própria removida,
  IPv4 idêntico, persistência 6/6, unidades `inactive/dead` com
  `NextElapse=infinity`. A confirmação não ocorreu e o journal do run
  permanece `rollback_incomplete`: a verificação interna do stop do timer
  falhou pela recusa acima; as ações de rollback foram aplicadas.
- Reconciliação factual permanece pendente: as unidades do run continuam em
  `/run/systemd/system` e `active.json` continua presente; nenhum desses
  artefatos foi alterado nesta correção.
- **Reconciliação proposta — não executar nesta etapa:** usar o mesmo
  `operation.lock` compartilhado (com timeout; nunca um lock por run), reler e
  validar de forma somente leitura a identidade de `active.json` (`run_id`,
  chain, manifest e estado do journal), boot, script/manifest/unidades e
  hashes dos dois unit files antes de qualquer remoção. Exigir snapshot IPv6
  igual ao `before`, persistência inalterada, nenhuma service em execução e
  nenhum job das unidades. O alvo desta proposta é somente o run antigo em
  `rollback_incomplete` com restauração externamente comprovada; não aceitar
  qualquer fase terminal. Recusar apontador inválido/de outro run, colisão,
  divergência de bytes/hash ou ausência inesperada; não adotar recursos por nome. Para cada
  remoção, registrar intenção durável antes, remover somente os dois unit files
  cujo `FragmentPath` e hash correspondam ao bundle original, executar
  `daemon-reload`, reler ausência/estado `not-found` e preservar bytes do
  `active.json` até a limpeza estar verificada. Em seguida, gravar evidência
  durável da limpeza e somente então renomear o apontador para um artefato
  arquivado privado; colisão no destino ou falha parcial deixa o apontador
  original intacto e exige retry idempotente. O comando `status` apenas lê o
  registro/journal e não substitui essas verificações operacionais; a proposta
  também não inclui firewall, persistência, reboot ou novo apply.
- Estados de retomada da proposta, sempre sob o mesmo lock e sem reescrever
  o journal original:
  - **Remoção parcial:** preservar marcador separado com identidade, hashes,
    bytes originais e intenção por arquivo. Um arquivo já ausente só pode ser
    tratado como etapa concluída se sua intenção válida e seu readback estiverem
    registrados; arquivos restantes exigem nova validação antes da remoção.
  - **Limpeza completa, apontador ainda ativo:** validar novamente a limpeza e
    a evidência durável, conferir bytes do apontador e ausência de colisão no
    destino; só então arquivar. Uma falha anterior preserva o apontador ativo.
  - **Apontador já arquivado:** validar marcador durável, identidade, bytes e
    hashes do arquivo arquivado, ausência dos unit files/jobs e restauração
    operacional. Somente essa conclusão comprovada permite um no-op.
  - **Apontador ausente sem evidência correspondente, outro run ou colisão:**
    abortar e preservar registros. Nunca inferir sucesso de ausência isolada.
    O algoritmo executável ainda precisa de revisão própria e autorização; esta
    definição de estados não executa nem aprova reconciliação.
- Encerramento do guest concluído: conta padrão restaurada à forma
  pré-janela (campo sem hash, `lastchg` de provisionamento), root inalterado.
  O repasse operacional confirma que o console serial/Cloud Shell foi
  encerrado: logout concluído, conexões listadas vazias e Cloud Shell fechado;
  não afirmar descarte da chave temporária, que permanece não comprovado
  (adendo em [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md) §9).

## 6. Recuperação OCI/Ubuntu — caminho identificado, exercido na janela

> **Atualização (STK-M0-31):** a condição exigida por esta seção foi satisfeita
> na janela executada em 07/09/2026 — console independente estabelecido e
> mantido durante a alteração de firewall, com sessão autenticada e `sudo` root
> ([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §2). O histórico abaixo permanece
> como registro do estado na R2. O descarte da chave temporária serial continua
> pendente e explícito.

**Inspeção do Codex retransmitida:** instância → **OS Management → Console
connection**. A tabela não exibiu conexão existente. Os botões **Launch Cloud
Shell connection** e **Create local connection** estavam disponíveis, mas não
foram acionados. **IAM, conexão serial e login/recuperação Ubuntu não validados.**

**Leitura focada do guest (STK-M0-04):** console serial em `ttyAMA0`
(`console=tty1 console=ttyAMA0`) com `serial-getty@ttyAMA0` ativo — o guest
exibirá prompt serial assim que existir conexão de console; getty ativo
comprova configuração do guest, e transporte/prompt interativo seguem
dependendo do teste OCI. Classificação de forma do shadow (sem hashes):
nenhuma conta pertinente possui hash (root `*`, usuário padrão `!`) — não
existe senha anterior a desbloquear; o teste exigirá **definir** senha
temporária. sshd em execução sem opções alternativas; configuração carregada
verificada (include único, **nenhuma linha `Match` nos arquivos carregados**)
e campos de autenticação registrados (`PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `UsePAM yes`, `AuthenticationMethods any`),
idênticos no contexto padrão e no contexto da tupla real observada pelo
servidor: senha definida no guest não autentica via SSH. Estado, pré-requisitos
e sequência proposta: [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md).

**Validação executada (STK-M0-05, 05/09/2026):** IAM, transporte, autenticação
serial e capacidade administrativa foram validados dentro da janela autorizada
(condução do Codex; autenticação por digitação própria do proprietário), com
restauração verificada do estado pré-teste pelo Hermes e exclusão da conexão
confirmada pelo Codex. Registro completo e limitações — inclusive o descarte
**não comprovado** da chave temporária da integração — em
[ACCESS-RECOVERY.md](ACCESS-RECOVERY.md) §9. O teste pontual concluído **não**
marca a recuperação como pronta para janela futura (ACCESS-RECOVERY §5).

[Referência oficial consultada pelo Hermes](https://docs.oracle.com/en-us/iaas/Content/Compute/References/serialconsole.htm)
para documentar pré-requisitos, sem acessar a conta:

1. Verificar permissões IAM efetivas no compartment correto para leitura da
   instância e gerenciamento de `instance-console-connection`; presença do botão
   não prova autorização. Cloud Shell possui requisitos próprios de acesso/rede.
   Não editar políticas nesta tarefa.
2. **Launch Cloud Shell connection cria conexão e chave temporária** segundo a
   documentação; não é botão de consulta somente leitura. Precisa de autorização
   separada. Não foi acionado.
3. Caminho local exige cliente compatível, par RSA conforme a documentação e
   alcance do endpoint de console por SSH em TCP/443 (não HTTPS só porque usa
   443), direto ou pelo proxy permitido. Validar a identidade do endpoint em
   fonte confiável. Não criar/reutilizar credenciais por inferência.
4. A chave do transporte OCI autentica a conexão ao console; **não concede
   automaticamente login no Ubuntu**. Ver saída serial também não comprova
   capacidade de executar rollback como administrador dentro do guest.
5. Planejar e validar procedimento específico de **Ubuntu 24.04 Minimal ARM64**:
   getty/console disponível, autenticação do guest ou recuperação suportada,
   acesso administrativo e eventual impacto de reboot. Não copiar procedimentos
   `opc`, `rd.break`, SELinux ou outros exclusivos de Oracle Linux.
6. Em tarefa autorizada separada, demonstrar transporte, saída serial e caminho
   de recuperação administrativa do Ubuntu, registrar evidência privada e
   encerrar/limpar a conexão criada conforme escopo autorizado.

Nenhuma conexão, chave, credencial, sessão serial ou recurso foi criado.
O timer protege somente o delta do guest enquanto o servidor/sistema estiverem
operantes; não reverte OCI e não é substituto de recuperação fora de banda.

## 7. Validação local e critérios

O código operacional usa Python 3.11+ e biblioteca padrão; não introduz um
serviço Python nem altera a arquitetura TypeScript do produto. Na futura VPS,
a disponibilidade/versão do interpretador e comandos do adaptador deverá ser
confirmada em preflight; indisponibilidade bloqueia execução, não autoriza
instalar pacotes automaticamente.

Comandos **locais e inofensivos**, na raiz do repositório:

```bash
python -B -m unittest discover -s scripts/network_security -p 'test_*.py' -v
pnpm format:check
git diff --check
```

Foi feita também uma validação separada com **systemd real em container
Ubuntu 24.04 descartável**, sem iptables/ip6tables e sem firewall real. O
ambiente usou Docker Engine `29.7.2`, backend Linux sobre host Windows 11
x86_64, `systemd 255.4-1ubuntu8.17` e arquitetura `x86_64`. O container foi
iniciado com `--privileged`, `--cgroupns=host` e `/sys/fs/cgroup` montado; nele
foram criadas somente unidades temporárias em `/run/systemd/system` e executados
`daemon-reload`, `start`, `stop`, `systemctl show` e `systemctl list-jobs`.
O readback real foi `ActiveState=active/SubState=waiting/NextElapseUSecMonotonic=15min 4.560508s`
armado, com `Job=`, e `ActiveState=inactive/SubState=dead/NextElapseUSecMonotonic=infinity`
após `stop`, com `Job=`. O container foi removido ao final. Isso valida o
adaptador contra a formatação systemd 255 e o sentinel `infinity`, mas não
substitui validação ARM64 na VPS nem autoriza nova janela.

No complemento autorizado ao Codex, o controlador e o adaptador foram também
exercitados juntos com systemd `255.4-1ubuntu8.17`, Ubuntu 24.04 x86_64 e cgroup
namespace privado. A suíte opt-in `scripts/network_security/integration_systemd.py`
passou 5 cenários: confirmação normal, rollback manual, início do worker durante
parada/marcador e perda da conexão de referência. Firewall, persistência e probes
de rede permaneceram simulados. A reprodução e os limites estão no
[README do guard](../scripts/network_security/README.md). Não confundir esses
resultados com execução na VPS ou com aprovação de nova janela.

A CI mantém `format-check` e acrescenta `network-security-simulation` no runner
hospedado Ubuntu, com Python do runner e sem dependências Python externas.
Os testes usam substitutos de kernel/systemd/persistência; não executar adaptador
Linux real, iptables, ip6tables, nft ou systemctl reais para validar esta PR.
Não é necessário root. Resultados e cenários ficam registrados na devolutiva
associada ao head e na CI; não confundir checks simulados com probes da VPS.

### Gates de execução

- [x] Leitura guest realizada na R1, com limitações explicitadas.
- [x] Inspeção OCI incorporada com autoria Codex/retransmissão do proprietário.
- [x] Escopo fechado somente IPv6 INPUT/FORWARD ativo, preservando IPv4/OCI.
- [x] Caminho de console identificado sem criar conexão.
- [x] Recuperação administrativa validada como **teste pontual concluído**
      (STK-M0-05; [ACCESS-RECOVERY.md](ACCESS-RECOVERY.md) §9), com exclusão
      da conexão confirmada; descarte da chave temporária permanece pendência
      explícita.
- [x] Gate da janela: console independente estabelecido e mantido durante toda a
      janela de firewall, sem depender de SSH para recriá-lo (ACCESS-RECOVERY §5);
      a atestação registra operador em sessão serial e os checks de recuperação
      do provedor aprovados ([M0-31-VALIDATION.md](M0-31-VALIDATION.md) §2).
- [x] Revisão do Codex e autorização explícita para aplicação
      (`user-confirmed-apply-STK-M0-23-2026-09-07`).
- [x] Script/estado/cópia de recuperação presentes no servidor e cópia privada externa.
- [x] Timer real armado e agendamento monotônico validado na janela autorizada;
      desarmado após a confirmação, sem próximo disparo.
- [x] Segunda conexão SSH e probes reais **depois** da alteração.
- [x] Confirmação real sem corrida, rollback não iniciado e estado final conferido.

O encerramento administrativo do run legado (STK-M0-22) e a simulação de rede
na CI não equivalem a execução técnica na VPS. A janela IPv6 autorizada foi
executada e confirmada em 07/09/2026, fechando os gates acima
([issue #11](https://github.com/RhianB14/stakeframe/issues/11),
[M0-31-VALIDATION.md](M0-31-VALIDATION.md)). O plano que a antecedeu permanece
como registro histórico em [NEXT-NETWORK-WINDOW.md](NEXT-NETWORK-WINDOW.md). A
pendência histórica do descarte da chave temporária serial **não** é resolvida
por essa execução.

Os testes simulados validam a lógica do controlador, incluindo confirmação normal
com service nunca iniciada e rejeição de qualquer timestamp positivo. Não
confundir essa camada com a validação do adaptador contra systemd real.
A validação real não cobre firewall, exposição de portas ou recuperação da VPS;
CI verde não autoriza merge. Nenhuma alteração de banco, deploy, release, migração,
compra ou infraestrutura foi realizada nesta rodada. A PR permanece pendente de
revisão do Codex.

## 8. Persistência no boot — STK-M0-33 (implementação, não instalada)

Um aplicador próprio e versionado reaplica, no boot, exatamente o delta IPv6
confirmado na §4, como **uma única transação atômica** de `ip6tables-nft`
(`ip6tables-restore --noflush`, gerada em memória). Não há captura integral do
ruleset, restauração integral, `nft flush ruleset`, `netfilter-persistent save`,
sequência de comandos independentes nem adoção de chain externa pelo nome.

A transação nomeia apenas a chain própria (`STK6_BOOT`), seu salto único em
`INPUT` (posição 1) e as políticas `INPUT`/`FORWARD`. IPv4, IPv6 `OUTPUT`, NAT,
chains/regras Docker e Fail2Ban, regras terceiras, SSH e rpcbind não são citados
nem passam por flush; a preservação é garantida por construção e verificada em
container descartável.

Ordenação da unit: `After=netfilter-persistent.service`,
`Before=docker.service network-online.target`, aprovada por `systemd-analyze
verify` (rc 0) sem ciclo. `CapabilityBoundingSet=CAP_NET_ADMIN` é suficiente
(validado em container), `RemainAfterExit=yes`, `Restart=no`,
`TimeoutStartSec=90`, diretórios `RuntimeDirectory`/`StateDirectory` privados em
`0700` e hardening compatível com Python e `ip6tables`.

Falha no boot **não** é fail-closed: se a unit falhar, o host permanece no estado
fornecido pela persistência preexistente (IPv6 `INPUT`/`FORWARD` permissivos),
sem estado parcial, com a falha visível no journal
(`SyslogIdentifier=stk6-ipv6-boot`). A persistência via unit **não modifica**
`rules.v4`/`rules.v6`; a presença do delta nesses arquivos bloqueia a aplicação.
Falha no boot **não** é fail-closed. O resultado depende do ponto exato:
falha **antes do commit** preserva o estado da persistência preexistente (IPv6
`INPUT`/`FORWARD` permissivos), sem estado parcial; falha **pós-commit** com o
delta exato comprovado gera rollback automático apenas do delta próprio; **deriva
ou readback indisponível** deixa o estado **não declarado** como restaurado
(`rollback_required`, sem sobrescrever nada); **crash** entre o commit e o recibo
é recuperado na execução seguinte por rollback conservador; **crash sem prova
válida** é recusado sem mutação. Em todos os casos a falha é visível no journal
(`SyslogIdentifier=stk6-ipv6-boot`). A persistência via unit **não modifica**
`rules.v4`/`rules.v6`; a presença do delta nesses arquivos bloqueia a aplicação.
O delta atual continua não persistente, e a instalação, a ativação e qualquer
reboot exigem autorização posterior do Codex. VPS, reboot e recuperação real não
foram testados ([M0-33-VALIDATION.md](M0-33-VALIDATION.md)).

Recuperação após o commit: todas as etapas posteriores à transação (readback,
recibo, sidecar, `fsync`, `os.replace`) estão no caminho de recuperação; o
recibo é o marcador final de sucesso e o journal pré-transação nunca é
reescrito entre o commit e o evento terminal. Falha pós-aquisição com o
estado próprio comprovado ⇒ rollback automático só do delta próprio; deriva ou
perda de prova ⇒ `rollback_required` sem sobrescrever nada; crash entre o commit e
o recibo ⇒ rollback conservador na execução seguinte (`interrupted_rolled_back`),
sem adoção do delta nem recibo sintetizado; recibo ilegível (truncado, sem
sidecar, sidecar divergente, JSON não-objeto) nunca é sucesso e nunca bloqueia a
recuperação por journal; recibo coerente exige `phase`/`state` consistentes e
`policy_sha256` atual antes de qualquer rollback; o rollback grava um journal
durável `rolling_back` (`state=unknown`) antes de qualquer snapshot/transação —
acknowledgement perdido, readback indisponível ou morte após o commit nunca
deixam `status()` declarar `applied`; a transição terminal é à prova de crash —
o journal `rolled_back`/`clean` é persistido **antes** de o recibo stale ser
tocado e só depois o recibo terminal é gravado; depois de um rollback comprovado,
a remoção durável do recibo antigo é tentada, e **quando ela funciona** o recibo
é eliminado — se a invalidação falhar, o journal terminal/de recuperação
prevalece e impede `status()` de declarar `applied`; uma morte entre o commit e
os registros terminais, inclusive com o recibo removido (ou removido em parte),
é reconciliada no retry por um journal `rolling_back` integralmente validado —
finaliza `rolled_back` **sem nova transação de firewall**; um journal terminal
já persistido apenas completa o recibo, sem mutação; `rolling_back`/
`rollback_required` significam estado **não comprovado** (`state=unknown`) e só
há `clean` depois de rollback ou ausência do delta comprovados; controlador
ausente no caminho
instalado ⇒ unit `failed` (a unit não usa `ConditionPathExists`), nunca skip.
Todas as referências jump/goto à `STK6_BOOT` em qualquer chain são inventariadas:
fora de `INPUT` posição 1 com a especificação revisada, o estado é recusado antes
de qualquer mutação; deriva de política durante o rollback também é recusada sem
transação ([M0-33-VALIDATION.md](M0-33-VALIDATION.md) §5, §7 e §8).
