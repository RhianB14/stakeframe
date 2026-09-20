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

## Fatia F1 — contrato e prompt neutros

Esta fatia remove APENAS a decisão da IA: o prompt e o contrato de extração
deixam de expor `bookmaker`, `bookmakerId`, `bookmakerName` e `layoutId`; o
contexto declara `bookmakerContext=user-informed`; resposta fora do contrato é
recusada (`AI_EXTRACTION_INVALID`). A resolução determinística da casa no
motor (casa do usuário → catálogo ativo → policy v2) foi entregue nas fatias
seguintes. Nenhuma migração, policy real, ativação ou deploy é feita nesta PR.

## Fatia F2 (implementação direta após a F1)

O motor agora resolve o contexto exclusivamente no servidor: tipster e casa da
legenda são comparados por alias ao catálogo ativo da organização, enquanto a
seleção explícita de casa gravada por Telegram/MiniApp/Web tem precedência e é
revalidada sob a transação. Casa ausente produz BOOKMAKER_UNRESOLVED;
catálogo inexistente, inativo, ambíguo ou fora da organização produz
BOOKMAKER_REFUSED. O layout não é escolhido pela IA: o contexto do usuário é
revalidado e a policy global vigente é aplicada ao modelo configurado.
modelo configurado, com validade e unicidade verificadas; layoutId e
policyDigest enviados pela IA são rejeitados como tentativa de autoridade e qualquer valor
não nulo mantém o item em revisão. Nenhum lançamento financeiro ocorre quando
um desses gates falha. A policy v2 global e o loader/checker são entregues na
PR agrupada F3+F4; a policy real e a ativação continuam reservadas à F5.

## Fatias F3+F4 (esta PR agrupada)

A política operacional passa a ser um documento global v2, sem lista de casas
ou layout escolhido pela IA. Ela declara `requiresUserBookmaker: true`,
`aiBookmakerClassification: 'disabled'`, `bookmakerScope: 'all-active'`, os
formatos de data de colocação aceitos pelo parser neutro, o modelo aprovado e
a evidência agregada de corpus. O loader do worker e o estado exibido à Web e
ao Mini App exigem o schema v2, arquivo regular absoluto, limite de tamanho,
permissão privada em sistemas POSIX e janela de validade atual; qualquer
ausência, versão antiga, corrupção ou expiração continua fail-closed.

O motor usa a casa/tipster resolvidos pelo contexto explícito do usuário e
aplica a política global a qualquer casa ativa da organização. A IA só organiza
o OCR; ela não recebe nem retorna bookmaker, layout ou rótulos específicos.

Telegram, MiniApp e Web continuam sendo três superfícies do mesmo registro:
alterações de casa, tipster, origem e data passam por rotas canônicas com
organização, versão otimista e idempotência; a outbox edita a mensagem da
aposta específica. A troca de casa pós-importação altera `finance.bet` e a
exposição por journals compensatórios; uma edição antiga nunca sobrescreve a
mais nova. Não há migração, ativação ou chamada externa nesta PR.

## Fatia F5 — finalização da extração neutra (esta PR)

Correções determinísticas sobre as leituras reais da RUN-015 (Bet365 e
Superbet), sem novas chamadas pagas e sem tocar nos artefatos privados
originais:

- **Retorno potencial por evidência explícita**: o prompt passa a reconhecer os
  rótulos fixos "Retorno Total", "Prêmio" e "Ganho Potencial" (a dependência
  dos "rótulos autorizados do layout" saiu com a F1) e recupera o valor somente
  quando ele está visível; nunca calcula nem deriva de stake × odd; ausente →
  `null`, com aviso conservador quando o recorte corta o bloco.
- **Referências ambíguas**: segunda leitura focada (mesma imagem/OCR, schema
  mínimo) quando o OCR e o modelo divergem apenas nos pares confundíveis
  U/J, I/1, O/0; divergência ou falha → `reference=null` + aviso (revisão).
- **Separadores de data**: na avaliação, hífen/meia-risca/travessão são
  equivalentes **somente** no separador textual de data/hora; hífens reais em
  nomes, mercados e referências continuam significativos.
- **Auditoria RUN-015**: o ground truth do bilhete `898C-7R4JIY` continha erro
  (`UIY`); registrado em draft privado versionado com hash, sem sobrescrever os
  artefatos originais. Projeção local (não é rodada paga): Bet365 25/25;
  Superbet 19/25 → 21/25 (restantes dependem de nova leitura).
- **A policy final continua dependendo da casa informada pelo usuário** — a IA
  não classifica bookmaker nem layout.

## Impacto

Migração nenhuma; contrato OpenAPI ajustado; change OpenSpec `stk-g0-22`.
Sem deploy, migração, tag ou publicação nesta PR. Novo commit invalida revisão
anterior.
