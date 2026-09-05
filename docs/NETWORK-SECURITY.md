# STK-M0-03 — Revisão de rede e preparação da segurança

> **Estado:** proposta bloqueada, não aplicada e não autorizada para execução.
> A documentação separa fatos observados, proposta condicional e itens não
> verificados. Nenhum comando desta proposta foi executado na VPS ou na Oracle.
>
> **Base:** `main` em `666f915ab0c94eeef3f792f5eed88809a049297e`.
>
> **Identificadores privados:** host, usuário SSH, caminho da chave, endereços,
> OCIDs, tenancy e regras do painel permanecem fora deste documento.

## 1. Escopo e veredito desta rodada

Esta rodada deveria completar a leitura da rede convidada e do painel Oracle e
preparar uma política aplicável com rollback. A leitura local da VPS permanece
incompleta porque a sessão SSH autorizada não pôde ser reconstruída sem adivinhar
o usuário, e a sessão autenticada do painel Oracle não ficou disponível. A
proposta abaixo é, portanto, uma base de revisão do Codex, não uma autorização de
mudança.

### Classificação usada

| Estado             | Significado                                                      |
| ------------------ | ---------------------------------------------------------------- |
| **Observado**      | Resultado retornado pela leitura SSH aprovada em STK-M0-02.      |
| **Proposto**       | Política ou procedimento para uma futura tarefa autorizada.      |
| **Não verificado** | Evidência ainda ausente; não pode ser preenchida por inferência. |
| **Bloqueador**     | Item que impede aplicar a política com segurança nesta rodada.   |

### Bloqueadores atuais

1. **Acesso SSH:** a chave privada local está no caminho privado já validado,
   mas o usuário remoto não está disponível em configuração ou histórico local
   recuperável nesta sessão. Não será tentado `ubuntu`, `opc` ou outro usuário
   por inferência.
2. **Rede convidada completa:** o inventário aprovado consultou `iptables` e
   `nftables`, mas não preservou a visão completa de backend, IPv4/IPv6, NAT,
   chains Docker/Fail2Ban, persistência, rotas, autenticação SSH e dependências
   RPC necessárias para uma alteração segura.
3. **Oracle:** shape, volumes, VNIC, subnet, rotas, Security Lists, NSGs,
   regras IPv4/IPv6 e semântica stateful/stateless não foram confirmados no
   painel/API.
4. **Recuperação:** o caminho de recuperação de acesso SSH pelo provedor não
   foi identificado nem validado.

Enquanto esses bloqueadores existirem, a PR deve permanecer **draft** e nenhum
comando de aplicação deve ser executado.

## 2. Evidências já observadas na VPS

As linhas abaixo são fatos do inventário sanitizado aprovado em STK-M0-02; não
foram reinterpretadas como prova de exposição pública.

| Item                         | Estado              | Observação e limite                                                                                                                                                                                              |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sistema                      | Observado           | Ubuntu 24.04.4 LTS, kernel `6.17.0-1020-oracle`, arquitetura `aarch64`/ARM64.                                                                                                                                    |
| Capacidade                   | Observado/informado | 2 CPUs observadas; 12 GB informados pelo proprietário; `free` exibiu 11 GiB; disco observado de 50 GB. A shape Oracle não foi inferida.                                                                          |
| Serviços ativos selecionados | Observado           | SSH, Docker/containerd, Fail2Ban, agente Oracle/Fluentd, `systemd-resolved`, `systemd-timesyncd`, `rpcbind`, `iscsid`, `unattended-upgrades`, `fwupd` e serviços básicos.                                        |
| Containers                   | Observado           | Nenhum container ou projeto Compose ativo; somente `hello-world:latest` estava presente. Chains dinâmicas do Docker não foram coletadas na íntegra.                                                              |
| Listeners                    | Observado           | TCP 22 em IPv4/IPv6; TCP e UDP 111 em IPv4/IPv6; DNS somente em loopback; nenhum listener UDP 22; nenhum listener TCP 80/443.                                                                                    |
| `rpcbind`                    | Observado           | Escuta TCP/UDP 111 em IPv4/IPv6 e todas as interfaces. Necessidade, clientes RPC e alcançabilidade externa não foram determinados.                                                                               |
| Firewall                     | Observado parcial   | UFW não está instalado. A coleta consultou `iptables` e `nftables`; foram registradas as políticas `INPUT ACCEPT`, `FORWARD DROP`, `OUTPUT ACCEPT` e accepts explícitos para novas conexões TCP em 22, 80 e 443. |
| Oracle ingress               | Não verificado      | Não houve confirmação das regras de Security List/NSG nem teste externo. Uma regra local ou listener não prova exposição pública.                                                                                |

`iptables-nft` e `nftables` não devem ser tratados como dois firewalls
independentes. O backend efetivo, a relação entre as ferramentas e o caminho de
persistência ainda precisam ser identificados por leitura explícita.

## 3. Leitura convidada que falta

### 3.1. Backend e regras completas

Antes de escrever regras, deve ser preservado em armazenamento privado o estado
completo e selecionado abaixo. A captura não deve ser publicada, enviada ao
repositório ou misturada com variáveis de ambiente, logs ou dados da aplicação.

```bash
sudo -n iptables -V
sudo -n ip6tables -V
sudo -n update-alternatives --display iptables 2>/dev/null || true
sudo -n update-alternatives --display ip6tables 2>/dev/null || true
sudo -n nft --version
sudo -n iptables-save -c
sudo -n ip6tables-save -c
sudo -n iptables -S
sudo -n ip6tables -S
sudo -n iptables -t nat -S
sudo -n ip6tables -t nat -S
sudo -n iptables -t mangle -S
sudo -n ip6tables -t mangle -S
sudo -n iptables -t raw -S
sudo -n ip6tables -t raw -S
sudo -n nft -a list ruleset
```

A leitura deve identificar, sem substituir ou limpar:

- política e ordem efetiva de `INPUT`, `OUTPUT` e `FORWARD` em IPv4 e IPv6;
- `PREROUTING`, `POSTROUTING`, `DOCKER`, `DOCKER-USER`,
  `DOCKER-FORWARD`, chains de compatibilidade e regras de NAT;
- chains e jails criadas pelo Fail2Ban, especialmente para SSH;
- regras de ICMP/ICMPv6, `ESTABLISHED,RELATED`, loopback e rejeições finais;
- diferença real entre `iptables`/`ip6tables` e o backend nftables instalado.

A ausência atual de containers não autoriza remover chains Docker. Elas podem ser
criadas pelo daemon quando o primeiro Compose for iniciado.

### 3.2. Interfaces, rotas e serviços essenciais

```bash
ip -brief address
ip route show table main
ip -6 route show table main
ip rule show
ip -6 rule show
resolvectl status
resolvectl dns
systemctl is-active systemd-resolved.service systemd-timesyncd.service
systemctl is-enabled systemd-resolved.service systemd-timesyncd.service
systemctl list-units --type=service --state=running --no-pager --no-legend
systemctl list-units --type=socket --state=running --no-pager --no-legend
ss -H -lntup
```

Esses comandos devem esclarecer interface principal, rota default, IPv6 global
ou somente local, resolvedor efetivo, NTP e eventual DHCP. O inventário anterior
confirmou `systemd-resolved` e `systemd-timesyncd`, mas não confirmou servidores
DNS, rotas, DHCP ou endereços públicos.

### 3.3. Autenticação SSH sem segredos

A configuração efetiva deve ser lida sem exibir chaves, tokens ou conteúdo de
`authorized_keys`:

```bash
sudo -n sshd -T
sudo -n systemctl status ssh.service ssh.socket --no-pager
sudo -n systemctl cat ssh.service ssh.socket
sudo -n systemctl show ssh.service ssh.socket \
  -p FragmentPath -p DropInPaths -p Requires -p Wants -p After -p Before
```

A saída deve ser capturada privadamente e revisada para `PasswordAuthentication`,
`KbdInteractiveAuthentication`, `PermitRootLogin`, `PubkeyAuthentication`,
`AllowUsers`/`AllowGroups`, `ListenAddress`, `AddressFamily`, limites de tentativas
e o uso de `fail2ban`. A leitura não deve abrir nem imprimir chaves privadas ou
arquivos de autorização.

### 3.4. `rpcbind`, sockets e dependências RPC/NFS

O fato de `rpcbind` estar ativo não prova que pode ser removido. A próxima leitura
deve separar unidade, socket, consumidores locais e montagens:

```bash
systemctl status rpcbind.service rpcbind.socket --no-pager
systemctl cat rpcbind.service rpcbind.socket
systemctl show rpcbind.service rpcbind.socket \
  -p ActiveState -p SubState -p FragmentPath -p DropInPaths \
  -p Requires -p Wants -p After -p Before
systemctl list-dependencies --all rpcbind.service
systemctl list-dependencies --all rpcbind.socket
rpcinfo -p 127.0.0.1
ss -H -lntup '( sport = :111 )'
findmnt -t nfs,nfs4
mount | awk '$5 ~ /^nfs/ {print $0}'
systemctl list-units --type=service --all --no-pager --no-legend \
  | grep -Ei 'nfs|rpc|mountd|statd|lockd' || true
```

Até essa leitura, a conclusão correta é: **dependência de NFS/RPC não
comprovada, mas também não descartada**. `iscsid` apareceu na lista selecionada
de serviços, porém isso não demonstra dependência de `rpcbind`. Não será
executado `disable`, `stop`, `mask` ou alteração de socket nesta tarefa.

### 3.5. Persistência e Docker/Fail2Ban

A forma de persistir deve ser descoberta, não escolhida por preferência:

```bash
systemctl list-unit-files --no-pager --no-legend \
  | grep -Ei 'netfilter|nftables|iptables|firewalld' || true
systemctl list-timers --all --no-pager --no-legend \
  | grep -Ei 'netfilter|nftables|iptables' || true
find /etc -maxdepth 3 -type f \( \
  -path '*/iptables/*' -o -name 'rules.v4' -o -name 'rules.v6' \
  -o -name 'nftables.conf' \) -print 2>/dev/null
sudo -n docker network ls
sudo -n docker info --format '{{json .}}'
sudo -n fail2ban-client status
sudo -n fail2ban-client status sshd 2>/dev/null || true
```

Os resultados devem ser tratados como configuração operacional sensível e
armazenados somente no ambiente privado do operador. Não se deve alterar
`DOCKER-USER`, chains Docker ou jails Fail2Ban antes de conhecer o gerenciador
que as mantém.

## 4. Leitura Oracle pendente

### 4.1. Estado desta rodada

| Evidência Oracle                              | Estado         | Motivo                                                                |
| --------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| Shape, região e capacidade configurada        | Não verificado | Sem leitura de painel/API disponível.                                 |
| Boot volume e volumes anexados                | Não verificado | Sem leitura de painel/API disponível.                                 |
| VNICs, subnet, IP público e privado           | Não verificado | Sem leitura de painel/API disponível; nenhum endereço será publicado. |
| Route table, Internet Gateway e conectividade | Não verificado | Sem leitura de painel/API disponível.                                 |
| Security Lists associadas                     | Não verificado | Sem leitura de painel/API disponível.                                 |
| NSGs associados                               | Não verificado | Sem leitura de painel/API disponível.                                 |
| Ingress/egress IPv4 e IPv6                    | Não verificado | Sem leitura de painel/API disponível.                                 |
| Stateful/stateless                            | Não verificado | Sem leitura de painel/API disponível.                                 |
| Políticas adicionais de rede                  | Não verificado | Sem leitura de painel/API disponível.                                 |
| Caminho de recuperação do SSH                 | Não verificado | Console e pré-requisitos não foram identificados.                     |

Não há OCI CLI/configuração local disponível. A sessão do navegador local não
produziu uma sessão Oracle Cloud utilizável nesta rodada. Se o painel for
necessário, o proprietário deverá fazer login e MFA no navegador apropriado;
nenhuma senha, token ou cookie deve ser enviado ao Hermes.

### 4.2. Checklist de leitura para o painel

Com a sessão legítima disponível, a coleta deve registrar apenas fatos
sanitizados e placeholders:

1. Instância, região, Availability Domain, shape, OCPU/vCPU, memória e status.
2. Boot volume, tamanho, performance e volumes anexados; sem baixar dados.
3. VNIC primária, subnet, route table, Internet Gateway e estado de IP público.
4. Todas as Security Lists associadas à subnet, com direção, protocolo, CIDR,
   porta, descrição e indicação stateful/stateless.
5. Todos os NSGs efetivamente associados à VNIC, com as mesmas colunas.
6. Regras de egress e eventual política adicional de rede.
7. Caminho de recuperação disponível, tipo de console, pré-requisitos de
   autorização/chave, necessidade de parar a instância e procedimento de acesso.
8. Ausência ou presença de regras que permitam TCP/UDP 111, PostgreSQL, Redis,
   OmniRoute e interfaces administrativas.

Security List e NSG devem ser avaliados em conjunto. Um NSG restritivo não prova
que uma Security List permissiva deixou de permitir tráfego; o conjunto efetivo
e a direção das regras é que precisam ser comparados.

Nenhum console de recuperação, chave, recurso, regra ou instância foi criado.

## 5. Política proposta para revisão

Esta é uma proposta condicional. A primeira alteração deve preservar SSH e não
pode restringir o acesso ao IP momentâneo da conexão presumindo que seja fixo.
A regra atual de SSH deve ser identificada e mantida durante a primeira janela.

### 5.1. Matriz de regras

| Origem                  | Destino                      | Protocolo     | Porta               | Finalidade                               | Estado atual                                                                                      | Estado proposto                                                                                                              | Camada responsável                                |
| ----------------------- | ---------------------------- | ------------- | ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Operador autorizado     | VPS                          | TCP           | 22                  | Administração SSH                        | Listener observado em IPv4/IPv6; origem e Oracle não verificadas                                  | Preservar durante toda a primeira mudança; restringir somente após CIDR estável e autorização própria                        | Security List/NSG + firewall convidado + Fail2Ban |
| Internet autorizada     | VPS                          | TCP           | 80                  | HTTP para Caddy/reverso futuro           | Nenhum listener observado; accept local para novas conexões foi registrado; Oracle não verificado | Permitir somente quando houver listener autorizado e HTTPS/redirect planejado                                                | Security List/NSG + firewall convidado            |
| Internet autorizada     | VPS                          | TCP           | 443                 | HTTPS público                            | Nenhum listener observado; Oracle não verificado                                                  | Permitir para o proxy público futuro, em IPv4 e IPv6                                                                         | Security List/NSG + firewall convidado            |
| Qualquer origem pública | VPS                          | TCP/UDP       | 111                 | `rpcbind`/RPC                            | `rpcbind` escuta em todas as interfaces; dependências não verificadas                             | Não publicar; manter serviço até a análise de dependências; se houver uso privado, permitir apenas origem privada comprovada | Security List/NSG + firewall convidado            |
| Qualquer origem pública | VPS                          | TCP           | 5432                | PostgreSQL                               | Nenhum listener PostgreSQL observado                                                              | Negar/não criar ingresso público; usar somente rede interna ou túnel administrativo autorizado                               | Security List/NSG + Compose/firewall              |
| Qualquer origem pública | VPS                          | TCP           | 6379                | Redis                                    | Nenhum listener Redis observado                                                                   | Negar/não publicar; bind interno/loopback quando o serviço existir                                                           | Security List/NSG + Compose/firewall              |
| Qualquer origem pública | VPS                          | TCP           | 20128, 20129, 20132 | Interfaces/API/WebSocket do OmniRoute    | Nenhum listener OmniRoute observado; portas são somente referência local                          | Negar publicação direta; acesso interno ou administrativo separado                                                           | Security List/NSG + Compose/firewall              |
| Loopback                | Loopback                     | IPv4/IPv6     | qualquer            | Serviços locais                          | DNS de loopback observado; regra completa não verificada                                          | Preservar loopback sem alteração                                                                                             | Firewall convidado                                |
| Qualquer origem/destino | VPS                          | IPv4/IPv6     | estado              | Respostas e conexões estabelecidas       | Não verificado no conjunto completo                                                               | Preservar `ESTABLISHED,RELATED` antes de filtros finais                                                                      | Firewall convidado                                |
| VPS                     | Resolvedor configurado       | UDP/TCP       | 53                  | DNS                                      | `systemd-resolved` ativo; servidores e egress não verificados                                     | Permitir somente resolvedores efetivamente configurados; não abrir entrada pública                                           | Firewall convidado + route/egress Oracle          |
| VPS                     | Servidores NTP               | UDP           | 123                 | Sincronização de relógio                 | `systemd-timesyncd` ativo e NTP sincronizado no inventário                                        | Preservar egress necessário; sem ingresso público                                                                            | Firewall convidado + egress Oracle                |
| VPS                     | APIs, atualizações e backups | TCP           | 443                 | Operação, atualizações e backups futuros | Destinos não verificados                                                                          | Preservar egress necessário, sujeito à política Oracle observada                                                             | Firewall convidado + egress Oracle                |
| VPS                     | Rede de diagnóstico          | ICMP/ICMPv6   | tipos aplicáveis    | MTU, descoberta e diagnóstico            | Regras completas não verificadas                                                                  | Preservar o mínimo necessário para operação e diagnóstico; não bloquear ICMPv6 indiscriminadamente                           | Firewall convidado + Security List/NSG            |
| Interface usando DHCP   | Servidor DHCP                | UDP           | 67/68 ou 546/547    | Configuração automática, se aplicável    | Não verificado                                                                                    | Permitir somente se a interface efetivamente depender de DHCP                                                                | Firewall convidado                                |
| Docker bridge           | Containers/host              | TCP/UDP       | conforme Compose    | Redes internas e portas publicadas       | Nenhum container e nenhuma rede de aplicação observados                                           | Manter chains Docker administradas pelo daemon; publicar somente proxy e portas aprovadas                                    | Docker/DOCKER-USER + firewall convidado           |
| Fail2Ban                | Chains de proteção           | conforme jail | conforme jail       | Bloqueios dinâmicos de SSH               | Serviço ativo; chains/jails não foram lidos                                                       | Preservar e não sobrescrever chains administradas pelo Fail2Ban                                                              | Fail2Ban + firewall convidado                     |

A matriz não autoriza abrir 80/443 agora. Ela define o estado desejado para uma
futura aplicação após existir Caddy/listener e após a confirmação da camada
Oracle. PostgreSQL, Redis e OmniRoute não devem ser publicados diretamente.

### 5.2. Decisão proposta para `rpcbind`

A decisão segura nesta fase é **não desativar** `rpcbind` e seu socket. A escuta
em 111 é observada, mas a ausência de containers não prova ausência de NFS/RPC.

A sequência proposta é:

1. Ler dependências de `rpcbind.service` e `rpcbind.socket`, `rpcinfo` local,
   montagens NFS e unidades RPC/NFS.
2. Ler ingress/egress Oracle e confirmar se 111 é alcançável externamente.
3. Se não houver consumidor RPC/NFS e houver autorização específica, preparar
   desativação do serviço **e do socket** em tarefa separada, com rollback.
4. Se houver consumidor, manter o serviço e restringir o alcance às origens
   privadas comprovadas; nunca deixar a decisão baseada somente em `ss`.
5. Em todos os casos, documentar a diferença entre serviço ativo, listener local
   e exposição pública.

Nenhuma dessas decisões foi aplicada nesta tarefa.

## 6. Procedimento proposto de aplicação e recuperação

Os comandos desta seção são um runbook futuro, parametrizado e **não executado**.
Os placeholders devem ser preenchidos somente após a revisão do Codex. O backend
observado deve determinar se o procedimento usa `iptables-restore`/`ip6tables-restore`
ou `nft`; nunca se devem restaurar os dois formatos por hábito.

### 6.1. Pré-condições

A aplicação fica bloqueada até todos os itens abaixo serem verdadeiros:

- usuário, host, chave e fingerprints SSH confirmados em fonte privada;
- backend efetivo e cadeia de persistência identificados;
- estado completo IPv4/IPv6, NAT, Docker e Fail2Ban capturado;
- dependências de `rpcbind` classificadas;
- Security Lists e NSGs reconciliados para IPv4 e IPv6;
- caminho de recuperação Oracle identificado e acessível;
- sessão SSH atual mantida aberta;
- segunda conexão SSH independente preparada, de origem distinta quando
  possível, sem restringir ao IP momentâneo;
- janela de rollback temporizado armada e verificada;
- proposta exata revisada e autorização explícita do Codex para aplicação.

### 6.2. Captura privada do estado anterior

A captura deve ser local, fora do repositório, com permissões restritas. Exemplo
parametrizado para a futura janela:

```bash
umask 077
SNAPSHOT="<PRIVATE_SNAPSHOT_DIR>/stakeframe-network-<UTC_TIMESTAMP>"
mkdir -p "$SNAPSHOT"

ssh -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile='<PRIVATE_KNOWN_HOSTS>' \
  -i '<SSH_KEY_PATH>' '<SSH_USER>@<VPS_HOST_OR_IP>' \
  'sudo -n iptables-save -c' > "$SNAPSHOT/iptables.v4"
ssh ... 'sudo -n ip6tables-save -c' > "$SNAPSHOT/ip6tables.v6"
ssh ... 'sudo -n nft -a list ruleset' > "$SNAPSHOT/nft.rules"
ssh ... 'ip -brief address; ip route; ip -6 route; ss -H -lntup' \
  > "$SNAPSHOT/network-state.txt"
ssh ... 'sudo -n sshd -T; systemctl status rpcbind.service rpcbind.socket --no-pager' \
  > "$SNAPSHOT/ssh-rpc-state.txt"
sha256sum "$SNAPSHOT"/* > "$SNAPSHOT/SHA256SUMS"
```

O `...` acima representa a repetição dos mesmos parâmetros privados, não um
comando pronto para copiar. O snapshot deve ser lido e conferido antes de
qualquer alteração; não deve conter `env`, logs completos, chaves ou dados de
aplicação.

### 6.3. Validação antes da aplicação

- Comparar o snapshot com a política aprovada e confirmar que a regra SSH atual
  continuará presente.
- Validar sintaxe no backend identificado, sem carregar a mudança:
  `iptables-restore --test`/`ip6tables-restore --test` para candidatos do
  backend iptables, ou `nft -c -f <candidate>` para candidato nftables.
- Confirmar que o candidato não contém flush global, alteração de Docker/Fail2Ban,
  regra pública de 5432/6379/OmniRoute ou bloqueio de loopback/estabelecidas.
- Conferir a ordem das regras, especialmente antes de qualquer REJECT/DROP final.
- Registrar a identificação da Security List/NSG que será alterada, sem publicar
  OCIDs.

Validação de sintaxe não é teste real de firewall, de exposição pública ou de
rollback.

### 6.4. Rollback local temporizado

Antes da primeira alteração convidada, preparar um script privado de rollback que
restaure **somente** o backend identificado a partir do snapshot e registrar seu
hash. Armá-lo como unidade transitória do systemd, com prazo curto e explícito:

```bash
sudo systemd-run \
  --unit='stakeframe-network-rollback-<RUN_ID>' \
  --on-active=10min \
  --collect \
  /root/<PRIVATE_ROLLBACK_DIR>/rollback-<RUN_ID>.sh
sudo systemctl show \
  'stakeframe-network-rollback-<RUN_ID>.timer' \
  -p Id -p ActiveState -p NextElapseUSecRealtime
```

A forma exata da unidade e a restauração devem ser confirmadas no host antes da
janela. O rollback não deve usar `iptables-restore`, `ip6tables-restore` e `nft`
ao mesmo tempo. O script precisa registrar sucesso/erro em local privado e ser
idempotente.

O timer deve permanecer armado até:

1. a sessão SSH original continuar funcionando;
2. uma segunda conexão SSH independente autenticar e executar apenas probes de
   leitura;
3. listeners, rotas, DNS/NTP, `rpcbind`, Docker e Fail2Ban apresentarem o estado
   esperado;
4. a leitura do painel Oracle confirmar as regras efetivas;
5. o operador conferir o snapshot pós-mudança.

Somente então o operador cancela a unidade com o comando correspondente ao nome
real validado, por exemplo `sudo systemctl stop <ROLLBACK_UNIT>`. Não cancelar
por decurso de tempo nem por uma única conexão.

### 6.5. Ordem futura das mudanças

1. Confirmar o caminho de recuperação Oracle e deixar o console acessível.
2. Capturar e validar o estado local e a política Oracle.
3. Armar o rollback local e verificar que ele está agendado.
4. Preservar a regra de SSH na Security List/NSG e no host.
5. Aplicar mudanças pequenas no host, sem flush global e sem tocar chains
   administradas por Docker/Fail2Ban.
6. Abrir/reter somente 80/443 nas duas camadas quando houver serviço autorizado.
7. Remover alcance público de 111 somente após a análise de dependências e a
   decisão do Codex; não desligar `rpcbind` nesta sequência automaticamente.
8. Abrir uma segunda conexão SSH independente e executar probes de leitura.
9. Se qualquer probe falhar, não cancelar o rollback; deixar a restauração
   temporizada ocorrer ou usar o caminho Oracle separado.
10. Depois de todos os critérios de aceite, persistir pelo mecanismo nativo
    confirmado e cancelar o rollback.

### 6.6. Oracle e rollback são camadas separadas

O timer local só pode restaurar regras do host se o host continuar executando.
Ele **não desfaz** Security Lists, NSGs, route tables, IP público ou qualquer
alteração da Oracle. Para a camada Oracle, o runbook futuro deve guardar
privadamente o estado anterior, aplicar a mudança pelo painel/API autorizado,
ler novamente o conjunto efetivo e ter uma sequência independente de reversão no
mesmo painel/API. Perder SSH exige o caminho de recuperação confirmado; não se
pode prometer que o timer local resolverá isso.

### 6.7. Persistência após sucesso

A persistência só pode ser configurada depois de identificar o mecanismo já
instalado. O futuro operador deve:

- salvar pelo serviço nativo já presente, sem instalar UFW ou trocar backend;
- reler a configuração salva e comparar com o estado ativo;
- testar a carga em uma janela autorizada, sem reiniciar nesta tarefa;
- em tarefa posterior, verificar após reinício autorizado que SSH, IPv4/IPv6,
  80/443, loopback, egress, Docker e Fail2Ban continuam corretos.

## 7. Critérios de aceite para a futura aplicação

- [ ] Host, usuário, chave e fingerprints confirmados sem publicar valores.
- [ ] Backend efetivo e persistência identificados.
- [ ] IPv4 e IPv6 conferidos separadamente, incluindo NAT e chains finais.
- [ ] Docker e Fail2Ban preservados e suas chains compreendidas.
- [ ] SSH original mantido; segunda conexão independente validada.
- [ ] Oracle Security Lists e NSGs reconciliados, sem regras permissivas
      esquecidas em uma camada.
- [ ] 80/443 liberados somente para o proxy autorizado e em ambas as camadas.
- [ ] 5432, 6379, portas administrativas e OmniRoute sem publicação direta.
- [ ] `rpcbind` mantido ou restringido com dependências documentadas; nenhuma
      desativação sem tarefa e autorização próprias.
- [ ] Loopback, estabelecidas, ICMP/ICMPv6 aplicável, DNS, NTP e egress mantidos.
- [ ] Snapshot privado, hashes e rollback temporizado verificados antes da
      primeira alteração.
- [ ] Rollback cancelado somente após segunda conexão e probes completos.
- [ ] Persistência conferida e eventual reinício autorizado verificado.

## 8. Arquivos e limites desta PR

Foi preparado somente este documento. Nenhum arquivo de configuração de firewall
foi criado porque os dados observados não permitem escolher com segurança entre
backend iptables-nft/nftables, cadeia Docker/Fail2Ban ou mecanismo de persistência.
Criar um instalador genérico neste estado esconderia justamente os riscos que a
tarefa exige revisar.

Nenhuma regra, serviço, socket, pacote, container, volume, usuário, permissão,
configuração SSH, Security List, NSG, rota ou recurso Oracle foi alterado.
