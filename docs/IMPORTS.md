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

A legenda segue primeira linha tipster, segunda linha casa e terceira linha o
tipo da aposta (`real` ou `freebet`). O legado de duas linhas continua
disponível para revisão manual e nunca autoriza importação automática;
terceiro valor ausente, desconhecido ou ambíguo falha fechado. A quarta linha
é opcional e informa a data e hora da aposta (`DD/MM/AAAA HH:mm`); ela é
obrigatória para a automação quando a imagem não traz data legível, e imagem e
contexto precisam apontar para o mesmo instante (divergência ou ambiguidade
permanece em revisão; o horário de upload nunca é usado como horário da
aposta). Aliases ativos
resolvem nomes sem diferenciar caixa/acentos. Divergência entre legenda e
extração fica explícita e impede preselecionar a casa no formulário. Datas
escritas permanecem evidência: o formulário exige confirmar o instante da
aposta e mantém as datas dos eventos vazias até conferência. O tipo informado
na legenda é a fonte de verdade financeira; a leitura visual da IA só bloqueia
quando contradiz esse contexto (`FREEBET_CONFLICT`) e `null` da IA não
contradiz contexto explícito. Sem tipo na legenda, a escolha manual de origem
real/freebet permanece. Ausência de evento/data não inventa fatos.

A data/hora do evento não pertence à extração automática desta fase:
`eventDateText` é reservado e depreciado (a importação sempre envia `null` e
ignora o valor), nunca autoriza nem bloqueia a importação e nunca é
convertido em data. Toda seleção criada automaticamente nasce pendente de
enriquecimento — `eventDate` e `eventAt` nulos e `dateStatus` `pending` — e o
enriquecimento de eventos acontece por processo posterior (docs/EVENTS.md).
Período ao vivo, minuto da partida e placar jamais são tratados como
data/hora do evento.

Nenhuma policy vem aprovada por padrão: a policy explícita (v3) nomeia as
casas homologadas e as pendentes, e ainda não existe amostra privada autorizada
para todas as casas. Nessas condições, `automatic=false` e
`LAYOUT_NOT_VALIDATED` mantêm a restrição verificável. Uma única amostra de IA
da fase M0 não habilita lançamento automático. O fluxo de habilitação e o
avaliador de amostras estão em [VALIDATION.md](VALIDATION.md).

Com uma policy explícita v3 privada aprovada e ativação explícita no worker, a
IA recebe somente o contrato neutro: ela organiza os dados entregues pelo OCR e
nunca escolhe casa ou layout. O servidor resolve a casa e o tipster pelos
aliases/catálogo ativos da organização, aplica o modelo e os formatos aprovados
pela policy e registra o digest dessa policy. A casa escolhida pelo usuário é a
autoridade — e precisa estar entre as aprovadas na policy: casa pendente ou
fora da lista permanece em revisão (`BOOKMAKER_NOT_APPROVED`); qualquer
tentativa de a IA fornecer bookmaker/layout fica em revisão. O servidor exige
moeda BRL, tipo da aposta informado na
legenda (contexto confiável, com a leitura visual apenas como detecção de
conflito), referência
(vazia é aceita quando a casa não a apresenta: nenhuma referência sintética é
gravada e a deduplicação por imagem/similaridade segue bloqueando colisões),
stake/odd e seleções válidas, nenhuma dúvida na extração e instante da aposta
interpretável pelo formato aprovado. Não reduz textos para fazê-los caber.
Datas sem ano, datas futuras e horários ambíguos/inexistentes no horário de
verão ficam em revisão. Eventos com data explícita entram como estimados;
ausências permanecem pendentes e horários não são inventados.

Os rótulos autorizados de retorno potencial vêm da política da casa (ex.:
Bet365 `Retorno Total`; Superbet `Prêmio` e `Ganho Potencial`); rótulos como
`Retorno Obtido`, `Retorno Líquido`, cashout, saldo, stake e odds nunca
preenchem o campo, e uma divergência entre OCR e modelo mantém a revisão. O
retorno potencial, quando escrito, deve conferir centavo a centavo. O tipo
informado decide a criação: dinheiro real nunca consome crédito promocional e
um conflito visual de freebet (`FREEBET_CONFLICT`) bloqueia a importação.
Freebets exigem permissão na política e exatamente um crédito disponível da
mesma casa, valor e validade; as regras desse crédito determinam a devolução do
principal.
Unidade histórica ausente e qualquer candidato a duplicata mantêm revisão.
O sistema nunca justifica duplicata nem escolhe um crédito ambíguo automaticamente.

Extração, aposta, contabilidade, vínculo, versão, recibo e auditoria da decisão
automática são gravados em uma transação, com os mesmos locks e regras da
confirmação manual. Validações recusadas preservam a extração e o motivo para
revisão; falhas inesperadas desfazem tudo e o worker registra resultado incerto,
sem repetir a chamada paga. Uma tentativa concluída ou substituída não pode
registrar outra aposta. A auditoria `import.automatic` inclui tentativa,
política/digest, motivo e vínculo; a exportação JSON já inclui essa tabela.
Não há migração adicional para esse fluxo.

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

## Fluxo definitivo Telegram/Web (STK-G0-19-R5)

A foto chega pelo Telegram com a legenda canônica (`tipster` + `casa` — nada de
tipo, data ou valor). O backend cria o rascunho idempotente com os
identificadores privados da mensagem (`telegramChatId`,
`telegramSourceMessageId`, `telegramReceivedAt`), responde de imediato com uma
mensagem temporária (recibo + protocolo sanitizado) e enfileira a extração.
Após o OCR/IA, o rascunho é persistido, a mensagem final é entregue respondendo
à foto e — somente com a entrega confirmada — a temporária é excluída. Falha
na entrega final preserva a temporária e não duplica rascunho, aposta ou
mensagem.

O retorno potencial é sempre calculado no servidor
(`potentialReturn = stake × totalOdds`, aritmética decimal exata); o valor
visual do bilhete é apenas diagnóstico de fidelidade — ausência não bloqueia e
divergência (stake/odd possivelmente incorretos) encaminha para revisão.

### Origem financeira declarada

O tipo financeiro (`real | freebet | null`) é declarado pelo usuário no Mini
App do Telegram ou no formulário de revisão web; nunca vem da legenda, da
imagem, do OCR ou da IA. Enquanto for nulo nenhuma aposta é criada e a
automação permanece em revisão (fail-closed). Freebet exige a seleção
explícita do crédito (validado por organização, casa, valor, validade e
disponibilidade); dinheiro real com crédito é contradição. A leitura visual de
freebet só pode encaminhar para revisão e nunca altera a escolha.

### Datas com semânticas separadas

`telegramReceivedAt` é o instante confiável e imutável da mensagem — nunca
sobrescrito pela data do evento nem pelo relógio do servidor. `eventAt` nasce
nulo (`eventDateStatus = pending`); a primeira mensagem exibe o instante de
recebimento como provisório e editável; ao confirmar, `eventAt` é gravado e o
status vira `confirmed`, preservando `placedAt`. Instantes são persistidos em
UTC e exibidos no fuso da organização. Toda seleção criada automaticamente
continua nascendo `eventDate=null`, `eventAt=null`, `dateStatus="pending"`.

### Fonte canônica única e outbox

O banco é a única fonte de verdade; Telegram e web são interfaces do mesmo
registro (`integration.inbox`). Toda edição valida usuário e organização,
confere versão otimista, persiste no canônico, recalcula derivados, grava
auditoria sanitizada (sem identificadores Telegram) e emite a operação
idempotente em `integration.telegram_outbox` (chave organização + importação +
versão + operação). A web nunca chama o Telegram: a sincronização acontece no
backend/worker.

Operações: `send_processing_message`, `send_result_message`,
`edit_result_message`, `delete_processing_message`, `delete_source_message`,
`delete_result_message`. Retry com backoff só em falhas transitórias; 429
respeita `retry_after`; 400/403 são permanentes sem loop; evento antigo nunca
sobrescreve versão mais nova; falha no Telegram não desfaz a edição financeira
e marca a sincronização para reconciliação; nenhum token, payload privado ou
resposta bruta aparece em logs.

### Limpeza automática ao sair de pending

Enquanto o status é `pending`, foto e resposta final permanecem no chat. Ao
mudar para qualquer outro estado (ganha, perdida, meio ganha, meio perdida,
cashout, reembolsada, anulada — por Mini App, web, comando, liquidação ou
processo administrativo), o backend enfileira a exclusão da foto, da resposta e
de eventual temporária, somente após o commit do status. Mensagem ausente é
sucesso idempotente; falha por idade/permissão não desfaz o status; mensagem
excluída nunca é editada; voltar para `pending` não recria mensagens.

### Migração 0011 e testes

`0011_telegram_sync` é aditiva e replay-safe: colunas privadas e de origem/data
no inbox, tabela `integration.telegram_outbox` com constraints de operação,
estado e versão, índices de organização/idempotência e FKs compostas. Registros
existentes ficam com origem não informada e datas pendentes — nenhum fato é
inventado. Testes: unitários (cliente Bot API moçado, `initData` assinado,
mensagem final, contrato), integração (rascunho canônico, importação
fail-closed, outbox com retry/429/permanente/versão antiga, limpeza,
isolamento entre organizações) e E2E web/Mini App — zero operação real no
Telegram e `AUTOMATIC_IMPORT_ENABLED=false`.

## Correções pós-revisão (STK-G0-19-R6)

- **Leitura do Mini App**: o GET do detalhe aceita sessão web OU
  `Telegram.WebApp.initData` validado no servidor (mesmo autorizador do PATCH);
  idade máxima de 24 h, tolerância de 2 min para relógio adiantado, recusa de
  parâmetros sensíveis duplicados e vínculo ao Telegram ID do proprietário. O
  `initData` nunca aparece em logs ou respostas.
- **Botões funcionais**: 'Editar' abre o Mini App via botão `web_app` com URL
  HTTPS validada (`TELEGRAM_MINIAPP_URL`, nunca com token/initData/segredo) e o
  UUID opaco do registro; 'Alterar Status'/'Alterar Casa' respondem pelo vínculo
  canônico (chat + id da mensagem) e re-sincronizam a mensagem; 'Excluir' exige
  confirmação explícita em dois toques, é idempotente e recusa callbacks de
  outra conversa/organização. Payloads de callback não carregam identificadores.
- **Retorno visual apenas diagnóstico**: `potentialReturn` extraído nunca
  autoriza, bloqueia ou altera importação e deixa de ser essencial na
  concordância OCR↔modelo; a base é o cálculo `stake × totalOdds`. Divergências
  aparecem em `returnFidelityMismatch` (qualidade), separadas da segurança.
- **Freebet completa no rascunho**: créditos listados já filtrados por casa
  resolvida, stake, validade, disponibilidade e política aprovada; o PATCH
  repete a validação completa sob lock; o consumo mantém a validação
  transacional (um crédito → uma importação; concorrência serializada no
  financeiro).

## Ações reais no Telegram e declaração × política (STK-G0-19-R7)

- **Botões da resposta final** — "Editar", "Alterar Status" e "Alterar Casa" são
  botões `web_app` que abrem o Mini App autenticado POR IMPORTAÇÃO na seção
  correspondente (`/miniapp#miniapp?import=<uuid>[&section=status|bookmaker|tipster]`); a URL
  base vem de `TELEGRAM_MINIAPP_URL` (HTTPS validada). Nenhum botão responde
  apenas texto: o único `callback_query` sobrevivente é a exclusão em dois
  toques.
- **Seção Alterar Status** — exibe o estado canônico da aposta e lista apenas as
  transições permitidas (ganhou/perdeu para aposta pendente), exige confirmação
  e grava pelo comando financeiro canônico (`bet.settle`) com versão otimista,
  idempotência determinística e autorização da organização; o retorno é
  calculado no servidor (`remaining × odds` no ganho, zero na perda). Ao sair de
  pendente, a limpeza do chat (foto, temporária, resultado) é enfileirada pela
  regra existente; repetir o pedido não duplica efeitos.
- **Seção Alterar Casa** — lista apenas casas ativas da organização, mostra a
  casa canônica atual e salva pelo serviço canônico do rascunho
  (`bookmaker_override_id`, migração 0012). Trocar a casa REVALIDA o crédito
  freebet associado: crédito de casa diferente, consumido ou expirado é
  removido com aviso sanitizado e a origem volta a "não informada" (nova escolha
  explícita) — nunca preservado em silêncio.
- **Declaração × policy automática** — a declaração real/freebet do usuário é
  validada SOMENTE contra o crédito da própria organização (casa efetiva, valor
  exato da stake, validade, disponibilidade) e é salva mesmo sem arquivo de
  política; o Mini App informa o estado da política automática
  (`disabled|absent|invalid|approved`). A importação AUTOMÁTICA é estritamente
  fail-closed: policy ausente/inválida/expirada ⇒ revisão
  (`LAYOUT_NOT_VALIDATED`); casa fora das aprovadas ⇒ revisão
  (`BOOKMAKER_NOT_APPROVED`); policy sem `allowFreebet` ou crédito inválido ⇒
  revisão (`FREEBET_UNRESOLVED`); `null` nunca significa autorização.
