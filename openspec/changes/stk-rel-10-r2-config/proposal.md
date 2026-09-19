# STK-REL-10-R2 — configuração reprodutível do deploy beta.2 (Mini App URL, OCR e importação automática)

## Por quê

1. O worker exige `TELEGRAM_MINIAPP_URL` em runtime
   (`TELEGRAM_CONFIGURATION_INVALID` sem ela), mas nenhum compose do
   repositório a injetava: a produção dependia de uma edição local não
   versionada do `compose.integrations.yml` (constatado no preflight
   STK-REL-10). Qualquer atualização de checkout removeria a linha e derrubaria
   o worker recriado na janela de deploy.
2. O `deployment-check` recusava a configuração autorizada com OCR ativo: o
   `assertDeploymentConfig` exigia `AZURE_VISION_ENABLED=false` incondicional e
   não conhecia o overlay `compose.ocr.yml`, os segredos do OCR nem a URL do
   Mini App — o gate oficial não representava o conjunto que a janela de deploy
   precisa validar (Azure primário, Google fallback, `OCR_MODE=failover`).
3. A configuração desejada da v0.1.0-beta.2 (Telegram, MiniApp, OpenRouter,
   Azure Vision, Google Vision e importação automática ativos) precisa ser
   aceita pelo `deployment-check` com rigor idêntico ao dos conjuntos já
   validados — nenhuma flag ativa pode escapar do gate.

## O quê (MUST)

- `compose.integrations.yml` entrega `TELEGRAM_MINIAPP_URL` ao worker por
  interpolação obrigatória `${TELEGRAM_MINIAPP_URL:?Mini App URL required}`,
  sem valor literal no repositório.
- `deployment-check` ganha a flag `--ocr` (requer `--integrations`): overlay
  `compose.ocr.yml`, validação de Azure primário + Google fallback
  (`OCR_MODE=failover`, endpoints HTTPS, timeouts e os dois segredos montados)
  e da URL do Mini App (HTTPS absoluta, sem credenciais/query).
- Testes: contrato dos composes de produção (entrega da URL, ausência de
  valores literais de segredo, política OpenRouter/OCR/importação automática),
  mensagens de falha sem material sensível, e cenários novos no
  `deployment:rehearse` (positivos com `--ocr` e negativos: URL
  ausente/insegura, OCR incompleto, `--ocr` sem `--integrations`).
- Documentação de runtime e deploy + `deployment.env.example` com as variáveis
  exigidas por overlay (sem URL real).

## Impacto

Sem mudança de imagem ou de candidate: os digests ARM64 publicados da
v0.1.0-beta.2 permanecem os mesmos e nenhum novo candidate é exigido. Nenhuma
tag, release, publicação, deploy ou migração é executada nesta fase.
