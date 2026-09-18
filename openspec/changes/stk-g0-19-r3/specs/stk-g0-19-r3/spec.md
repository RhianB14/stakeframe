# Capability: stk-g0-19-r3

Separação entre a data da aposta e a data do evento, contrato de extração
ajustado e avaliação de decisão fiel ao fluxo real.

## ADDED Requirements

### Requirement: Duas datas separadas

`placedAt` DEVE (MUST) continuar sendo a data/hora em que a aposta foi
registrada, admitindo somente o texto visual parseável do comprovante ou a
quarta linha explícita da legenda (`DD/MM/AAAA HH:mm`), com instantes
coincidentes quando ambos existirem. NUNCA usar horário de upload, timestamp do
Telegram, data do arquivo, data/hora do evento ou inferência pelo estado da
partida. A data/hora do evento NÃO pertence à extração automática desta fase:
não autoriza nem bloqueia importação, não é comparada como campo essencial,
não é persistida e será obtida por enriquecimento posterior; período ao vivo e
minuto nunca são confundidos com data do evento.

#### Scenario: sem data visual

- **WHEN** a imagem não apresenta `placedAt` legível e o proprietário informa a
  quarta linha válida
- **THEN** o caso pode ser automatizado com o instante informado

#### Scenario: sem qualquer placedAt

- **WHEN** a imagem não traz data e não há quarta linha
- **THEN** o caso permanece em revisão; nenhuma data é inventada

### Requirement: eventDateText reservado/depreciado

O campo `eventDateText` DEVE (MUST) ser mantido temporariamente como `null` por
compatibilidade, marcado reservado/depreciado, enviado sempre `null` pelo
prompt e ignorado pela importação: nenhum valor antigo é convertido em data e
o campo sai dos gates essenciais e da decisão de homologação. A remoção
definitiva fica como unidade separada.

#### Scenario: valor legado presente

- **WHEN** uma extração ainda traz `eventDateText` preenchido
- **THEN** nada é convertido, nada é persistido e a importação não é bloqueada
  nem autorizada por esse campo

### Requirement: Seleções automáticas pendentes

Toda seleção criada automaticamente DEVE (MUST) nascer com `eventDate: null`,
`eventAt: null` e `dateStatus: 'pending'`, independentemente de
`eventDateText`.

#### Scenario: criação pela importação

- **WHEN** um bilhete é importado automaticamente
- **THEN** a seleção persistida nasce pendente de enriquecimento

### Requirement: Avaliação fiel ao fluxo

`validation:decision` DEVE (MUST) reproduzir a ordem real do fluxo: schema,
layout selecionado, modelo aprovado, política/digest, OCR consistente, contexto
informado, casa e aliases, tipo real/freebet, `placedAt`, financeiro,
duplicidade e dados efetivamente persistidos. `actual.layoutId=null`, layout
diferente, modelo diferente, digest cobrado no fluxo real, OCR inconsistente,
contexto ausente, conflito de casa/tipo, data divergente e duplicidade
permanecem em revisão; negativo cross-house rejeitado é revisão esperada e não
importação insegura; positivo sem layout reconhecido é revisão conservadora.
A data/hora do evento nunca participa. O contexto privado explícito
(`homologationContextSchema`) é ligado por `imageSha256` e contém apenas o que
o proprietário informou.

#### Scenario: gates de segurança

- **WHEN** a avaliação roda sobre a evidência preservada
- **THEN** `unsafeAutoImport`, `wrongPersistedData`, `conflictAccepted`,
  `layoutOrPolicyBypass` e `crossTenantLeak` são zero, e
  `conservativeReview`, `eventEnrichmentPending`, qualidade e fidelidade do
  retorno são reportados à parte

### Requirement: Rótulos obrigatórios na política

`potentialReturnLabels` DEVE (MUST) ser obrigatório em toda política
nova/aprovada (Bet365 `Retorno Total`; Superbet `Prêmio` e `Ganho Potencial`),
fazendo parte do digest; rótulos não autorizados, retorno obtido/líquido,
cashout, saldo, stake e odds continuam recusados.

#### Scenario: política sem rótulos

- **WHEN** uma política nova não declara `potentialReturnLabels`
- **THEN** a validação da política falha fechado

### Requirement: Comparação apenas do que é persistido

A validação de caso autoimportável DEVE (MUST) comparar somente bookmaker do
contexto, stake, odd total, tipo, `placedAt`, referência confiável, quantidade
de seleções, evento, esporte (somente explícito), mercado, seleção e odd por
seleção. Data/hora do evento, minuto/período ao vivo, placar e `eventDateText`
nunca são comparados nem persistidos.

#### Scenario: data dentro da seleção

- **WHEN** a extração traz data/hora dentro de uma seleção
- **THEN** nada é persistido como data de evento e a decisão não muda
