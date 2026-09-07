# Importações e comprovantes privados — STK-M3-01

Upload, revisão, vínculos e retenção estão implementados. O ambiente local
permite revisar e registrar manualmente mesmo com Telegram, IA e R2 desativados.
Autoria e verificações diretas do Codex, conforme D019; esta entrega não é
implantação nem validação independente no GitHub.

## Recebimento e revisão

O site aceita PNG/JPEG de até 8 MiB, uma página e até 40 milhões de pixels.
Sharp decodifica o arquivo completo, recusando truncamento; o processo limita
a concorrência de decodificação e a fila de espera. A API confere sessão e
origem antes de analisar o corpo. O navegador guarda um envio pendente em
IndexedDB antes do POST e reutiliza imagem, legenda e chave após interrupção
ou recarga da página. O armazenamento é vinculado ao proprietário e limpo
após confirmação ou logout.
Envios de abas distintas têm espaços separados, protegidos por Web Locks.
Uma aba duplicada negocia outro espaço se o identificador herdado estiver
ocupado; a recarga recupera o espaço original após o navegador liberar o lock.
Navegadores sem Web Locks recusam o upload antes de enviá-lo. O teste de
regressão mantém dois envios incertos, recarrega ambas as abas e verifica
que cada uma recupera sua própria imagem, legenda e chave.

Uma chave de upload identifica uma solicitação; conteúdo diferente com a mesma
chave é recusado. Entradas diferentes podem compartilhar os bytes do mesmo
hash SHA-256, preservando legenda, origem, extração e situação próprias.
Limites de admissão: 2.000 entradas não encerradas e 1 GiB de imagens locais.

A legenda segue primeira linha tipster, segunda linha casa. Aliases ativos
resolvem nomes sem diferenciar caixa/acentos. Divergência entre legenda e
extração fica explícita e impede preselecionar a casa no formulário. Datas
escritas permanecem evidência: o formulário exige confirmar o instante da
aposta e mantém as datas dos eventos vazias até conferência. Origem em dinheiro
real ou freebet também exige escolha. Ausência de evento/data não inventa fatos.

Todos os layouts continuam sujeitos a revisão: ainda não existe amostra privada
representativa aprovada das três casas. O campo `automatic=false` com motivo
`LAYOUT_NOT_VALIDATED` torna essa restrição verificável. Uma única amostra de
IA da fase M0 não habilita lançamento automático.

## Integridade financeira e duplicidade

O comando de confirmação trava primeiro a versão financeira e depois a entrada
da importação. Criar aposta, registrar principal, vincular comprovante, mudar
situação, gravar auditoria e recibo de idempotência ocorre na mesma transação.
Falha em qualquer validação desfaz tudo; repetição retorna o recibo original.
Uma importação já encerrada não cria outra aposta com uma chave nova.

São candidatos: mesma imagem de um bilhete vinculado, mesma casa/referência,
ou mesma casa/valor/odd/data de realização em São Paulo. O último critério é
deliberadamente conservador e também reconhece recortes sem hash idêntico.
A confirmação consulta novamente esses candidatos com os campos corrigidos.
O proprietário pode justificar um bilhete legítimo semelhante ou vincular
uma aposta existente sem novo lançamento financeiro. Nenhum candidato é apagado.

Descartar e solicitar nova extração também exigem versões e chave idempotente.
Reprocessamento conserva a evidência anterior na auditoria e grava um pedido
na outbox da mesma transação. O worker publica esse pedido em pg-boss antes de
removê-lo, transacionalmente. Tentativas antigas não podem sobrescrever uma
tentativa posterior. Não há repetição automática de chamada paga; cotas UTC
de 60/dia e 1.500/mês incluem falhas e resultados incertos.

## Armazenamento e retenção

`integration.attachment` mantém o hash, tamanho, formato, dimensões, estado e
chave imutável `tickets/<uuid>`. O adaptador R2 usa SDK S3, HTTPS canônico,
timeout de 30 segundos e uma tentativa por operação. A intenção remota é
persistida antes do PUT. Bytes locais só são liberados depois da confirmação;
uma resposta incerta permite repetir o PUT da mesma chave sem duplicar objetos.
Leituras verificam SHA-256 e limite de tamanho.
Operações remotas são abortadas se a conexão que detém o lock for perdida.
Repetição e retenção aguardam dois minutos após a atividade remota, além do
timeout de 30 segundos, para separar a recuperação de uma solicitação incerta.

A imagem é entregue pela API após conferir a sessão em cada leitura, com
`Cache-Control: no-store` e proteção de origem. Nenhuma credencial ou URL pública
é enviada ao navegador. O vínculo aparece nos detalhes da aposta e continua
visível após a imagem expirar (D020).

O worker verifica retenção a cada minuto. Todas as referências devem estar
descartadas ou vinculadas a apostas encerradas há 30 dias. Revisão pendente,
aposta aberta, vínculo recente ou liquidação registrada tardiamente preserva
o arquivo. Auditoria e datas de criação evitam expirar imediatamente uma
liquidação retroativa. Arquivos compartilhados aguardam todas as referências.

A exclusão reivindica o arquivo sob o mesmo lock financeiro usado para reabrir
apostas, libera a transação, exclui o objeto e só então apaga os bytes locais.
Uma interrupção deixa estado recuperável `deleting`. Reabertura aguarda essa
exclusão terminar; depois de `deleted`, a correção financeira continua possível,
com a imagem identificada como indisponível. Sem credencial R2, arquivos com
qualquer tentativa de upload remoto aguardam manutenção para evitar objetos
órfãos. Nenhum histórico financeiro ou entrada de importação é excluído.

Na restauração, executar a manutenção de retenção antes de expor a aplicação;
o futuro procedimento operacional deve reaplicar esses prazos, inclusive aos
anexos recuperados de backup. A implantação e o backup contínuo permanecem
pendências operacionais de M0/M6.

## Configuração e migração

Por padrão os bytes ficam no PostgreSQL e nenhum serviço externo é acessado.
Para R2, preparar `R2_ATTACHMENTS_ENABLED=true`, `R2_ACCOUNT_ID`,
`R2_ATTACHMENTS_BUCKET`, `R2_ATTACHMENTS_ACCESS_KEY_ID_FILE` e
`R2_ATTACHMENTS_SECRET_ACCESS_KEY_FILE` na API e no worker, com arquivos privados
montados e saída HTTPS. Produção recusa segredos em valores de ambiente.
O token deve ter leitura/escrita somente no bucket privado de anexos; a
credencial de backups não serve para este adaptador. Essa credencial e os
overlays de produção ainda dependem da preparação/ativação operacional.

`0003_import_attachments` cria anexos e outbox, referencia apostas/importações
e move imagens existentes para armazenamento compartilhado por hash sem perder
legendas ou entradas. Dimensões de imagens legadas ficam desconhecidas; novas
admissões exigem decodificação. A migração preserva a coluna legada nullable,
esvaziando-a após copiar os bytes. Produção exige backup e autorização explícita
para aplicar a migração; Compose local usa o migrador habitual.

## Verificação

`pnpm local:test-db` verifica upload repetido/concorrente, arquivo inválido,
upgrade com imagens existentes, rollback financeiro, duplicidade, vínculo,
aliases, divergência, outbox, resposta atrasada, upload/exclusão incertos,
retenção compartilhada, reabertura e acesso privado. Dados são fictícios em
bancos descartáveis. `pnpm test:e2e` cobre revisão em desktop/mobile, campos
incertos vazios, vínculo e recuperação da imagem/chave após recarregar a página.
O adaptador R2 é verificado com armazenamento simulado; nenhum teste público
usa credencial real, bilhete privado ou chamada paga.

Referências técnicas: [Sharp input](https://sharp.pixelplumbing.com/api-constructor/),
[R2 com SDK S3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
