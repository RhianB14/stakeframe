# PR #279 — contratos dos testes de navegador

**Estado:** proposta de design; abordagem B aprovada em m01330. Esta especificação aguarda revisão escrita do proprietário.

**Objetivo:** alinhar fixtures e assertions de browser com o comportamento atual e as invariantes do PR #279, eliminando falhas determinísticas sem reduzir cobertura.

**Arquitetura:** manter fixtures distintas para fluxos de hoje e de histórico; deixar preferências e identidade dos dados explícitas; fazer selectors/assertions pela interface acessível; modelar cache e retry conforme a configuração existente. As mudanças de produto cobertas pela especificação irmã “PR #279 — comportamento e acessibilidade da aplicação” permanecem obrigatórias.

**Contexto de referência:** [PR #279](https://github.com/RhianB14/stakeframe/pull/279), sua descrição de escopo/regressões e a configuração vigente em [playwright.config.ts](../../../playwright.config.ts).

## Decisões por fluxo

### Datas, lista e histórico

A fixture base em [tests/e2e/product-fixtures.ts:199–207](../../../tests/e2e/product-fixtures.ts#L199-L207) representa aposta de 2026-09-01, portanto é histórica em 2026-10-14. Preservá-la para testes de histórico. Criar/derivar uma fixture específica de hoje para casos que verificam lista atual, tabela responsiva, ordenação e cashout; derivar o dia com saoPauloDate(new Date()) e usar horário seguro dentro do dia de São Paulo. Os testes não devem depender de uma data fixa nem mudar a separação correta do produto entre hoje e histórico.

### Moeda e preferências

Nos cenários que afirmam valores R$1.000, configurar explicitamente a moeda de exibição BRL pela preferência existente antes da asserção. Não mudar o default USD nem depender de uma taxa externa incidental. Cobrir tanto o workspace privado quanto a sessão expirada que confirma a remoção de dados privados.

### Onboarding e cadastro

Atualizar o teste de primeira aposta para o fluxo de referência vigente: selecionar Straight (que avança imediatamente à etapa de seleções), preencher Event, Bet Type e Selection, e só então usar CONTINUE para avançar à etapa seguinte. Preservar o registro e asserções após o formulário; não reverter copy/fluxo da aplicação para satisfazer expectativas antigas em português. Verificar desktop e mobile.

### Identidade do calendário

Decisão do proprietário (m06967): opção 3 — aceitar que a ação “Conferir data” seja removida do calendário e que BetTrack detail não exponha “Conferir data e fontes” nesta PR. Não restaurar UI. Atualizar E2E para preservar as verificações de contagem/pendências e navegação `Ver aposta`→detalhe, afirmando a ausência dos CTAs e que nenhum comando de revisão é enviado. Remover os dois E2Es de UI que exigem EventReview/event-search sem entrada ativa; manter cobertura de backend em `tests/integration/events.test.ts`. Sem alterações de aplicação/API/schema. Custo aceito: a revisão/busca de datas não fica acessível nesses fluxos da interface e perde sua cobertura E2E até eventual reintrodução explícita.

### Seletores acessíveis

O campo de tipo de mercado com datalist é exposto como combobox; localizar pelo papel combobox. Localizar o resumo histórico pelo grupo nomeado definido na especificação de comportamento e conferir o texto vigente “2 BETS”, sem getByLabel em div genérico nem dependência de texto oculto.

### Cache e filtros do histórico

O query key inclui os parâmetros serializados e o QueryClient usa staleTime=15_000 em [apps/web/src/main.tsx:8](../../../apps/web/src/main.tsx#L8). Remover/limpar o chip restaura a chave não filtrada ainda fresca; o comportamento esperado é mostrar novamente as linhas, remover o chip e limpar o campo sem exigir nova requisição. Não forçar invalidação nem tratar a última request como fonte da verdade quando o resultado vem do cache.

### Analytics e retry manual

Manter o retry global retry=1. Os testes que verificam estado de erro e retry manual devem retornar 503 nas duas primeiras tentativas (inicial e retry automático), manter os dados de endpoints bem-sucedidos visíveis e retornar sucesso após a ação explícita do usuário na terceira tentativa. Confirmar que o retry manual repete apenas o endpoint que falhou. Depois da correção CSS, localizar valores nas métricas visíveis/linhas apropriadas, não em nós ocultos ou na primeira ocorrência global de texto duplicado.

## Arquivos e responsabilidades esperados

- [tests/e2e/product-fixtures.ts](../../../tests/e2e/product-fixtures.ts): fixtures distintas para hoje/histórico e detalhe do calendário com IDs consistentes.
- [tests/e2e/product.test.ts](../../../tests/e2e/product.test.ts): asserts de moeda, lista, história, mercado, first-use, calendário, analytics, cache e recuperação.
- [tests/e2e/onboarding.test.ts](../../../tests/e2e/onboarding.test.ts): labels e sequência atuais de referência.
- [apps/web/src/product/pages.tsx](../../../apps/web/src/product/pages.tsx) e [apps/web/src/product/product.css](../../../apps/web/src/product/product.css): apenas conforme especificação irmã, para tornar acessível o resumo e manter analytics visível.

## Critérios de aceitação

1. Testes de dados de hoje usam data São Paulo derivada em runtime; testes históricos mantêm fixture histórica explícita.
2. Os cenários que esperam BRL configuram BRL e são determinísticos independentemente de taxa de câmbio externa.
3. Onboarding e entrada de aposta usam nomes/etapas atuais nos dois projetos Playwright.
4. Calendário e detalhe compartilham identidade de seleção válida.
5. Limpar filtro valida linhas/chips/campo restaurados, sem exigir refetch dentro da janela fresca de 15 segundos.
6. Erros persistentes de analytics permanecem visíveis após o retry automático; a ação explícita recupera somente a consulta falha, com contagem compatível com retry=1.
7. Nenhum teste é removido, rebaixado para assertion mais fraca ou estabilizado aumentando timeouts sem evidência; nenhum novo skip é adicionado. Preservar somente o skip condicional pré-existente da ordenação no mobile, pois a tabela ordenável pertence ao desktop.
8. A suíte E2E completa, em desktop Chromium e mobile Chromium, passa localmente e nos dois jobs CI (AMD64 e ARM64).

## Fora de escopo e restrições

- Não alterar API, migration, schema, dependências, preferência padrão de moeda, retry global ou regra de cache.
- Não reclassificar apostas históricas como apostas de hoje.
- Não incluir scripts temporários de smoke test como parte da entrega.
- Node.js >=24.20.0 <25; pnpm 11.24.0.
- Nenhum commit/push/merge/deploy de produto fica autorizado por este documento; a revisão e as gates operacionais da PR continuam obrigatórias.

## Foco de revisão

- Virada de dia em America/Sao_Paulo: datas UTC próximas à meia-noite devem permanecer no dia local correto.
- Preferência BRL explícita: resultados monetários de teste não dependem de taxa disponível ou mudança de default.
- Mobile e desktop: mesma regra de produto com visibilidade/seletores próprios de cada viewport.
- Cache fresco: remover o filtro mostra resultado anterior sem request duplicada; cache vencido não é confundido com cache fresco.
- Falhas persistentes e transitórias: retry automático e retry manual são diferenciados sem apagar dados de endpoints saudáveis.
