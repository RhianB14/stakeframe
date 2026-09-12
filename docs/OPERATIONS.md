# Operação, backups e alertas

STK-M0-18 implementa a configuração operacional e os ensaios isolados. A
ativação operacional (repositório Restic e daemon de backup com retenção)
ocorreu em 07/09/2026 junto à janela do piloto — fora do escopo registrado
para aquela janela e regularizada documentalmente após a descoberta, em
08/09/2026 — e está registrada em
[M0-25-VALIDATION.md](M0-25-VALIDATION.md). O monitor externo, o ensaio mensal
agendado e a validação com anexos reais continuam sujeitos a autorização
específica. Hermes executa sob autorização específica; Codex revisa e autoriza.

## Composição e credenciais

O conjunto normal usa `compose.production.yml`, `compose.integrations.yml` e
`compose.operations.yml`, com o perfil `operations`. O target `operations` é a
quinta imagem imutável. PostgreSQL, API, worker e operações não publicam portas;
apenas Caddy recebe tráfego externo. O worker tem saída para provedores e o
serviço de operações acessa os buckets R2 pela rede de saída de backup.

O overlay de integrações habilita OpenRouter, Telegram, anexos R2 e TheSportsDB.
Tavily depende de `compose.tavily.yml` e da chave com limite de gastos conferido.
Importação automática depende de `compose.automatic-import.yml` e das políticas
privadas aprovadas pelo corpus, conforme [VALIDATION.md](VALIDATION.md). Sem esse
overlay, toda extração segue para conferência. Nenhum layout é aprovado por padrão.

Arquivos adicionais ficam no diretório privado de segredos, fora do Git:

| Arquivos                                                                 | Consumidores e escopo                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `openrouter_api_key`                                                     | Worker; chave individual, limite mensal de US$5                                     |
| `telegram_bot_token`, `telegram_owner_user_id`, `telegram_owner_chat_id` | Worker; bot e conversa privada do proprietário                                      |
| `r2_reader_access_key`, `r2_reader_secret_key`                           | API e operações; leitura apenas do bucket de anexos                                 |
| `r2_writer_access_key`, `r2_writer_secret_key`                           | Worker; leitura, escrita e exclusão apenas no bucket de anexos                      |
| `recovery_key`                                                           | Operações e recuperação; 32 bytes aleatórios em hex, cópia sob custódia fora da VPS |
| `r2_backup_access_key`, `r2_backup_secret_key`                           | Operações; leitura, escrita e exclusão apenas no bucket de backups                  |
| `r2_backup_restore_access_key`, `r2_backup_restore_secret_key`           | Ensaio mensal; leitura apenas do bucket de backups                                  |
| `monitor_token`                                                          | API e segredo do monitor externo; 32 bytes aleatórios em hex                        |
| `tavily_api_key`                                                         | Somente worker, quando autorizado                                                   |

As chaves de acesso R2 usam 32 caracteres hex e seus segredos usam 64.
Consumidores Node executam com UID 1000. O operador provisiona arquivos legíveis
por esse UID em diretório privado, sem conceder leitura a outros usuários.
Instalar ou modificar credenciais e permissões exige autorização específica.
Os escopos reais são conferidos no provedor; o checker local não prova permissões.

O arquivo privado de deployment acrescenta contas/buckets R2, digest da imagem
de operações e confirmação de retenção, seguindo
[deployment.env.example](../infra/production/deployment.env.example). Buckets de
anexos e backup devem ser distintos e privados. Não aplicar lifecycle que remova
objetos internos do Restic. A retenção é gerenciada pelo próprio repositório.

Provisionar `/var/lib/stakeframe/operations-status` com UID/GID 1000 e modo
0700 na janela autorizada. O volume operacional usa esse diretório fixo como
bind. Assim, o runner mensal registra seu resultado diretamente no host, mesmo
se o Docker estiver indisponível ou o arquivo de deployment for inválido.

`DEPLOYMENT_ID` identifica a instalação e permanece igual ao atualizar imagens;
os labels dos volumes persistentes usam essa identidade. Registrar commit e
digests da release separadamente. Conferir essa identidade antes de reutilizar
os volumes em qualquer atualização.

```bash
node scripts/deployment-check.mjs /etc/stakeframe/deployment.env --integrations --operations
```

Esse comando só renderiza e verifica a configuração. Os flags `--tavily` e
`--automatic` acrescentam os overlays correspondentes. O arquivo de política é
montado somente para leitura e não é criado quando o caminho está incorreto.

## Backup consistente e retenção

O daemon executa um ciclo no início e a cada fronteira de 30 minutos. Cada ciclo
tem limite de 25 minutos. Um advisory lock impede sobreposição; outro coordena
o backup com upload e exclusão dos anexos. Antes do snapshot, anexos expirados
são marcados para exclusão na mesma política transacional usada pela aplicação.

O dump lógico usa o snapshot exportado de uma transação repetível. As imagens
ficam em arquivos individuais, separados do dump, e seus metadados completos
ficam no pacote de recuperação. Assim, remover uma imagem histórica não exige
alterar os lançamentos financeiros. O manifesto registra contagens, saldos por
conta, exposição, papéis, permissões e checksums. A role `stakeframe_app` deve continuar sem
superusuário, criação de papéis/bancos, replicação, bypass de RLS ou memberships.
O pacote registra proprietários e ACLs de banco, schemas, relações, colunas,
rotinas e tipos; recusa grants ou privilégios padrão fora da baseline revisada.
A recuperação compara essas permissões entre origem e destino e verifica
memberships nos dois sentidos.
A consistência entre conexões usa o parâmetro `--snapshot` do
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).

O staging privado usa RAM (`tmpfs`), até 4 GiB, com dump limitado a 512 MiB e
metadados a 64 MiB por arquivo. A soma é validada antes de baixar anexos. O
serviço tem teto de 5 GiB de memória; exceder a capacidade falha e gera sinal
operacional. O alvo inventariado tem 2 OCPUs, 12 GiB de RAM e disco de 50 GB;
capacidade e espaço livre precisam ser revalidados antes da ativação e no piloto.

Restic 0.19.1 criptografa o pacote antes do envio ao prefixo `stakeframe-v1`.
Somente um backup com saída bem-sucedida recebe a marca `complete`. Ausência de
imagem, checksum incorreto ou dump incompleto impede a publicação como válido.
O repositório nunca é inicializado automaticamente pelo agendador.

Após cada ciclo, as imagens expiradas são removidas de todos os snapshots
retidos por `rewrite --forget`; `forget` mantém as cópias das últimas 48 horas,
diárias por 30 dias e pelo menos a última cópia completa. `prune --max-unused 0`
remove os blocos sem referência, inclusive bytes expirados. A retenção só recebe
estado pronto quando essas operações terminam. As janelas do Restic são
relativas ao snapshot mais recente; o monitor também acusa backup parado.
Referência: [retenção do Restic](https://restic.readthedocs.io/en/stable/060_forget.html).

Na janela autorizada, usar os três arquivos Compose citados acima em todos os
comandos. Inicializar uma vez pelo perfil `operations`, executando
`run --rm -e BACKUP_CONFIRM=initialize-encrypted-repository operations src/server.mjs init`.
Depois executar `up -d --wait operations`; a configuração normal exige
`BACKUP_CONFIRM=production-with-retention`. Essas confirmações de CLI não
substituem a autorização vinculada ao commit, digests, buckets e retenção.

## Recuperação e ensaio mensal

`compose.restore.yml` cria PostgreSQL e volumes novos, com nomes únicos, rede
privada e nenhuma porta publicada. Não se conecta ao banco de produção. A
ferramenta só restaura no host fixo `restore-postgres` e recusa um banco ocupado.
Ela confere o manifesto, recria metadados antes dos dados que os referenciam,
executa `pg_restore --exit-on-error` e verifica contagens, lançamentos, saldos,
exposição, proprietário e privilégios.

A recuperação lê o snapshot completo escolhido e os marcadores de expiração do
mais recente. Imagens vencidas pela política atual ou removidas depois do snapshot
escolhido não são reintroduzidas. As imagens válidas voltam como bytes locais;
após liberação, o worker pode enviá-las novamente ao armazenamento remoto.

Sessões, verificações e tokens Google são revogados. Importações e buscas em
estado incerto passam a falha para conferência manual; a outbox é esvaziada e
todos os subsistemas do worker ficam em quarentena. Após conferir os dados, o
backlog Telegram e a configuração, a retomada explícita usa o comando `resume`,
`RESTORE_CONFIRM=reviewed-recovery-and-telegram-backlog` e
`RECOVERY_TELEGRAM_NEXT_OFFSET` conferido. O cursor existente nunca retrocede.
Essa retomada altera dados e integrações do destino e exige autorização própria.

O runner Linux `scripts/restore-rehearsal.mjs` usa a imagem de operações por
digest e credenciais R2 de leitura. O modo sem locks evita exigir escrita no
bucket; uma poda concorrente pode interromper a leitura e o teste falha com
segurança. Conferir esse incidente e repetir após o ciclo de backup. A conta
de recuperação nunca recebe permissão de poda ou escrita para contornar a falha.

O serviço e timer em `infra/production/stakeframe-restore.*` foram instalados e
habilitados na [STK-M0-30](M0-30-VALIDATION.md). O timer está ativo para o dia 1
de cada mês às 03:26 UTC, com `Persistent=true`; a execução inicial
supervisionada passou e a próxima ocorrência observada é 01/10/2026. Node
24.20.0, checkout revisado, configuração Docker privada e arquivo de deployment
permanecem pré-requisitos para reinstalação ou recuperação do host. Qualquer
mudança ou execução adicional fora do timer exige nova janela autorizada.

O primeiro ensaio foi executado na ativação da STK-M0-30. Para uma futura
reinstalação autorizada, a execução supervisionada equivalente usa:

```bash
sudo env \
  RESTORE_REHEARSAL_CONFIRM=monthly-isolated-recovery \
  DOCKER_CONFIG=/etc/stakeframe/docker \
  /opt/stakeframe-tools/node/bin/node \
  /opt/stakeframe/scripts/restore-rehearsal.mjs \
  /etc/stakeframe/deployment.env
```

O runner cria `/run/stakeframe-restore` (0700, root:root) quando ausente e remove
apenas o runtime root que ele próprio criou nesta execução; um diretório
preexistente — inclusive o provisionado pelo `RuntimeDirectory` do systemd — é
validado e preservado.

O runner exige pelo menos 10 GiB e 20% livres no filesystem de dados do Docker
antes de iniciar. Durante o ensaio, confere o espaço a cada cinco segundos e
aborta abaixo de 5 GiB ou 10%, iniciando a limpeza dos recursos próprios. Esses
limites preservam margem para a operação normal; não substituem dimensionamento
e medição com o volume real.

O runner confere labels antes de remover apenas os recursos que criou. Guarda
relatórios privados em `/var/lib/stakeframe/restore-reports` e o resultado mais
recente em `/var/lib/stakeframe/operations-status/restore-latest.json`, por troca
atômica após conferir caminho, proprietário e permissões do diretório. Uma
falha inicial de configuração ou Docker substitui o sucesso anterior. Um teste com falha na
limpeza não conta como sucesso. RTO real depende do volume de produção, servidor
disponível e atuação do operador; o ensaio fictício não comprova o RTO real.

## Monitor externo e orçamento

`infra/monitor/worker.mjs` roda fora da VPS, com cron de cinco minutos e estado
persistente em Durable Object SQLite. A configuração versionada permanece
desabilitada. A ativação exige deployment Cloudflare e segredos privados
`MONITOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID` e
`TELEGRAM_OWNER_CHAT_ID`, conferidos com o proprietário. Não há trigger público.
O estado privado do monitor exige o mesmo bearer e informa falhas de entrega.

O Durable Object registra a trilha do cron: `fired_at` (último disparo
recebido), `started_at` (início da execução), `completed_at`/`result`
(conclusão ou falha) e `error` (categoria sanitizada: `configuration` ou a
classe do health check — `health_check`, `health_check_timeout`,
`health_check_network`, `health_check_http`, `health_check_payload` — nunca
valores privados). O `/status` autenticado expõe esses campos de forma aditiva
(`lastFiredAt`, `lastStartedAt`, `lastCompletedAt`, `lastResult`, `lastError`,
`lastHttpStatus`, `lastSignature`), preservando `lastCheckedAt`, `state` e
`delivery`. `lastHttpStatus` registra o código HTTP visto no endpoint de saúde
(nulo quando não houve resposta) e `lastSignature` expõe o conjunto sanitizado
de checks degradados (`nome:estado`, separados por vírgula, ou
`application:failed`), sem valores privados.
Leitura: `lastFiredAt` nulo indica nenhum disparo registrado desde a migração;
`lastFiredAt` posterior a `lastCompletedAt` indica disparo recebido sem
conclusão (em andamento, interrompido ou bloqueado por lease ativo);
`lastResult` `ready`/`attention` indica verificação concluída e `failed`
indica conclusão com falha do próprio check. Para comprovar uma execução
real, ler o `/status` com o bearer (procedimento privado aprovado) e conferir
o avanço de `lastFiredAt`/`lastCompletedAt` entre leituras separadas por ao
menos um ciclo de cinco minutos — sem depender dos painéis do provedor.

O endpoint HTTPS `/api/v1/operations/health` exige token próprio e retorna apenas
estados e horário. O token não autentica acesso financeiro. A leitura tem limite
total de tempo: um check interno que não responde dentro do orçamento permanece
`failed` em vez de segurar a resposta. São monitorados banco,
worker, backup, retenção, disco, filas, anexos, cota e orçamento de IA, quarentena
e ensaio mensal. Backup com cutoff de uma hora falha; teste mensal avisa aos 32
dias e falha aos 35, ou imediatamente em caso de execução/limpeza malsucedida.
Disco avisa abaixo de 5 GiB ou 15% livres e falha abaixo de 1 GiB ou 5%.

Alertas Telegram só ocorrem quando muda o conjunto de problemas ou há recuperação.
Um estado saudável inicial permanece silencioso. A tentativa de envio é gravada
antes da chamada externa; entrega incerta não é repetida automaticamente após
reinício. Isso evita mensagens duplicadas e torna necessária a conferência do
estado privado quando houver falha do próprio Telegram.

O worker consulta apenas os metadados da própria chave OpenRouter, com cache,
para conferir limite mensal conhecido de até US$5 e saldo disponível. Falha ou
configuração fora da política impede novas extrações e permite retry manual após
correção. Não há chamada paga de geração nessa verificação. Referência:
[consulta da chave atual](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).

Durable Objects SQLite estão disponíveis no plano gratuito, sujeito às cotas do
provedor. Confirmar plano, consumo e alertas na ativação; a configuração preparada
não é garantia de custo zero. Referência:
[preços e limites do Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Evidências e limites

`pnpm operations:test` testa políticas e alertas sem envio real.
`pnpm operations:rehearse` constrói a imagem e usa banco, repositório Restic e
anexos fictícios em rede isolada. Verifica backup de imagens locais/remotas,
recusa de armazenamento ausente, lock de sobreposição, exclusão histórica,
chave incorreta, restauração, quarentena, recusa de destino ocupado, permissões
indevidas e atualização do estado após falhas iniciais do runner mensal. Relatórios
sanitizados ficam em `.cache/operations-reports`. O armazenamento remoto do
ensaio é um adaptador fictício; não demonstra a permissão real do R2.

`pnpm deployment:rehearse` valida também os overlays e as fronteiras do Compose
de recuperação. `pnpm monitor:check` empacota o Worker em dry run. Os testes do
monitor cobrem disparo agendado, execução saudável, falha do health check,
entrega incerta, concorrência/lease, configuração recusada ou desabilitada,
autenticação do `/status` e migração do estado persistido. A CI executa
os ensaios em AMD64 e ARM64. Credenciais reais, emissão ACME, operação contínua,
mensagem de alerta e volume representativo são gates do piloto de produção.
