# Primeira implantação — preparo e autorização

Este documento organiza a janela do piloto em `stakeframe.com.br`. O código de
produto e operação está implementado; a aplicação ainda não foi instalada na
VPS. Codex é autor e executor das verificações, conforme D019. Cada campo de
autorização deve ser preenchido com evidência real antes da ação correspondente.

## Inventário conferido em 07/09/2026

Inspeção somente leitura por SSH às 07:58:47 UTC, com identidade de host já
conhecida e sem gravar arquivos no servidor:

| Item                            | Resultado                                                       |
| ------------------------------- | --------------------------------------------------------------- |
| Plataforma                      | ARM64, 2 CPUs, aproximadamente 12 GiB de RAM                    |
| Docker / Compose                | 29.7.2 / 5.5.0; daemon acessível                                |
| Disco de dados Docker           | 50.884.108.288 bytes totais; 45.998.489.600 livres              |
| Aplicação instalada             | Zero containers ativos; `/opt/stakeframe` ausente               |
| Ensaio mensal                   | Timer ainda não instalado                                       |
| Acesso administrativo           | SSH e sudo sem interação disponíveis                            |
| Listeners TCP públicos no guest | 22 e 111; não havia 80/443                                      |
| DNS A                           | Havia resposta, sem apontamento direto ao IPv4 conhecido da VPS |

O resultado DNS não identifica sozinho estacionamento, proxy ou delegação.
Conferir o painel do domínio e os registros antes de propor a alteração.
O inventário não comprova acesso serial disponível na próxima janela nem as
regras OCI atuais. Revalidar capacidade, rede e recuperação no início da janela.

O run de rede antigo foi encerrado administrativamente sob autorização de
Rhian em 07/09/2026. Bundle e lacuna histórica preservados; resultado em
[M0-22-VALIDATION.md](M0-22-VALIDATION.md). A [issue #11](https://github.com/RhianB14/stakeframe/issues/11)
acompanha a nova janela IPv6, preparada em [NEXT-NETWORK-WINDOW.md](NEXT-NETWORK-WINDOW.md).
Essa janela continua dependente de autorização e console independente ativo.

Leitura DNS em 07/09/2026 às 12:09 UTC: nameservers `dns3.hostgator.com.br`
e `dns4.hostgator.com.br`, um registro A para destino diferente da VPS, nenhum
AAAA e resposta sem dados CAA. O painel disponível exigiu login; a zona ainda
precisa ser conferida antes de definir o diff DNS. Não alterar nameservers,
MX/TXT ou registros por dedução a partir dessa consulta pública.

## Registro necessário

Preparar um registro privado, fora do Git, contendo os itens abaixo. O relatório
público usa somente hashes, estados e referências sanitizadas.

| Grupo       | Identificação a conferir                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| Fonte       | SHA da main, run CI aprovado e run do candidato                                |
| Artefatos   | Manifesto ARM64, seu SHA-256 e os cinco digests OCI                            |
| Publicação  | Destinos `ghcr.io/rhianb14/stakeframe-<target>` e política de acesso           |
| Instalação  | `DEPLOYMENT_ID` estável, host conhecido e checkout `/opt/stakeframe`           |
| Rede        | DNS desejado/atual, regras OCI/guest, recuperação serial e rollback conferidos |
| Banco       | Primeiro cluster vazio, lista/hash das migrações e role `stakeframe_app`       |
| Recuperação | Bucket privado, prefixo `stakeframe-v1`, chave sob custódia externa e retenção |
| Credenciais | Identidade Google, bot/owner, limite OpenRouter e escopos R2 conferidos        |
| Monitor     | Worker Cloudflare, segredos, cron e teste de alerta ao proprietário            |
| Aceite      | Resultados HTTPS/OAuth, backup externo, restore isolado e início do piloto     |

Nenhum digest local de ensaio substitui o candidato da CI. O artefato é
preparado conforme [RELEASE-CANDIDATE.md](RELEASE-CANDIDATE.md). Registrar
autorização explícita de publicação antes de conceder escrita no registry.

## Credenciais e recursos preparados

O cliente Google de produção, a associação Telegram, a chave OpenRouter com
US$5 mensais e os buckets privados `stakeframe-attachments` e
`stakeframe-backups` foram preparados nas tarefas anteriores. Revalidar seus
metadados sem imprimir segredos. A credencial R2 temporária de ensaio tem outro
escopo/ciclo de vida e não é adotada como credencial definitiva.

As quatro credenciais R2 foram criadas e guardadas fora do Git após autorização
específica na [issue #52](https://github.com/RhianB14/stakeframe/issues/52):
leitores e escritores exclusivos de anexos e backups, sem administração de
buckets. Os 34 testes de escopo passaram; os objetos fictícios foram removidos.
A instalação das chaves na VPS continua pendente. Detalhes em [R2.md](R2.md). Gerar
segredos de banco, sessão, recuperação e monitor; manter a chave de recuperação
fora da VPS e conferir sua custódia antes do primeiro backup.

O diretório `/etc/stakeframe/secrets` é privado. O provisionamento precisa
preservar leitura pelos consumidores definidos em [OPERATIONS.md](OPERATIONS.md)
e impedir leitura por outros usuários. Provisionar também
`/var/lib/stakeframe/operations-status` com UID/GID 1000 e modo 0700, o arquivo
privado de deployment, a configuração Docker privada e o runtime Node fixado
para o runner mensal. Criar recursos, segredos e permissões requer autorização;
não faz parte da geração das imagens candidatas.

## Sequência da janela autorizada

1. Conferir SHA, CI, manifests e autorização vigente. Publicar os bytes OCI
   aprovados com os mesmos digests e verificar leitura pela VPS. Registrar
   os digests no arquivo privado de deployment.
2. Revalidar rede, identidade do host, recursos e acesso de recuperação.
   Aplicar somente as mudanças de DNS/firewall previamente discriminadas na
   autorização própria, com seu procedimento de reversão. Confirmar a segunda
   conexão administrativa e probes antes de encerrar a janela de rede.
3. Provisionar checkout, runtime, diretórios e segredos autorizados. Executar
   `deployment-check.mjs` com `--integrations --operations`. Importação
   automática e Tavily permanecem fora do primeiro piloto proposto.
4. Com `compose.production.yml`, `compose.integrations.yml` e
   `compose.operations.yml`, conferir que não existe um banco anterior.
   Subir apenas `postgres`; executar o migrador pelo perfil `migration` com
   `MIGRATION_CONFIRM=production`. A autorização deve nomear esse primeiro
   cluster vazio. Divergência interrompe a janela antes da migração.
5. Inicializar explicitamente o repositório criptografado de backup e conferir
   acesso dos leitores/escritores. Subir `api` e `web`, verificar HTTPS público,
   autenticação real, recarga, logout e recusas. Subir `worker` após conferir o
   backlog do bot e registrar os efeitos externos autorizados.
6. Ativar `operations` com retenção explicitamente autorizada; aguardar o
   primeiro ciclo completo. Executar o ensaio isolado lendo o backup externo,
   conferir finanças, imagens, ACLs, quarentena e limpeza. Preservar o relatório.
7. Instalar e iniciar o timer mensal e publicar/ativar o monitor externo.
   Conferir estado saudável, simular uma falha controlada e uma recuperação
   com envio autorizado ao proprietário; verificar deduplicação. Encerrar a
   simulação e registrar o estado normal recuperado.
8. Conferir os fluxos no computador e celular; iniciar observação do piloto
   conforme [VALIDATION.md](VALIDATION.md). Medir capacidade, custos e RPO/RTO
   reais. O aceite da `v1.0.0` ocorre após esses resultados, em autorização própria.

Usar os mesmos três arquivos Compose e os perfis explícitos em todos os passos.
Comandos-base estão em [DEPLOYMENT.md](DEPLOYMENT.md); inicialização, retenção,
ensaio mensal e monitor estão em [OPERATIONS.md](OPERATIONS.md). A confirmação
de CLI não substitui autorização. Nenhum procedimento inicia transações de aposta
em casas externas; o proprietário confere os registros financeiros no piloto.

## Interrupção e reversão

### Indisponibilidade ou retomada de instância Always Free

A Oracle pode retomar instâncias ociosas. A documentação consultada em
07/09/2026 considera uma janela de sete dias com CPU no percentil 95 abaixo
de 20%, rede abaixo de 20% e, no A1, memória abaixo de 20%. A disponibilidade
de outra instância gratuita depende da capacidade regional. Fonte:
[Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

A política do projeto é manter dados recuperáveis fora da VPS e tratar perda
do host como incidente. Conferir avisos da conta e métricas no piloto; o monitor
externo identifica indisponibilidade mesmo com o host parado. Não gerar carga
artificial nem contratar recursos automaticamente. Uma troca de host requer
autorização, conferência de custos/capacidade, identidade SSH nova validada por
canal independente, restauração em cluster novo e alteração DNS autorizada.

Preservar externamente chave de recuperação, credenciais necessárias, configuração
privada, digests publicados e procedimento. Se houver falta de capacidade,
informar o impacto no RTO e submeter alternativa ao proprietário. O RTO de quatro
horas depende também de servidor disponível e atuação do operador; não é garantido
pelo plano gratuito. Esta política está preparada; restauração após perda real do
host permanece pendente de validação operacional.

### Aplicação e dados

No primeiro deploy não existe imagem anterior da aplicação. Em falha, parar os
serviços recém-ativados afetados, preservando banco, anexos, configuração e
relatórios. Não remover volumes nem tentar migração reversa. Registrar o ponto
atingido e restaurar somente em cluster novo com autorização própria quando
necessário. Após ativar integrações, interromper o worker antes de reavaliar
efeitos incertos ou restaurar dados.

Em atualizações posteriores, guardar configuração e digests anteriores antes
de iniciar; retornar a eles somente após conferir compatibilidade do schema.
Rollback de DNS/firewall segue sua autorização específica. Falha de restore ou
limpeza impede marcar recuperação como demonstrada. A primeira liberação pública
da aplicação permanece um piloto até cumprir o aceite de `docs/PLAN.md` §5.5.
