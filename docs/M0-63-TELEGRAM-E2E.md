# STK-M0-63 — Ensaio funcional ponta a ponta do consumidor Telegram

Data: 2026-09-13. Base: `ee1016e14c64ff3fe0917c4f46617554e0b5adea`.
Ensaio em produção do fluxo real do consumidor com **exatamente um bilhete
privado novo**, escolhido e enviado manualmente pelo proprietário ao bot
privado após a declaração `JANELA_PRONTA`. Execução pelo Hermes; aprovação do
Codex retransmitida pelo proprietário (regra 8 do [AGENTS.md](../AGENTS.md)).

**Classificação: PARCIAL** — a cadeia foi consumida até R2 + IA com as
garantias válidas (identidade, anexo único, uma única tentativa de IA, R2
writer/reader, zero efeito financeiro, item preservado); a **extração não
completou**: a tentativa recebeu uma resposta HTTP não aceita, classificada
pelo código como `AI_PROVIDER_UNAVAILABLE`. O status HTTP não foi persistido
nesta execução; portanto, a evidência não distingue erro de
requisição/modelo/parâmetros, endpoint inexistente, erro 5xx ou outra resposta
não allowlisted.

## 1. Autorização retransmitida pelo proprietário

> Autorizo o processamento de exatamente uma imagem privada de bilhete,
> selecionada e enviada manualmente por mim ao bot privado do Stakeframe.
>
> Autorizo que essa imagem seja:
>
> - recebida pelo consumidor já configurado;
> - armazenada no bucket privado R2 de anexos;
> - processada uma única vez pelo modelo OpenRouter configurado;
> - exibida exclusivamente na revisão privada do Stakeframe.
>
> Autorizo no máximo uma inferência paga para esse bilhete, dentro do orçamento
> já configurado. Não autorizo confirmação da importação, criação de aposta,
> alteração de saldo, liquidação, exclusão do anexo ou envio da imagem a
> qualquer outro destino.

O bilhete não foi enviado ao Hermes nem ao Codex; o proprietário o enviou
diretamente ao bot privado, somente após a declaração `JANELA_PRONTA`.

## 2. Pré-janela (somente leitura — gates satisfeitos)

- `origin/main = ee1016e14c64ff3fe0917c4f46617554e0b5adea`; CI pós-merge 5/5;
- worker `running`/`healthy`, `restarts=0` (desde 2026-09-12 23:55:53Z);
- monitor `ready`, HTTP 200, `lastError=null` (leitura autenticada 03:49:51Z);
- advisory lock `782341094` presente; `/budget = ready`;
- `IDENTIDADE_CONFERE=true` (STK-M0-60 §5; nenhuma alteração de configuração
  desde então);
- filas vazias (`pgboss.job` 0; `inbox` 0; `extraction_request` 0; anexos 0);
- R2 reader/writer presentes por metadados (7 mounts, 2 de R2);
- `ai_usage_day` 0/0 (abaixo das cotas); logs do worker sem códigos de falha;
- aplicação privada acessível ao proprietário (tela de importações
  confirmada).

Gate final às 04:01:27Z (worker, `/`, `/budget`, contagens e cursor
revalidados). `JANELA_PRONTA` declarada às ~04:02Z.

## 3. Horários (UTC)

| Fase                                       | Horário             |
| ------------------------------------------ | ------------------- |
| Gate final pré-janela                      | 2026-09-13 04:01:27 |
| `JANELA_PRONTA` declarada                  | ~04:02              |
| Envio manual do bilhete (proprietário)     | ~04:03              |
| Item registrado no inbox                   | ~04:03:40           |
| Falha sanitizada registrada                | 04:03:43            |
| Primeira observação sanitizada (contagens) | 04:04:17            |
| Leitura autenticada final do `/status`     | 04:13:36            |

## 4. Transições sanitizadas

- **`inbox` (1 item):** `failed` · `attempts=1` · `error_code=
AI_PROVIDER_UNAVAILABLE` · `attachment_id` presente · sem extração
  persistida · sem aposta (`imported_bet_id` nulo) · `updated_at` 04:03:43Z,
  estável desde então.
- **`attachment` (1):** `remote` · `remote_attempted=true` · `object_key`
  presente · 23.877 bytes · 450×421 · 21 s do recebimento ao estado final
  (a imagem não foi lida nem copiada).
- **`extraction_request`:** 0 — a cadeia falhou antes de criar a extração.
- **`ai_usage_day` (2026-09-13):** `requests=1` — **exatamente uma tentativa
  paga**, sem repetição automática (`attempts=1`).
- **Cursor Telegram:** avançou com o envio; valor não registrado; nenhum outro
  consumo.
- **Filas:** nada em `pending`/`processing`; nenhum item preso.

## 5. R2 writer e reader

- **Writer comprovado:** objeto privado gravado no bucket de anexos
  (`remote` + `object_key` presente no registro do anexo).
- **Reader/interface comprovado:** `IMAGEM_VISIVEL=true` — o proprietário vê a
  imagem do bilhete na revisão privada. `RESULTADO_VISIVEL=false` — não há
  resultado (a extração não completou). Nenhum conteúdo foi copiado para o
  registro.

## 6. Efeito financeiro

**Zero.** As 11 tabelas do schema `finance` permaneceram idênticas ao baseline
da pré-janela: `account=6`, `audit=6`, `bet=1`, `command_receipt=6`,
`freebet=0`, `journal=4`, `monthly_unit=1`, `posting=9`, `selection=1`,
`settlement=1`, `settlement_reversal=0`. Nenhuma confirmação de importação,
aposta, lançamento, liquidação ou alteração de saldo.

## 6.1. Monitor: pares de alertas observados

Durante a vizinhança da janela foram observados **pares de alertas do monitor**
(atenção → recuperação no ciclo seguinte), reportados pelo proprietário apenas
como recebidos: ~03:30/03:35Z e ~04:00/04:05Z, com **correlação temporal
compatível com a janela de backup de 30 min** (`OPS_BACKUP_VERIFIED` foi
observado no log do serviço de operações na janela 03:55–04:10Z; os checks
degradados não foram capturados; etiquetas não registradas). O par das 04:00Z
antecede o processamento do bilhete (04:03:40Z). Nenhuma ação foi tomada (sem
reinício, sem alteração).

## 7. Estado final (worker e monitor)

- Worker `running`/`healthy`, `restarts=0` (verificado 04:17:05Z).
- Monitor `ready`, HTTP 200, `lastError=null`, `lastSignature=ready` (leitura
  autenticada 04:13:36Z; ciclo 04:10:43Z).
- `/` e `/budget` = `ready`; advisory lock `782341094` presente; item do
  ensaio preservado em `failed`.

## 8. Item preservado

O item permanece em `failed`, **sem reprocessamento, sem exclusão e sem
confirmação** — nenhum clique em confirmar/importar/aprovar foi feito. O
reprocessamento explícito permanece inteiramente fora do escopo desta tarefa e
depende de decisão posterior.

## 9. Classificação: PARCIAL

- **Comprovados:** identidade autorizada; recepção e consumo do update único;
  anexo único admitido; **R2 writer**; **R2 reader/interface**
  (`IMAGEM_VISIVEL=true`); uma única tentativa de IA (sem repetição
  automática); nenhum efeito financeiro; filas sem item preso; item
  preservado; monitor e worker saudáveis.
- **Não completado:** extração e resultado para revisão. A tentativa recebeu
  uma resposta HTTP não aceita, classificada pelo código como
  `AI_PROVIDER_UNAVAILABLE`. O status HTTP não foi persistido nesta execução;
  portanto, a evidência não distingue erro de requisição/modelo/parâmetros,
  endpoint inexistente, erro 5xx ou outra resposta não allowlisted.
  Reprocessamento não tentado (fora da autorização).

## 10. Confirmações

- Zero segredos lidos, copiados ou registrados; bearer apenas no procedimento
  privado do proprietário.
- Zero exposição de conteúdo: sem imagem, texto, IDs privados, odds, valores
  ou payload (somente códigos, contagens, dimensões e booleanos sanitizados).
- Zero mutações além do processamento normal autorizado: nenhuma confirmação,
  importação, aposta, liquidação ou alteração de saldo; nenhuma exclusão;
  nenhum reinício de serviço; nenhuma chamada externa adicional.
- O ensaio **não** usou mensagem artificial do Hermes: o bilhete foi enviado
  pelo proprietário ao bot privado.

Referências: [TELEGRAM.md](TELEGRAM.md),
[INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md),
[M0-61-WORKER-REACTIVATION.md](M0-61-WORKER-REACTIVATION.md),
[M0-CHECKLIST.md](M0-CHECKLIST.md).
