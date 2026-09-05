# Inventário da infraestrutura e prontidão dos acessos

> **Estado:** inventário remoto de STK-M0-02 concluído em modo somente leitura;
> a VPS foi acessada com host key estrita e os resultados estão registrados
> abaixo. A shape no painel Oracle ainda não foi confirmada. Este documento não
> autoriza provisionamento, instalação ou alteração remota.

## 1. Escopo e data da observação

A observação foi realizada em **2026-09-05**, com relógio local observado em
13:53:10 no fuso `-03:00` (16:53:10 UTC). A consulta do domínio ocorreu na
mesma data antes do acesso remoto.

O objetivo desta rodada foi separar fatos informados pelo proprietário,
fatos observados localmente e fatos confirmados em fontes externas. Nenhuma
credencial, sessão, chave privada, IP administrativo ou identificador de conta
é publicado aqui.

### Classificação dos fatos

| Classificação                   | Resultado                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Informado pelo proprietário     | Existe uma VPS Oracle Always Free com 2 CPU, 12 GB de RAM e 50 GB de armazenamento total.                                                                                                                                                                                                         |
| Observado localmente            | Existe um par de chave SSH no perfil privado local; a chave pública correspondente passou por validação de formato. `~/.ssh/config` não existe, não há configuração OCI local e o OCI CLI não foi encontrado.                                                                                     |
| Observado na VPS                | Ubuntu 24.04.4 LTS, kernel Linux 6.17.0-1020-oracle, máquina `aarch64`, 2 CPUs lógicas, 11 GiB de memória exibidos pelo `free`, 2 GiB de swap, disco raiz de 48 GiB com 43 GiB livres, Docker 29.7.2/Compose 5.5.0, zero containers, TCP 22, TCP/UDP 111 e DNS de loopback em escuta, sem UDP 22. |
| Confirmado no painel/API Oracle | Nada. A shape, volumes, rede e regras de ingresso do painel Oracle não foram consultados.                                                                                                                                                                                                         |

A capacidade informada de 50 GB foi confirmada pelo disco `sda` observado, mas
a capacidade livre é a medida operacional relevante: a raiz tinha 43 GB livres
e 2% dos inodes usados no momento da coleta. A arquitetura observada é ARM64;
isso não permite inferir a shape Oracle.

## 2. Acesso à VPS

### Evidência local e validação da sessão

- A chave privada local existe, mas seu conteúdo não foi lido, copiado ou
  impresso.
- A chave pública correspondente foi aceita pelo `ssh-keygen`, sem registrar o
  fingerprint no repositório.
- Há um arquivo `known_hosts`. Depois que o proprietário identificou o destino,
  os três tipos de chave apresentados pelo host coincidiram com as entradas
  conhecidas; não houve divergência de fingerprint.
- Não há `~/.ssh/config` associando host, usuário e chave.
- Não há `~/.oci/config` nem o executável `oci` disponível.
- A conexão foi feita com `BatchMode`, `IdentitiesOnly` e
  `StrictHostKeyChecking=yes`; o caminho da chave e os identificadores do
  destino permanecem fora deste documento.
- A sonda SSH e o coletor remoto terminaram com sucesso, sem criar arquivos
  persistentes no servidor.

O usuário de acesso observado pertence aos grupos administrativos e do Docker;
um teste não interativo de `sudo -n id -u` retornou UID 0. Nenhuma permissão,
usuário, chave ou configuração foi alterada.

Os identificadores administrativos são deliberadamente representados apenas por
placeholders neste repositório público:

```text
VPS_HOST_OR_IP=<endereco-publico-ou-hostname>
SSH_USER=<usuario-ssh>
SSH_KEY_PATH=<caminho-local-da-chave-privada>
ORACLE_TENANCY_ID=<identificador-da-tenancy>
```

## 3. Inventário remoto observado

A coleta foi executada em 2026-09-05 às 16:53:10 UTC, com SSH em modo
não interativo e host key estrita. As saídas abaixo foram selecionadas para não
ler variáveis de ambiente, argumentos de processos, logs completos ou conteúdo
de dados.

| Item                                         | Resultado observado                                                                                                                                                                                                                                                               | Interpretação e limitação                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribuição e versão do sistema operacional | Ubuntu 24.04.4 LTS (`ID=ubuntu`, `VERSION_ID=24.04`); kernel `6.17.0-1020-oracle`.                                                                                                                                                                                                | Sistema observado na VPS; nenhuma atualização foi executada.                                                                                                                                                           |
| Arquitetura, CPU e shape                     | `aarch64`/ARM64; 2 CPUs lógicas, 2 cores, 1 socket e 1 nó NUMA.                                                                                                                                                                                                                   | A contagem de CPU e a arquitetura foram observadas. A shape Oracle não foi confirmada no painel/API e não é inferida.                                                                                                  |
| Memória e swap                               | `free -h`: total 11 GiB, usado 590 MiB, livre 9,1 GiB, disponível 11 GiB. Swap de 2,0 GiB, usado 0 B. O Docker reportou `MemTotal=12506689536` bytes.                                                                                                                             | A leitura é um retrato do momento da observação; não é benchmark nem garantia de carga futura.                                                                                                                         |
| Discos, partições e volumes                  | `sda` com 50 GB; `sda1` com 49 GB em `/`; `sda16` com 891 MiB em `/boot`; `sda15` com 98 MiB em `/boot/efi`.                                                                                                                                                                      | Não foi identificado volume adicional dedicado ao projeto.                                                                                                                                                             |
| Espaço e inodes                              | `/`: 48 GB, 4,5 GB usados, 43 GB disponíveis, 10%. Inodes da raiz: 6,2 milhões, 84 mil usados, 2%. `/boot` e EFI também tinham folga.                                                                                                                                             | A margem atual não inclui PostgreSQL, anexos, backups ou imagens futuras.                                                                                                                                              |
| Horário e sincronização                      | Fuso `Etc/UTC`; `NTP=yes`; `NTPSynchronized=yes`.                                                                                                                                                                                                                                 | Nenhum relógio foi ajustado.                                                                                                                                                                                           |
| Docker e Compose                             | Docker Engine/cliente `29.7.2`, API `1.55`; Docker Compose `v5.5.0`; daemon ativo e disponível.                                                                                                                                                                                   | A arquitetura reportada pelo daemon também foi `aarch64`; nenhum pacote foi instalado ou atualizado.                                                                                                                   |
| Containers, projetos e volumes               | `docker compose ls` sem projetos; `docker ps -a` sem containers. `docker system df`: 1 imagem, 0 containers, 0 volumes e 0 build cache. A única imagem listada era `hello-world:latest`.                                                                                          | Não há aplicação Stakeframe/OmniRoute em execução nem conflito de container observado.                                                                                                                                 |
| Serviços existentes                          | Ativos: `docker`/`containerd`, SSH, Fail2Ban, agente de monitoramento unificado da Oracle/Fluentd, `systemd-resolved`, `systemd-timesyncd`, `rpcbind`, `iscsid`, `unattended-upgrades`, `fwupd` e serviços básicos do sistema.                                                    | Não foi identificada unidade ativa de Caddy, Nginx, PostgreSQL, Redis, Stakeframe ou OmniRoute. A lista é de serviços ativos, não uma auditoria de todas as unidades instaladas.                                       |
| Portas em escuta                             | TCP 22 em IPv4/IPv6 (`sshd`); TCP e UDP 111 em IPv4/IPv6 (`rpcbind`); nenhum listener UDP 22; DNS somente em `127.0.0.53`/`127.0.0.54`.                                                                                                                                           | `rpcbind` é um serviço em escuta em todas as interfaces; sua necessidade e alcançabilidade externa precisam ser avaliadas. Não houve teste externo, as regras OCI não foram consultadas e 111 não conflita com 80/443. |
| 80/443                                       | Nenhum processo escutando em TCP 80 ou 443 na coleta.                                                                                                                                                                                                                             | As regras locais permitem novas conexões TCP em 80/443; o ingresso na rede Oracle não foi confirmado. Isso não equivale a HTTPS funcionando.                                                                           |
| Firewall                                     | UFW não está instalado, portanto a consulta `ufw status verbose` não estava disponível. A coleta utilizou `iptables`: políticas `INPUT ACCEPT`, `FORWARD DROP`, `OUTPUT ACCEPT`, com accepts explícitos para novas conexões TCP em 22, 80 e 443; `nftables` também está presente. | A saída foi filtrada; `INPUT ACCEPT` isoladamente não descreve todo o comportamento das regras. É necessário revisar o conjunto efetivo e o ingresso OCI antes de publicar serviços. Nenhuma regra foi alterada.       |
| Backups e monitoramento                      | Agente `unified-monitoring-agent` ativo, com coletor Fluentd. Timer `dpkg-db-backup` presente para a base de pacotes do sistema.                                                                                                                                                  | Não foi identificado backup da aplicação, PostgreSQL ou anexos entre os timers/serviços selecionados. Monitoramento externo do Stakeframe ainda não existe/verificado.                                                 |
| Permissões para futura instalação            | O usuário de acesso pertence a grupos administrativos e `docker`; `sudo -n id -u` retornou UID 0.                                                                                                                                                                                 | Há capacidade administrativa observada, mas qualquer instalação futura continua dependendo de tarefa autorizada e revisão do Codex.                                                                                    |

### Consultas executadas

A coleta remota usou consultas selecionadas equivalentes às seguintes, sem
persistência no servidor:

```bash
cat /etc/os-release
uname -sr
uname -m
nproc
lscpu -b -p=CPU,Core,Socket,Node
free -h
swapon --show
lsblk -e7 -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS
df -hT
df -ih
findmnt -rn -o TARGET,SOURCE,FSTYPE
date --iso-8601=seconds
timedatectl show -p Timezone -p NTPSynchronized -p NTP

id -Gn
sudo -n id -u
docker --version
docker compose version
docker version --format '...'
docker info --format '...'
docker compose ls
docker ps -a --format '...'
docker stats --no-stream --format '...'
docker system df
systemctl list-units --type=service --state=running --no-legend --no-pager
systemctl list-timers --all --no-legend --no-pager
ss -lntup
ufw status verbose
nft list ruleset
iptables -S
```

A consulta ao UFW não estava disponível porque o utilitário não está instalado. A
coleta do firewall utilizou os mecanismos presentes, `iptables` e `nftables`.
Nenhum pacote foi instalado para complementar a coleta.

## 4. Capacidade e conflitos conhecidos

A capacidade observada é compatível com a informação inicial do proprietário em
CPU, RAM e disco total, mas há pontos que precisam de revisão antes de qualquer
provisionamento:

- `rpcbind` é um serviço em escuta em TCP e UDP 111, em IPv4 e IPv6, em
  todas as interfaces. Sua necessidade e alcançabilidade externa precisam ser
  avaliadas. Não houve teste externo, as regras OCI não foram consultadas e a
  porta 111 não conflita com 80/443.
- Não há listener em 80/443, mas o firewall local aceita novas conexões TCP
  nessas portas. A política de ingresso da rede Oracle ainda não foi confirmada;
  isso não confirma exposição pública nem HTTPS disponível.
- A política `INPUT ACCEPT` do `iptables`, combinada com múltiplas tabelas
  `nftables`, requer uma revisão de segurança do conjunto efetivo e das regras
  do painel Oracle. Nenhuma regra foi modificada.
- A raiz tem 43 GB livres e 2% dos inodes usados, mas esse espaço terá de
  comportar banco, anexos, imagens e cópias temporárias futuras. Não foi feito
  benchmark nem estimativa de carga.
- Não existem containers ou projetos Compose ativos; portanto não há conflito
  atual com Stakeframe ou OmniRoute no daemon Docker.

Como referência **local do OmniRoute, não como inventário da VPS**, o Compose
consultado publica por padrão:

- aplicação/dashboard: `20128`;
- API: `20129`;
- WebSocket: `20132`;
- Redis opcional para acesso do host: `6379`, limitado a loopback por padrão;
- perfis opcionais: Qdrant em `6333/6334`, Bifrost em `8080` e CLIProxyAPI em
  `8317`.

Essas portas são potenciais pontos de conferência futura, não portas observadas
no servidor. O plano mestre continua sendo a fonte das decisões de arquitetura;
este inventário não escolhe portas, shape, distribuição, topologia ou serviços.

## 5. Matriz de prontidão dos acessos e integrações

| Item                      | Estado atual                                            | Já existe/verificado                                                                                                                                                                                     | Falta e dependências                                                                                                                                          | Ação pessoal necessária                                                                                                      |
| ------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Oracle/VPS                | **Inventário remoto verificado; painel pendente**       | Acesso SSH com host key estrita; Ubuntu 24.04.4 LTS, ARM64, 2 CPUs, memória/swap, armazenamento, Docker/Compose, serviços, sockets e firewall local observados.                                          | Shape, volumes/rede no painel Oracle e regras de ingresso OCI ainda não confirmados; revisar `rpcbind`, `INPUT ACCEPT` e espaço antes de provisionar.         | Nenhuma ação adicional de acesso nesta rodada; eventual login/MFA do painel, se disponibilizado, ocorre fora do repositório. |
| Domínio e DNS             | **Disponibilidade e preço verificados; não registrado** | ISAVAIL do Registro.br retornou código `0` para `stakeframe.com.br`; a página oficial informa `R$ 40,00` por 1 ano. Consulta DNS local não resolveu o nome.                                              | Compra, titularidade, servidores autoritativos e registros DNS ainda não existem/verificados nesta tarefa. Disponibilidade pode mudar antes da compra.        | Decidir se compra e executar eventual login/pagamento no Registro.br; nenhuma compra foi feita.                              |
| Cloudflare R2             | **Não verificado**                                      | Nenhuma conta, bucket ou credencial foi criada ou testada nesta tarefa.                                                                                                                                  | Conta, buckets privados separados, política de retenção, credenciais de escopo mínimo e teste de upload/download.                                             | Login/MFA e eventual contratação, se necessário; criar recursos somente com autorização posterior.                           |
| Google OAuth              | **Não verificado**                                      | Nenhum client, consent screen ou credencial foi criado/testado.                                                                                                                                          | Projeto, tela de consentimento, client restrito à identidade do proprietário, callback e segredos de ambiente.                                                | Login/MFA e configuração da identidade autorizada; não enviar credenciais ao repositório.                                    |
| Telegram                  | **Não verificado**                                      | Nenhum bot ou token foi criado/testado para o Stakeframe.                                                                                                                                                | Bot, token fora do repositório, chat/usuário permitido e teste controlado de recebimento.                                                                     | Criar o bot com o BotFather e informar somente identificadores não secretos no canal privado apropriado.                     |
| OmniRoute dedicado na VPS | **Compatibilidade base verificada; não implantado**     | Instalação local consultada: pacote `omniroute` na versão `3.8.50`. A VPS reportou `aarch64`; o manifesto oficial de `diegosouzapw/omniroute:3.8.50` publicou descritores `linux/amd64` e `linux/arm64`. | Tag/digest a fixar, consumo, limites, armazenamento, saída estruturada e provedores efetivamente disponíveis. Sessões e bancos locais não serão transferidos. | Nenhuma chamada paga foi feita; decidir provedores e limites somente após revisão do Codex.                                  |

Ter uma chave ou uma conta disponível não equivale a ter a integração testada.
Cada integração deverá ter um teste explícito, não destrutivo e com resultado
registrado.

## 6. Domínio: evidência da consulta oficial

A disponibilidade foi consultada pelo protocolo oficial ISAVAIL do Registro.br:

- servidor: `avail.registro.br`, UDP/43;
- domínio consultado: `stakeframe.com.br`;
- resposta: `ST 0`;
- significado na especificação: domínio disponível para registro;
- data da consulta: 2026-09-05;
- compra ou reserva: não realizada.

A consulta do resolvedor local não encontrou endereço para o domínio no momento
da observação. Isso não é usado como prova de disponibilidade: DNS ausente,
`NXDOMAIN` ou ausência de endereço não substitui a pesquisa de disponibilidade
do Registro.br.

A página oficial de pagamento consultada em 2026-09-05 informa o preço de
**R$ 40,00 para um ano** de registro/manutenção conforme a tabela de categorias.
Os períodos maiores possuem valores próprios na mesma tabela. O preço pode
mudar; não houve checkout.

## 7. OmniRoute: referência de instalação e arquitetura

A instalação local foi consultada somente como referência, sem alteração no
projeto antigo e sem copiar dados. O `package.json` local reporta a versão
`3.8.50`; o Compose documenta perfis `base`, `web`, `cli`, `host` e sidecars
opcionais.

A VPS reportou `aarch64`/ARM64 e a leitura somente do manifesto do registry
oficial para `diegosouzapw/omniroute:3.8.50` encontrou imagens Linux para
`amd64` e `arm64`. Portanto, a compatibilidade de plataforma base está coberta
pelo manifesto consultado; isso não valida automaticamente cada perfil,
dependência nativa, provedor, limite ou custo em produção. A imagem não foi
baixada nem executada na VPS.

Nenhuma chamada de inferência foi feita nesta tarefa. Não houve transferência de
sessões, bancos, arquivos `.env` ou credenciais do OmniRoute local.

## 8. Sequência proposta para revisão do Codex

Esta sequência é proposta de execução, não decisão arquitetural aprovada:

1. Manter host, usuário, caminho da chave e fingerprints somente no ambiente
   privado; a sessão usada nesta rodada já foi encerrada.
2. Submeter ao Codex o inventário observado e os conflitos concretos de CPU,
   RAM, disco, 80/443, porta 111, firewall, permissões e serviços existentes.
3. Se houver acesso ao painel Oracle, confirmar por leitura shape, volumes, rede
   e regras de ingresso; não instalar OCI CLI apenas para isso.
4. Após a revisão, decidir o tratamento de `rpcbind`, a política de firewall e
   as regras de ingresso antes de publicar qualquer serviço.
5. Após decisão sobre domínio, configurar DNS e HTTPS somente em tarefa
   autorizada; a disponibilidade atual não reserva o nome.
6. Provisionar R2, OAuth e Telegram com credenciais fora do repositório e testes
   de escopo mínimo, cada integração com evidência própria.
7. Escolher a imagem e o perfil do OmniRoute depois da revisão, fixando
   versão/digest e validando consumo, healthcheck e saída estruturada.
8. Só então preparar os serviços do Stakeframe, backup, monitoramento e
   recuperação, com autorizações específicas para qualquer alteração remota.

## 9. Fontes e limitações

| Fonte                                                                                                                             | Uso                                                                  | Data/limitação                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Serviço de disponibilidade do Registro.br](https://registro.br/tecnologia/provedores-de-hospedagem/disponibilidade-de-dominios/) | Endpoint oficial e transporte ISAVAIL.                               | Consultado em 2026-09-05; resposta específica registrada acima.                                                    |
| [Protocolo ISAVAIL v2](https://registro.br/tecnologia/Protocolo-ISAVAILv2.txt)                                                    | Interpretação de `ST 0`.                                             | Fonte oficial consultada em 2026-09-05.                                                                            |
| [Preço de domínio — Registro.br](https://registro.br/ajuda/pagamento-de-dominio/)                                                 | Preço oficial de R$ 40,00 por 1 ano.                                 | Consultado em 2026-09-05; não houve checkout.                                                                      |
| [Repositório oficial do OmniRoute](https://github.com/diegosouzapw/OmniRoute)                                                     | Identificação do projeto e referência de instalação.                 | Fonte pública; a cópia local observada é `3.8.50` e possui alterações não relacionadas, não reutilizadas.          |
| [Guia Docker oficial do OmniRoute](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/guides/DOCKER_GUIDE.md)               | Referência de execução por Docker/Compose.                           | Consultado em 2026-09-05; guia pode evoluir independentemente deste projeto.                                       |
| [Imagem oficial no Docker Hub](https://hub.docker.com/r/diegosouzapw/omniroute)                                                   | Manifesto da tag `3.8.50` e plataformas `linux/amd64`/`linux/arm64`. | Consulta GET ao registry; não houve pull, execução ou alteração remota.                                            |
| Ambiente local de execução                                                                                                        | Git, SSH, OCI CLI, DNS e arquivos públicos do projeto.               | Host/IP e usuário foram utilizados somente em ambiente privado; painel Oracle e shape ainda não foram confirmados. |

As limitações são deliberadas: não houve scan externo, benchmark, teste de
carga, instalação, atualização, reinício, mudança de firewall, alteração de
container/volume, criação de recurso, compra ou chamada paga de IA.
