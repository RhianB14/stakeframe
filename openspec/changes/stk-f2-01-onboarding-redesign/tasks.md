## 1. Descoberta e especificação

- [x] 1.1 Ler AGENTS.md, plano master, docs/PLAN.md, docs/F1-09-ONBOARDING.md, docs/ARCHITECTURE.md, docs/F1-07-CONSENTS.md
- [x] 1.2 Ler código do onboarding (apps/web) e testes unit/integration/e2e
- [x] 1.3 Registrar conflito temas claro/escuro (dark-only) na proposta e no card
- [x] 1.4 Pesquisar referências primárias WCAG 2.2 / WAI (somente w3.org)

## 2. Implementação UI

- [ ] 2.1 Indicador de progresso acessível (ol + aria-current + live region)
- [ ] 2.2 Fieldset/legend por passo; labels, ajuda e erros associados (aria)
- [ ] 2.3 Estados: reading (aria-busy), read-error + retry, empty, partially-completed
- [ ] 2.4 Estados de envio: submitting (duplo envio bloqueado), submit-error + retry
- [ ] 2.5 product.css: tokens --onb-*, :focus-visible, alvos ≥44px, responsivo ≤640px

## 3. Testes

- [ ] 3.1 Unit: estados novos (progresso, retry, duplo envio, parcial, mensagens)
- [ ] 3.2 E2E: teclado/foco (ordem Tab, foco visível)
- [ ] 3.3 E2E: viewport mobile (360×640) — suíte de onboarding completa
- [ ] 3.4 E2E: erro 500 + retry; retomada parcial; deferimento; gate server-side
- [ ] 3.5 Verificação programática de contraste AA nos pares de cor do onboarding

## 4. Validação local

- [ ] 4.1 pnpm build:types, typecheck, lint, test, test:integration
- [ ] 4.2 pnpm api:spec:check, format:check; git diff --check
- [ ] 4.3 E2E onboarding desktop + mobile (PLAYWRIGHT_CHANNEL=chrome)

## 5. Revisão e segurança

- [ ] 5.1 diff-review do diff completo contra main
- [ ] 5.2 Subagentes de revisão independente (a11y + preservação de gates)
- [ ] 5.3 Snyk code scan + SCA sem vulnerabilidade alta/crítica introduzida

## 6. Entrega

- [ ] 6.1 Docs da unidade (docs/F2-01-ONBOARDING-REDESIGN.md) + nota em F1-09
- [ ] 6.2 Commit/push/PR contra main (sem merge)
- [ ] 6.3 Card Kanban → REVIEW com checkpoints e telemetria sanitizada
