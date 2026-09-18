# Capability: stk-g0-19-r6

Correções pós-revisão: autenticação de leitura do Mini App, botões funcionais,
retorno visual apenas diagnóstico e validação completa de freebet no rascunho.

## ADDED Requirements

### Requirement: Leitura do detalhe autenticada por sessão ou initData

O GET do detalhe DEVE (MUST) aceitar sessão web válida OU `initData` do Mini
App com HMAC validado no servidor, idade máxima de 24 h, tolerância de 2 min
para relógios adiantados, recusa de parâmetros sensíveis duplicados e vínculo
exato ao Telegram ID do proprietário; a organização vem sempre do servidor e
não há identificador de organização no cliente.

#### Scenario: mini app carrega sem cookie

- **WHEN** o Mini App envia GET com `initData` assinado válido e sem cookie
- **THEN** o detalhe da importação da organização é retornado

#### Scenario: initData inválido

- **WHEN** o `initData` é inválido, expirado, futuro além da tolerância ou de outro usuário
- **THEN** a resposta é 401 sem qualquer dado

### Requirement: Botões da resposta final com comportamento real

Cada botão da resposta final DEVE (MUST) executar uma ação real: 'Editar' abre
o Mini App por `web_app` HTTPS com o UUID opaco do registro; os demais
resolvem a importação no servidor por chat + id da mensagem (nunca por payload)
e respondem ao callback; 'Excluir' exige confirmação explícita, é idempotente e
protegida contra callback alheio ou de outra organização.

#### Scenario: exclusão em dois toques

- **WHEN** o usuário toca Excluir
- **THEN** o teclado vira confirmação (Confirmar/Cancelar); somente Confirmar executa o descarte

#### Scenario: callback repetido

- **WHEN** o mesmo evento de confirmação chega novamente
- **THEN** o resultado é o mesmo, sem efeito duplicado

### Requirement: Retorno visual apenas diagnóstico

O retorno potencial DEVE (MUST) ser sempre o cálculo server-side
(`stake × totalOdds`, decimal exato); o valor extraído da imagem NUNCA
autoriza, bloqueia ou altera a importação, participa da concordância OCR ou
muda a decisão offline — divergências aparecem apenas como diagnóstico de
fidelidade separado.

#### Scenario: valor visual divergente

- **WHEN** o retorno visual diverge do cálculo com stake e odd válidas
- **THEN** a importação prossegue normalmente e a divergência é registrada como fidelidade

### Requirement: Freebet compatível validada no rascunho

A escolha de freebet no rascunho DEVE (MUST) validar sob lock: organização,
casa resolvida, valor igual à stake, validade, disponibilidade e política
aprovada permitindo freebet; a listagem de créditos já vem filtrada; escolha
explícita é obrigatória; a importação final mantém a validação transacional
(um crédito alimenta uma única importação).

#### Scenario: crédito incompatível

- **WHEN** o usuário tenta salvar freebet com crédito de outra casa, valor diferente, expirado, usado ou bloqueado por política
- **THEN** o rascunho não é gravado e o erro é sanitizado
