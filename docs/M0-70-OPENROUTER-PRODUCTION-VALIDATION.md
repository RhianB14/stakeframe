# STK-M0-70 — validação de produção do fix do OpenRouter

**Data:** 13/09/2026  
**Classificação:** OPERACIONAL para o caminho de extração do item reprocessado

## Escopo

Esta janela confirma que o candidato ARM64 da STK-M0-64 foi publicado e está
ativo na VPS, e que o item preservado pela STK-M0-63 foi processado novamente
uma única vez após a correção do schema estruturado. Não foram lidos segredos,
conteúdo de imagem, texto do bilhete ou respostas do provedor.

## Proveniência e publicação

- `main` no momento da verificação: `8e6a10095416bba26053d7a476211f7b38bb1c79`;
- candidato aprovado: source SHA
  `1a8eab4db54a331336baa9582e39814940ce0096`;
- artifact ARM64: `10317922336`, 553.768.597 bytes, digest
  `e5da2fd5e14d41420d8f87f461e5c50554bfcee5586219933fd760964aa1fa02`,
  não expirado na leitura (expiração `2026-09-14T12:39:26Z`);
- workflow de publicação `34759361864`: `completed/success`, com
  `PUBLICATION_FIVE_APPROVED_ARCHIVES_VERIFIED` e
  `PUBLICATION_REGISTRY_VERIFIED` para `api`, `worker`, `migrate`,
  `web-production` e `operations`;
- `verified.json` e `published.json` do workflow correspondem
  programaticamente ao `approved-arm64.json` nos cinco índices. O campo
  `productionDeployed=false` no artifact é preservado: ele descreve o
  workflow de publicação, não a etapa posterior de atualização da VPS.

## Estado da VPS (somente leitura)

Leitura em `2026-09-13T15:32:39Z`:

- `api`: `sha256:5bff2cad…`, `running/healthy`, restart `0`;
- `worker`: `sha256:192257bcc…`, `running/healthy`, restart `0`;
- `operations`: `sha256:daae7e57…`, `running/healthy`, restart `0`;
- `web-production`: `sha256:09ce7320…`, `running/healthy`, restart `0`;
- PostgreSQL `18.4-alpine`: `running/healthy`, restart `0`;
- `backup.json`: `state=ready`, cutoff `2026-09-13T15:30:02.103Z`,
  conclusão `2026-09-13T15:30:18.517Z`, retenção ativa;
- nenhum recurso Docker de restore e nenhum processo residual de backup/restore.

Probes internas sem autenticação retornaram HTTP 200 para API live/readiness,
Worker `/` (`{"status":"ready"}`), Worker `/budget` (`{"status":"ready"}`)
e Operations `/health/live`.

## Reprocessamento e integridade

Leitura sanitizada do banco após a janela:

- inbox: `1` item, estado `imported`, `attempts=2`, `error_code=null`,
  extração presente;
- attachment: `1` item remoto preservado;
- extraction request pendente: `0`;
- uso de IA acumulado: `2` requests (a tentativa original e o reprocessamento);
- nenhum item `pending`/`processing` na inbox ou na fila de extração;
- contagens financeiras: `bet=2`, `posting=13`, `journal=6`,
  `settlement=1`, `freebet=0`. A leitura registra os valores atuais sem
  atribuir causalidade a uma operação específica.

O registro confirma aceitação do resultado da extração e encerramento do item
sem erro. A conferência visual do bilhete e qualquer conteúdo privado ficaram
restritos ao procedimento do proprietário.

## Critérios e limitações

Comprovados: artifact aprovado e não expirado; publicação íntegra; cinco
digests aprovados ativos na VPS; serviços saudáveis sem restart; uma única
segunda tentativa no item (`attempts=2`); extração presente; erro limpo; filas
sem pendências; nenhum conteúdo ou segredo exposto.

O monitor externo não foi consultado nesta janela porque o bearer permanece no
procedimento privado do proprietário. O alerta de backup atrasado continua
pendente e não foi induzido. A precisão estatística com bilhetes de três casas
e a renovação automática do certificado continuam fora desta validação.

Não houve alteração de código de produção nesta janela, migração, rollback,
pausa de backup, chamada artificial ao Telegram/OpenRouter, leitura de segredo
ou operação adicional na VPS além das verificações registradas.
