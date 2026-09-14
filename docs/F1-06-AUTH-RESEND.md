# STK-F1-06 — Autenticação: Google OAuth + e-mail/senha com verificação via Resend

Status: implementado na branch `hermes/stk-f1-06-auth-resend` (base `13f2693e…`), aguardando
revisão do Codex. Sem release, sem deploy, sem migração em produção.

## Objetivo

Completar a autenticação do beta: Google OAuth preservado, e-mail/senha com verificação
obrigatória, recuperação de senha e aviso de novo login, com envio transacional pelo Resend
(real) e adaptador in-memory (testes/local). O gate de convite beta da STK-F1-05 permanece
intacto e nenhum fluxo de e-mail/senha contorna o convite ou o vínculo organizacional.

## Abstração de e-mail (`apps/api/src/email.ts`, `email-service.ts`, `email-templates.ts`)

- `EmailSender` com duas implementações:
  - **Resend (real)**: `POST https://api.resend.com/emails` via `fetch` (sem SDK novo), 10s de
    timeout. A chave vem exclusivamente de `RESEND_API_KEY(_FILE)`; nunca há valor no código.
    Falhas (rede, timeout, HTTP não-2xx) colapsam em `EMAIL_SEND_FAILED` — corpo do provedor,
    chave e detalhes de rede nunca propagam.
  - **In-memory (fake)**: captura as mensagens em memória para local/CI; nunca envia e-mail
    real e nunca toca serviço externo.
- `readEmailRuntimeConfig`: produção → Resend somente com `RESEND_API_KEY` + `RESEND_FROM`
  válidos; configuração parcial/inválida → sem remetente (nada é silenciosamente rebaixado);
  `EMAIL_TRANSPORT=memory` só fora de produção; sem configuração → local usa memória e
  produção permanece sem envio. **A verificação de e-mail nunca é desabilitada para
  contornar ausência de chave**: sem remetente, os fluxos de senha respondem 503 sanitizado.
- Templates PT-BR (`verificationEmail`, `passwordResetEmail`, `newLoginEmail`): assunto claro,
  identidade Stakeframe, URL de ação, expiração explícita (1 h / 30 min), notas de segurança,
  HTML inline sem scripts/assets externos e versão texto. O alerta de login **não** inclui IP
  nem dados do dispositivo.

## Fluxos

### Verificação de e-mail

- `requireEmailVerification: true`, `sendOnSignUp: true`, `autoSignInAfterVerification: false`,
  expiração de 3600 s (JWT HS256 assinado pelo segredo do serviço).
- Reenvio: `POST /api/auth/send-verification-email` (resposta genérica com piso de tempo
  constante do próprio Better Auth; e-mail desconhecido/já verificado não dispara envio).
- Login sem verificação: `403 EMAIL_NOT_VERIFIED` (código acionável e sanitizado; a senha já
  foi validada pela biblioteca nesse ponto). Sem sessão.
- Token expirado/reutilizado: redireciona `/?error=TOKEN_EXPIRED|INVALID_TOKEN` ou falha
  sanitizada; reutilização é idempotente (sem sessão, sem acesso, sem identidade extra).

### Recuperação de senha

- `POST /api/auth/request-password-reset` → sempre `{status:true}` para e-mail existente ou
  inexistente (anti-enumeração, com mitigação de tempo da biblioteca). O link chega apenas
  pelo e-mail da conta: `…/?reset=<token>` (o app constrói a URL; o token não passa por
  callback do provedor).
- `POST /api/auth/reset-password` → token de uso único na tabela `auth.verification`
  (`reset-password:<token>`), TTL 1800 s, `revokeSessionsOnPasswordReset: true` (sessões
  antigas caem), falhas → `400 RESET_REJECTED` sanitizado.
- O hook de envio **nunca** dispara para o e-mail do proprietário (senha nunca existe para
  ele) nem para contas sem conta `credential` (só-Google, que continuam entrando pelo
  Google). O gate de hooks da STK-F1-05 também bloqueia a criação de credencial fora do
  fluxo de convite (defesa em profundidade).

### Alerta de novo login

- Critério determinístico (decisão documentada): alerta quando uma sessão **confirmada**
  (hook `session.create.after`, pós-commit) tem par (IP, user-agent) que **não coincide com
  nenhuma sessão anterior** do usuário, exigindo ao menos uma sessão anterior registrada —
  o primeiro acesso nunca alerta — e fingerprint completo (sem IP ou sem user-agent não
  alerta).
- Limitação documentada: sessões removidas por logout não deixam histórico; após encerrar
  todas as sessões, o próximo login é tratado como primeiro acesso e não alerta.
- Entrega: nunca bloqueia nem falha o login (erros engolidos), dedupe por sessão (guarda
  in-process limitada) e conteúdo sem IP/user-agent.

### Rate limiting e anti-enumeração

- Mecanismo existente do Better Auth (in-memory) estendido:
  `/send-verification-email` 3/5 min, `/request-password-reset` 3/5 min,
  `/reset-password` 5/5 min, `/verify-email` 10/5 min (por cliente, além das regras já
  existentes de sign-up/sign-in/Google).
- Respostas equivalentes para e-mail existente/inexistente em reset e reenvio; mensagens sem
  detalhe de banco/provedor; nenhum vazamento de existência de usuário.

## Interface web

- `PasswordReset.tsx`: painel de solicitação (resposta sempre genérica) e painel de definição
  de nova senha (token da URL, confirmação, estados de carregamento/sucesso/link inválido com
  pedido de novo link).
- `InviteAccess.tsx`: aviso de e-mail pendente, botão de reenvio de confirmação, link
  "Esqueci minha senha" e tratamento do código `EMAIL_NOT_VERIFIED`; mensagens sempre
  sanitizadas (as mensagens exibidas vêm do contrato de erro da API).
- `App.tsx`: `…/?reset=<token>` abre o painel de redefinição; a URL é limpa após a captura.
- Sem cadastro público independente do convite beta.

## Banco e migrações

Nenhuma migração nova: a tabela `auth.verification` (migração 0000) já cobre tokens de
verificação e de reset, e o Better Auth usa JWT assinado para a confirmação de e-mail.
Nenhuma migração é executada em produção.

## Testes

- `tests/unit/email-service.test.ts` (11): templates (link, marca, expiração, alerta sem
  IP/UA), sender Resend (payload, header de autorização, falha sanitizada sem eco de corpo,
  falha de rede), sender in-memory, normalização `EMAIL_SEND_FAILED`, configuração de
  runtime (produção nunca memory; parciais → sem remetente) e ausência de segredo em logs.
- `tests/integration/auth-email.test.ts` (16): ciclo completo convite→cadastro→verificação
  obrigatória→reenvio→verificação→login→organização; e-mail não verificado; token expirado;
  reutilização idempotente; reenvio genérico (desconhecido/verificado/pendente); reset
  completo com revogação de sessões; reset expirado; reset reutilizado; token inválido;
  equivalência de enumeração (login/reset/reenvio); rate limit por cliente; proprietário e
  conta só-Google sem reset; logout; sessão expirada; alerta de novo login (critério,
  conteúdo sem IP/UA, falha de envio não bloqueia); falha do provedor sem vazamento e sem
  aceitação parcial; logs sem segredos; isolamento por organização.
- `tests/integration/beta-gate.test.ts` (17, atualizado): harness migrado para o novo serviço
  de e-mail; login antes da verificação agora espera `EMAIL_NOT_VERIFIED`.

## Limitações

- Produção permanece **sem** `RESEND_API_KEY` configurada nesta unidade: os fluxos de senha
  respondem 503 até a configuração de produção (etapa própria, autorizada separadamente).
- Contas só-Google não recebem link de redefinição (não há senha a redefinir).
- O alerta de novo login usa (IP, user-agent) das sessões existentes; não há tabela de
  dispositivos conhecidos (decisão mínima suportada pela arquitetura atual).
- Sem 2FA, sem Turnstile, sem cadastro público (escopo pós-beta declarado no Plano Master).
