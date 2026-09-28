# STK-F2-05 — Fluxo Telegram: uma foto por vez, preview obrigatório, arquivo recuperável e duplicata determinística

Unidade STK-F2-05 do Plano Master 2026 (§8.2 e §15). Base: `8d99c0f` (main, com a
STK-F2-04 já integrada). Transporte: **o polling do worker existente** — nenhum
webhook, nenhum serviço novo (rejeitado em §8.2).

Esta entrega **não** autoriza produção: sem deploy, sem merge, sem promoção e sem
aplicação da migração fora do ambiente local.

## 1. Objetivo

O caminho da foto até o bilhete, com quatro garantias que o card nomeia e que a
implementação torna estruturais:

1. **Uma foto por vez.** A fila é serial por organização.
2. **Preview obrigatório.** Nenhuma escrita financeira antes de confirmar/editar/descartar.
3. **Arquivo recuperável por 30 dias.** Sem `/undo` temporizado.
4. **Duplicata por identidade determinística** da imagem + contexto, nunca por horário.

Mais uma separação que o card exige: `placedAt` vem da **mensagem original** e a
data do **evento** é outro campo, que nasce pendente e nunca é inferido do envio.

## 2. Modelo de dados (migration `0023_telegram_ticket_flow`)

Forward-only e replay-safe (`IF NOT EXISTS`, `DROP ... IF EXISTS`, `DO $$ … END $$`
para constraints e FKs), no mesmo padrão manual da 0010, 0011 e 0021.

### `integration.inbox` — colunas novas

| Coluna                  | Tipo        | Notas                                                                      |
| ----------------------- | ----------- | -------------------------------------------------------------------------- |
| `telegram_identity`     | text        | SHA-256 hex da identidade determinística; NULL fora do Telegram            |
| `telegram_duplicate_of` | uuid (FK)   | importação original apontada pela duplicata                                |
| `telegram_queue_state`  | text        | `none` \| `queued` \| `admitted` \| `preview` \| `duplicate` \| `archived` |
| `telegram_queued_at`    | timestamptz | ordem da fila                                                              |
| `telegram_admitted_at`  | timestamptz | início da admissão; usada para recuperar admissão abandonada               |
| `telegram_preview_at`   | timestamptz | prova de que o preview foi publicado antes da decisão                      |

Índices: `inbox_telegram_identity_idx` (organização + identidade, parcial) e
`inbox_telegram_queue_idx` (estado + chegada + id, parcial sobre `queued`/`admitted`).

### `integration.telegram_ticket_archive` — o arquivo de 30 dias

| Coluna              | Tipo        | Notas                                                  |
| ------------------- | ----------- | ------------------------------------------------------ |
| `id`                | uuid (PK)   |                                                        |
| `organization_id`   | uuid        | tenant, `ON DELETE cascade`                            |
| `inbox_id`          | uuid (FK)   | bilhete arquivado                                      |
| `identity`          | text        | identidade determinística, para reencontrar o registro |
| `reason`            | text        | `discarded` \| `duplicate` \| `superseded`             |
| `state`             | text        | `archived` \| `restored` \| `expired`                  |
| `archived_at`       | timestamptz | início da janela                                       |
| `recoverable_until` | timestamptz | **a verdade do prazo**: `> archived_at` (CHECK)        |
| `restored_at`       | timestamptz | coerência com `state = 'restored'` (CHECK)             |

`RLS` fail-closed com o predicado explícito de organização (o mesmo das tabelas
privadas de `finance`/`integration`).

Índice parcial `telegram_ticket_archive_live_idx` sobre `state = 'archived'`: é o
**banco** que garante no máximo um arquivo vivo por bilhete, então duas decisões
concorrentes não produzem dois arquivos nem duas janelas.

### Contadores de replay

Os testes de replay (`tenant-registry`, `import-action-atomicity`) derivam o
limite de marcadores do **journal**, não de uma constante escrita à mão, então a
0023 entra sozinha. Nenhum ajuste manual foi necessário — confirmado pela suíte
de integração completa verde.

## 3. As três garantias, no código

### Fila de uma foto por vez — `admitNext`

`pg_advisory_xact_lock` dedicado (782341096, sem colisão com os locks do
financeiro) serializa a admissão entre instâncias. A ordem vem de
`SELECT … ORDER BY telegram_queued_at, id … FOR UPDATE SKIP LOCKED` — **não** de
`ORDER BY` em `UPDATE`, que o PostgreSQL recusa. Com um `admitted` vivo, devolve
`null`: a próxima foto espera. Uma admissão abandonada (worker caiu) volta para
a fila depois de 15 minutos, para que uma foto presa não vire um bilhete perdido.

### Preview obrigatório — `publishPreview`

O módulo **não escreve** em `finance.bet`, `finance.journal` nem
`finance.posting`. Ele lê o rascunho e publica o preview. A vaga da fila é
liberada na publicação, não na decisão: a próxima foto pode entrar enquanto o
usuário confere a anterior, e quem protege o dinheiro é a **decisão**. A aposta
nasce exclusivamente por `confirmDraft`/`import.confirm`, com versão otimista e
chave idempotente determinística (importação + versão).

### Duplicata determinística — `enqueue`

```
identidade = SHA-256( sha256_da_imagem ‖ NUL ‖ contexto_normalizado )
```

O contexto é a legenda inteira normalizada (NFD sem diacríticos, espaços
colapsados, minúsculas, linhas vazias removidas). O id da mensagem, o `update_id`
e o instante **não entram** — são justamente o que muda entre o reenvio e o
original. A detecção é resolvida pelo índice do banco sob um advisory lock por
identidade, então duas mensagens no mesmo instante não se veem como ausentes.

A mesma foto com legenda **diferente** é um bilhete novo (é outra declaração), e
a mesma identidade em outra organização também é (a identidade é escopada pelo
tenant).

Motivos de duplicata: `image` (identidade), `reference` (referência declarada) e
`similar` (casa/valor/odd/data), sempre **adicionais** — a referência e a
semelhança nunca substituem a identidade nem a tratam como_timestamp.

### Arquivo recuperável — `archive` / `restore` / `expireRecoveries`

Descarte e duplicata **arquivam**; nada é apagado. A restauração devolve o
bilhete à fila de decisão — nunca cria uma aposta por reenvio. Duplicata **não é
recuperável** (o registro a recuperar é o original), e um arquivo já restaurado
responde `NOT_RECOVERABLE`. Fora dos 30 dias, `EXPIRED`.

## 4. Datas: envio ≠ evento

- `sentAt` = `telegram_received_at`, gravado no **recebimento** a partir do
  instante da mensagem original. Imutável.
- `eventAt` = data do **jogo**. Nasce `null` com `eventDateStatus = 'pending'` e
  só existe por declaração explícita (`updateDraft`), mesmo com a extração
  completa. Nunca é inferida de `sentAt`.

A mensagem do Telegram usa rótulos que não deixam dúvida: "📅 Enviado em" e
"🎮 Evento em", e o preview abre com "nada foi lançado ainda".

## 5. Privacidade

Bilhetes reais aparecem no preview, então:

- o preview é montado em um módulo próprio e **nunca** vai a log;
- todo erro no worker é um código sanitizado (`TELEGRAM_PREVIEW_SEND_FAILED`,
  `TELEGRAM_TICKET_QUEUE_FAILED`, …), sem legenda, extração, valor, nome ou id de
  mensagem;
- a auditoria (`finance.audit`) grava **estados e motivos**, nunca conteúdo;
- o teclado não carrega o id da importação no payload: a resolução é pelo
  vínculo canônico (chat + id da mensagem), como em toda a STK-G0-20.

## 6. Superfície da API

| Método | Rota                                                  | operationId                    |
| ------ | ----------------------------------------------------- | ------------------------------ |
| `GET`  | `/api/v1/telegram/tickets/:id/preview`                | `getTelegramTicketPreview`     |
| `POST` | `/api/v1/telegram/tickets/:id/decision`               | `decideTelegramTicketPreview`  |
| `GET`  | `/api/v1/telegram/tickets/archive`                    | `listTelegramTicketArchive`    |
| `POST` | `/api/v1/telegram/tickets/archive/:archiveId/restore` | `restoreTelegramTicketArchive` |

Mesmo gate privado do produto: sessão válida, consentimento vigente e Origin
igual à origem configurada em escrita. A organização vem **sempre** do usuário
autenticado; o corpo escolhe apenas a decisão (`confirm` | `discard` | `retry`) e a
versão lida.

Códigos novos: `TELEGRAM_TICKET_NOT_FOUND`, `TELEGRAM_TICKET_STATE_CONFLICT`,
`TELEGRAM_TICKET_DUPLICATE`, `TELEGRAM_TICKET_ARCHIVED`, `TELEGRAM_TICKET_EXPIRED`,
`TELEGRAM_TICKET_NOT_RECOVERABLE`, `TELEGRAM_TICKET_BUSY`.

## 7. Testes (§15)

- **Unit** (`tests/unit/telegram-ticket-flow.test.ts`, 26 casos): identidade
  determinística (reenvio reconhecido, forma da legenda ignorada, contexto e
  imagem distintos separados, colisão de campos impedida pelo separador NUL);
  contrato do preview (datas separadas, decisões explícitas, ausência de `undo`
  temporizado); mensagem de preview (nada lançado ainda, "Evento em: pendente",
  aviso de duplicata, janela de 30 dias, retry quando a extração falhou);
  teclado e callbacks sem identificador no payload.
- **Integração** (`tests/integration/telegram-ticket-flow.test.ts`, 17 casos,
  PostgreSQL real): uma foto por vez e ordem de chegada; organização alheia não
  bloqueada; admissão abandonada volta à fila; duplicata por identidade com
  **outro id de mensagem e três horas de diferença**; contexto diferente aceito;
  isolamento entre organizações; **nenhuma aposta/lançamento entre recebimento e
  confirmação** (contagem de `finance.bet` e exposição `0.00` antes e depois);
  confirmação é a única escrita e recusa versão errada; retry explícito (recusado
  fora de `failed`, aceito em `failed`, um pedido de extração só); arquivo de 30
  dias, restaura sem lançamento, `EXPIRED` fora da janela, duplicata não
  recuperável, expiração, e **sem segunda janela** ao rearquivar; data de envio do
  instante da mensagem e evento pendente, preenchido só por declaração.

## 8. Fora do escopo (como no card)

Webhook (rejeitado em §8.2); áudio/Whisper (§14); escrita automática sem
confirmação; `/undo` temporizado; materialised views; recomendações; IA narrativa.
Nenhuma alteração em `compose.*`, corpus privado, telemetria ou material de
produção. Nenhuma operação de merge, deploy, promoção ou migration em produção.

## 9. Notas de operação

- A migration `0023` é **local**. Produção exige o fluxo de autorização, backup e
  recuperação do runbook antes de aplicá-la.
- O username do bot e a fila continuam independentes: a STK-F2-04 não precisa
  mudar, e nenhuma variável de ambiente nova foi criada.
- A identidade gravada por organization_id + índice é o que torna a detecção
  segura entre instâncias do worker; a RLS sozinha esconderia o conflito entre
  organizações, então a unicidade é decidida pelo índice, não pela aplicação.
