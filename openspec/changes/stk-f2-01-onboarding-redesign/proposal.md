# STK-F2-01 — Redesign incremental do onboarding inicial do beta

## Why

O onboarding em três passos da STK-F1-09 está funcional e blindado server-side, mas a
experiência visual é mínima: sem indicador de progresso acessível, sem hierarquia visual,
estados de carregamento/erro rudimentares e contraste/foco apenas implícitos. A unidade
STK-F2-01 entrega o redesign **incremental** desse fluxo, responsivo e acessível (WCAG AA),
**sem tocar** nos gates server-side, na lógica financeira, nos contratos de API ou no banco.

## Conflito plano × código (decisão registrada)

A tarefa pede "suporte aos temas claro e escuro **existentes**". O produto atual é
**dark-only**: `apps/web/src/style.css` declara `color-scheme: dark` e o `product.css`
usa cores fixas (nenhum mecanismo de tema claro existe no código — verificado por busca em
`apps/web/**`). Decisão:

- manter o tema escuro único nesta unidade (nenhum toggle claro/escuro será inventado
  silenciosamente nem aplicado pela metade no produto inteiro);
- tokenizar localmente as cores do onboarding (variáveis CSS `--onb-*`) para que um tema
  claro futuro plugue sem alterar marcação;
- contraste WCAG AA verificado **programaticamente** nos pares de cor usados;
- decisão registrada também no card Kanban `t_e3399482`.

## What Changes

- `apps/web/src/product/onboarding.tsx`: indicador de progresso acessível (`ol` +
  `aria-current="step"` + região `aria-live`), `fieldset`/`legend` por passo, labels e
  descrições associados (`for`/`id`, `aria-describedby`, `aria-invalid`), estados de
  carregamento (`aria-busy`), erro de leitura com "Tentar novamente", estados vazios e
  parcialmente concluídos com marcação "concluída", mensagens de erro genéricas (sem
  detalhes internos), prevenção de duplo envio reforçada na marcação.
- `apps/web/src/product/product.css`: estilos do onboarding tokenizados (`--onb-*`),
  `:focus-visible` consistente, alvos de toque ≥ 44px, refinamento responsivo
  (desktop + mobile ≤ 640px).
- Testes: unitários para cada estado novo; E2E de teclado/foco, viewport mobile,
  erro 500 + retry, retomada parcial, deferimento e preservação do gate server-side.
- Documentação da unidade: `docs/F2-01-ONBOARDING-REDESIGN.md` (novo).

## Não-objetivos

- Conexão real com Telegram (a opção permanece como decisão explícita registrada).
- Nova lógica financeira, novo mecanismo de consentimento, cadastro público, cobrança.
- Polymarket, Azure Vision/Google Vision, importação automática, IA narrativa.
- Migração de banco (nenhuma necessidade encontrada; se surgir → BLOCKED antes da migration).
- Tema claro global, reescrita total, mudanças fora do fluxo de onboarding.

## Impact

- **Código:** `apps/web/src/product/onboarding.tsx`, `apps/web/src/product/product.css`.
- **Testes:** `tests/unit/onboarding.test.ts`, `tests/e2e/onboarding.test.ts`.
- **Docs:** `docs/F2-01-ONBOARDING-REDESIGN.md` (novo), `docs/F1-09-ONBOARDING.md`
  (nota de continuidade).
- **API/banco:** nenhuma alteração de contrato, schema ou migration.
- **Segurança:** sem segredos, sem produção, sem deploy; Snyk sem vulnerabilidade
  alta/crítica introduzida.
