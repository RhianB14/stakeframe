# F1-05 — Gate efetivo do beta por convite e vínculo com autenticação

Data: 2026-09-13 · Base: `2792447f25d4c91bfb2263352431bc58b3386a54` (main)
Branch: `hermes/stk-f1-05-beta-auth-gate`

## Objetivo

Conectar o convite beta (STK-F1-04) à autenticação e ao provisionamento da organização
(STK-F1-01/F1-03): nenhum usuário externo entra sem convite válido, com e-mail efetivamente
verificado, consumido uma única vez e vinculado à identidade. O convite é de **acesso ao
beta** — nunca de membro de organização; a organização continua sendo criada
automaticamente por usuário.

## Fluxos

### Google OAuth (usuário externo)

1. O navegador abre o link do convite → `POST /api/v1/beta-invite/open` valida o token
   (hash, pendente, dentro da validade) e fixa o token em cookie **HttpOnly** de vida curta
   (`stakeframe-invite`, 1 h, `SameSite=Lax`, `Secure` em HTTPS). Nada é consumido.
2. `POST /api/auth/sign-in/google` → fluxo OAuth padrão (estado, PKCE, nonce, verificação
   criptográfica do ID token inalterados).
3. No retorno, o gate roda nos hooks de banco antes de persistir qualquer coisa:
   - **identidade**: só cria usuário se o e-mail verificado do provedor tiver convite
     pendente válido **ou** for o proprietário (caminho existente intacto);
   - **conta**: idem, para conta `google` (e `credential`), com descarte dos tokens do provedor;
   - **sessão**: proprietário, ou identidade verificada que já aceitou convite, ou **consumo
     atômico agora** (token do cookie + e-mail + `accepted_user_id`, na MESMA transação do
     `INSERT` da sessão), senão a sessão é negada.
4. Sessão e organização seguem o fluxo já existente: `/api/v1/me` garante a organização
   (idempotente) e resolve o contexto; falha de organização = 401 sanitizado, sem dados.

### E-mail e senha (somente com convite aberto)

1. Mesmo passo de abertura do convite (cookie).
2. `POST /api/auth/sign-up/email` → o gate valida convite + e-mail (senão a resposta é a
   genérica anti-enumeração da biblioteca, **sem criar nada**). Cadastro cria o usuário
   **não verificado**, a credencial é tratada exclusivamente pelo Better Auth (hash) e o
   transporte **falso/controlado** envia o link de verificação (memória, local/CI — nunca
   e-mail real, nunca Resend).
3. O convite é **consumido na própria transação do cadastro** (hook de criação da conta,
   `accepted_user_id` = usuário): falha posterior reverte identidade e aceitação juntas; a
   resposta pública nunca revela e-mail, token ou senha.
4. `GET /api/auth/verify-email` confirma o e-mail (token só nesta chamada, nunca registrado).
5. `POST /api/auth/sign-in/email` só obtém sessão com e-mail verificado **e** convite já
   aceito (predicado de admissão); falhas usam um único código sanitizado.

## Regras do gate (fail-closed)

| Situação                                | Resultado                                                            |
| --------------------------------------- | -------------------------------------------------------------------- |
| Token inexistente/inválido              | negado (sem usuário, sem sessão, convite intacto)                    |
| Convite expirado / revogado / já aceito | negado                                                               |
| E-mail autenticado ≠ e-mail do convite  | negado                                                               |
| E-mail não verificado (Google ou senha) | negado (sem sessão)                                                  |
| Sem convite                             | negado (cadastro sem estado; Google redireciona para falha genérica) |
| Reutilização concorrente do token       | **uma única aceitação**; a outra falha sanitizada                    |
| E-mail do proprietário via senha        | negado sempre; proprietário entra só pelo Google existente           |
| Organização indisponível                | 401 sanitizado (sem dados), comportamento de sessão não autenticada  |

Nada é confiado ao cliente: e-mail/userId/organização/status vindos do navegador são
ignorados; o token é a única capacidade aceita e é validado por hash no servidor.

## Consumo atômico (transação compartilhada)

- `consumeInvitationForUser(executor, token, { userId, email })` **não abre transação própria**:
  roda no executor da transação do chamador (`SELECT ... FOR UPDATE` por hash → checagens de
  pendência/validade/e-mail → `UPDATE status='accepted', accepted_at=now(), accepted_user_id`).
  O commit/rollback é o da transação que o contém; a função nunca libera conexão por conta
  própria (não há conexão própria).
- A **criação de sessão** roda inteira dentro de UMA transação pelo mecanismo transacional do
  próprio Better Auth (`runWithTransaction` + adapter Drizzle com `transaction: true`): os
  hooks de banco (consumo do convite incluído) e o `INSERT` da sessão compartilham a mesma
  conexão e o mesmo commit/rollback. Uma falha na persistência da sessão — mesmo convertida
  pela biblioteca em resposta de erro — **reverte a aceitação junto**: não existe janela de
  convite aceito sem sessão.
- No cadastro por senha, o consumo roda no hook de criação da conta, dentro da transação do
  próprio sign-up: falha da identidade reverte a aceitação; falha do consumo não cria a
  identidade nem libera sessão.
- Concorrência: duas tentativas do mesmo token serializam no `FOR UPDATE`; exatamente uma
  aceita e a outra falha sanitizada.
- Recuperação: identidade admitida que perca a sessão pode reentrar (vínculo
  `accepted_user_id`); token já aceito nunca é aceito de novo.

## Sessão e organização

- `/api/v1/me` mantém o contrato (`user.id/name`, `organization.id/role`, `expiresAt`) e
  passa a admitir usuário externo admitido; uma organização por usuário, sem
  compartilhamento; e-mail, tokens, cookies e detalhes do driver nunca aparecem.
- Cookies de sessão mantêm HttpOnly/SameSite/Secure(HTTPS); o cookie de convite é separado e
  expira em 1 h.

## Banco de dados

**Alterações de banco: nenhuma.** A tabela `core.beta_invitation` da STK-F1-04 é reutilizada
como está (`status`, `accepted_at`, `accepted_user_id` já existentes).

## Segurança e anti-vazamento

- Mensagens públicas: códigos sanitizados (`INVITE_REJECTED`, `AUTH_REQUEST_FAILED`,
  `UNAUTHENTICATED`, `RATE_LIMITED`, `AUTH_UNAVAILABLE`); sem distinguir e-mail existente,
  senha incorreta ou e-mail não verificado; sem SQL, tabela, host, porta ou stack.
- Token bruto: existe apenas no limite necessário (link → cookie → validação → descarte);
  nunca em logs, erros, documentação ou banco (só sha256).
- Rotas genéricas continuam não expostas (404); as rotas novas exigem Origin e limites da
  biblioteca (`sign-up/email` e `sign-in/email` com 5/min por IP).

## Limitações

- Transporte de e-mail é falso/controlado (memória) para local/CI; o runtime de produção
  permanece **sem transporte** e, portanto, com e-mail/senha desabilitado (503) até uma
  integração de e-mail autorizada em tarefa posterior. Nenhum e-mail real é enviado.
- No Google, se a criação da sessão falhar, a identidade pode persistir **inerte** (sem
  sessão e sem convite aceito — nunca admitida); a nova tentativa reutiliza a identidade e
  conclui. O que nunca sobrevive a uma falha é a dupla convite-aceito↔sessão.
- Sem recuperação de senha, sem UI completa de onboarding, sem convite de membros, sem
  organização compartilhada, sem impersonação (fora do escopo desta unidade).
- O convite aberto não é revalidado em cada requisição posterior — a admissão fica registrada
  em `accepted_user_id` (single-use já aplicado no aceite).

## Testes

- `tests/integration/beta-gate.test.ts` (17): Google convidado aceito; rejeições sem convite,
  inválido, expirado, revogado, já aceito, e-mail divergente e e-mail não verificado; retorno
  do usuário admitido sem convite; rejeição de identidade alheia; fluxo e-mail/senha completo
  (cadastro → verificação → sessão); rejeições de cadastro; proprietário sem senha; consumo
  concorrente único (duas transações reais); **falha real na persistência da sessão após a
  tentativa de consumo → nenhuma sessão, convite ainda pendente, `accepted_user_id` nulo e
  nova tentativa válida conclui** (trigger que só bloqueia o insert quando o convite está
  aceito na MESMA transação); organização fail-closed; sanitização de respostas; rotas sem
  bypass; cookies (inclusive `Secure` em HTTPS); duas organizações isoladas.
- `tests/unit/beta-invitation.test.ts` (+4): pré-checagens sem I/O (executor nunca chamado),
  falha fechada sem executor, sanitização de falha do executor e token desconhecido.
- `tests/integration/owner-auth.test.ts`: mantido (23) com a rota de cadastro agora desabilitada
  sem transporte (503) e todas as validações do proprietário inalteradas.
