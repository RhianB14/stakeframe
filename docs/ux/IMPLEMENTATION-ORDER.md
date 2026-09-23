# STK-UX — Ordem proposta de implementação

Sequência sugerida para levar os protótipos de `docs/ux/prototypes/` ao produto, **sem quebrar regra financeira nenhuma**. Cada etapa é verificável por si.

> **Princípio de ordem:** primeiro o que afeta a confiança nos números (D2), depois acessibilidade e legibilidade, depois consistência de fluxo, e só então refinamento visual. Nenhuma etapa toca comando canônico, idempotência, ledger ou liquidação.

---

## Etapa 1 — Semântica de cor financeira (D2, D8) · prioridade máxima

**Por que primeiro:** é o único achado que muda como o usuário lê o resultado. Hoje `R$ 0,00` de aposta aberta aparece em verde, junto de lucro.

**O que fazer:**

- Adicionar `--positive`, `--negative`, `--neutral-value`, `--pending` em `product.css`.
- `R$ 0,00`, saldo e aposta aberta **sem realização** → `--neutral-value`.
- `Retorno recebido` e `Resultado realizado` de aposta aberta **sem liquidação** → `—` / `Não liquidado`.
- Aposta ainda aberta **com cashout parcial** mantém o retorno e o lucro/prejuízo já realizados, rotulados como parciais; não escondê-los por causa de `state=open`.
- Sinal `+` em lucro positivo.

**Não mexe em:** cálculo, exposição, ledger, liquidação. É só apresentação do valor já calculado.

**Verificação:** unit na apresentação sem recalcular dinheiro; E2E desktop/mobile para aberta sem liquidação, cashout parcial (positivo/negativo) e aposta liquidada.

---

## Etapa 2 — Piso tipográfico e contraste (D3) · rápido

**Estado:** entregue no STK-UX-04 — sete rótulos medidos agora usam pelo menos
12px; o token `--text-faint` e os placeholders do Mini App passam pelo teste de
contraste de 4.5:1 nas superfícies reais.

**O que fazer:**

- Os sete estilos medidos em `8px`/`9px` → `12px` (`.sidebar-caption`, `.product-eyebrow`, `.metric-card small`, `.product-footer`, `.card-kicker` e `.updating`, incluindo overrides mobile).
- `--text-faint` com contraste ≥ 4.5:1.
- Placeholder do Mini App usando `--text-faint` no seletor visível, em vez do tom abaixo do mínimo.

**Risco:** baixo — muda só CSS. Pode alterar quebra de linha em telas estreitas; conferir nos breakpoints reais.

---

## Etapa 3 — Acessibilidade mobile (A1, A2, A3) · rápido

**Estado:** entregue no STK-UX-04 — navegação inferior sem corte/overflow,
espaço inferior para a última linha da tabela e alvos segmentados de 44px
(meta de ergonomia do produto, não critério WCAG AA).

**O que fazer:**

- `padding-bottom` suficiente para a bottom nav não cobrir a tabela.
- Rótulo da bottom nav quebra sem truncar `Configurações`.
- `.mini-segmented label { min-height: 44px }` (hoje `42px`) — **meta própria de
  experiência móvel**, não exigência de AA: o alvo medido (210×42 desktop /
  115,33×42 mobile) já é **conforme WCAG 2.2, 2.5.8 (AA, ≥24×24)**; a meta
  aproxima de **2.5.5 (AAA, ≥44×44)**, critério não exigido.

**Verificação:** E2E mobile — última linha da tabela visível sem scroll extra;
alvo medido ≥ 44 (meta própria). Reproduzir a medição com
`tests/ux-capture/measure.spec.ts`.

---

## Etapa 4 — Padrão único de filtro (D4)

**O que fazer:**

- Portar o cabeçalho de `#analytics` (`Aplicar filtros`) para `#bets`, que hoje não tem botão algum.
- `Limpar filtros` nas duas.
- Chips de filtros ativos.
- Agrupar `Apostada desde/até` sob `Período da aposta`.

**Verificação:** E2E — aplicar, ver chip, limpar, lista volta ao estado inicial.

---

## Etapa 5 — Tabela em cards no mobile (D5)

**O que fazer:** abaixo de `900px`, `#bets` vira lista de cards com `data-label`.

**Verificação:** E2E mobile — nenhuma coluna cortada, sem scroll horizontal não anunciado.

---

## Etapa 6 — Erro com papel visual (D6, E2, E4)

**O que fazer:**

- Componente de erro com `role="alert"`, ícone e ação primária dentro do card afetado.
- `Tentar novamente` vira botão com estado `Tentando…`.
- Conflito de versão do Mini App sinalizado como alerta de **não-salvamento**, não só `hint`.

**Verificação:** E2E — forçar 503 e `VERSION_CONFLICT`, assertar papel e ação.

---

## Etapa 7 — Detalhe da aposta (D7)

**O que fazer:** footer com `Corrigir dados` / `Liquidar aposta`; `Cancelar registro` isolado com confirmação. Rebaixar `Principal aberto` e `Unidade do registro` para seção secundária.

**Não mexe em:** o fluxo de liquidação em si — só posição dos botões.

---

## Etapa 8 — Hierarquia do Mini App (D9)

**O que fazer:** `h2` por bloco de formulário, `h1` legível, separadores.

**Verificação:** E2E — heading único `Editar aposta` permanece accessible name do diálogo.

---

## Etapa 9 — Consolidar tokens (D1) · último

**Por que último:** é a refatoração mais ampla e a menos urgente.

**O que fazer:** de seis azuis para `--action`, escada de superfície, cinco breakpoints para três.

**Risco:** maior — toca toda a base. Fazer depois que as etapas 1–8 estabilizarem.

---

## O que fica explícitamente fora

| Item                                                  | Motivo                         |
| ----------------------------------------------------- | ------------------------------ |
| Recriar a antiga página de revisão de importações     | proibido pelo escopo           |
| Comando canônico para valor/odd de aposta confirmada  | decisão de produto pendente    |
| Remover tipster sem comando                           | decisão de produto pendente    |
| `UX-03..UX-06`, fundos animados, rebranding           | fora desta tarefa              |
| Qualquer alteração de ledger, exposição ou liquidação | bloqueio financeiro preservado |
