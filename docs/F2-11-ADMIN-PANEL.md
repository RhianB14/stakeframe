# STK-F2-11 — Painel interno mínimo do superadmin

> Unidade do Plano Master 2026 (§7.2 superadmin, §15 Plano de testes).
> Escopo: rota interna autenticada restrita ao papel `superadmin`, com quatro
> visões de **metadados** (contas, uso/cotas/filas, flags, erros recentes) e
> auditoria de todos os acessos. **Sem impersonação.**

## O que existe

| Rota                         | Visão     | Conteúdo                                                                                                                                                 |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/accounts` | Contas    | Rótulo da organização, papel, onboarding, consentimentos aceitos, estado de exclusão, sessões ativas, último acesso. Paginado (`limit` 1–200, `offset`). |
| `GET /api/v1/admin/usage`    | Uso       | Cota de IA (global, somada entre organizações) e contagens de fila por organização.                                                                      |
| `GET /api/v1/admin/flags`    | Flags     | Toggles operacionais configurados no processo e as chaves de rollout realmente consultadas.                                                              |
| `GET /api/v1/admin/errors`   | Erros     | Falhas por **código** e origem (importação, busca de evento, saída do Telegram), com contagem e última ocorrência.                                       |
| `GET /api/v1/admin/audit`    | Auditoria | A própria trilha de acessos a este painel.                                                                                                               |

No cliente web, `/admin` monta a página do painel — e **só** para uma sessão
`superadmin`. Qualquer outro papel não vê tela de acesso negado: o servidor
responde 404 e o produto segue o fluxo normal.

## Autorização (fail-closed, sem anunciar a superfície)

A ordem das checagens é fixa e nenhuma etapa pode ser pulada:

1. **Sem `ownerAuth` ou sem serviço** → `404 NOT_FOUND` (a rota não existe).
2. **Sem sessão válida** → `401 UNAUTHENTICATED`.
3. **Consentimentos vigentes pendentes** → `403 CONSENT_REQUIRED` — a mesma
   regra das demais rotas privadas; nenhuma organização é resolvida antes.
4. **Papel diferente de `superadmin`** → `404 NOT_FOUND`, com a tentativa
   gravada na auditoria.

O `404` do passo 4 é deliberado: um `403` confirmaria a existência de uma
superfície interna a quem não tem o papel. O papel vem **sempre** do
membership da sessão (campo `organization.role` devolvido por `getOwner`).

### Impersonação

Não existe. Nenhuma rota do painel aceita usuário ou organização de destino, e
nenhuma delas abre os dados de um tenant — o painel **lista** contas, não abre
a conta de alguém. Um parâmetro de destino na query é ignorado pelo schema
estrito, nunca aplicado.

## Auditoria

Migração `0020_admin_panel_audit.sql` cria `core.admin_panel_access` com uma
linha por **tentativa** — permitidas e recusadas:

| Coluna          | Conteúdo                                                         |
| --------------- | ---------------------------------------------------------------- |
| `actor_user_id` | id interno de quem tentou (FK `auth.user`, `ON DELETE restrict`) |
| `view`          | `accounts` \| `usage` \| `flags` \| `errors` \| `audit`          |
| `outcome`       | `allowed` \| `denied`                                            |
| `request_id`    | id da requisição gerado pelo servidor (correlação com o log)     |
| `created_at`    | instante                                                         |

Sem e-mail, IP, user-agent, cookie, sessão, corpo de requisição ou conteúdo de
usuário. A tabela é **global** (não escopada por organização) porque o painel é
a única superfície que atravessa tenants e a trilha não pode depender — nem ser
apagada junto — do contexto de uma organização.

A gravação acontece **antes** de qualquer leitura. Se a auditoria não puder ser
escrita, a rota responde `503` em vez de servir uma visão sem registro.

A trilha é **somente-adição**: o trigger `admin_panel_access_immutable`
(`core.immutable_admin_audit`) recusa `UPDATE` e `DELETE` com
`ADMIN_AUDIT_IMMUTABLE`. Reescrever ou apagar a evidência de um acesso anularia
a única prova de um abuso.

## Nenhum conteúdo de usuário

O serviço devolve apenas contagens agregadas no próprio SQL e códigos de erro.
Nenhuma consulta do painel seleciona aposta, lançamento, posting, saldo,
resultado, imagem, legenda, checkpoint de extração, nome ou e-mail. O teste de
integração semeia conteúdo privado real (journal, posting, caption, hash do
comprovante, nome e e-mail distintivos) e exige que **nenhum** deles apareça
serializado em qualquer payload.

O id interno do usuário **aparece** — é metadado de conta e o mesmo pseudônimo
que `/api/v1/me` já devolve ao dono. Nome e e-mail, não.

## Isolamento entre organizações

O painel é, por desenho, o único serviço do produto que atravessa tenants. Por
isso:

- **Filas e erros** são lidos em `withOrganizationTransaction` **por
  organização**, com o predicado explícito
  `organization_id = current_setting($$app.organization_id$$, true)::uuid` em
  cada sub-select. Nunca um `count` sem escopo.
- **`core.*` e `auth.session`** são dados de registro, não conteúdo privado, e
  são lidos direto: o contexto de tenant esconderia justamente as linhas que o
  painel precisa mostrar.
- **`integration.ai_usage_day`** é infraestrutura global e **não** leva
  predicado — a cota do provedor protege a infraestrutura inteira e escopá-la
  por tenant faria cada organização multiplicar o limite em silêncio. O teste
  semeia uso em duas organizações e exige a **soma** (50 = 30 + 20), que uma
  implementação por tenant devolveria como 30.

Cada visão declara `truncated` quando o teto de linhas corta o resultado, em vez
de devolver um conjunto silenciosamente incompleto.

## Erros recentes e Sentry

A visão de erros **não consulta o Sentry**. Ela agrega os códigos de falha que o
próprio produto já grava (`inbox.error_code`, `event_search.error_code`,
`telegram_outbox.last_error`) e publica o **estado** da telemetria: Sentry ligado
e seu ambiente, PostHog, Better Stack e o modo debug.

O DSN do Sentry é segredo e não sai daqui. A integração existente do repositório
(`apps/api/src/telemetry.ts`, init em runtime) é usada como fonte do estado, sem
token, sem chamada de rede externa e sem mudar a coleta. Trazer/issues do Sentry
exigiria um escopo de credenciais próprio e está fora desta unidade.

## Flags

`flags` publica os toggles operacionais realmente validados por
`readTelemetryConfig` e as chaves de rollout que o produto consulta. Hoje essa
lista é **vazia** (`keys: []`) e o `source` é `none` sem PostHog: o painel
informa o que existe, nunca o que se imagina. Um produto que passe a ler uma
flag real deve lê-la do mesmo catálogo que o painel publica.

## Testes (§15)

`tests/unit/admin-panel.test.ts` (8 casos) — autorização por papel:

- sem `ownerAuth` e sem serviço → 404;
- sem sessão → 401;
- consentimento pendente → 403 `CONSENT_REQUIRED`;
- `owner` em **todas** as cinco visões → 404 (nunca 403) e recusa auditada;
- `superadmin` → 200 nas cinco visões;
- parâmetro de destino ignorado (não há impersonação);
- auditoria falhando → 503, sem servir a visão;
- paginação validada (400 em `limit=0`, `limit=201`, `offset=-1`).

`tests/integration/admin-panel.test.ts` (8 casos) — auditoria, restrição de dados
e isolamento, contra o PostgreSQL descartável:

- tentativa permitida gravada **antes** da resposta, com `requestId`;
- recusa grava só `denied` e nenhuma visão é servida;
- `UPDATE`/`DELETE` na trilha recusados por `ADMIN_AUDIT_IMMUTABLE`;
- conteúdo privado semeado ausente de **todos** os payloads serializados;
- cota de IA somada entre as organizações (o caso por tenant falharia);
- fila e erros contados por organização, sem vazar entre tenants;
- estado da telemetria publicado sem nenhum segredo nem DSN;
- rota: 200 para `superadmin`, 404 para `owner`, com auditoria nos dois casos.

## Banco

`0020_admin_panel_audit.sql` — **preparada, não executada em produção**. É
replay-safe (função `CREATE OR REPLACE`, trigger `DROP IF EXISTS`), e o harness
de upgrade remove os objetos dela antes de reaplicar a cadeia.

## Fora do escopo (por decisão do plano)

- **Impersonação** — proibida (§7.2).
- **Acesso ao conteúdo** das contas (bilhetes, comprovantes, extrato) — exigiria
  consentimento, justificativa e auditoria própria; não faz parte do painel.
- **Gestão de planos e cobrança** — Fase 4.
- **Implantação, migração em produção, release e promoção** — fora desta
  unidade; a migration é preparada e validada só localmente.
