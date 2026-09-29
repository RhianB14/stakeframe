# STK-F2-13 — Entitlements no banco + circuit breakers de custo

Plano Master 2026 §4.7 (teto de R$200/mês com circuit breakers), §6.1 e §11.1
(entitlements no banco; PostHog não é fonte de verdade). Card `t_7c36c48d`.

Migração `0025_entitlements_breakers`, forward-only e replay-safe, aplicada
**apenas em local**.

## O que mudou, em uma frase

O plano do tenant passou a ser **dado do banco** e o limite de gasto passou a ser
**contabilidade do banco**, e as duas coisas são aplicadas na API **antes** de
qualquer chamada paga — sem preço, sem cobrança e sem duplicar a contabilidade
que a F2-06 já mantinha.

## 1. Entitlements: o banco é a fonte de verdade

Quatro objetos novos em `core`:

| Objeto                                 | Papel                                                     |
| -------------------------------------- | --------------------------------------------------------- |
| `core.plan`                            | catálogo global de planos (`free`, `starter`, `pro`)      |
| `core.plan_entitlement`                | permissões por plano, com teto de **uso** (`limit_value`) |
| `core.organization_entitlement`        | o plano efetivo de uma organização (RLS, fail-closed)     |
| `core.organization_entitlements(uuid)` | **a função que calcula** a resolução                      |

A resolução mora na função, não no chamador. Ela é fail-closed em dois pontos:

- organização **sem atribuição** → plano `free`, o mais restritivo. Um tenant
  novo nunca nasce com mais permissão do que o mínimo;
- organização **inexistente** → **nenhuma linha**. O chamador trata ausência como
  recusa, então um id desconhecido nunca vira permissão.

Quem decide é o servidor: `apps/api` lê a mesma função que o painel lê, então
"o que o painel mostra" e "o que a API aplica" não podem divergir. O frontend, o
PostHog e o payload de webhook não têm palavra nessa decisão.

`entitlementAllows` e `entitlementWithinLimit` (em `packages/shared`) aplicam a
lista que o banco devolveu. **Recurso ausente da lista é negado** — a ausência é
a forma fail-closed, não um "conceder por omissão".

## 2. Sem preço e sem cobrança (Plano §4.7)

Os preços são **INDEFINIDOS** de propósito: cobrança é Fase 4 / Mercado Pago e
está no escopo excluído do card.

- Não existe coluna de preço em `core.plan` nem em `core.plan_entitlement`, e um
  teste verifica isso por nome de coluna;
- `plan.billable` é `boolean NOT NULL DEFAULT false` com **CHECK
  `billable = false`**: o banco recusa o próprio plano vir cobrável. A ausência de
  cobrança é uma invariante, não um esquecimento — ligar cobrança passa a exigir
  migração nova e explícita;
- o payload do painel traz `priceBRL: null` e `pricesDefined: false`, e a
  interface escreve "A definir". Zero seria uma promessa de grátis que o
  produto não faz.

`limit_value` é **teto de uso** (unidades do recurso por mês), nunca dinheiro.
E acima dele continuam valendo o teto global de quota e o teto global de R$200:
plano nunca amplia a capacidade da infraestrutura.

## 3. Circuit breakers em três níveis

A F2-06 já entregou a **base estrutural** (`integration.ai_circuit_breaker`, com
os escopos `global`, `daily` e `user`) e nomeou esta card para substituir o
limiar e a janela, que eram constantes de código. Agora eles são **dados**:

`integration.breaker_policy` tem uma linha por escopo, com `failure_threshold`,
`recovery_ms`, `spend_cap_micros` e `spend_window`. `packages/db/src/extraction-policy.ts`
lê a política por escopo e aplica — mudar a política é um UPDATE auditável, não
um deploy. Um teste prova o caminho: `failure_threshold` 5 → 2 muda a leitura sem
tocar em código.

A **forma** não mudou: a base continua sendo a da 0024, e a degradação é
conservadora. Se `breaker_policy` não puder ser lida, o serviço assume limiar e
janela **mais contidos** que o default (3 falhas / 5 min), porque perder a tabela
de política precisa fechar a porta mais cedo, nunca abrir.

Disparo (já provado na 0024, reconfirmado aqui nos três escopos): falhas
**CONFIRMADAS** consecutivas abrem o circuito; falha **incerta** (timeout,
conexão perdida) não abre, porque pode ter custado trabalho sem ser recusa do
serviço. O escopo por usuário é independente dos outros.

## 4. Teto global de R$200/mês

`integration.ai_usage_day` ganhou **uma coluna**: `cost_micros bigint NOT NULL
DEFAULT 0`, com CHECK de não-negativo. É a **mesma tabela** da quota da 0024 —
nenhuma contabilidade foi duplicada, apenas uma dimensão nova sobre os mesmos
dias, e o teto é lido da **mesma agregação mensal**.

O custo é estimado por preço de **referência** do fornecedor
(`integration.ai_model_price`, por 1.000 tokens, em microreais) e tem três
regras, todas favoráveis a fechar a porta:

1. **Arredonda para cima.** Uma divisão exata daria ao teto a chance de ser
   furado por fração de microreal; arredondar para cima torna o valor um teto do
   custo real.
2. **Preço ausente não é custo zero.** Cai no valor de fallback declarado em
   `integration.ai_cost_model` (1500 micros). Um fornecedor que escondesse o
   preço não escaparia do teto.
3. **Uso não declarado também não é zero** (mesma regra).

Quando o gasto do mês atinge R$200, `refusesPaidCalls` é verdadeiro e a próxima
chamada é **recusada com `reason: 'spend'`**, escopo `global`.

### Custo ≠ cota

São dimensões diferentes e a distinção é deliberada:

|                       | Unidade                            | Conta quando                |
| --------------------- | ---------------------------------- | --------------------------- |
| `presented` (F2-06)   | extrações **apresentadas**         | o usuário recebeu estrutura |
| `cost_micros` (F2-13) | microreais **pagos ao fornecedor** | uma chamada saiu            |

A recusa por cota (`refused_quota`) não debita **nenhum dos dois**: nenhuma
chamada saiu. A resposta incerta não debita quota, mas **debita custo** — pode
ter custado dinheiro ao fornecedor, e é exatamente por isso que ela não pode ser
repetida.

## 5. Recusa com orientação para o fluxo manual

Fail-closed coerente com a F2-06: a recusa é decisão de orçamento ou de plano,
nunca defeito do bilhete, e **o item continua disponível para preenchimento
manual**. Três códigos, três mensagens que terminam no mesmo lugar:

| Código                           | Quando                                   | HTTP |
| -------------------------------- | ---------------------------------------- | ---- |
| `ENTITLEMENT_FEATURE_DENIED`     | recurso ausente ou desligado no plano    | 403  |
| `ENTITLEMENT_PLAN_LIMIT_REACHED` | teto de uso do plano atingido            | 403  |
| `PAID_CALL_CEILING_REACHED`      | quota, gasto ou breaker fecharam a porta | 429  |

As três mensagens_WARN orientam a continuar ("segue disponível para você
preencher manualmente"), e `manualFlowGuidance` no shared é a fonte única dos
textos. A ordem de verificação no upload é **entitlement → teto de plano → teto
de chamada paga**: a recusa de plano vem antes, então nem chega a haver tentativa
de chamada.

O serviço de entitlement é **opcional na assinatura e obrigatório no fato**: sem
ele o upload recusa em 503, porque um produto sem o banco de entitlement não pode
afirmar que respeita plano.

## 6. Painel interno (F2-11) — leitura, sem conteúdo de tenant

`GET /api/v1/admin/usage` ganhou, no **mesmo payload** de uso:

- `spend` — gasto estimado do mês, teto de R$200 e `exhausted`;
- `breakers` — `global` e `daily` por escopo: estado, contador de falhas
  confirmadas e janela de recuperação;
- `openUserBreakers` — **contagem** de circuitos por usuário abertos. O `scope_key`
  é o id interno do usuário, que é identificador pessoal, e **não é publicado**;
- `plans` — plano, consumo e teto por organização, com `priceBRL: null`.

O consumo do plano é lido **dentro do contexto da própria organização** e pela
**mesma condição** que a quota debita (`outcome_presented`), então o teto aplicado
e o consumo publicado não podem divergir.

O que **não** entra: aposta, saldo, resultado, journal, imagem, e-mail, token,
código de erro com conteúdo, e o id do usuário. O rótulo da organização aparece
porque é o metadado de tenant que a F2-11 já publica em contas e filas — a conta
precisa ser reconhecível para ser operada.

## 7. Testes §15

`tests/integration/entitlements-breakers.test.ts` — **36 casos** em PostgreSQL
real, banco descartável, dados fictícios, sem chamada ao fornecedor:

- entitlement resolvido pelo banco; sem atribuição cai no `free`; organização
  inexistente devolve **nenhuma** linha; trocar o plano no banco muda a resposta
  sem tocar em código;
- banco recusa `billable = true` e não existe coluna de preço;
- breaker dispara nos **três** escopos; o por usuário é independente; limiar vem
  do banco; a degradação é mais contida;
- teto de R$200 recusa com `reason: 'spend'`; abaixo do teto, permite;
- custo: soma por token, arredondamento para cima, preço ausente ≠ zero, uso não
  declarado ≠ zero, recusa custa zero;
- painel expõe breakers, gasto e plano; circuito por usuário é contagem; o
  consumo do painel bate com a unidade da API;
- replay-safe: 0025 é a última entrada do journal, seis objetos existem, banco
  recusa incoerência, RLS da atribuição é fail-closed.

Suíte completa: **483 unit** + **36 novos de integração** + as demais suítes de
integração sem regressão.

## Fora do escopo, declarado

- **Sem cobrança.** Nenhum preço, nenhuma integração de pagamento. `billable` é
  CHECK false e não existe coluna de preço.
- **Sem tiers de gasto por usuário ou diário.** Só o escopo global tem teto
  (R$200/mês). A coluna `spend_cap_micros` existe e é lida nos três escopos; os
  valores ficam `null` porque um número de gasto por usuário seria política de
  produto inventada aqui. O teto **diário** que já existia é o de quota por
  apresentação, e é ele que conta.
- **Sem pacotes de excedente e sem conversão cambial** (§4.7, escopo excluído).
- **Preços de referência são estimativas provisionais.** O teto é o que protege:
  mesmo com preço superestimado, R$200/mês fecha a porta antes de gasto
  relevante.
- **Fiação no laço da fila.** A política já é aplicada no ponto de chamada paga
  (`extractUnderPolicy`, que consulta `requirePaidCall`) e na API; o secundário
  §8.3 continua **bloqueado** por construção, como na F2-06.
- **Nada de materialized view, telemetry, corpus, compose ou segredo** foi
  tocado. Migração aplicada **só em local**.
