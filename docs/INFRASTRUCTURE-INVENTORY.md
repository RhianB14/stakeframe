# Inventário da infraestrutura e prontidão dos acessos

> **Estado:** diagnóstico parcial de STK-M0-02. A VPS não foi acessada porque o
> destino e o usuário SSH não estão identificados no ambiente local. Este
> documento não autoriza provisionamento, instalação ou alteração remota.

## 1. Escopo e data da observação

A observação foi realizada em **2026-09-05**, com relógio local observado em
13:31:48 no fuso `-03:00` (16:31:48 UTC).

O objetivo desta rodada foi separar fatos informados pelo proprietário,
fatos observados localmente e fatos confirmados em fontes externas. Nenhuma
credencial, sessão, chave privada, IP administrativo ou identificador de conta
é publicado aqui.

### Classificação dos fatos

| Classificação                   | Resultado                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Informado pelo proprietário     | Existe uma VPS Oracle Always Free com 2 CPU, 12 GB de RAM e 50 GB de armazenamento total.                                                                                                                     |
| Observado localmente            | Existe um par de chave SSH no perfil privado local; a chave pública correspondente passou por validação de formato. `~/.ssh/config` não existe, não há configuração OCI local e o OCI CLI não foi encontrado. |
| Confirmado no painel/API Oracle | Nada. Não há acesso local ao painel/API Oracle confirmado nesta rodada.                                                                                                                                       |
| Confirmado na VPS               | Nada. Não foi feita conexão SSH.                                                                                                                                                                              |

A capacidade informada de 50 GB é capacidade total declarada, não espaço livre.
CPU, shape, arquitetura, sistema operacional e ocupação ainda não podem ser
inferidos a partir desses números.

## 2. Acesso à VPS

### Evidência local

- A chave privada local existe, mas seu conteúdo não foi lido, copiado ou
  impresso.
- A chave pública correspondente foi aceita pelo `ssh-keygen`, sem registrar o
  fingerprint no repositório.
- Há um arquivo `known_hosts`, mas seus registros não foram usados para
  identificar o destino. A existência de uma entrada não prova que ela pertence
  à VPS do projeto.
- Não há `~/.ssh/config` associando host, usuário e chave.
- Não há `~/.oci/config` nem o executável `oci` disponível.
- Nenhum comando SSH foi executado contra um destino desconhecido; portanto não
  houve validação de host key nem conflito de fingerprint a resolver.

### Informação necessária para continuar

No ambiente privado, ainda são necessários:

```text
VPS_HOST_OR_IP=<endereco-publico-ou-hostname-da-vps>
SSH_USER=<usuario-ssh-da-vps>
SSH_KEY_PATH=<caminho-local-da-chave-privada-ja-existente>
```

O proprietário deve fornecer somente o host/endereço público, o usuário SSH e
confirmar o caminho local da chave. O conteúdo da chave, tokens, sessões e
senhas não devem ser enviados.

Quando esses dados forem fornecidos, a primeira conexão deverá manter a
verificação padrão de host key. Se a chave apresentada divergir de uma entrada
conhecida, a conexão deve parar para reconciliação; não é permitido desativar a
verificação nem aceitar uma chave por conveniência.

## 3. Inventário remoto pendente

Nenhuma linha abaixo foi marcada como observada, porque a conexão ainda não foi
possível.

| Item                                         | Estado         | Evidência que falta                                                                                                                                 |
| -------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribuição e versão do sistema operacional | Não observado  | Consulta remota somente leitura a `/etc/os-release` e informações do kernel.                                                                        |
| Arquitetura, CPU e shape                     | Não observado  | `uname`, `lscpu`/`nproc` e confirmação posterior no painel Oracle, se disponível. Não inferir shape pela contagem de CPU.                           |
| Memória total, disponível e swap             | Não observado  | `free`, `swapon` e leitura selecionada de `/proc/meminfo`.                                                                                          |
| Discos, partições, volumes, espaço e inodes  | Não observado  | `lsblk`, `df -hT` e `df -ih`, sem ler arquivos de dados.                                                                                            |
| Horário, fuso e sincronização                | Não observado  | `timedatectl` ou equivalente, sem ajustar o relógio.                                                                                                |
| Docker e Compose                             | Não observado  | Versões do cliente/Compose e estado do daemon; não instalar nem atualizar.                                                                          |
| Containers e serviços                        | Não observado  | Lista selecionada de nomes, imagens, estado, consumo e portas publicadas; não usar `docker inspect` amplo, variáveis de ambiente ou logs completos. |
| Portas em escuta e firewall local            | Não observado  | `ss`/`nft`/`ufw`/unidades de firewall disponíveis, somente leitura. Não haverá scan externo.                                                        |
| Conflitos em 80/443                          | Não verificado | Portas em escuta e regras locais da VPS. Nenhuma ocupação pode ser afirmada hoje.                                                                   |
| Backups e monitoramento                      | Não observado  | Nomes/estados de serviços e tarefas, sem abrir conteúdos sensíveis nem logs completos.                                                              |
| Permissões para futura instalação            | Não observado  | Usuário efetivo e capacidade administrativa a confirmar depois do acesso; não alterar permissões.                                                   |

### Comandos previstos para a próxima observação

Após validar a identidade do destino, a coleta deve ser limitada a consultas
selecionadas equivalentes a:

```bash
cat /etc/os-release
uname -m
nproc
free -h
swapon --show
lsblk -e7 -o NAME,SIZE,FSTYPE,MOUNTPOINTS
df -hT
df -ih
timedatectl

docker version --format '{{.Client.Version}} / {{.Server.Version}}'
docker compose version
docker info --format '{{.ServerVersion}} {{.OperatingSystem}} {{.Architecture}}'
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
ss -lntup
```

A consulta de firewall deve usar somente o mecanismo já instalado e disponível.
A ausência de `sudo` ou de um comando não deve ser corrigida instalando pacote;
deve ser registrada como limitação.

## 4. Capacidade e conflitos conhecidos

Não existe conflito concreto confirmado na VPS nesta rodada. Em particular,
não é possível declarar se 80/443, armazenamento, memória, Docker ou alguma
porta administrativa já estão ocupados.

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

| Item                      | Estado atual                                            | Já existe/verificado                                                                                                                                                                | Falta e dependências                                                                                                                                                              | Ação pessoal necessária                                                                                                                              |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle/VPS                | **Parcial — acesso bloqueado**                          | Capacidade declarada pelo proprietário; chave local existente e chave pública validada.                                                                                             | Host/IP, usuário SSH, confirmação do caminho da chave, host key e inventário remoto. Shape, arquitetura e painel Oracle continuam sem confirmação.                                | Fornecer host e usuário; confirmar a chave local. Login/MFA do painel, se o proprietário quiser disponibilizar consulta, ocorre fora do repositório. |
| Domínio e DNS             | **Disponibilidade e preço verificados; não registrado** | ISAVAIL do Registro.br retornou código `0` para `stakeframe.com.br`; a página oficial informa `R$ 40,00` por 1 ano. Consulta DNS local não resolveu o nome.                         | Compra, titularidade, servidores autoritativos e registros DNS ainda não existem/verificados nesta tarefa. Disponibilidade pode mudar antes da compra.                            | Decidir se compra e executar eventual login/pagamento no Registro.br; nenhuma compra foi feita.                                                      |
| Cloudflare R2             | **Não verificado**                                      | Nenhuma conta, bucket ou credencial foi criada ou testada nesta tarefa.                                                                                                             | Conta, buckets privados separados, política de retenção, credenciais de escopo mínimo e teste de upload/download.                                                                 | Login/MFA e eventual contratação, se necessário; criar recursos somente com autorização posterior.                                                   |
| Google OAuth              | **Não verificado**                                      | Nenhum client, consent screen ou credencial foi criado/testado.                                                                                                                     | Projeto, tela de consentimento, client restrito à identidade do proprietário, callback e segredos de ambiente.                                                                    | Login/MFA e configuração da identidade autorizada; não enviar credenciais ao repositório.                                                            |
| Telegram                  | **Não verificado**                                      | Nenhum bot ou token foi criado/testado para o Stakeframe.                                                                                                                           | Bot, token fora do repositório, chat/usuário permitido e teste controlado de recebimento.                                                                                         | Criar o bot com o BotFather e informar somente identificadores não secretos no canal privado apropriado.                                             |
| OmniRoute dedicado na VPS | **Referência local; destino pendente**                  | Instalação local consultada: pacote `omniroute` na versão `3.8.50`. Manifesto oficial da imagem `diegosouzapw/omniroute:3.8.50` publicou descritores `linux/amd64` e `linux/arm64`. | Arquitetura da VPS, tag/digest a fixar, consumo, limites, armazenamento, saída estruturada e provedores efetivamente disponíveis. Sessões e bancos locais não serão transferidos. | Nenhuma chamada paga foi feita; decidir provedores e limites somente após o inventário e revisão do Codex.                                           |

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

A leitura somente do manifesto do registry oficial para
`diegosouzapw/omniroute:3.8.50` encontrou imagens Linux para `amd64` e `arm64`.
Isso confirma cobertura dessas duas arquiteturas no manifesto consultado, mas
**não confirma a arquitetura da VPS**, que ainda depende do SSH/painel Oracle.
Também não valida automaticamente cada perfil, dependência nativa, provedor,
limite ou custo em produção.

Nenhuma chamada de inferência foi feita nesta tarefa. Não houve transferência de
sessões, bancos, arquivos `.env` ou credenciais do OmniRoute local.

## 8. Sequência proposta para revisão do Codex

Esta sequência é proposta de execução, não decisão arquitetural aprovada:

1. Receber no ambiente privado o host/IP e usuário SSH; confirmar a chave sem
   revelar seu conteúdo.
2. Validar host key e executar o inventário remoto somente leitura, registrando
   valores selecionados e sanitizados.
3. Se houver acesso já configurado ao painel Oracle, confirmar por leitura shape,
   volumes, rede e regras de ingresso; não instalar OCI CLI apenas para isso.
4. Submeter ao Codex os conflitos concretos de CPU, RAM, disco, 80/443, portas,
   firewall, permissões e serviços existentes.
5. Após decisão sobre domínio, configurar DNS e HTTPS somente em tarefa
   autorizada; a disponibilidade atual não reserva o nome.
6. Provisionar R2, OAuth e Telegram com credenciais fora do repositório e testes
   de escopo mínimo, cada integração com evidência própria.
7. Escolher a imagem e o perfil do OmniRoute depois de confirmar a arquitetura,
   fixando versão/digest e validando consumo, healthcheck e saída estruturada.
8. Só então preparar os serviços do Stakeframe, backup, monitoramento e
   recuperação, com autorizações específicas para qualquer alteração remota.

## 9. Fontes e limitações

| Fonte                                                                                                                             | Uso                                                                  | Data/limitação                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Serviço de disponibilidade do Registro.br](https://registro.br/tecnologia/provedores-de-hospedagem/disponibilidade-de-dominios/) | Endpoint oficial e transporte ISAVAIL.                               | Consultado em 2026-09-05; resposta específica registrada acima.                                           |
| [Protocolo ISAVAIL v2](https://registro.br/tecnologia/Protocolo-ISAVAILv2.txt)                                                    | Interpretação de `ST 0`.                                             | Fonte oficial consultada em 2026-09-05.                                                                   |
| [Preço de domínio — Registro.br](https://registro.br/ajuda/pagamento-de-dominio/)                                                 | Preço oficial de R$ 40,00 por 1 ano.                                 | Consultado em 2026-09-05; não houve checkout.                                                             |
| [Repositório oficial do OmniRoute](https://github.com/diegosouzapw/OmniRoute)                                                     | Identificação do projeto e referência de instalação.                 | Fonte pública; a cópia local observada é `3.8.50` e possui alterações não relacionadas, não reutilizadas. |
| [Guia Docker oficial do OmniRoute](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/guides/DOCKER_GUIDE.md)               | Referência de execução por Docker/Compose.                           | Consultado em 2026-09-05; guia pode evoluir independentemente deste projeto.                              |
| [Imagem oficial no Docker Hub](https://hub.docker.com/r/diegosouzapw/omniroute)                                                   | Manifesto da tag `3.8.50` e plataformas `linux/amd64`/`linux/arm64`. | Consulta GET ao registry; não houve pull, execução ou alteração remota.                                   |
| Ambiente local de execução                                                                                                        | Git, SSH, OCI CLI, DNS e arquivos públicos do projeto.               | Host/IP, usuário, painel Oracle e todos os dados da VPS continuam indisponíveis.                          |

As limitações são deliberadas: não houve scan externo, benchmark, teste de
carga, instalação, atualização, reinício, mudança de firewall, alteração de
container/volume, criação de recurso, compra ou chamada paga de IA.
