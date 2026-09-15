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

- `schemaVersion: 1` e `bookmakerContext`: `user-informed` quando o usuário
  informa a casa (a IA não é fonte de verdade para o bookmaker; marca ausente
  não invalida o bilhete) ou `visual-only`, o contrato legado em que a
  classificação visual decidia; ausente equivale a `visual-only`.
- `layout`: `id`, `bookmaker` (slug; somente `bet365`,
  `superbet` e `novibet` são aceitos), `bookmakerId` do cadastro de destino,
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
equivalentes; separadores isolados de confronto (`x`, `v`, `vs`, `-`, `–`, `—`)
são equivalentes em `selections.event`, assim como a estrutura empilhada em que
exatamente dois lados não vazios aparecem separados por quebra de linha (o
separador implícito dos layouts atuais); a ausência total de separador é
divergência (leitura incerta) e `º`/`°` são equivalentes em mercados. O hífen
dentro de nomes permanece significativo e nenhuma outra normalização semântica é
aplicada — nomes, valores, odds, datas, acentos e ordem continuam exatos. No
modo `user-informed`, a casa vem do contexto: layout não reconhecido pelo
modelo não perde um bilhete válido e a evidência visual só pesa quando aponta
para outra casa. O relatório separa cinco grupos: (1) **erros essenciais do
conteúdo extraído** (transcrição); (2) **diagnósticos de layout visual**
(reconhecimento do modelo, incluindo falsos positivos cross-house — nunca
mascarados); (3) **divergências normalizáveis** (as equivalências acima,
aplicadas somente no comparador); (4) **erros de contexto** (conflito de casa;
a IA não é fonte de verdade para o bookmaker); (5) **falhas que obrigam
revisão humana** (respostas inválidas preservadas, incertezas e ambiguidades).
A elegibilidade exige zero erros essenciais, zero falso positivo cross-house e
cobertura mínima; itens de revisão humana nunca são aprovados automaticamente.
O relatório privado
identifica índice do caso e campo com erro, sem copiar os valores; a saída de
console mostra somente totais e hashes.

`pnpm validation:policy <arquivo-de-políticas-absoluto> <diretório-corpus>...`
verifica uma política proposta contra as evidências salvas: recalcula a
avaliação, confere hashes, cobertura, contagens e validade, exige que cada
entrada tenha corpus aprovado correspondente e falha fechado quando qualquer
campo divergir. A verificação não escreve nada e não imprime conteúdo dos
bilhetes.

Para levar um layout à aprovação, exigir zero divergências na amostra, pelo
menos 20 imagens distintas do layout, cinco exemplos que não devem ser
reconhecidos, três múltiplas do layout e três casos do próprio layout com
ausências explícitas. As ausências dos exemplos negativos não substituem essa
cobertura. No caminho com casa informada, a amostra positiva avalia a extração
do bilhete: o reconhecimento visual do layout não é classificação independente
obrigatória, mas falsos positivos cross-house continuam bloqueando a aprovação
e são reportados à parte. Políticas
que permitem freebet exigem ao menos três exemplos promocionais. Amostras
repetidas não contam como cobertura. Esses mínimos são critérios de ensaio,
não estimativa estatística da precisão futura. Cada layout/casa precisa de
seu próprio ensaio; a rodada atual do beta avalia Bet365 e Superbet
separadamente. Novibet está fora do escopo inicial do beta (D025); quando
retornar ao escopo, exige o próprio ensaio com os mesmos mínimos.

Depois de conferir o relatório e autorizar a política, o proprietário prepara
um JSON privado com uma lista de até cinco layouts. Cada item segue
`validatedLayoutSchema`: os campos de `layout`, `layoutSha256`, `corpusSha256`
e `evaluationSha256` apresentados pelo avaliador, `coverage` com as contagens
da amostra, `sampleCount`, `essentialFieldErrors: 0`, `approvedBy: "owner"`,
`approvedAt` com offset e `expiresAt` (validade explícita; política expirada é
recusada).
O worker valida esses campos, o modelo do layout (um dos três da cadeia
aprovada — Qwen e DeepSeek só importam com corpus e política próprios),
`approvedAt` no passado e
`expiresAt` no futuro; o arquivo é a configuração operacional confiável, não
uma saída que a IA possa escrever.

Montar esse arquivo no worker, definir `AUTOMATIC_IMPORT_POLICIES_FILE` com
seu caminho absoluto e `AUTOMATIC_IMPORT_ENABLED=true`, mantendo IA habilitada.
Reiniciar o worker é necessário para trocar as políticas carregadas. Cada
alteração muda o digest usado na decisão e requer nova conferência. Desabilitar
a variável devolve as novas extrações à revisão manual. Não há políticas reais
ou automação habilitada no repositório; testes fictícios nunca as aprovam.

### Replay privado da extração

`pnpm validation:replay <casa> <diretório-privado> <diretório-da-outra-casa>
--bookmaker-id <uuid> [--model <modelo>]` gera a evidência real: o modelo
opcional pertence à cadeia aprovada (padrão: o primeiro) e qualquer outro
identificador é recusado antes de rede, escrita ou custo; lê os rascunhos privados das duas
casas, confere o SHA-256 de cada imagem, ignora as duplicatas listadas no
rascunho e usa a extração real do worker (`apps/worker/dist/openrouter.js`;
função de evidência, sem cálculo do digest de política — o fluxo normal do
worker continua sempre calculando) — uma chamada por imagem, sem repetição
automática. O replay real aplica internamente 60 segundos entre chamadas por
padrão; `--pacing-ms <milissegundos>` permite ajustar entre 15 e 300 segundos,
mas nunca desativar o intervalo numa execução real. O resumo registra o pacing
efetivamente usado. O `corpus.json` registra `bookmakerContext: user-informed`: o
ensaio avalia o caminho com casa informada. Cinco imagens distintas da
outra casa entram como negativas (`expectedLayoutId=null`). Falhas de cobrança,
cota ou autenticação abortam sem escrever; em HTTP 429, somente os headers
numéricos seguros de limite (`Retry-After` e `X-RateLimit-*`) são preservados
quando enviados pelo provedor — corpo e headers arbitrários são descartados.
Falhas por imagem ficam preservadas
em `actual.extraction` como erro sanitizado, nunca substituídas pelo esperado.
O modelo é selecionado por execução (`--model`) dentro da cadeia aprovada; a
qualificação individual mede um modelo exato por rodada, sem fallback entre
modelos — o resumo registra o modelo solicitado e o retornado, e um retorno
divergente aborta de forma sanitizada sem gravar corpus. Numa execução real o
default é o primeiro da cadeia; a OpenRouter pode trocar apenas o endpoint que
serve esse mesmo modelo em caso de indisponibilidade ou rate limit, e o nome do
provedor retornado fica registrado por caso quando a API o informa. Os
artefatos ficam separados por rodada, casa e modelo (um diretório privado
exclusivo por combinação).
`--dry-run` valida plano e configuração sem chamadas nem escrita. O
`corpus.json` só é gravado no diretório privado e não sobrescreve arquivo
existente. Exige `AI_ENABLED=true` e as variáveis OpenRouter de `.env.example`
(segredo via `OPENROUTER_API_KEY_FILE`); chaves e conteúdo de imagem não
aparecem em logs. `--draft <arquivo>` seleciona o rascunho revisado versionado
(padrão `ground-truth-draft.json`) e o resumo registra o SHA-256 dos rascunhos
usados. O extrator não infere esporte a partir de nomes de equipes ou
participantes.

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
