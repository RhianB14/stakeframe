# STK-F1-07 — Consentimentos versionados (Termos, Privacidade e idade mínima)

> Unidade do Plano Master Stakeframe 2026. Escopo: catálogo versionado de documentos
> obrigatórios, registro de aceites auditável, gate de acesso fail-closed, re-aceite
> em upgrade de versão e tela web de consentimento.
>
> **Limitação jurídica declarada:** os textos iniciais em `docs/legal/` são **rascunhos
> técnicos provisórios** (`1.0.0-draft`), identificados como tal dentro do próprio
> documento. Não constituem redação jurídica aprovada e **a validação jurídica externa
> permanece obrigatória** antes de qualquer lançamento pago. A estrutura foi desenhada
> para substituição direta por versões aprovadas (basta publicar uma nova versão).

## 1. Modelo de dados (`migração 0007_consents`)

### `core.legal_document` — catálogo versionado

| Coluna             | Tipo                              | Notas                                                                                                    |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`               | uuid PK                           | `gen_random_uuid()` (mesmo padrão do schema `core`)                                                      |
| `doc_type`         | enum `core.legal_document_type`   | `terms_of_use` · `privacy_policy` · `minimum_age` — **tipos estáveis**, nunca derivados de texto de tela |
| `version`          | text                              | ex.: `1.0.0-draft`; única por tipo                                                                       |
| `title`, `summary` | text                              | dados de exibição                                                                                        |
| `content_md`       | text                              | texto integral (markdown) servido pela rota pública de leitura                                           |
| `content_hash`     | text                              | SHA-256 do `content_md` — verificação de integridade                                                     |
| `text_url`         | text                              | caminho público de leitura (`/api/v1/legal/documents/<type>/<version>`)                                  |
| `required`         | boolean                           | obrigatoriedade do aceite (hoje: todos true)                                                             |
| `status`           | enum `core.legal_document_status` | `current` · `superseded`                                                                                 |
| `effective_at`     | timestamptz                       | vigência; só conta como "vigente" com `status = current` **e** `effective_at <= now()`                   |
| `created_at`       | timestamptz                       | default `now()`                                                                                          |

Garantias: `UNIQUE (doc_type, version)` (impede versões duplicadas);
índice `(doc_type, status)`; versões antigas permanecem no catálogo (`superseded`).

### `core.consent_record` — histórico de aceites (append-only)

| Coluna                                          | Tipo                                                     | Notas                                                           |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `id`                                            | uuid PK                                                  |                                                                 |
| `user_id`                                       | text FK → `auth."user"(id)` `ON DELETE RESTRICT`         | dono do aceite (**usuário**, não organização)                   |
| `document_id`                                   | uuid FK → `core.legal_document(id)` `ON DELETE RESTRICT` | referência da versão aceita                                     |
| `doc_type`, `document_version`, `document_hash` | denormalizados                                           | respondem "o que foi aceito" mesmo sem join                     |
| `accepted_at`                                   | timestamptz `DEFAULT now()`                              | **gerado pelo servidor/banco**; o cliente nunca envia timestamp |
| `created_at`                                    | timestamptz                                              |                                                                 |

Garantias: `UNIQUE (user_id, document_id)` — um aceite por usuário/versão, o que torna
a repetição da operação **idempotente** e a concorrência segura (segunda gravação
concorrente cai no conflito e é ignorada); índice `(user_id, accepted_at)`. O fluxo
comum **não** expõe update/delete de registros; FK `RESTRICT` preserva o histórico
(mesmo padrão de retenção conservadora usado em `core.beta_invitation`).

### Dados iniciais (seed na migração)

Três documentos `1.0.0-draft` (`terms_of_use`, `privacy_policy`, `minimum_age`),
com conteúdo idêntico aos arquivos `docs/legal/*-DRAFT-v1.md` e hash SHA-256 calculado
sobre o texto embutido. Vigência: `2026-09-14T03:00:00Z`. Substituir por versão
aprovada = publicar nova versão (ver §6).

**Migração aplicada apenas em local/CI.** Nenhum comando desta unidade tocou banco de
produção; não há conteúdo jurídico sensível nem dados pessoais nos logs de migração.

## 2. Integridade do catálogo (anti-alteração silenciosa)

O status do usuário recomputa `sha256(content_md)` e compara com `content_hash`:

- hash divergente ⇒ o documento é tratado como **não satisfazível** (`integrity: 'changed'`);
- aceite antigo deixa de satisfazer a versão modificada (o gate **volta a bloquear**);
- tentativa de aceite com documento nessa condição é **rejeitada** (`CONSENT_INVALID`).

Assim, alteração material de conteúdo **exige nova versão** — a mudança silenciosa
quebra o gate em vez de passar despercebida.

## 3. API

Autenticadas (sessão — admissão beta/proprietário; **não** exigem consentimento, pois
são a via para satisfazê-lo):

- `GET /api/v1/consents/status` — documentos obrigatórios vigentes, versão, título,
  resumo, vigência, `textUrl`, `accepted`/`stale`/`integrity` por documento e `pendingTypes`.
- `POST /api/v1/consents/accept` — corpo `{ documents: [{ type, version? }] }`.
  O servidor resolve as versões vigentes; exige **todos** os obrigatórios; `version`
  é opcional e, se enviada, precisa ser exatamente a vigente (versões antigas ou
  futuras são rejeitadas). Grava tudo em **uma transação**; `ON CONFLICT DO NOTHING`
  torna a repetição idempotente; `user_id` vem sempre da sessão.
- `GET /api/v1/consents/history` — histórico do próprio usuário, ordenado por
  `accepted_at DESC, id DESC`; sem edição/exclusão; sem IP/user-agent.

Pública (documentos legais são públicos por natureza):

- `GET /api/v1/legal/documents/:type/:version` — texto integral (`text/plain`), 404
  sanitizado quando inexistente.

Erros: `CONSENT_REQUIRED` (403) e `CONSENT_INVALID` (400), sanitizados e estáveis.

## 4. Gate de acesso (fail-closed)

`getOwner()` passou a exigir aceite vigente de **todos** os documentos obrigatórios:

- sem aceite ⇒ retorna estado `consent_required`; `/api/v1/me` responde
  `403 CONSENT_REQUIRED` e **nada da organização é provisionado ou exposto** antes
  disso (a membership/organização só é criada depois do aceite);
- as rotas privadas (finance/import/event/report) respondem `CONSENT_REQUIRED` antes
  de qualquer dado organizacional;
- vale para Google OAuth, e-mail/senha, proprietário, beta, sessões existentes e
  novas versões publicadas — não há bypass por query string, cookie, localStorage ou
  flag de frontend; a verificação é sempre do servidor;
- sessão restrita continua podendo: consultar status, registrar aceite, ver histórico,
  fazer logout e (re)autenticar. Depois do aceite válido, o fluxo normal libera.

## 5. Re-aceite em upgrade de versão

Publicar uma versão nova (procedimento §6) faz o status do usuário retornar o
documento como pendente/`stale` (aviso "você aceitou uma versão anterior"),
`/me` volta a `403 CONSENT_REQUIRED`, o histórico antigo permanece intacto e o novo
aceite é gravado em **novas linhas** (versão e hash novos).

## 6. Publicação de nova versão (procedimento operacional)

```sql
-- 1) marcar a versão atual como superseded
UPDATE core.legal_document SET status = 'superseded' WHERE doc_type = $1 AND status = 'current';
-- 2) inserir a nova versão vigente (hash = sha256 do content_md)
INSERT INTO core.legal_document (doc_type, version, title, summary, content_md, content_hash, text_url, required, status, effective_at)
VALUES (...);
```

Alteração de conteúdo na **mesma** versão é proibida pela regra de integridade (§2).
Este procedimento é também o caminho para substituir os drafts por texto aprovado
juridicamente.

## 7. Interface web

Tela `ConsentScreen` (exibida quando `/me` responde `CONSENT_REQUIRED`):

- lista título, versão, vigência, resumo e link "Ler na íntegra" por documento;
- **checkbox individual por documento, nunca pré-selecionado**;
- botão "Aceitar e continuar" **desabilitado** até todos os checkboxes serem marcados;
- ação explícita do usuário + resposta bem-sucedida da API ⇒ refetch de `/me` e
  entrada no fluxo normal (abrir a tela **não** registra aceite);
- estados de carregamento, erro sanitizado, sessão expirada e sucesso;
- "Recusar e sair" encerra a sessão; teclado e leitor de tela suportados
  (fieldset/legend, labels associados, `role=alert`, foco visível); sem dark patterns.

## 8. Testes

- `tests/integration/consents.test.ts` — catálogo, gate, status, aceite completo/parcial/
  idempotente, versão inválida/antiga/futura, re-aceite, histórico + isolamento entre
  usuários, `user_id` ignorado, falha transacional sem aceite parcial, concorrência,
  integridade/alteração silenciosa, zero segredos em respostas/logs.
- `tests/e2e/consent.test.ts` — tela: sem pré-seleção, botão bloqueado, liberação após
  aceite, aviso de versão anterior, recusa/logout, navegação por teclado, labels.
- Suítes preservadas e atualizadas para o novo passo: `beta-gate`, `auth-email`,
  `owner-auth` (Google, e-mail/senha, convite, reset e alerta continuam funcionando).

## 9. Zero produção

Nenhum release, deploy ou migração em produção nesta unidade; nenhuma proteção,
credencial ou permissão alterada; nenhum segredo em código, documentação, PR, card ou
logs. O banco de produção permanece com o schema anterior até autorização explícita
separada (a migração 0007 fica pronta e **não aplicada** em produção).
