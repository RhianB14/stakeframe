# Capability: stk-f2-01-onboarding-redesign

Onboarding inicial do beta: fluxo de três passos (perfil → primeira banca → primeira
aposta) com UI acessível (WCAG AA), responsiva e sem fallback silencioso.

## ADDED Requirements

### Requirement: Estados da interface

O onboarding DEVE (MUST) apresentar os seguintes estados explícitos, cada um com marcação
semântica:

- **reading** — leitura do estado atual no servidor: conteúdo com `aria-busy`,
  rótulo textual "Carregando seu onboarding…", controles desabilitados.
- **read-error** — falha de leitura: mensagem em `role="alert"`, texto genérico sem
  detalhes internos, botão "Tentar novamente" que repete somente a leitura (GET);
  sem fallback silencioso.
- **steps** — passos 1–3 ativos, cada um com `fieldset`/`legend`, labels associados
  (`for`/`id`), ajuda via `aria-describedby`, erros de campo com `aria-invalid` e
  mensagem associada.
- **partially-completed** — retomada no primeiro passo não concluído; passos anteriores
  marcados "concluída" no indicador; dados já salvos permanecem (fonte: servidor).
- **empty** — passo 2 sem banca ou passo 3 sem aposta: instrução clara para criar/decidir.
- **submitting** — envio em andamento: botão desabilitado com rótulo "Salvando…",
  `aria-busy`; duplo envio impedido.
- **submit-error** — falha de envio (inclui 500): `role="alert"` com mensagem genérica
  sem detalhes internos, botão "Tentar novamente" que repete a ação pendente; o
  onboarding NUNCA é exibido como concluído; o passo atual é mantido.

#### Scenario: erro de leitura com retry

- **WHEN** a leitura do estado do onboarding falha
- **THEN** a UI exibe alerta acessível com botão "Tentar novamente"
- **AND** nenhum passo aparece como concluído
- **AND** nova tentativa repete a leitura sem mutação

#### Scenario: erro 500 no finish

- **WHEN** o envio final falha com 500
- **THEN** a UI exibe mensagem genérica em `role="alert"` com "Tentar novamente"
- **AND** o onboarding não aparece como concluído
- **AND** o passo atual permanece selecionado

### Requirement: Indicador de progresso acessível

A UI DEVE (MUST) exibir um indicador de progresso por lista ordenada (`ol`), com um item por
passo, `aria-current="step"` no passo ativo, texto visualmente oculto "concluída" nos
passos concluídos e região `aria-live="polite"` que anuncia "Etapa X de 3 — título"
ao trocar de passo (padrão WAI Forms Tutorial — Multi-page Forms).

#### Scenario: progresso anunciado

- **WHEN** o usuário avança do passo 1 para o passo 2
- **THEN** a região `aria-live` anuncia a nova etapa
- **AND** o item correspondente tem `aria-current="step"`

### Requirement: Acessibilidade WCAG AA

A UI do onboarding DEVE (MUST) atender os critérios abaixo:

- Foco visível em todos os controles via `:focus-visible` (SC 2.4.7).
- Navegação por teclado completa e em ordem lógica, sem armadilhas de foco (SC 2.1.1/2.1.2).
- Labels/instruções para todo campo (SC 3.3.2); erros identificados em texto
  (SC 3.3.1) com sugestão de correção (SC 3.3.3).
- Contraste AA verificado programaticamente para os pares de cor usados (SC 1.4.3).
- Alvos de toque ≥ 44px em viewport mobile.

#### Scenario: navegação por teclado

- **WHEN** o usuário percorre a página com Tab
- **THEN** todos os controles interativos recebem foco em ordem lógica
- **AND** o indicador de foco é visível

### Requirement: Responsividade e temas

- A UI DEVE (MUST) manter layout íntegro em viewport mobile (360×640) e desktop (1280×720).
- Cores do onboarding definidas como variáveis CSS locais `--onb-*`; tema escuro único
  mantido (decisão registrada na proposta).

#### Scenario: viewport mobile

- **WHEN** o fluxo é executado em viewport 360×640
- **THEN** passos, indicador e ações são utilizáveis sem overflow horizontal
- **AND** a suíte E2E onboarding passa no projeto mobile

### Requirement: Preservação dos gates (não-regressão)

O redesign NÃO DEVE (MUST NOT) alterar: gate server-side do finish, exigência de perfil
concluído, exigência de banca inicial ancorada, escolha explícita de primeira aposta
("Registrar aposta manual" / "Conectar Telegram" / "Continuar sem registrar aposta"),
tratamento de erro 500, isolamento por organização, consentimentos F1-07, nem a regra
de escrita financeira somente com confirmação humana.

#### Scenario: gate preservado

- **WHEN** a suíte E2E/integração existente do onboarding roda após o redesign
- **THEN** todos os cenários de gate passam sem alteração de comportamento
