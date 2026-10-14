# PR #279 — comportamento e acessibilidade da aplicação

**Estado:** proposta de design; abordagem B aprovada em m01330. Esta especificação aguarda revisão escrita do proprietário.

**Objetivo:** corrigir os defeitos de apresentação e de controle de apostas confirmados durante a investigação da CI do PR #279, preservando os contratos financeiros existentes.

**Arquitetura:** limitar o ocultamento do grid de métricas à rota Painel, bloquear a ação vazia de registrar aposta quando a banca ainda não foi inicializada e dar semântica acessível ao resumo do histórico. As mudanças ficam nos componentes/CSS existentes e não alteram consultas, contratos de API ou o fluxo explícito de confirmação de saldos.

**Contexto de referência:** [PR #279](https://github.com/RhianB14/stakeframe/pull/279), especialmente o escopo e as regressões de analytics declaradas na descrição da PR.

## Evidências e decisões

1. A regra em [apps/web/src/product/product.css:7110–7112](../../../apps/web/src/product/product.css#L7110-L7112) esconde todo .metric-grid que seja filho direto de .product-main. A página de analytics monta .metric-grid.report-metrics nessa posição, então seus indicadores ficam invisíveis. Restringir a regra ao grid da rota Overview/Painel; analytics mantém cards visíveis. Não alterar o conteúdo, os cálculos nem a política de retry.
2. A ação vazia do painel em [apps/web/src/product/ProductApp.tsx:1615–1617](../../../apps/web/src/product/ProductApp.tsx#L1615-L1617) chama open({ kind: 'bet' }) sem o bloqueio de inicialização usado por outros pontos de entrada. Desabilitá-la quando workspace.initialized for falso. Uma banca não inicializada não pode iniciar a criação de aposta pelo painel; depois da inicialização a ação permanece disponível. A confirmação explícita dos saldos continua sendo o fluxo existente.
3. O resumo do histórico em [apps/web/src/product/pages.tsx:1826–1841](../../../apps/web/src/product/pages.tsx#L1826-L1841) usa aria-label em um div genérico. Expor o resumo como grupo nomeado, preservando valores/texto, para que leitores de tela e testes possam localizá-lo semanticamente.

## Contratos de comportamento

- Na rota Analytics, os cards de métricas aparecem e podem ser alcançados; a regra de ocultamento do grid não vaza para essa rota.
- Na rota Overview/Painel, a apresentação previamente intencional do grid não muda.
- Com workspace.initialized=false, a ação vazia do painel não abre o formulário de aposta; inicializar a banca pelo fluxo atual continua exigindo a confirmação já existente.
- Com workspace.initialized=true, a ação de registrar aposta permanece utilizável.
- O resumo do histórico conserva os mesmos valores, passa a ser um grupo acessível com nome e não muda a formatação localizada.
- Falha ou retry de analytics não deve remover dados de outro endpoint que carregou com sucesso; o default global de retry permanece inalterado.

## Arquivos e responsabilidades esperados

- [apps/web/src/product/product.css](../../../apps/web/src/product/product.css): escopo da regra CSS à página Overview/Painel.
- [apps/web/src/product/ProductApp.tsx](../../../apps/web/src/product/ProductApp.tsx): guarda de inicialização na ação vazia do painel.
- [apps/web/src/product/pages.tsx](../../../apps/web/src/product/pages.tsx): semântica acessível do resumo do histórico.
- [tests/e2e/product.test.ts](../../../tests/e2e/product.test.ts): regressões que comprovem visibilidade, bloqueio da criação antes da inicialização e nome acessível do resumo.

## Critérios de aceitação

1. O grid .report-metrics está visível no Analytics e os resultados de analytics existentes continuam legíveis.
2. A ação vazia de criar aposta fica desabilitada antes da inicialização e não abre o formulário; após inicialização não fica indevidamente bloqueada.
3. O resumo do histórico é encontrado pelo papel/nome acessível e seus valores não mudam.
4. Nenhum endpoint, esquema, migração, dependência ou default global de retry é alterado.
5. Os E2Es relevantes passam em desktop Chromium e mobile Chromium.

## Fora de escopo e segurança

- Não mudar regra financeira, arredondamento/decimais, consentimento, idempotência, autorização ou persistência.
- Não mudar QueryClient retry/staleTime nem invalidar cache só para satisfazer uma contagem de requests.
- Não introduzir dependências, migration ou alteração de schema.
- Esta especificação não autoriza push, merge, release ou deploy; esses atos permanecem sujeitos às gates e autorizações específicas do repositório.

## Restrições globais

- Node.js >=24.20.0 <25; pnpm 11.24.0.
- Sem novos pacotes ou alterações de banco.
- Não enfraquecer um teste de comportamento para ocultar um defeito confirmado.

## Foco de revisão

- Banca ainda não inicializada: nenhuma ação do painel abre criação de aposta; confirmação de saldo continua explícita.
- Analytics: cards permanecem visíveis mesmo sob o tema BetTrack e os estados parciais de erro continuam isolados.
- Painel: restringir o CSS sem tornar visível um grid duplicado que a rota Overview intencionalmente oculta.
- Histórico: o grupo nomeado conserva valores, texto e comportamento para teclado/leitor de tela.
- Sem regressão financeira: nenhum cálculo ou valor monetário muda como efeito colateral.
