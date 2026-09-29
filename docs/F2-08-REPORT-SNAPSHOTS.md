# STK-F2-08 — Relatórios: páginas HTML privadas + cadência por plano + snapshot imutável

Plano Master 2026 §8.6 e §15. Card de planejamento `t_68a91f45`.

## 1. O que foi entregue

O relatório deixou de ser "a tela de análises" e passou a ser um **documento
congelado**, entregue por uma página privada da conta do usuário:

- **Página HTML privada** (`/relatorios` na web, `/api/v1/report-snapshots*` na
  API): exige sessão do dono, não tem URL pública temporária, token no endereço,
  PDF, PNG, e-mail ou imagem compartilhável.
- **Cadência por plano**, avaliada no **fuso do usuário**: Free = nenhum envio
  automático (resumo mensal sob demanda pelo `/relatorio` da F2-07), Starter =
  semanal, Pro = diário + semanal + mensal. Diário às 21h, semanal na segunda
  às 9h, mensal no dia 1 às 9h.
- **Snapshot imutável e auditável**: cada emissão vira uma linha congelada com
  hash SHA-256 do conteúdo e a versão do financeiro que a produziu. Correção cria
  **versão 2 ao lado da 1**; o banco recusa `UPDATE` e `DELETE` por trigger.
- **Deduplicação de envio** por (janela × versão financeira), garantida por chave
  única no banco.
- **Narrativa inicial determinística**, derivada dos números e de heurísticas do
  produto. **Sem IA generativa** (§6.2).

## 2. O que foi REUTILIZADO (e não duplicado)

| Requisito                | Onde já existia                          | Como foi usado                                                                |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `/relatorio`             | F2-07 (`telegram-commands.ts`)           | o comando agora aponta para a rota privada; não gera nem envia nada           |
| Entitlement por plano    | F2-13 (`core.organization_entitlements`) | o job lê o plano **do banco** e só então consulta a cadência do produto       |
| Métricas e comparações   | F2-02 (`dashboard`) e F2-03 (`splits`)   | o snapshot congela a **mesma** agregação; nenhuma consulta nova               |
| Envio Telegram           | F2-05/F2-07 (`telegram.ts`, outbox)      | o job usa o mesmo cliente e o mesmo canal; nenhum transporte novo             |
| Fuso e preferências      | F2-10 (`notification.preference`)        | o job lê o fuso pela MESMA tabela e pela MESMA função                         |
| Quaisquer 4 rotas da API | padrão `registerXRoutes`                 | o gate é o mesmo das demais (sessão + consentimento + organização do usuário) |

## 3. Modelo de dados — migração `0027_report_snapshots`

> **Numeração reservada.** A 0026 pertence à STK-F2-09 (branch paralela
> `stk/f2-09-import-csv`) e ainda não existe no journal da `main`. Esta migração
> usa **0027** e ocupa o último `idx` (26) sem a 0026; o replay test fixa essa
> decisão para que a colisão não passe despercebida.

Duas tabelas, ambas com RLS fail-closed e predicado por organização
(`nullif(current_setting(...), '')::uuid`, a mesma fronteira de
`core.organization_entitlement`, 0025):

### `integration.report_snapshot`

Uma linha por **versão publicada** de um par (período, janela).

- `version` é a revisão dentro do mesmo par: 1 = original, 2+ = revisões.
- `financial_version` amarra o número mostrado ao estado de `finance.settings`.
- `content_sha256` é o SHA-256 da **forma canônica** do payload (chaves
  ordenadas), com CHECK que exige um digest de 64 hex — um payload sem
  verificação possível não entra.
- `metrics` e `payload` guardam o relatório congelado: a página renderiza
  **exatamente** o que foi enviado, sem recomputar.
- **Chave única** em `(organization_id, period, from, to, version)`.
- **Imutabilidade por trigger**: `integration.immutable_report_snapshot` recusa
  `UPDATE` e `DELETE` com `REPORT_SNAPSHOT_IMMUTABLE` (SQLSTATE 23514). A
  garantia é do banco, não da disciplina do chamador.
- CHECK do motivo: versão 1 sem motivo, versão > 1 **com** motivo.

> **Por que o índice único é por VERSÃO e não por versão financeira.** Uma
> revisão nasce, por definição, do mesmo estado do financeiro que a versão 1 (é
> o DADO do usuário que mudou, não o saldo). Um índice único por versão
> financeira recusaria a revisão — e o teste de integração provou isso na
> prática antes da correção. A dedupe de ENVIO vive em `report_delivery`, cuja
> chave já carrega a versão financeira; são duas perguntas, em duas tabelas.

### `integration.report_delivery`

O registro do que foi **entregue**, separado do snapshot porque a entrega é o
que falha e repete.

- `dedupe_key` (por janela × versão financeira) é a chave de idempotência.
- `channel` tem **CHECK `= 'telegram'`**: e-mail, PDF, PNG e webhook são
  recusados pelo banco (§6.2), não por convenção da aplicação.
- Estados: `pending` → `delivered` \| `failed`; `skipped_no_data` marca a janela
  sem apostas.
- A entrega que falha volta para `pending` com **backoff** e vira `failed` na
  quinta tentativa. Marcar como entregue sem ter entregado é proibido pelo
  desenho: o relatório sumiria e ninguém saberia que faltou.

### RLS

Ambas com `organization_isolation` e predicado explícito. Sem contexto de
organização, a expressão devolve NULL e a comparação não casa **nenhuma** linha
— a falha fechada é a contagem zero, não uma exceção (o mesmo padrão de
`core.organization_entitlement`, 0025).

### Forward-only e replay-safe

`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` e `DROP POLICY IF EXISTS`.
Provas: `tests/integration/report-snapshots-replay.test.ts`.

## 4. Onde está a lógica

| Camada            | Arquivo                                            | Responsabilidade                                                                                           |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Pura (shared)     | `packages/shared/src/report-snapshots.ts`          | cadência por plano, horário por fuso, janela, chave de dedupe, narrativa, resumo do Telegram, link privado |
| Contrato (shared) | `packages/shared/src/report-snapshot-contract.ts`  | forma do payload da página e blocos de número                                                              |
| Domínio (db)      | `packages/db/src/report-snapshots.ts`              | gerar, versionar, reservar envio, concluir entrega, listar                                                 |
| Esquema (db)      | `packages/db/src/report-snapshot-schema.ts`        | espelho Drizzle das duas tabelas                                                                           |
| Migração          | `packages/db/migrations/0027_report_snapshots.sql` | DDL, RLS, trigger de imutabilidade, CHECKs                                                                 |
| API               | `apps/api/src/report-snapshot-routes.ts`           | 4 rotas autenticadas                                                                                       |
| Worker            | `apps/worker/src/report-cadence.ts`                | job de cadência: plano → fuso → horário → dados → reserva → envio                                          |
| Web               | `apps/web/src/product/reports.tsx`                 | a página privada                                                                                           |

## 5. Decisões que valem ser revisadas

**1. A cadência é do PRODUTO, o plano é do BANCO.** A F2-13 resolve o plano
efetivo em `core.organization_entitlements`; o catálogo `AUTOMATIC_CADENCE_BY_PLAN`
diz o que aquele plano **oferece**. Nenhum dos dois é recalculado aqui. O
`free` não tem envio automático — o card diz "resumo mensal **via `/relatorio`**",
e "via comando" é o oposto de automático.

**2. "A partir de" o horário, não "exatamente".** O job roda a cada 5 minutos e
pode atrasar; `reportPeriodIsDue` devolve `true` a partir do horário. A dedupe é
o que impede que atravessar as 21h vire três envios. Um igual-exatamente
perderia o relatório do dia sempre que o worker atrasasse.

**3. A revisão NÃO é reenviada.** Uma revisão nasce do mesmo estado do
financeiro, então a chave de dedupe é a mesma e a reserva é recusada. O card
exclui reenvio automático, e o teste de integração prova isso contra o banco.

**4. A narrativa separa `fact` de `heuristic`.** Cada linha carrega o número
que a produziu. Abaixo do limiar de amostra, a narrativa avisa e **não**
interpreta percentuais — a F2-02 já decidiu que `N < minSample` mostra só número
cru, e interpretar 4 apostas como tendência seria inventar leitura.

**5. Participação em MAGNITUDE.** Numa janela negativa, a casa com o MAIOR
resultado (`-10,00` < `-2,00` em ordem numérica) é a de **menor** perda.
"Concentra X% do resultado" é calculado em módulo, senão apareceria `-50%`, que
não é uma leitura. Com resultado zero, a frase não inventa participação.

**6. Ausência é resposta, não zero.** `reportHasData` é a MESMA função no job e
na API. Sem apostas, nada é congelado e nada é enviado: um P&L de `R$ 0,00`
afirmaria que o usuário apostou e não perdeu nada, que é uma leitura errada.

**7. O hash é da forma canônica.** `JSON.stringify` depende da ordem das
chaves, que muda entre versões do Node; um snapshot que "mudasse de hash" sem
mudar de número seria um falso positivo de auditoria.

## 6. Segurança

- **A organização vem do usuário autenticado**, nunca do corpo nem do id da URL.
  Snapshot de outra organização devolve **404** — o mesmo código de inexistente,
  porque um 403 confirmaria que o id existe.
- **A RLS é fail-closed**: sem contexto, zero linhas.
- **A página não tem download.** Não existe botão de PDF, PNG, "copiar imagem"
  nem link público; a ausência é o requisito (§6.2), não uma lacuna.
- **A mensagem do Telegram** carrega o resumo e o endereço do produto. Testes
  verificam por texto que ela não contém `pdf|png|jpeg|imagem`, `token=`, `sig=`
  nem `exp=`.
- **Logs sanitizados**: só códigos. A resposta bruta do Telegram nunca é
  gravada (`sanitizeReportDeliveryError`).
- **A narrativa não chama modelo.** Nenhum caminho deste card faz chamada de IA.

## 7. Testes — §15 Relatórios

`tests/unit/report-snapshots.test.ts` — 39 testes, sem banco, sem rede, com o
instante **injetado**:

- cadência por plano (Free sem automático; Starter semanal; Pro três);
- **fuso do usuário**: o mesmo instante produz 20:30 em São Paulo e 19:30 em
  Manaus; 21h vence num e não no outro; a janela semanal é a **mesma** do
  `/semana` da F2-07; um fuso inválido **nunca** envia;
- ausência de dados (mesma função para job e página);
- dedupe: a chave não muda com o instante e muda com a versão financeira;
- link privado: sem `?`, sem `=`, rota validada contra injeção de caminho;
- narrativa: determinística, `fact` vs `heuristic`, amostra pequena sem
  interpretação, "sem base" ≠ "0%", participação em módulo, zero sem fração;
- resumo do Telegram: número + link, e nada de arquivo/e-mail/token.

`tests/integration/report-snapshots.test.ts` — 30 testes, **PostgreSQL real**,
banco descartável, dados fictícios:

- o snapshot carrega as **mesmas** métricas do dashboard da F2-02 (prova de que
  a página e a tela de análises não divergem);
- **`UPDATE` e `DELETE` recusados pelo trigger** (23514);
- o banco recusa hash que não é digest, e versão sem motivo;
- **revisão versionada**: v2 ao lado da v1, motivo gravado, v1 intacta e legível;
  revisar v1 depois de v2 dá `REPORT_SNAPSHOT_NOT_REVISABLE`, não um 23514 opaco;
- **sem dados não publica**: `null` e zero linhas gravadas;
- **isolamento**: snapshot de outro tenant é `null` (404), listagem vazia, RLS
  devolve **zero** sem contexto;
- **dedupe pelo banco**: a segunda reserva da mesma janela é `null`; a versão
  revisada **não** é reenviada;
- entrega só é `delivered` após sucesso; falha volta para `pending` com
  `attempts`++; esgotada vira `failed` com o **código**, não a mensagem;
- **cadência pelo plano do banco**: sem atribuição → `free` → 0 envios; `pro`
  lido de `core.organization_entitlements` habilita as três; o horário é do
  fuso do usuário; dois passes no mesmo instante enviam **um** por cadência;
- **API**: 401 sem sessão, contrato da página, `empty` para janela vazia, 404
  `REPORT_SNAPSHOT_NOT_FOUND` para id inexistente, revisão cria v2.

`tests/integration/report-snapshots-replay.test.ts` — replay da 0027 e canal
exclusivo.

## 8. Fora do escopo (e por quê)

- **E-mail, PDF, PNG, imagem compartilhável** — rejeitados por §6.2. O CHECK do
  canal no banco é o que impede um segundo destino de nascer por conveniência.
- **IA generativa na narrativa** — §6.2. A narrativa é função pura dos números.
- **Reenvio automático da versão revisada** — exclusão explícita do card.
- **Preço, cobrança, upgrade** — Fase 4 (Mercado Pago). A F2-13 já gravou
  `plan.billable = false` como CHECK; a cadência é direito do beta.
- **Deploy, migração em produção, merge, promoção** — fora do escopo autorizado
  neste card. A 0027 é **LOCAL**.

## 9. Limitações conhecidas

1. **A correção criadora (`0027`) precisa ser reconciliada com a `0026` da
   F2-09** quando as duas branches convergirem: o journal terá duas entradas
   não contíguas. A ordem de aplicação é indiferente (as migrações são
   independentes e ambas `IF NOT EXISTS`), mas o journal precisa ganhar a 0026
   com `idx` correto **antes** do próximo `migrate` local, ou o runner não a
   encontra.
2. **O job de cadência só existe quando o Telegram está configurado.**
   `readTelegramConfig` devolve `null` sem `TELEGRAM_ENABLED=true` e o job não
   sobe. Sem canal, o relatório continua disponível na página privada — que é o
   comportamento correto, já que o card exclui todos os outros destinos.
3. **O destinatário do envio é o `owner` mais antigo** da organização, o mesmo
   que a F2-10 usa para quiet hours. O card não define multi-dono por
   organização; se a F1-03 evoluir nesse sentido, o job precisa acompanhar.
4. **A página mostra a última versão por padrão**; versões antigas são
   acessíveis pelo histórico, e a tela mostra a lista de revisões apenas quando
   há mais de uma.
5. **A cadência não é configurável pelo usuário.** O horário é do produto
   (§8.6 fixa 21h/9h/9h) e a janela é o recorte de §3.8. Não há opt-out além
   de não estar em plano com cadência; um tenant Pro que não queira o diário
   não tem como desligá-lo sem mudança de produto.
6. **A revisão exige justificativa** (1–200 caracteres) e cria versão mesmo que
   o conteúdo não mude. Não há "revisão sem alteração" — se o dado não mudou,
   revisar não é a operação certa.
