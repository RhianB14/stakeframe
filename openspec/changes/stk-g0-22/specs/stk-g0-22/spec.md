# Spec — extração neutra e importação automática para todas as casas

## ADDED Requirements

### Requirement: Extração neutra sem bookmaker

A extração da IA DEVE (MUST) operar sem o campo `bookmaker`: o contrato
(`ticketExtractionSchema`) não o expõe e o prompt não o solicita; a IA organiza
somente esporte, torneio, evento, seleções, mercado, odds, stake, crédito de
freebet, referência, campos financeiros visíveis, warnings e evidência OCR.
Valores inferidos de casa (texto, layout, cor, logo ou contexto) DEVEM (MUST)
ser ignorados; resposta da IA fora do contrato DEVE (MUST) resultar em revisão.

#### Scenario: resposta com bookmaker inferido

- **WHEN** a resposta da IA traz qualquer indicação de casa
- **THEN** o contrato a recusa (campo inexistente) e o item permanece em revisão
- **AND** nenhum efeito financeiro é aplicado

#### Scenario: OCR neutro

- **WHEN** o OCR não contém marca da casa
- **THEN** a extração segue normalmente (Azure primário; Google apenas como fallback elegível)

### Requirement: Prompt e contrato neutros (F1)

O prompt e o contrato de extração NÃO DEVEM (MUST NOT) expor `bookmaker`,
`bookmakerId`, `bookmakerName` ou `layoutId`; o contexto DEVE (MUST) declarar
`bookmakerContext=user-informed` e instruir a não identificação, não inferência
e não sugestão de casa, sem escolha de layout e sem extração de data/hora do
evento. Resposta com qualquer um desses campos DEVE (MUST) ser recusada
(`AI_EXTRACTION_INVALID`). A resolução determinística da casa ocorre no motor,
fora da IA, e uma policy global vigente autoriza o contrato neutro para a casa
ativa informada pelo usuário.

#### Scenario: resposta com campo de casa ou layout

- **WHEN** a resposta do modelo contém `bookmaker`, `bookmakerId`, `bookmakerName` ou `layoutId`
- **THEN** a extração é recusada como inválida e o item vai para revisão

#### Scenario: contexto user-informed

- **WHEN** o worker monta a requisição de extração
- **THEN** o prompt declara `bookmakerContext=user-informed` e não contém instrução de classificar, identificar ou sugerir a casa

### Requirement: Bookmaker exclusivamente do usuário

A casa DEVE (MUST) vir de escolha explícita do usuário (legenda do Telegram,
botão de casa, MiniApp ou Web), resolvida contra o catálogo ATIVO da
organização. Ausente → `null` → revisão (`BOOKMAKER_UNRESOLVED`); inativa,
inexistente ou de outra organização → recusa fail-closed (`BOOKMAKER_REFUSED`).
A seleção DEVE (MUST) atualizar a mesma aposta nas três superfícies.

#### Scenario: casa ausente

- **WHEN** o bilhete chega sem declaração de casa
- **THEN** o item permanece com bookmaker null e vai para revisão humana

#### Scenario: casa de outra organização

- **WHEN** a casa informada não pertence ao catálogo ativo da organização
- **THEN** a importação automática é recusada sem efeito

### Requirement: Policy v2 para todas as casas ativas

A política de importação automática DEVE (MUST) ser global (`schemaVersion: 2`)
com `requiresUserBookmaker: true`, `aiBookmakerClassification: 'disabled'`,
`bookmakerScope: 'all-active'`, evidência de corpus (`coverage`, `sampleCount`,
`essentialFieldErrors: 0`), `approvedBy: 'owner'`, `approvedAt` e `expiresAt`;
ausente, inválida ou expirada → revisão, nunca autoimportação. O checker do
repositório DEVE (MUST) validar a v2 e recusar divergências.

#### Scenario: política expirada

- **WHEN** a política carregada está expirada
- **THEN** nenhum item é autoimportado e todos seguem para revisão

#### Scenario: política legada ou com escopo de casas

- **WHEN** o arquivo não é `schemaVersion: 2` ou tenta enumerar uma casa/layout
  como autoridade da IA
- **THEN** o loader recusa a política e a importação permanece em revisão

#### Scenario: política global vigente

- **WHEN** a política v2 está vigente e o bookmaker foi informado pelo usuário
  e validado como casa ativa da organização
- **THEN** o motor pode organizar a extração neutra para essa casa
- **AND** o digest registrado é da política global, não de uma classificação do
  modelo

### Requirement: Sincronização canônica entre superfícies

Telegram, MiniApp e Web DEVEM (MUST) ler e alterar a mesma importação/aposta
canônica. Casa, tipster, origem e data DEVEM (MUST) ser gravados no servidor
com organização, versão otimista e idempotência; uma alteração válida DEVE
emitir uma edição da mensagem Telegram específica pela outbox, e uma operação
antiga NÃO DEVE sobrescrever uma versão mais nova.

#### Scenario: edição Web para Telegram e leitura MiniApp

- **WHEN** o usuário altera a casa ou tipster na Web
- **THEN** a leitura do MiniApp retorna o novo valor
- **AND** a outbox edita somente a mensagem Telegram daquela aposta com o
  valor novo

#### Scenario: edição Telegram para Web

- **WHEN** o usuário escolhe a casa ou tipster no teclado/MiniApp do Telegram
- **THEN** a leitura Web retorna o mesmo registro canônico
- **AND** a casa deve pertencer ao catálogo ativo da organização

#### Scenario: versão antiga

- **WHEN** uma edição atrasada chega depois de uma edição mais nova
- **THEN** ela é recusada ou reconciliada idempotentemente sem alterar o valor
  vigente nem gerar journal/outbox duplicado

### Requirement: Cálculo financeiro no servidor

O servidor DEVE (MUST) calcular o retorno potencial: `real = valor × odd`;
`freebet = freebet × (odd − 1)` (sem devolver a parcela ao apostador);
`híbrida = valor real × odd + freebet × (odd − 1)`. A IA apenas organiza os
valores encontrados; retorno divergente calculado, stake/odd/freebet ambíguos
ou valor inventado DEVEM (MUST) manter o item em revisão.

#### Scenario: híbrida com cálculo divergente

- **WHEN** o retorno visual diverge do cálculo server-side
- **THEN** o valor calculado prevalece como fonte e a divergência não autoriza importação indevida

### Requirement: Integridade temporal e sanitização

`Enviado em` DEVE (MUST) permanecer o timestamp imutável do recebimento;
`Evento em` DEVE (MUST) permanecer null/pending (nunca extraído pela IA nem
persistido nesta etapa). Respostas, logs e recebíveis DEVEM (MUST) ser
sanitizados (sem segredos, tokens ou conteúdo de bilhete privado).

#### Scenario: data do evento fora da extração

- **WHEN** o bilhete mostra a data do evento
- **THEN** o campo `eventAt` permanece pendente e fora do contrato de extração
