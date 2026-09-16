# STK-F1-09 — Onboarding inicial do beta (primeiros passos em três etapas)

> Unidade do Plano Master Stakeframe 2026 (§8.1). Escopo: fluxo inicial autenticado do beta —
> (1) perfil, fuso horário e preferências essenciais; (2) primeira banca, reutilizando o comando
> financeiro existente; (3) primeira aposta manual ou encaminhamento para a conexão do Telegram.
> O prompt desta tarefa referiu a unidade como "STK-F2-01 — onboarding inicial do beta"; no board
> o onboarding em três passos é o card `t_7354fbde` (STK-F1-09) e o card "STK-F2-01" é o redesign
> incremental (escopo distinto, dependente deste). Não há cards duplicados.

## 1. Modelo de dados (`migração 0008_onboarding_state`)

### `core.onboarding_state` — progresso por usuário, escopo por organização

| Coluna                  | Tipo                        | Notas                                                                       |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `user_id`               | text PK → `auth."user"(id)` | um registro por usuário; `ON DELETE CASCADE`                                |
| `organization_id`       | uuid → `core.organization`  | **escopo multi-tenant**; `NOT NULL`, índice próprio; `ON DELETE CASCADE`    |
| `timezone`              | text (nullable)             | preferência essencial; validada como IANA no servidor                       |
| `profile_completed_at`  | timestamptz (nullable)      | passo 1 concluído (gravado junto com nome + fuso)                           |
| `first_bet_deferred_at` | timestamptz (nullable)      | **escolha explícita** de concluir sem aposta ("conectar o Telegram depois") |
| `completed_at`          | timestamptz (nullable)      | primeiros passos concluídos (ação explícita do passo 3, sob gate)           |
| `created_at/updated_at` | timestamptz                 | defaults do schema `core`                                                   |

Garantia de banco: `CHECK (timezone is null or btrim(timezone) <> '')`.

**Uma fonte por dado** — o que o núcleo financeiro responde não é duplicado aqui:

- **passo 2 (banca)** = `finance.settings.initialized` (o próprio comando existente);
- **passo 3 (primeira aposta)** = aposta registrada (`finance.bet`, `resolution: "registered"`)
  **ou** a escolha explícita registrada em `first_bet_deferred_at` (`resolution: "deferred"`);
- **nome exibido** = `auth."user".name` (o onboarding grava, o produto lê).

### Isolamento

- Toda leitura/escrita é filtrada por `(user_id, organization_id)`; o upsert é guardado
  (`WHERE state.organization_id = excluded.organization_id`), então uma linha de outra
  organização nunca é sobrescrita — o guard recusa e o serviço devolve erro sanitizado.
- A organização vem sempre do usuário autenticado (`ensureOrganizationMembership`, idempotente);
  nada é aceito do corpo, de query string ou de cookie.
- Nenhuma linha de outra organização é exposta: o estado é sempre o do próprio usuário.
- **Flags financeiras (âncora):** enquanto o finance for single-tenant, as flags de banca e
  primeira aposta pertencem ao **espaço ancorado** — a organização do membership `owner` mais
  antigo (determinístico por `created_at, organization_id`). **Somente a organização ancorada**
  recebe essas flags; qualquer outra organização vê os dois passos como não configurados (a
  banca dela não existe até o F1-13) e tem o `finish` recusado fail-closed. O onboarding assim
  **não expõe o estado financeiro de outra organização** — sem inventar dados e sem criar
  lógica contábil paralela.

### Dependência declarada (sem antecipar)

O núcleo financeiro ainda é single-tenant (`finance.settings` singleton, sem
`organization_id`) — o multi-tenant pleno do finance é a **STK-F1-13 (PLANNED)**. O passo 2
reutiliza o comando exatamente como ele existe hoje e **não há alegação de isolamento
financeiro completo**: a leitura por organização (banca e aposta) substitui a âncora quando o
F1-13 avançar, sem mudança de contrato deste onboarding.

## 2. API

Autenticadas (`sessão válida + consentimento vigente`; sem aceite ⇒ `403 CONSENT_REQUIRED`;
sem sessão ⇒ `401 UNAUTHENTICATED`; mutações exigem `Origin` da aplicação):

- `GET /api/v1/onboarding` — estado do próprio usuário: `displayName`, `timezone` e os três
  passos (`profile` com `completedAt`; `bankroll` e `firstBet` derivados, com
  `firstBet.resolution` = `registered` | `deferred` | `null`), mais `completedAt` geral.
  **Não escreve nada.**
- `POST /api/v1/onboarding` — atualizações idempotentes:
  - `{ "step": "profile", "displayName": string, "timezone": string }` — grava o nome
    exibido (identidade) e o fuso IANA validado no servidor; repetir preserva o primeiro
    `profile_completed_at` (`coalesce`) e o resultado final é o mesmo.
  - `{ "step": "finish", "firstBet": "registered" | "deferred" }` — conclui explicitamente os
    primeiros passos sob **gate de servidor** (chamada direta à API não contorna): exige
    perfil concluído, banca inicial configurada **para a organização ancorada** e a decisão
    explícita da primeira aposta — `registered` é verificado contra apostas registradas
    (nunca confiado do corpo) e `deferred` registra a escolha de continuar sem aposta.
    Pré-requisito não satisfeito ⇒ `409 ONBOARDING_PREREQUISITE` (sanitizado e estável);
    sem o campo `firstBet` ⇒ `400 INVALID_REQUEST`. Repetir mantém o mesmo instante
    (idempotente; concorrência serializa na mesma linha).
  - Corpo estrito (`strict`): campos extras são recusados; `timezone` inválida ⇒
    `400 INVALID_REQUEST` **antes de qualquer gravação**.

O documento OpenAPI versionado ([openapi.json](openapi.json)) é gerado destas mesmas rotas
(`pnpm api:spec`); o `api:spec:check` da CI compara o gerado com o versionado.

## 3. Reúso do núcleo financeiro (sem segunda lógica contábil)

- O passo 2 **executa o comando existente** `bankroll.initialize` pelo mesmo
  `POST /api/v1/commands` do produto — mesma idempotência por `Idempotency-Key`, mesma
  `expectedVersion`, mesma serialização por lock e mesmos erros (`INVALID_FINANCIAL_OPERATION`
  quando repetido). Nada novo toca lançamentos, unidades ou configurações.
- **Confirmação explícita**: o formulário reutilizado (`InitializeForm`) exige a conferência
  declarada ("Conferi os saldos reais e quero iniciar minha banca.") antes de enviar; repetir a
  tentativa de confirmação não duplica o lançamento de abertura.
- O onboarding **não escreve** estado financeiro em nenhum outro ponto; OCR/importação não
  participam deste fluxo.

## 4. Interface web

- Enquanto o onboarding está incompleto, a visão geral do produto apresenta a página
  **"Primeiros passos"** (h2 próprio, progresso "Passo N de 3" e etapas com estado
  pendente/ativo/concluído); concluir (ou já estar concluído) restaura a visão geral normal.
- Estados cobertos: **carregando** (role=status), **erro** (role=alert + "Tentar novamente"),
  **vazio** (formulário começa nos valores atuais/navegador) e **concluído**. Uma falha de
  leitura **nunca** é interpretada como onboarding concluído nem degrada em silêncio para a
  visão geral: a página mostra o erro e oferece nova tentativa (o dado é sempre do servidor).
- **Recarga/abandono**: todo o progresso vem do servidor — recarregar em qualquer etapa retoma
  a etapa correta, sem estado privado no navegador além dos campos do formulário.
- **Mobile e desktop**: layouts verificados nos dois projetos Playwright; o CSS do produto
  segue os tokens existentes e a barra de ações empilha em telas estreitas.
- **Passo 3**: "Registrar aposta manual" abre o **formulário manual existente** (modal "Nova
  aposta"); "Conectar Telegram" apenas **encaminha** — explica que a vinculação pelo site chega
  com a STK-F2-04 e não recria nenhuma integração; "Continuar sem registrar aposta" registra a
  **escolha explícita** (`deferred`) e só então o encerramento é aceito pelo servidor. O botão
  de conclusão reflete a resolução real do passo (aposta registrada × escolha de adiar).
- **Sem bypass por frontend**: validações, pré-requisitos do encerramento e o estado efetivo
  são do servidor; a checagem de fuso no navegador é apenas orientação (a mesma regra roda no
  schema compartilhado).

## 5. Testes

- **Unitários** (`tests/unit/onboarding.test.ts`): conjunto IANA aceito/recusado (incluindo
  formatos hostis), `trim` do fuso, corpo estrito do contrato (incluindo `finish` sem a decisão
  da primeira aposta e valores inválidos) e o modelo de leitura com `firstBet.resolution`.
- **Integração com PostgreSQL real** (`tests/integration/onboarding.test.ts`): usuário sem
  onboarding (e leitura **não grava**); fuso inválido recusado antes de gravar; perfil salvo
  (nome na identidade + fuso); idempotência e concorrência (repetição e `Promise.all`);
  isolamento entre organizações; consentimento ausente **e** re-bloqueio após upgrade de versão;
  banca refletida do comando existente e repetição da confirmação recusada sem duplicar a
  abertura; primeira aposta marcada (`registered`) e conclusão explícita; **gate do
  encerramento** (`finish` antes do perfil, antes da banca e antes da decisão explícita ⇒ `409
ONBOARDING_PREREQUISITE`, sem gravação; `firstBet` ausente ⇒ `400`; `registered` sem aposta
  ⇒ `409`; `deferred` válido); **âncora financeira** (organização não ancorada nunca vê as
  flags de banca e primeira aposta do espaço único, seu `finish` é recusado e nada é escrito
  no finance); acesso não autenticado e origem cruzada recusados.
- **E2E** (`tests/e2e/onboarding.test.ts`, desktop + mobile, respostas isoladas):
  fluxo completo com **recarga em cada etapa** e abandono/retomada (concluindo com a aposta
  registrada); conclusão sem aposta exigindo a escolha explícita de adiar; **erro da rota de
  onboarding** mostrando estado de erro com "Tentar novamente" (nunca a visão geral, nunca
  tratado como concluído); fuso inválido permanece no perfil sem enviar; consentimento pendente
  mostra a tela de consentimento (não o onboarding); visitante não autenticado nunca vê o
  onboarding; onboarding concluído abre a visão geral normal; a opção do Telegram apenas
  explica e não escreve nada.

## 6. Limitações e não-objetivos

- A conexão real do Telegram é a STK-F2-04; aqui a etapa apenas encaminha (sem deep link).
- Moeda única do produto (BRL); nenhuma preferência multi-moeda foi criada.
- Consentimentos continuam sendo da STK-F1-07 — nenhum mecanismo duplicado.
- Redesign incremental/acessibilidade ampla (temas/WCAG AA) é o card "STK-F2-01" do board
  (redesign), dependente deste.
- O finance multi-tenant é a STK-F1-13 (ver §1).

## 7. Zero produção

A migração `0008` foi aplicada apenas em bancos locais descartáveis (testes) — nenhum banco de
produção foi tocado; nenhum provedor externo (Azure/Google/OpenRouter) foi chamado ou
configurado; `AUTOMATIC_IMPORT_ENABLED` permanece desligado; nenhum merge/deploy/release.
