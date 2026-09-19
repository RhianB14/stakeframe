# Spec — configuração reprodutível do deploy beta.2

## ADDED Requirements

### Requirement: Entrega da URL do Mini App pelo compose

O `compose.integrations.yml` DEVE (MUST) injetar `TELEGRAM_MINIAPP_URL` no
worker por interpolação obrigatória
`${TELEGRAM_MINIAPP_URL:?Mini App URL required}`, sem valor literal no
repositório; o worker DEVE (MUST) manter `TELEGRAM_CONFIGURATION_INVALID`
quando a variável estiver ausente ou não for uma URL HTTPS válida sem
credenciais ou query.

#### Scenario: env-file sem a variável

- **WHEN** o env-file não declarar `TELEGRAM_MINIAPP_URL`
- **THEN** o `docker compose config` falha na expressão obrigatória
- **AND** o `deployment-check --integrations` recusa com `TELEGRAM_MINIAPP_URL_REQUIRED`

#### Scenario: URL insegura

- **WHEN** `TELEGRAM_MINIAPP_URL` for HTTP, localhost, com credenciais ou query
- **THEN** o gate de deploy recusa com `TELEGRAM_MINIAPP_URL_REQUIRED`
- **AND** o worker recusa iniciar com `TELEGRAM_CONFIGURATION_INVALID`

### Requirement: Deployment-check aceita o conjunto autorizado com OCR

O `deployment-check` DEVE (MUST) aceitar `--ocr` (exigindo `--integrations`) e,
com ele, validar o overlay `compose.ocr.yml`: `AZURE_VISION_ENABLED=true`,
`GOOGLE_VISION_ENABLED=true`, `OCR_MODE=failover`,
`OCR_PRIMARY_PROVIDER=azure`, `OCR_FALLBACK_PROVIDER=google`,
`AZURE_VISION_ENDPOINT` HTTPS (não localhost), timeouts e os segredos
`azure_vision_api_key` e `google_vision_api_key` montados (`_FILE`). Sem
`--ocr`, o conjunto DEVE (MUST) continuar recusando `AZURE_VISION_ENABLED`
diferente de `false`. `--ocr` sem `--integrations` DEVE (MUST) ser recusado
com `OCR_REQUIRES_INTEGRATIONS`.

#### Scenario: OCR incompleto

- **WHEN** o render com `--ocr` não tiver um dos provedores, o modo `failover`,
  o endpoint HTTPS ou um dos segredos montados
- **THEN** o `deployment-check` recusa sem imprimir valores

#### Scenario: conjuntos autorizados completos

- **WHEN** o render incluir `--integrations` com `--ocr`, `--tavily`,
  `--automatic` e `--operations` (isolados ou combinados)
- **THEN** o `deployment-check` verifica e emite `DEPLOYMENT_CONFIGURATION_VERIFIED`

### Requirement: Falhas de configuração não expõem material sensível

As mensagens de falha de configuração (runtime e gate de deploy) DEVEM (MUST)
conter apenas códigos estáveis, nunca valores de segredo, tokens ou URLs com
credenciais; testes DEVEM (MUST) cobrir a ausência de eco.

#### Scenario: falha de configuração com material sintético

- **WHEN** um loader de configuração recusa por valor ausente, ambíguo ou inválido
- **THEN** a mensagem contém apenas o código estável (por exemplo, `TELEGRAM_CONFIGURATION_INVALID`)
- **AND** nenhum valor de segredo, token ou URL com credenciais aparece na mensagem
