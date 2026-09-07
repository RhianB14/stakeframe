# Validação do piloto

## Volume e desempenho

`pnpm validation:performance` usa exclusivamente a configuração de `.env.local`
e PostgreSQL em `127.0.0.1`, cria uma base aleatória `stk_perf_test_*`, aplica as
migrações e remove somente a base criada por aquela execução. Não aceita URL
externa nem carrega dados reais. Execute após `pnpm local:up`.

A massa fictícia contém 10 mil apostas, 16.666 seleções, 5 mil liquidações e
35.003 partidas contábeis. Há múltiplas, esportes diferentes, 500 datas ausentes
e 500 estimadas. As 9 mil apostas com data confirmada geram resultado de
R$22.500 e exposição de R$45 mil no relatório. A banca completa, incluindo as
pendências de data, fecha em R$225 mil, com exposição de R$50 mil. Cada diário
deve ter soma zero; dimensões, calendário, detalhamento e exportações devem
usar a população esperada. Esse cenário complementa os testes de operações,
freebets, estornos e concorrência; não substitui o piloto real.

O ensaio aquece cada operação e mede dez amostras de leituras e três de cada
exportação. O p95 usa o método de posição mais próxima; nestas amostras pequenas,
equivale ao maior tempo observado. São limites de engenharia para regressões:

| Operação                               | Limite p95 |
| -------------------------------------- | ---------- |
| Visão geral da banca                   | 500 ms     |
| Relatório completo                     | 2 s        |
| Primeira/última página do detalhamento | 500 ms     |
| CSV de 9 mil apostas                   | 10 s       |
| JSON completo de 10 mil apostas        | 10 s       |

As medições incluem a chamada ao serviço, SQL, validação e serialização; não
incluem rede pública, autenticação HTTP ou renderização do navegador. A CI
executa o ensaio em amd64 e arm64. O arquivo local ignorado pelo Git
`.cache/validation/performance.json` registra versões, plataforma, reconciliação,
amostras e limites, sem credenciais. O número medido localmente não é SLA da VPS.

Em 07/09/2026, no ambiente Windows x64 com PostgreSQL 18 e Node 24.20.0, a
primeira execução conciliada apresentou p95 de 48 ms para a banca, 622 ms para
o relatório, 199/223 ms para as páginas inicial/final, 485 ms para CSV e 1.582 ms
para JSON. A execução não mostrou necessidade de novos índices ou caches.

## Limites de consultas

O pool normal cancela a consulta no servidor após 3 segundos e aguarda até
5 segundos pelo retorno. Assim, um timeout não deixa a consulta rodando em
segundo plano. A conexão dedicada de migração usa 30 segundos por comando,
35 segundos de espera do cliente e 10 segundos para locks; é encerrada após
o uso. Os testes de administração de bases temporárias têm até 30 segundos.
As opções de timeout recusam valores inválidos, zero e valores acima de 30 s.

Testes com PostgreSQL real verificam o cancelamento pelo servidor, a reutilização
da conexão e a independência dos limites de migração. Os relatórios e
exportações permanecem em snapshots consistentes e com paginação limitada.

## Amostras privadas de extração

`pnpm validation:corpus <diretório-absoluto-privado>` lê `corpus.json` e grava
`evaluation.json` no mesmo diretório, fora do repositório. Não sobrescreve uma
avaliação existente, não faz chamadas de rede e não cria uma política ativa.
O diretório/arquivo devem ser privados; no Linux, usar permissões 0700/0600.
O limite do arquivo é 20 MiB. Imagens, gabaritos e respostas reais não vão ao Git.

O contrato executável é `corpusEvaluationInputSchema` em
`packages/shared/src/automatic.ts`. O arquivo contém:

- `schemaVersion: 1` e `layout`: `id`, `bookmakerId` do cadastro de destino,
  `model`, descrição visual exata, `placedAtFormat` (`iso-offset` ou
  `br-sao-paulo`) e `allowFreebet`.
- `cases`: SHA-256 da imagem em `imageSha256`, `expectedLayoutId` (ID ou `null`
  para imagens que não devem ser reconhecidas), `expected` com todos os campos
  de `ticketExtractionSchema` conferidos pelo proprietário e `actual`.
- `actual`: `imageSha256`, `model`, `layoutId`, `extraction`, `latencyMs`,
  `requestCount` e `costUsd` (valor informado pelo provedor ou `null`). Preservar
  respostas inválidas em `extraction` para contá-las como falhas. A ausência de
  custo não equivale a zero. O worker registra duração e uso junto à extração.

A avaliação verifica vínculo imagem/modelo/layout, validade do JSON, campos
essenciais, quantidade/ordem das seleções, presença de dúvidas, omissões e
valores inventados. Dinheiro/odds com representações como `10` e `10.00` são
equivalentes; textos têm apenas normalização Unicode/espaços, sem trocar
nomes, inferir datas ou corrigir valores. O relatório privado identifica
índice do caso e campo com erro, sem copiar os valores; a saída de console
mostra somente totais e hashes.

Para levar um layout à aprovação, exigir zero divergências na amostra, pelo
menos 20 imagens distintas do layout, cinco exemplos que não devem ser
reconhecidos, três múltiplas do layout e três casos do próprio layout com
ausências explícitas. As ausências dos exemplos negativos não substituem essa
cobertura. Políticas
que permitem freebet exigem ao menos três exemplos promocionais. Amostras
repetidas não contam como cobertura. Esses mínimos são critérios de ensaio,
não estimativa estatística da precisão futura. Cada layout/casa precisa de
seu próprio ensaio; validar Bet365, Superbet e Novibet separadamente.

Depois de conferir o relatório e autorizar a política, o proprietário prepara
um JSON privado com uma lista de até cinco layouts. Cada item segue
`validatedLayoutSchema`: os campos de `layout`, `corpusSha256` e
`evaluationSha256` apresentados pelo avaliador, `sampleCount`,
`essentialFieldErrors: 0`, `approvedBy: "owner"` e `approvedAt` com offset.
O worker valida esses campos e o modelo fixo; o arquivo é a configuração
operacional confiável, não uma saída que a IA possa escrever.

Montar esse arquivo no worker, definir `AUTOMATIC_IMPORT_POLICIES_FILE` com
seu caminho absoluto e `AUTOMATIC_IMPORT_ENABLED=true`, mantendo IA habilitada.
Reiniciar o worker é necessário para trocar as políticas carregadas. Cada
alteração muda o digest usado na decisão e requer nova conferência. Desabilitar
a variável devolve as novas extrações à revisão manual. Não há políticas reais
ou automação habilitada no repositório; testes fictícios nunca as aprovam.

## Piloto e aceite operacional

Iniciar o piloto somente após a implantação autorizada, com saldos iniciais
conferidos e importação automática desabilitada. A proposta de observação é
sete dias consecutivos e ao menos 30 comprovantes reais, incluindo as casas
usadas, apostas simples/múltiplas, freebets e revisão de imagens difíceis.
Se a atividade não gerar essa variedade, estender o piloto; não fabricar
operações reais para atingir uma amostra.

Registrar diariamente, em arquivo privado, saldo de reserva e de cada casa,
principal exposto e créditos promocionais separados. Comparar os comprovantes
com o histórico imutável, incluindo depósitos, retiradas, liquidações e
estornos. Explicar cada diferença antes de avançar. Exportar CSV/JSON e testar
recuperação em ambiente isolado com o backup daquele período, sem restaurar
sobre a base operacional.

Antes da `v1.0.0`, anexar evidência privada de saldos conciliados, revisão dos
layouts, custos/cotas, alertas recebidos, restauração e funcionamento com o
computador pessoal desligado. Validar upload, Telegram, revisão, calendário,
relatórios e correções em desktop e celular. Critérios finais e autorização
de release/deploy permanecem em [PLAN.md §5.5](PLAN.md#55-aceite-da-primeira-versão).
O desempenho sintético e a CI não encerram esse aceite real.
