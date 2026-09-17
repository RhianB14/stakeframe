# STK-F2-01 — Redesign do onboarding inicial (UI/UX e acessibilidade)

Unidade STK-F2-01 do plano master 2026. Base: STK-F1-09 (onboarding em três passos),
que este redesign não altera funcionalmente — nenhum gate server-side, contrato de API,
schema ou escrita financeira foi modificado.

## 1. Objetivo

Melhorar a experiência visual, a responsividade e a acessibilidade do onboarding em três
passos (perfil → primeira banca → primeira aposta), mantendo todo o comportamento
existente, incluindo:

- gate server-side do `finish` (409 `ONBOARDING_PREREQUISITE`);
- exigência de perfil concluído e banca inicial ancorada antes da decisão final;
- escolha explícita de primeira aposta ("Registrar aposta manual", "Conectar Telegram",
  "Continuar sem registrar aposta");
- tratamento de erro 500 sem apresentar o onboarding como concluído;
- isolamento por organização e consentimentos da STK-F1-07;
- regra de que nenhuma escrita financeira ocorre sem confirmação humana.

## 2. O que mudou (apenas apresentação)

- **Indicador de progresso acessível**: o stepper é uma lista ordenada com
  `aria-label="Etapas dos primeiros passos"`; cada item usa `aria-current="step"` na etapa
  ativa, "✓" com `aria-hidden` nas concluídas e texto "(concluída)"/"(etapa atual)"
  visível/para leitores de tela. O rótulo "Passo N de 3" virou `role="status"` com
  detalhamento em `sr-only` (anunciado ao vivo em mudanças de etapa).
- **Estado de carregamento**: a leitura do status exibe `aria-busy="true"` e um
  `role="status"` ("Carregando seus dados…") em vez de um painel estático.
- **Erro de leitura**: painel de erro com `role="alert"` e botão "Tentar novamente"
  (refetch); já existente em comportamento, agora com marcação acessível.
- **Erros de formulário por campo**: `ProfileForm` passou a sinalizar o campo com erro
  (`aria-invalid`) e a descrevê-lo via `aria-describedby` no banner `role="alert"`
  compartilhado; erros de formulário no passo 3 continuam com banner `role="alert"` + botão
  "Tentar novamente".
- **Estado vazio do passo 2**: sem casas de apostas, o passo exibe um bloco
  `.onboarding-empty` ("Nenhuma casa de apostas registrada ainda") orientando criar a
  primeira antes de confirmar saldos.
- **Grupo de escolha do passo 3**: as três ações viraram `role="group"` com
  `aria-label="Escolha da primeira aposta"`; o status de resolução é `role="status"`.
- **Contraste (WCAG AA)**: placeholder de input `#727f94 → #8490a6`, borda de input
  `#414d63 → #5b6984` e borda da etapa ativa `#4a5f8f → #586ea6` — os três pares falhavam
  4.5:1 sobre o fundo `#151c27` e passaram (placeholders ≥ 4.5:1; bordas de controle ≥ 3:1,
  SC 1.4.11).
- **Tokens locais**: `.onboarding-panel` concentra as variáveis do redesign com comentário
  indicando que a paleta é a do tema escuro único do produto (ver §4).

## 3. Não-objetivos

- Conexão real com Telegram (STK-F2-04) — a opção continua apenas explicando.
- Nova lógica financeira, multi-moeda ou migração de banco (nenhuma migration nesta
  unidade).
- Novo mecanismo de consentimento (permanece na STK-F1-07).
- Tema claro: o produto é dark-only (`style.css` declara `color-scheme: dark` e não existe
  tema claro implementado).

## 4. Decisão registrada (conflito plano × código)

O escopo pedia "suporte aos temas claro e escuro **existentes**". Inspecionado o código,
não existe tema claro: `apps/web/src/style.css` declara `color-scheme: dark` como tema
único e nenhum media query/atributo de tema claro existe no produto. Decisão: **não criar
um tema claro nesta unidade** (evita inventar paleta e escopo), e sim garantir que todas as
cores novas do onboarding passem WCAG AA sobre o fundo escuro existente, com os tokens
centralizados em `.onboarding-panel` para que um tema claro futuro ajuste apenas valores.
Decisão registrada também no card `t_e3399482` do board Stakeframe.

## 5. Testes

- **E2E** (`tests/e2e/onboarding.test.ts`, projetos desktop-chromium e mobile-chromium):
  novos testes para retomada no primeiro passo incompleto com progresso acessível; operação
  completa por teclado com foco visível (`:focus-visible`); prevenção de duplo envio
  (botão desabilitado + rótulo "Salvando…"); falha do `finish` (500) mantendo o passo
  aberto, anunciando o erro e oferecendo retry explícito que recupera; adaptação a viewport
  mobile sem overflow horizontal. A suíte completa do onboarding (26 testes) passa nos dois
  projetos.
- **Unit + integração**: 194 unit e 206 integration passam sem alteração — nenhum contrato
  mudou.
- **Validação**: `pnpm build:types`, `pnpm typecheck`, `pnpm lint`, `pnpm api:spec:check`,
  `pnpm format:check` (CI: `--end-of-line auto`) e `git diff --check` sem erros.

## 6. Zero produção

Nenhuma migration, nenhum deploy, nenhum release, nenhuma tag, nenhum acesso a produção,
nenhum segredo adicionado; `AUTOMATIC_IMPORT_ENABLED` permanece desligado; nenhuma chamada
a provedores externos. A unidade toca apenas `apps/web` (UI), estilos, E2E, openspec e
esta documentação.
