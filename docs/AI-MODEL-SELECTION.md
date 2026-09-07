# Seleção de IA para leitura dos bilhetes

> Decisão aprovada pelo proprietário em 06/09/2026, após comparação por Codex.
> Ainda não há benchmark com bilhetes reais nem integração implantada.
> Gemini direto substitui a instalação obrigatória do OmniRoute na VPS (D017).

## Recomendação

Usar diretamente a API Gemini. A comparação inicial priorizou
`gemini-3.5-flash-lite`, mas a prova real retornou indisponibilidade para ele
e para `gemini-3.8-flash`. O `gemini-3.1-flash-lite` respondeu e acertou os oito
campos do exemplo fictício: é o principal inicial para a próxima avaliação.
Os outros dois permanecem candidatos a revalidar, respectivamente para extração
e segunda leitura. A escolha por precisão depende das imagens das três casas
usadas pelo proprietário; esse teste simples não mede qualidade em produção.

O proprietário informou menos de 30 bilhetes em dias normais e picos de 45–60,
enviados ao longo do dia. Uma fila simples, limites por modelo e validação dos
campos podem atender esse perfil sem um serviço intermediário de roteamento.
API direta também funciona com o computador pessoal desligado.

## Cotas observadas na conta

O painel autenticado do Google AI Studio foi consultado em modo de leitura,
no projeto que contém uma chave nomeada para visão.
Faturamento, chaves e permissões não foram alterados. A tabela abaixo registra
os limites exibidos, não saldo restante nem garantia de disponibilidade.
O histórico mostrado pelo painel correspondia aos máximos nos últimos 28 dias.

| Modelo                   | Chamadas/minuto | Tokens de entrada/minuto | Chamadas/dia | Papel proposto                                  |
| ------------------------ | --------------: | -----------------------: | -----------: | ----------------------------------------------- |
| Gemini 3.5 Flash-Lite    |              15 |                  250.000 |          500 | Candidato; indisponível na prova real           |
| Gemini 3.1 Flash-Lite    |              15 |                  250.000 |          500 | Principal inicial; exemplo fictício validado    |
| Gemini 3.8 Flash         |               5 |                  250.000 |           20 | Comparação e segunda leitura de casos difíceis  |
| Gemini 3 Flash           |               5 |                  250.000 |           20 | Alternativa de comparação; versão preview       |
| Gemini 2.5 Flash         |               5 |                  250.000 |           20 | Referência adicional, sem cota para todo o pico |
| Gemini 2.5 Flash-Lite    |              10 |                  250.000 |           20 | Cota menor que a das versões Lite acima         |
| Gemini 3.1 Pro / 2.5 Pro |               0 |                        0 |            0 | Sem cota gratuita exibida no projeto consultado |

Os limites pertencem ao projeto e podem ser compartilhados com outros usos.
Uma chamada para cada um de 60 bilhetes consome 12% das 500 chamadas; duas
chamadas em todos esses bilhetes consomem 24%. Retentativas e uso externo ao
Stakeframe também contam. A fila deve respeitar os limites e encaminhar a
revisão quando uma segunda leitura não estiver disponível, sem troca automática
para um provedor pago.

Fonte da observação: [painel de limites da conta](https://aistudio.google.com/rate-limit).
O Google orienta consultar os limites ativos no AI Studio, pois variam por
projeto e nível: [documentação de cotas](https://ai.google.dev/gemini-api/docs/rate-limits).

## Adequação dos modelos

- **Gemini 3.5 Flash-Lite:** recebe imagens e oferece saída estruturada; o
  fabricante o descreve para processamento de documentos e extração simples.
  Foi o primeiro candidato pela combinação de finalidade e cota disponível,
  mas não concluiu a prova devido a indisponibilidade do serviço.
  [Ficha oficial](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
- **Gemini 3.8 Flash:** também recebe imagens e oferece saída estruturada.
  Deve participar da avaliação dos bilhetes complexos, com múltiplas seleções,
  texto pequeno e trechos ambíguos. Sua vantagem sobre o Lite precisa ser
  demonstrada na amostra, não presumida pelo nome ou por avaliações de código.
  [Ficha oficial](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
- **Gemini 3.1 Flash-Lite:** recebe imagens e suporta JSON estruturado. A
  documentação inclui extração de dados entre seus usos; é uma comparação
  pertinente com a versão 3.5 do catálogo da mesma conta. A prova real com o
  3.1 passou; ele inicia a avaliação dos bilhetes privados.
  [Ficha oficial](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite).
- **OpenCode Go — Kimi K2.6/K3:** constam do catálogo Go e têm visão na API
  original; K3 também documenta schema estrito. São candidatos técnicos,
  sujeitos à confirmação de suporte no endpoint Go e de adequação do plano
  ao uso de um aplicativo de bilhetes. A documentação Go descreve o plano
  para OpenCode e agentes de programação com solicitações semelhantes.
  Ter uma chave não comprova essas duas condições. Os modelos Kimi ainda não
  foram testados; o ensaio Go abaixo se limita ao DeepSeek solicitado depois.
  [Go](https://opencode.ai/docs/go/),
  [Kimi K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart),
  [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart).

O proprietário solicitou depois o teste de `deepseek-v4-flash-vision-exp` pelo
Go. A extração privada concluída conferiu os mesmos 22 campos que o Gemini,
mas levou 91.019 ms, contra 3.000 ms no Gemini. É uma única imagem e houve
ajustes no verificador, inclusive no limite de transporte SSE; não interpretar
isso como uma medida geral de precisão ou falha do modelo. A candidatura
permanece experimental e não altera o provedor inicial. Não converter as
estimativas de requisições de programação do plano em bilhetes por dia.

## Validação antes da escolha final

Em `2026-09-07T00:44:58.674Z`, o 3.1 Flash-Lite respondeu em 6.531 ms e
conferiu 8/8 campos do exemplo fictício, inclusive dinheiro/odds como strings
decimais e data ausente como `null`. A resposta informou 1.348 tokens totais.
Os ensaios de 3.5 Flash-Lite e 3.8 Flash retornaram HTTP 503 `UNAVAILABLE`;
não há medida de precisão deles. [Procedimento](AI-PROBE.md) e
[registro completo](M0-16-VALIDATION.md). Não generalizar disponibilidade nem
latência de uma única execução.

Comparar os candidatos com a mesma amostra privada e gabarito conferido pelo
proprietário: bilhetes simples e múltiplos das três casas, texto pequeno,
recortes, datas ausentes e imagens ilegíveis. Medir acerto por campo, acerto
integral por bilhete, omissões, valores inventados, latência, retentativas e
chamadas consumidas. A amostra inicial serve para seleção, não para certificar
uma taxa de erro baixa em produção.

Campos essenciais: casa, evento, mercado, seleção, odd, valor apostado,
quantidade de seleções e data/hora quando visíveis. Preservar texto original
e ausências explícitas. O sistema calcula valores e concilia dados por regras
determinísticas; a IA não decide saldos nem inventa dados ausentes.

JSON correto não garante números corretos. Validar os valores e encaminhar
incertezas à revisão, conforme a própria
[documentação de saída estruturada](https://ai.google.dev/gemini-api/docs/structured-output).

O nível gratuito do Google informa uso de conteúdo para melhorar seus
produtos. Isso precisa fazer parte da escolha antes de enviar bilhetes reais;
após a comparação inicial, o proprietário forneceu uma imagem e solicitou
o teste. Essa imagem foi enviada ao Go e ao Gemini no ensaio privado descrito
no registro, sem publicar arquivo, transcrição ou valores no GitHub.
[Condições do nível gratuito](https://ai.google.dev/gemini-api/docs/pricing).

A pesquisa ampliada de APIs solicitada pelo proprietário está em
[AI-API-CANDIDATES.md](AI-API-CANDIDATES.md). As recomendações de novos testes
não representam acesso confirmado à conta nem autorização de cobrança.

## Efeito na infraestrutura

O plano foi atualizado para Gemini direto no worker da VPS, mantendo
configuração de modelo e credencial fora do código de processamento.
O backup do OmniRoute local preserva a opção de usá-lo depois. Não é necessário
instalá-lo na VPS apenas para consumir uma API Gemini, e a comparação atual
não autoriza migração de sessões ou contratação de outro plano.
