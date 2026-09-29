# STK-F2-06 — Extração OCR/NLP fail-closed, persistência sanitizada e cota de extração

Unidade STK-F2-06 do Plano Master 2026 (§8.3, §4 princípios 1/5/6, §15). Base:
`e785b45` (main, com a STK-F2-05 já integrada).

Esta entrega **não** autoriza produção: sem merge, sem deploy, sem promoção e
sem aplicação da migração fora do ambiente local.

## 1. Objetivo

Quatro garantias, todas na fronteira da chamada paga:

1. **Fail-closed.** Timeout, interrupção de rede e resposta incerta
   interrompem o item para ação manual — sem retry e sem fallback automático.
2. **Nada bruto no banco.** Só estrutura sanitizada, versão do pipeline,
   hashes, categoria de erro, uso e desfecho.
3. **Cota só na apresentação.** A unidade é debitada quando a extração é
   APRESENTADA para revisão; falha técnica não consome nada.
4. **Dois resultados válidos → ambos apresentados**, e nada persistido como
   escolhido.

Mais a base estrutural do circuit breaker (global, diário e por usuário), que a
STK-F2-13 complementa sem mudar a forma.

## 2. Onde a política mora

Três camadas, cada uma com uma responsabilidade e nenhuma sobrepondo a outra:

| Camada        | Arquivo                                    | Responsabilidade                                             |
| ------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Contrato puro | `packages/shared/src/extraction-policy.ts` | categorias, desfechos, `quotaUnitForOutcome`, schema estrito |
| Persistência  | `packages/db/src/extraction-policy.ts`     | auditoria sanitizada, débito de cota, breakers               |
| Aplicação     | `apps/worker/src/extraction-policy.ts`     | a PORTA, a chamada única e o desfecho                        |

A regra da cota é uma função pura do desfecho, e isso é o ponto:

```ts
quotaUnitForOutcome('presented'); // 1
quotaUnitForOutcome('candidates_pending'); // 1
quotaUnitForOutcome('uncertain'); // 0
quotaUnitForOutcome('confirmed_failure'); // 0
quotaUnitForOutcome('refused_quota'); // 0
```

Não existe caminho em que "a chamada foi feita" incremente cota. Descarte
posterior do usuário **não** devolve a unidade: ela foi consumida pelo fato de a
extração ter sido apresentada.

## 3. Confirmada × incerta (§8.3)

O conjunto de categorias é fechado e a distinção é mecânica, não narrativa:

- `uncertain_timeout`, `uncertain_network` — a resposta **não** chegou. O
  fornecedor pode ter processado e cobrado; repetir ou trocar de modelo pode
  duplicar trabalho pago. Sem retry, sem secundário, item para o usuário.
- `confirmed_*` — a resposta chegou. Aí sim `secondaryAllowedAfter()` devolve
  `true` e o secundário §8.3 seria legítimo.
- `refused_quota` — nenhuma chamada foi feita, por decisão de orçamento.

Falha **confirmada** alimenta o circuit breaker; a **incerta** não. Um timeout
pode ter custado trabalho ao fornecedor, mas não é recusa do serviço, e abrir o
circuito por isso cobrarava disponibilidade sem causa.

## 4. Nada bruto — a sanitização é estrutural

`extractionAuditRecordSchema` é `strictObject` nos três níveis, e não existe
campo de texto livre. Um payload com `rawResponse`, `content`, `choices` ou
`prompt` é **rejeitado na borda** (`packages/db/src/extraction-policy.ts`),
antes de qualquer escrita. O banco nunca vê o texto porque não há onde ele
caber.

O que é persistido: `sanitized` (a estrutura), `candidates` (quando há dois
resultados), `usage` (inteiros), `pipeline_version`, os três hashes
(`prompt_sha256`, `response_sha256`, `image_sha256`), `error_category` e
`outcome`.

Os testes provam os dois lados: o que foi gravado contém a estrutura e os
hashes canônicos, e um payload com texto bruto é rejeitado pelo schema.

## 5. Modelo de dados (migração `0024_extraction_fail_closed`)

Forward-only e replay-safe (`IF NOT EXISTS`, `DROP ... IF EXISTS`, `DO $$ … END

$$ `), no mesmo padrão da 0010, 0011, 0021 e 0023. **Aplicada só em local.**

### `integration.inbox` — colunas novas

| Coluna                          | Tipo        | Notas                                          |
| ------------------------------- | ----------- | ---------------------------------------------- |
| `extraction_pipeline_version`   | text        | com qual regra a estrutura foi produzida       |
| `extraction_error_category`     | text        | código fechado, nunca texto de erro            |
| `extraction_outcome`            | text        | desfecho da extração                           |
| `extraction_prompt_sha256`      | text        | hash, nunca o prompt                           |
| `extraction_response_sha256`    | text        | hash, nunca a resposta                         |
| `extraction_presented_at`       | timestamptz | instante da apresentação — a verdade da cota   |

Coerência imposta por CHECK: `presented_at` existe **exatamente** nos desfechos
que contam unidade, e um desfecho de apresentação nunca carrega categoria de
erro.

### `integration.extraction_audit`

Uma linha por item e por chamada concluída, com o registro sanitizado, RLS
fail-closed (predicado explícito de organização, como as tabelas privadas) e
`selected` **sempre nulo** — a escolha entre dois resultados é do usuário.

`extraction_audit_presented_idx` é um índice **único parcial** sobre
`outcome_presented`: é o banco que impede a contagem dupla de um item, e não a
disciplina da aplicação.

### `integration.ai_circuit_breaker`

Base estrutural, GLOBAL e **sem RLS** — a falha do fornecedor não pertence a uma
organização, e um predicado de organização ali seria uma falsa fronteira (o
mesmo tratamento que a 0010 deu a `cursor` e `ai_usage_day`).

PK composta `(scope, scope_key)`, com `scope_key` = `global`, `daily` ou o id do
usuário, e um CHECK que impede os escopos globais de carregar chave de usuário.

### `integration.ai_usage_day` — o sinal da cota mudou

Antes a cota contava **requisições**, debitadas em `inbox.claim` (a reserva da
tentativa) — ou seja, uma falha técnica consumia cota sem nada ter sido
mostrado, exatamente o oposto do card. Agora:

- `presented` conta extrações apresentadas (a cota real);
- `uncertain`, `failed` e `refused` contam os desfechos sem consumo;
- `requests` continua somando os mesmos valores de antes, então o painel
  (STK-F2-11) e o monitor externo leem o mesmo total sem mudar.

`inbox.claim` deixou de debitar: ali sobrou só a **porta** (teto já atingido ⇒
`AI_LOCAL_QUOTA_REACHED`, sem chamada paga). O débito acontece em
`extraction_audit`, na mesma transação que grava a apresentação.

## 6. Circuit breaker

Falha confirmada consecutiva ≥ 5 abre o circuito, nos escopos `global`, `daily` e
`user` (o de usuário só existe quando há usuário identificado). A janela de
recuperação é de 15 minutos, já contida; a leitura trata janela vencida como
fechado, sem reescrever o banco.

Com teto atingido ou breaker aberto, `requirePaidCall` **registra a recusa**
(`refused_quota`, quota zero) e devolve o motivo — e o item continua
disponível para preenchimento manual. A recusa é decisão de orçamento, não
defeito do bilhete.

Os valores (5 falhas, 15 min) são a base estrutural do card; a STK-F2-13 ajusta
a política sem alterar a forma.

## 7. Testes (§15)

`tests/integration/extraction-fail-closed.test.ts` — 21 casos em PostgreSQL real,
dados fictícios, nenhuma chamada ao OpenRouter e nada de conteúdo em log:

- falha técnica **não** consome cota e **não** abre o circuito;
- falha confirmada não consome cota, mas alimenta o circuito;
- a apresentação consome exatamente uma unidade; reapresentar o mesmo item
  **não** debita de novo (o banco impede);
- dois resultados válidos contam uma unidade e não elegem nenhum (`selected`
  nulo);
- teto atingido recusa a chamada, não consome cota e preserva o item;
- o circuito abre na quinta falha confirmada, e não antes; falha incerta nunca o
  abre; o escopo por usuário é independente;
- o secundário §8.3 só é permitido depois de falha confirmada;
- o registro guarda estrutura/versão/hashes e um payload com texto bruto é
  rejeitado;
- o banco recusa coerência impossível (`presented` com categoria, `presented_at`
  sem desfecho de apresentação).

**Contadores de replay.** Os testes que derivam o limite do journal
(`tenant-registry`, `import-action-atomicity`) já leem `journal.entries.length`, e
a 0024 entra sozinha. A contagem de policies em `finance-tenant-isolation` foi
de 20 para 21 (+1 pela RLS de `extraction_audit`), e `inbox.test.ts` passou a
usar `presented` no teste de teto — que é a semântica nova.

## 8. Limitações conhecidas

- **O secundário §8.3 não está habilitado.** `secondaryAllowedAfter()` é a
  condição correta e está testada, mas nenhum registro de provedor novo foi
  adicionado: habilitá-lo é ato do orquestrador, não uma constante deste código.
- **`extractUnderPolicy` ainda não está ligado ao `integrations.ts`.** O worker
  continua chamando `extractTicket` diretamente; a política está pronta e
  testada, mas a fiação no laço da fila é o passo seguinte (F2-13), para que a
  troca de comportamento seja uma decisão revisada à parte.
- **O caso de dois resultados válidos é estrutural, mas não é produzido pelo
  caminho de um provedor só.** O modelo devolve uma escolha; fabricar um segundo
  seria inventar evidência. O registro, o desfecho, a cota e os CHECKs existem e
  são testados, e o serviço é quem recebe os dois quando houver dois provedores.
- Limiares (5 falhas, 15 min, 60/dia, 1500/mês) são estruturais e ficam para
  ajuste na STK-F2-13.
$$
