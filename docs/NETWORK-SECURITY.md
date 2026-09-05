# STK-M0-03 — Revisão de rede e preparação da segurança

> **Estado:** análise somente leitura da VPS concluída; leitura Oracle e caminho de
> recuperação permanecem pendentes. A proposta abaixo é host-specific, não foi
> aplicada e não autoriza mudança remota.
>
> **Base da PR:** `main` em `666f915ab0c94eeef3f792f5eed88809a049297e`.
>
> **Identificadores privados:** host, endereços, usuário SSH, caminho da chave,
> fingerprints, OCIDs, tenancy, região exata e regras do painel permanecem fora
> deste documento.

## 1. Escopo e veredito desta rodada

A conexão SSH autorizada foi retomada com os dados privados já confirmados pelo
proprietário. A identidade do login foi verificada, e a coleta abaixo foi
executada de forma não interativa, somente leitura, transmitindo um script por
stdin; nenhum arquivo temporário foi criado na VPS.

A análise local agora cobre backend, regras IPv4/IPv6, NAT, Docker, Fail2Ban,
persistência, interfaces, rotas, DNS/NTP, SSH efetivo e dependências
RPC/NFS. As saídas brutas foram mantidas somente em arquivos temporários
privados locais e não entram no repositório.

A sessão Oracle Cloud não ficou acessível ao Hermes: a tentativa em uma sessão
local nova para o console expirou sem produzir uma página ou dados utilizáveis.
Não há OCI CLI/configuração local disponível. Portanto, esta PR continua draft.

### Classificação usada

| Estado             | Significado                                                         |
| ------------------ | ------------------------------------------------------------------- |
| **Observado**      | Resultado da coleta somente leitura na VPS ou da verificação local. |
| **Proposto**       | Procedimento e estado desejado para uma futura tarefa autorizada.   |
| **Não verificado** | Evidência ausente; não pode ser preenchida por inferência.          |
| **Bloqueador**     | Item que impede aplicar a política com segurança nesta rodada.      |

### Bloqueadores atuais

1. **Camada Oracle:** shape, volumes, VNIC, subnet, rotas, conectividade
   pública, Security Lists, NSGs, regras IPv4/IPv6, stateful/stateless e
   políticas adicionais continuam não verificados.
2. **Recuperação:** o caminho de recuperação caso o SSH seja perdido não foi
   identificado nem validado. O timer do host não recupera uma alteração da
   Oracle nem um host que perdeu conectividade.
3. **Execução:** a proposta exata, a segunda conexão independente, a política
   Oracle e o rollback precisam de revisão/autorização específica do Codex.
4. **Exposição de aplicação:** não há listener HTTP/HTTPS e não há aplicação
   Stakeframe implantada; a abertura final de 80/443 deve ser separada da
   alteração de hardening do host.

O bloqueador de usuário SSH desconhecido foi removido após a conexão autorizada.
Nenhuma regra, serviço, socket, pacote, container, volume, configuração SSH,
Security List, NSG, rota ou recurso Oracle foi alterado.

## 2. Evidências sanitizadas da VPS

### 2.1. Sistema, interfaces e serviços

| Item                      | Resultado observado                                                                                                                                               | Limite                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Sistema                   | Ubuntu 24.04.4 LTS, kernel `6.17.0-1020-oracle`, `aarch64`/ARM64                                                                                                  | Evidência do guest; não confirma shape Oracle.                   |
| Interface principal       | `enp0s6`, estado routable/configured, MTU 9000                                                                                                                    | Endereços e gateway foram mantidos privados.                     |
| Configuração da interface | DHCPv4 via `systemd-networkd`; `systemd-resolved` recebe DNS pela interface                                                                                       | Não substitui a leitura da subnet/route table OCI.               |
| IPv6                      | Somente endereços/rotas link-local foram observados no guest                                                                                                      | Não confirma ausência ou presença de IPv6 na camada OCI.         |
| Bridge Docker             | `docker0` presente, sem carrier e sem container ativo                                                                                                             | Não remover a bridge nem suas chains; o daemon pode reativá-las. |
| Rotas                     | Default IPv4 via DHCP em `enp0s6`; tabelas de regras padrão sem policy routing extra                                                                              | O gateway/IP real não é publicado.                               |
| DNS                       | `systemd-resolved` ativo; `resolv.conf` em modo stub; DNS efetivo vindo da interface                                                                              | Não publicar servidores ou domínio interno.                      |
| Relógio                   | NTP habilitado e sincronizado; timezone do guest em UTC                                                                                                           | Nenhuma alteração foi feita.                                     |
| Serviços relevantes       | `ssh`, `docker`, `containerd`, `fail2ban`, `rpcbind`, `iscsid`, agentes Oracle/monitoramento, `systemd-networkd`, `systemd-resolved` e `systemd-timesyncd` ativos | A lista é selecionada, não um dump de logs.                      |
| Listeners                 | TCP 22 em IPv4/IPv6; TCP/UDP 111 em IPv4/IPv6; DNS local; DHCPv4; nenhum TCP 80/443 e nenhum UDP 22                                                               | Listener local não prova exposição pública.                      |

### 2.2. Backend efetivo e regras atuais

A leitura retornou:

- `iptables` e `ip6tables` versão `1.8.10 (nf_tables)`;
- `nft` versão `1.0.9`;
- Docker informa firewall backend `iptables`;
- `iptables-nft` e `nftables` são duas interfaces sobre o mesmo backend nftables
  quando usadas para as mesmas tabelas; não são dois firewalls independentes;
- UFW não está instalado/disponível. Isso registra a indisponibilidade do
  comando UFW; não é usado como prova de que não existe outro firewall.

#### Políticas e filtros IPv4

| Chain     | Política atual | Elementos relevantes                                                                                   |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `INPUT`   | `ACCEPT`       | Loopback, estado `ESTABLISHED,RELATED`, ICMP, TCP novo em 22/80/443 e rejeição final foram observados. |
| `FORWARD` | `DROP`         | Saltos para `DOCKER-USER` e `DOCKER-FORWARD`; chains Docker sem regras de publicação de aplicação.     |
| `OUTPUT`  | `ACCEPT`       | Há tratamento adicional de `InstanceServices`/egress Oracle no ruleset observado.                      |

Também foram consultadas as tabelas `nat`, `mangle`, `raw` e `security`. No NAT
IPv4 há saltos Docker e masquerade da rede Docker; não há regra de publicação
de porta de container no snapshot. O ruleset inclui as chains Docker abaixo,
mesmo sem containers ativos:

```text
DOCKER
DOCKER-BRIDGE
DOCKER-CT
DOCKER-FORWARD
DOCKER-INTERNAL
DOCKER-USER
```

#### Políticas e filtros IPv6

| Chain     | Política atual | Elementos relevantes                                                                      |
| --------- | -------------- | ----------------------------------------------------------------------------------------- |
| `INPUT`   | `ACCEPT`       | Não havia filtro equivalente de entrada para SSH/web além da política aberta no snapshot. |
| `FORWARD` | `ACCEPT`       | Saltos Docker estavam presentes, mas a política padrão era aberta.                        |
| `OUTPUT`  | `ACCEPT`       | Nenhuma alteração foi feita.                                                              |

As mesmas chains Docker de compatibilidade foram observadas no IPv6. Não há
regra de publicação de container no snapshot. A política IPv6 `INPUT ACCEPT` e
`FORWARD ACCEPT` é o principal ponto de hardening do guest: ainda não é prova
de exposição pública, pois as regras Oracle não foram lidas.

#### Fail2Ban

- `fail2ban.service` está ativo.
- O jail `sshd` está carregado.
- O ruleset nft contém `inet f2b-table`, com conjunto de endereços do jail SSH
  e rejeição de TCP/22 para endereços banidos.
- A chain/tabela dinâmica do Fail2Ban não deve ser sobrescrita por um restore
  global ou por edição manual de `nftables.conf`.

#### Docker

- Docker Engine `29.7.2`, API `1.55`, arquitetura ARM64.
- O backend de firewall informado pelo daemon é `iptables`.
- Não havia containers ativos nem projetos Compose ativos.
- As chains Docker existiam, mas não havia regra de porta publicada de aplicação.
- O fato de a bridge estar sem carrier não autoriza remover chains; elas são
  administradas pelo daemon e podem mudar quando o primeiro Compose iniciar.

### 2.3. Persistência observada

A persistência efetiva não é `nftables.service`:

- `netfilter-persistent.service` está habilitado e termina com sucesso (`active
exited`), usando os plugins `15-ip4tables` e `25-ip6tables`.
- Os arquivos persistentes observados são `/etc/iptables/rules.v4` e
  `/etc/iptables/rules.v6`, com propriedade/permissões restritas.
- `/etc/default/netfilter-persistent` informa:

```text
FLUSH_ON_STOP=0
IPTABLES_TEST_RULESET=yes
IP6TABLES_TEST_RULESET=yes
IPTABLES_RESTORE_NOFLUSH=yes
IP6TABLES_RESTORE_NOFLUSH=yes
```

- `nftables.service` está desabilitado/inativo.
- `/etc/nftables.conf` existe e contém `flush ruleset`; ele não deve ser
  iniciado como caminho alternativo, pois poderia apagar tabelas dinâmicas.
- Não foi executado `netfilter-persistent save`, `reload`, `restart` ou
  qualquer operação equivalente.

A persistência é compatível com o backend `iptables-nft`, mas o conteúdo salvo
precisa ser revisado após qualquer mudança. Não se deve salvar um estado que
inclua regras efêmeras de publicação Docker sem uma decisão explícita.

### 2.4. SSH efetivo

Foram executados `sshd -t`, `sshd -T` e `sshd -T -C` com o contexto da conexão
autorizada. Os campos selecionados não mudaram entre a configuração genérica
e o contexto `Match`:

| Campo                | Resultado                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Porta/família        | `22`, `addressfamily any`, escuta IPv4/IPv6                                                   |
| Chave pública        | habilitada                                                                                    |
| Senha                | `PasswordAuthentication no`                                                                   |
| Keyboard-interactive | `KbdInteractiveAuthentication no`                                                             |
| PAM                  | `UsePAM yes`                                                                                  |
| Tentativas           | `MaxAuthTries 6`                                                                              |
| Root                 | `PermitRootLogin without-password` — acesso por chave ainda é permitido por esta configuração |
| X11                  | `X11Forwarding yes`                                                                           |
| `Match`              | Nenhuma diferença nos campos selecionados para o contexto da conexão                          |

A política de root por chave e X11 forwarding não foram alteradas nesta tarefa;
qualquer endurecimento adicional de SSH deve ser uma decisão separada e não
pode ser misturado ao primeiro hardening de rede.

### 2.5. `rpcbind`, RPC e NFS

A leitura direta e reversa produziu:

- `rpcbind.service` e `rpcbind.socket` ativos e habilitados.
- Dependências diretas do serviço: socket, `remote-fs-pre.target` e
  `rpcbind.target`, além das unidades básicas do systemd.
- Dependências reversas observadas: cadeia de `multi-user.target`/`graphical.target`;
  não apareceu uma aplicação ou serviço NFS consumidor direto.
- `rpcbind.socket` é requerido pelo serviço e é requerido por `sockets.target`;
  não deve ser tratado separadamente.
- `rpcinfo` IPv4 e IPv6 retornou somente o programa `portmapper` em TCP/UDP
  111; não foram registrados programas NFS adicionais.
- `findmnt -t nfs,nfs4` e a consulta corrigida de `/proc/mounts` não retornaram
  montagens NFS.
- `nfs-server.service` não está instalado; `nfs-utils`, `rpc-gssd` e
  `rpc-svcgssd` estão inativos; `rpc-statd-notify` aparece como `active exited`.

Conclusão operacional: **nenhum consumidor NFS/RPC ativo foi observado**, mas
isso não prova que a remoção seja necessária ou segura para todos os usos
futuros. Nesta tarefa, `rpcbind` permanece ativo e inalterado. A evidência
permite preparar uma tarefa futura separada para desativar serviço **e** socket,
com rollback e autorização própria, depois de confirmar a camada Oracle e a
necessidade operacional. Até lá, a política de entrada proposta deve negar
alcance público a TCP/UDP 111 sem desligar o serviço.

## 3. Oracle Cloud e recuperação — pendentes

| Evidência Oracle                               | Estado         | Motivo                                                                 |
| ---------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| Shape, região e capacidade configurada         | Não verificado | Painel/API não ficou acessível.                                        |
| Boot volume e volumes anexados                 | Não verificado | Painel/API não ficou acessível.                                        |
| VNIC, subnet, IP público/privado e route table | Não verificado | Painel/API não ficou acessível.                                        |
| Internet Gateway e conectividade pública       | Não verificado | Não há teste externo autorizado nesta rodada.                          |
| Security Lists                                 | Não verificado | Sem leitura do painel/API.                                             |
| NSGs                                           | Não verificado | Sem leitura do painel/API.                                             |
| Ingress/egress IPv4 e IPv6                     | Não verificado | Sem leitura do painel/API.                                             |
| Stateful/stateless                             | Não verificado | Sem leitura do painel/API.                                             |
| Políticas adicionais                           | Não verificado | Sem leitura do painel/API.                                             |
| Console/caminho de recuperação SSH             | Não verificado | Nenhum console foi iniciado e os pré-requisitos não foram confirmados. |

A janela Oracle acessível ao Hermes não produziu conteúdo após a tentativa de
navegação; o carregamento expirou. Se for necessário continuar, o proprietário
deve fazer login e MFA no navegador Oracle Cloud que esteja efetivamente
acessível ao Hermes. Não devem ser enviados senha, token, cookie ou conteúdo de
sessão. Não serão criados recursos, chaves, credenciais ou conexões de console
nesta tarefa.

Security Lists e NSGs precisam ser avaliados em conjunto: um NSG restritivo não
neutraliza uma Security List permissiva em todas as combinações. A regra
convidada local e um listener também não provam exposição pública.

## 4. Proposta concreta compatível com o host observado

### 4.1. Decisões de backend e escopo

A proposta usa **somente `iptables`/`ip6tables` sobre o backend `nf_tables`**
e a persistência já instalada pelo `netfilter-persistent`. Ela não usa UFW,
não inicia `nftables.service`, não edita `/etc/nftables.conf` e não usa
`iptables-restore`/`ip6tables-restore` para substituir o ruleset inteiro.

A primeira mudança futura deve ser incremental e tocar apenas:

- política das chains base `INPUT`/`FORWARD` quando explicitamente autorizada;
- uma chain própria `STAKEFRAME_M003_R1` em cada família, se necessária;
- um salto da chain base para a chain própria;
- regras explicitamente identificadas pela tarefa.

Não deve tocar `DOCKER*`, `DOCKER-USER`, `DOCKER-FORWARD`, chains nft do
Fail2Ban, `inet f2b-table`, NAT Docker ou regras de `OUTPUT` do agente Oracle.

### 4.2. Diferença entre estado atual e estado proposto

| Área                       | Atual observado                                             | Proposta para revisão do Codex                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                    | `iptables-nft`/`ip6tables-nft`, representação nftables      | Manter o backend; não misturar com um segundo gerenciador.                                                                                                       |
| Persistência               | `netfilter-persistent`, arquivos v4/v6, restore `--noflush` | Manter o serviço e revisar o diff salvo; não executar `save` com Docker dinâmico sem inspeção.                                                                   |
| IPv4 `INPUT`               | Política `ACCEPT`, regras explícitas e rejeição final       | Preservar as regras existentes na primeira janela; opcionalmente mudar somente a política para `DROP` após validar a ordem. Nenhuma regra SSH deve ser removida. |
| IPv4 `FORWARD`             | `DROP` com saltos Docker                                    | Manter `DROP` e os saltos Docker; não editar chains administradas pelo daemon.                                                                                   |
| IPv4 `OUTPUT`              | `ACCEPT` com tratamento `InstanceServices`                  | Manter; não bloquear DNS/NTP/APIs/agentes sem análise de egress.                                                                                                 |
| IPv6 `INPUT`               | `ACCEPT` sem filtro equivalente                             | Preparar chain própria com loopback, `ESTABLISHED,RELATED`, ICMPv6 aplicável e SSH; mudar política para `DROP` somente após validação.                           |
| IPv6 `FORWARD`             | `ACCEPT` com saltos Docker                                  | Mudar política para `DROP` somente após confirmar que os saltos Docker continuam antes da política e que não há necessidade de forwarding externo.               |
| TCP 22                     | Listener IPv4/IPv6 e regra IPv4 observados                  | Preservar durante toda a primeira mudança; não restringir ao IP momentâneo.                                                                                      |
| TCP 80/443                 | Sem listener; accept IPv4 existente; OCI desconhecida       | Não publicar via OCI nem declarar disponibilidade agora. Liberar guest e OCI somente em mudança posterior com proxy/listener autorizado.                         |
| TCP/UDP 111                | `rpcbind` escuta nas duas famílias                          | Negar ingresso público nas duas camadas; manter serviço até tarefa separada de remoção/restrição.                                                                |
| PostgreSQL/Redis/OmniRoute | Sem listeners atuais                                        | Não publicar; manter em rede interna/loopback quando implantados.                                                                                                |
| Docker/Fail2Ban            | Chains e proteção SSH dinâmicas ativas                      | Preservar; rollback não pode fazer flush nem restaurar essas chains indiscriminadamente.                                                                         |

A decisão recomendada para a primeira aplicação de hardening é: fechar a
política IPv6 de entrada/encaminhamento com regras explícitas e preservar o
estado IPv4 funcional, em vez de combinar hardening, publicação de aplicação,
remoção de `rpcbind` e alteração OCI em uma única janela. A política IPv4
`INPUT DROP` pode ser adotada na mesma janela somente se a revisão confirmar
que a rejeição final atual e todos os accepts necessários continuam presentes.

### 4.3. Forma parametrizada das regras futuras

O bloco abaixo é um modelo host-specific para revisão, não foi executado e não
é um instalador genérico. Os comandos devem ser preenchidos a partir do
snapshot da janela e executados somente após autorização.

```bash
# Variáveis apenas conceituais; não preencher com valores publicados.
CHAIN='STAKEFRAME_M003_R1'

# Criar a chain somente se não existir e inserir um único salto na frente.
iptables  -n -L "$CHAIN" >/dev/null 2>&1 || iptables  -N "$CHAIN"
ip6tables -n -L "$CHAIN" >/dev/null 2>&1 || ip6tables -N "$CHAIN"
iptables  -C INPUT -j "$CHAIN" >/dev/null 2>&1 || iptables  -I INPUT 1 -j "$CHAIN"
ip6tables -C INPUT -j "$CHAIN" >/dev/null 2>&1 || ip6tables -I INPUT 1 -j "$CHAIN"

# Regras mínimas da chain própria; cada regra real deve ser idempotente.
iptables  -C "$CHAIN" -i lo -j ACCEPT 2>/dev/null || iptables  -A "$CHAIN" -i lo -j ACCEPT
iptables  -C "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -C "$CHAIN" -i lo -j ACCEPT 2>/dev/null || ip6tables -A "$CHAIN" -i lo -j ACCEPT
ip6tables -C "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
  ip6tables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -C "$CHAIN" -p ipv6-icmp -j ACCEPT 2>/dev/null || \
  ip6tables -A "$CHAIN" -p ipv6-icmp -j ACCEPT

# SSH deve ser inserido antes da mudança de política IPv6.
iptables  -C "$CHAIN" -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || \
  iptables -A "$CHAIN" -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT
ip6tables -C "$CHAIN" -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || \
  ip6tables -A "$CHAIN" -p tcp --dport 22 -m conntrack --ctstate NEW -j ACCEPT

# A chain própria sempre devolve o restante ao fluxo original.
iptables  -C "$CHAIN" -j RETURN 2>/dev/null || iptables  -A "$CHAIN" -j RETURN
ip6tables -C "$CHAIN" -j RETURN 2>/dev/null || ip6tables -A "$CHAIN" -j RETURN

# Só depois de uma segunda sessão SSH e dos probes, se autorizado:
# iptables  -P INPUT DROP       # mudança opcional da política IPv4
# ip6tables -P INPUT DROP
# ip6tables -P FORWARD DROP

# 80/443 não entram neste hardening enquanto não houver proxy/listener aprovado.
# A futura publicação deverá adicionar regras v4/v6 e OCI em mudança separada.
```

O uso de uma chain própria torna o rollback delimitado. Mesmo assim, a revisão
deve confirmar que a versão instalada aceita exatamente os módulos e sintaxe
usados, que a regra SSH original não foi sombreada e que a chain está antes de
qualquer rejeição final.

### 4.4. Publicação futura de HTTP/HTTPS

Quando houver um proxy/listener autorizado:

1. Confirmar bind do processo em TCP 80/443 localmente.
2. Adicionar as regras de guest IPv4 e IPv6 na chain aprovada, mantendo
   `ESTABLISHED,RELATED`, loopback e ICMP/ICMPv6.
3. Reconciliar as mesmas portas na Security List e em todos os NSGs associados.
4. Não abrir 5432, 6379, 111 ou portas administrativas do OmniRoute.
5. Testar de origem externa autorizada e registrar resposta real.
6. Persistir somente depois de revisar o diff e confirmar que não foram incluídas
   regras efêmeras Docker/Fail2Ban.

Nenhum desses passos foi executado nesta PR.

## 5. Runbook futuro de captura, rollback e persistência

Os comandos desta seção são preparação documental. Nenhum timer será armado
nesta rodada.

### 5.1. Captura antes da alteração

A captura precisa existir em dois lugares: cópia privada fora da VPS e cópia
privada no próprio servidor antes de qualquer alteração. A cópia no servidor é
necessária para que o rollback temporizado não dependa da conexão SSH depois da
mudança.

```bash
umask 077
RUN_ID='<UTC_RUN_ID>'
LOCAL_SNAPSHOT='<PRIVATE_LOCAL_SNAPSHOT_DIR>/stakeframe-m0-03-'"$RUN_ID"
mkdir -p "$LOCAL_SNAPSHOT"

# Executar com os parâmetros privados já confirmados; não publicar os valores.
ssh <PRIVATE_SSH_OPTIONS> <PRIVATE_SSH_TARGET> 'sudo -n iptables-save -c' \
  > "$LOCAL_SNAPSHOT/iptables.v4.before"
ssh <PRIVATE_SSH_OPTIONS> <PRIVATE_SSH_TARGET> 'sudo -n ip6tables-save -c' \
  > "$LOCAL_SNAPSHOT/ip6tables.v6.before"
ssh <PRIVATE_SSH_OPTIONS> <PRIVATE_SSH_TARGET> 'sudo -n nft -a list ruleset' \
  > "$LOCAL_SNAPSHOT/nft.before"
ssh <PRIVATE_SSH_OPTIONS> <PRIVATE_SSH_TARGET> 'sudo -n sha256sum /etc/iptables/rules.v4 /etc/iptables/rules.v6' \
  > "$LOCAL_SNAPSHOT/persistent-sha256.before"
sha256sum "$LOCAL_SNAPSHOT"/* > "$LOCAL_SNAPSHOT/SHA256SUMS"
```

No host, antes da aplicação, o operador deve criar uma área root-only com:

```text
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/iptables.v4.before
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/ip6tables.v6.before
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/rules.v4.before
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/rules.v6.before
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/rollback.sh
<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/SHA256SUMS
```

A cópia de `rules.v4`/`.v6` é para rollback da **configuração persistente**;
não deve ser usada automaticamente para fazer restore do estado ativo, porque
o arquivo pode conter chains administradas dinamicamente pelo Docker.

### 5.2. Script de rollback ativo

O script deve ser criado no servidor, tornar-se root-owned e ser testado apenas
por validação sintática/leitura antes da janela. Ele remove somente a chain e o
salto identificados por esta tarefa e reverte somente as políticas que a tarefa
alterar. Não deve usar `iptables-restore`, `ip6tables-restore`, `nft flush
ruleset` ou apagar chains Docker/Fail2Ban.

Modelo da parte ativa, ajustado ao delta efetivamente aprovado:

```bash
#!/bin/sh
set -eu
CHAIN='STAKEFRAME_M003_R1'

remove_jump() {
  tool="$1"
  family="$2"
  while "$tool" -C INPUT -j "$CHAIN" >/dev/null 2>&1; do
    "$tool" -D INPUT -j "$CHAIN"
  done
  if "$tool" -n -L "$CHAIN" >/dev/null 2>&1; then
    "$tool" -F "$CHAIN"
    "$tool" -X "$CHAIN"
  fi
  printf '%s active chain removed\n' "$family"
}

remove_jump iptables ipv4
remove_jump ip6tables ipv6

# Executar somente se a janela tiver alterado estas políticas.
# iptables  -P INPUT ACCEPT
# ip6tables -P INPUT ACCEPT
# ip6tables -P FORWARD ACCEPT

# Não tocar: DOCKER*, DOCKER-USER, DOCKER-FORWARD, inet f2b-table, NAT Docker.
```

As linhas de política ficam comentadas até o snapshot registrar quais políticas
foram realmente alteradas. O script definitivo precisa conter somente as
inversões da tarefa autorizada, com hash registrado, e não pode restaurar
indiscriminadamente o snapshot inteiro.

### 5.3. Unidades `.service` e `.timer`

O rollback temporizado deve ser uma unidade explícita. `systemctl stop` no timer
não cancela um serviço que já tenha sido disparado; os dois estados precisam ser
verificados separadamente.

Arquivo futuro:
`/etc/systemd/system/stakeframe-m0-03-rollback-<RUN_ID>.service`

```ini
[Unit]
Description=Rollback delimitado da alteração de rede STK-M0-03

[Service]
Type=oneshot
User=root
ExecStart=/root/<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/rollback.sh
NoNewPrivileges=no
```

Arquivo futuro:
`/etc/systemd/system/stakeframe-m0-03-rollback-<RUN_ID>.timer`

```ini
[Unit]
Description=Janela temporizada de rollback STK-M0-03

[Timer]
OnActiveSec=10min
AccuracySec=1s
Persistent=false
Unit=stakeframe-m0-03-rollback-<RUN_ID>.service

[Install]
WantedBy=timers.target
```

Sequência futura, somente após autorização da janela:

```bash
sudo install -o root -g root -m 0700 <rollback.sh> \
  /root/<PRIVATE_SERVER_ROLLBACK_DIR>/<RUN_ID>/rollback.sh
sudo install -o root -g root -m 0644 <service> \
  /etc/systemd/system/stakeframe-m0-03-rollback-<RUN_ID>.service
sudo install -o root -g root -m 0644 <timer> \
  /etc/systemd/system/stakeframe-m0-03-rollback-<RUN_ID>.timer
sudo systemctl daemon-reload
sudo systemctl start stakeframe-m0-03-rollback-<RUN_ID>.timer
sudo systemctl show stakeframe-m0-03-rollback-<RUN_ID>.timer \
  -p Id -p ActiveState -p SubState -p NextElapseUSecRealtime
```

A unidade não deve ser habilitada para boot; `start` arma somente a janela
transitória. Antes da alteração, deve-se confirmar `ActiveState=active` do timer
e uma próxima execução futura.

Depois de validar a sessão original, a segunda sessão SSH, listeners, rotas,
DNS/NTP, Docker, Fail2Ban e a leitura Oracle, cancelar assim:

```bash
sudo systemctl stop stakeframe-m0-03-rollback-<RUN_ID>.timer

# Parar o service somente se ele estiver em execução; parar o timer não basta.
if [ "$(sudo systemctl show -p ActiveState --value \
  stakeframe-m0-03-rollback-<RUN_ID>.service)" = active ]; then
  sudo systemctl stop stakeframe-m0-03-rollback-<RUN_ID>.service
fi

sudo systemctl show stakeframe-m0-03-rollback-<RUN_ID>.timer \
  -p ActiveState -p SubState -p NextElapseUSecRealtime
sudo systemctl show stakeframe-m0-03-rollback-<RUN_ID>.service \
  -p ActiveState -p SubState
```

O sucesso só pode ser declarado quando o timer estiver inativo, o service não
estiver em execução e não houver uma execução futura agendada. `reset-failed`,
remoção das unidades e limpeza dos artefatos ficam para depois da conferência
privada dos hashes.

### 5.4. Rollback ativo versus rollback persistente

São operações separadas:

- **Ativo:** executar apenas as inversões das regras/políticas desta tarefa,
  preservando Docker, Fail2Ban, NAT e chains dinâmicas.
- **Persistente:** restaurar os arquivos privados `rules.v4`/`.v6` anteriores
  no caminho correto, conferir proprietário/permissão/hash e somente depois
  decidir se uma recarga controlada é necessária.
- **Não fazer:** carregar o snapshot completo durante o rollback ativo, usar
  `nft flush ruleset`, iniciar `nftables.service` ou recarregar o serviço de
  persistência sem avaliar o impacto nas chains dinâmicas.

Se uma recarga persistente for necessária, ela deve ser uma etapa manual,
separada, autorizada e precedida de nova leitura de Docker/Fail2Ban. A cópia
fora da VPS continua sendo a proteção contra perda simultânea do host e do
servidor.

### 5.5. Persistência após a aplicação

Depois de a política ativa ser validada:

1. revisar o diff dos arquivos `/etc/iptables/rules.v4` e `.v6`;
2. confirmar que não há publicação não autorizada nem mudança em chains Docker;
3. confirmar que o Fail2Ban continua carregado em sua tabela própria;
4. usar o mecanismo já instalado (`netfilter-persistent`), sem instalar UFW;
5. reler os arquivos e comparar hashes/estado ativo;
6. não reiniciar nesta tarefa; um teste pós-reboot exige autorização separada.

O fato de `IPTABLES_RESTORE_NOFLUSH=yes` reduzir o risco de apagar chains durante
uma carga não transforma qualquer arquivo salvo em seguro. O conteúdo salvo
continua sujeito a revisão e ordem de inicialização.

## 6. Critérios de aceite para uma futura aplicação

- [ ] Shape, VNIC, subnet, route table, Security Lists, NSGs e IPv4/IPv6 Oracle
      reconciliados.
- [ ] Caminho de recuperação SSH identificado, acessível e testado sem criar
      recursos nesta tarefa.
- [x] Usuário SSH confirmado em fonte autorizada; não publicado.
- [x] Backend convidado e persistência identificados.
- [x] IPv4/IPv6, NAT, Docker, Fail2Ban, rotas, DNS/NTP e SSH coletados.
- [x] Dependências de `rpcbind`/RPC/NFS consultadas; nenhum consumidor ativo foi
      observado.
- [ ] Segunda conexão SSH independente validada antes da aplicação.
- [ ] Regras exatas da janela aprovadas pelo Codex.
- [ ] Snapshot local e cópia server-side criados, com hashes conferidos.
- [ ] Script de rollback root-only disponível no servidor antes da mudança.
- [ ] `.service` e `.timer` instalados, timer armado e próxima execução conferida.
- [ ] Loopback, estabelecidas, ICMP/ICMPv6 aplicável, DNS, NTP e egress
      preservados.
- [ ] TCP/22 preservado durante toda a janela.
- [ ] TCP/80/443 liberado somente com listener/proxy e regras Oracle aprovados.
- [ ] TCP/UDP/111 sem ingresso público; decisão de remoção de `rpcbind` separada.
- [ ] PostgreSQL, Redis e OmniRoute sem publicação direta.
- [ ] Rollback ativo e persistente verificados separadamente.
- [ ] Timer parado e service confirmado inativo somente após todos os probes.
- [ ] PR revisada pelo Codex; sem merge, deploy ou aplicação implícita.

## 7. Limites desta PR

Esta PR contém documentação de análise e preparação. Não contém credenciais,
endpoints privados, regras aplicadas, instalador genérico, timer armado ou
arquivo de configuração pronto para carregamento automático.

Não houve alteração na VPS ou na Oracle, nem instalação/remoção de pacote,
reinício, mudança de firewall/SSH, alteração de container/volume, criação de
recurso, compra, deploy, release ou migração.
