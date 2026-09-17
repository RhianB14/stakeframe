## 1. Descoberta e especificação

- [x] 1.1 Ler AGENTS.md, plano master, docs/PLAN.md, docs/F1-09-ONBOARDING.md, docs/ARCHITECTURE.md, docs/F1-07-CONSENTS.md
- [x] 1.2 Ler código do onboarding (apps/web) e testes unit/integration/e2e
- [x] 1.3 Registrar conflito temas claro/escuro (dark-only) na proposta e no card
- [x] 1.4 Pesquisar referências primárias WCAG 2.2 / WAI (somente w3.org)

## 2. Implementação UI

- [x] 2.1 Indicador de progresso acessível (ol + aria-current + live region)
- [x] 2.2 Fieldset/legend por passo; labels, ajuda e erros associados (aria)
- [x] 2.3 Estados: reading (aria-busy), read-error + retry, empty, partially-completed
- [x] 2.4 Estados de envio: submitting (duplo envio bloqueado), submit-error + retry
- [x] 2.5 product.css: tokens --onb-*, :focus-visible, alvos ≥44px, responsivo ≤640px

## 3. Testes

- [x] 3.1 Unit: estados novos (progresso, retry, duplo envio, parcial, mensagens)
- [x] 3.2 E2E: teclado/foco (ordem Tab, foco visível)
- [x] 3.3 E2E: viewport mobile (360×640) — suíte de onboarding completa
- [x] 3.4 E2E: erro 500 + retry; retomada parcial; deferimento; gate server-side
- [x] 3.5 Verificação programática de contraste AA nos pares de cor do onboarding

## 4. Validação local

- [x] 4.1 pnpm build:types, typecheck, lint, test, test:integration
- [x] 4.2 pnpm api:spec:check, format:check; git diff --check
- [x] 4.3 E2E onboarding desktop + mobile (PLAYWRIGHT_CHANNEL=chrome)

## 5. Revisão e segurança

- [x] 5.1 diff-review do diff completo contra main
- [x] 5.2 Subagentes de revisão independente (a11y + preservação de gates) — avaliado: não aplicável, mudança UI single-context; decomposição registrada aqui
- [x] 5.3 Snyk SCA (0 vulnerabilidades ≥ high, 7 projetos); SAST indisponível (Snyk Code desabilitado na org — SNYK-CODE-0005, registrado)

## 6. Entrega

- [x] 6.1 Docs da unidade (docs/F2-01-ONBOARDING-REDESIGN.md) + nota em F1-09
- [x] 6.2 Commit/push/PR contra main (sem merge) — PR #135, head 0416d80, CI 5/5
- [ ] 6.3 Card Kanban → REVIEW (feito) até merge autorizado pelo Codex

## 7. STK-F2-01-R1 — correção da revisão do Codex (aria-describedby)

- [x] 7.1 `Field` (forms.tsx): mesclar `aria-describedby` do filho com o ID do hint, sem duplicar IDs, sem alterar demais formulários
- [x] 7.2 Teste de regressão E2E: aria-invalid mantido, hint + erro em aria-describedby, mensagem em role="alert", fluxo não avança
- [x] 7.3 Requisito adicionado à spec (Associação de erro com hint) + bateria local re-executada + CI da PR
- [ ] 7.4 Nova revisão do Codex (o novo commit invalida a revisão anterior)
