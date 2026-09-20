# STK-G0-22 — extração neutra e importação automática para todas as casas

## Por quê

1. O fluxo atual exige que a IA identifique a casa (o `layoutId` e o campo
   `bookmaker` da extração selecionam o layout validado no
   `createAutomaticImportService`; sem layout correspondente a importação cai
   em `LAYOUT_NOT_VALIDATED`). Isso só funciona para as casas cujo layout foi
   classificado e aprovado — e coloca a IA na posição de decidir a casa.
2. A regra de produto passa a ser: **a IA NÃO decide qual casa produziu o
   bilhete**. O bookmaker vem exclusivamente de escolha explícita do usuário
   (legenda do Telegram, botão de casa, MiniApp ou Web); sem ela, o bilhete
   permanece com bookmaker null e vai para revisão.
3. Sem essa mudança, a importação automática não pode ser ativada para todas
   as casas ativas da organização (exigência da política real).

## O quê (MUST)

- **Prompt e contrato neutros**: remover `bookmaker` do contrato de extração da
  IA (`ticketExtractionSchema`) e do prompt; a IA não copia, não infere e não
  recebe a casa como objetivo. O OCR estruturado permanece (Azure primário,
  Google fallback elegível) e a IA organiza apenas: esporte/torneio/evento/
  seleções/mercado/odds/stake/credito freebet/referência/campos financeiros
  visíveis/warnings/confiança/evidência OCR.
- **Bookmaker exclusivamente do usuário**: a casa declarada na legenda ou
  escolhida por botão/MiniApp/Web é resolvida contra o catálogo ATIVO da
  organização; ausente → `null` → revisão (`BOOKMAKER_UNRESOLVED`); de outra
  organização, inativa ou inexistente → recusa fail-closed
  (`BOOKMAKER_REFUSED`); o contexto é `user-informed` no contrato de corpus.
- **Policy v2 (todas as casas ativas)**: novo formato de política global
  (`schemaVersion: 2`) com `requiresUserBookmaker: true`,
  `aiBookmakerClassification: 'disabled'`, `bookmakerScope: 'all-active'`,
  formatos de placedAt aceitos, rótulos de retorno e evidência de corpus
  (`coverage`, `sampleCount`, `essentialFieldErrors: 0`, `approvedBy: 'owner'`,
  `approvedAt`, `expiresAt`) — sem layout por casa e sem exigir classificação
  de bookmaker pela IA. O checker (`scripts/validation/policy.mjs`) e o loader
  do worker passam a validar a v2 (fail-closed: ausente/inválida/expirada →
  revisão, nunca autoimporta).
- **Motor**: o `layoutId`/classificação da IA deixa de selecionar a casa; a
  casa do usuário resolve o catálogo; gates mantidos: OCR consistente, campos
  essenciais válidos, origem financeira declarada, retorno calculado
  server-side (`real = valor × odd`; `freebet = freebet × (odd − 1)`;
  `híbrida = valor real × odd + freebet × (odd − 1)`), `Enviado em` imutável,
  `eventAt` fora da extração, duplicidade, cross-tenant, resposta AI inválida.
- **Sincronização de casa**: a seleção no Telegram, MiniApp e Web atualiza a
  mesma aposta (uma única fonte de verdade server-side por organização).
- **Testes RED→GREEN** cobrindo a lista do pedido (todas as casas ativas;
  bookmaker via Telegram/MiniApp/Web; ausente → revisão; inferido pela IA →
  rejeição; outra organização → recusa; OCR neutro sem marca; real/freebet/
  híbrida com cálculo server-side; data do evento fora da extração;
  duplicidade; resposta AI inválida; Azure com fallback Google; zero segredo
  nos logs).
- **Policy real**: documentar e preparar a política v2 aprovada para
  `/etc/stakeframe/automatic-import.json` (0600) — instalação e ativação
  somente em janela autorizada própria (`AUTOMATIC_IMPORT_ENABLED=true`).

## Fatia F1 (esta PR) — contrato e prompt neutros

Esta fatia remove APENAS a decisão da IA: o prompt e o contrato de extração
deixam de expor `bookmaker`, `bookmakerId`, `bookmakerName` e `layoutId`; o
contexto declara `bookmakerContext=user-informed`; resposta fora do contrato é
recusada (`AI_EXTRACTION_INVALID`). A resolução determinística da casa no
motor (casa do usuário → catálogo ativo → policy v2) fica para a F2; nesta
fatia a resolução final permanece a atual (legenda → `bookmakerId`; gate por
layout) e, sem `layoutId` fornecido pela IA, o item segue para revisão
(fail-closed). Nenhuma migração, policy real, ativação ou deploy nesta PR.

## Impacto

Migração nenhuma; contrato OpenAPI ajustado; change OpenSpec `stk-g0-22`.
Sem deploy, migração, tag ou publicação nesta PR. Novo commit invalida revisão
anterior.
