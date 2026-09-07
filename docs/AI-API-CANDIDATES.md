# Candidatos de API para extração de bilhetes

Pesquisa em 06/09/2026, horário de São Paulo, após solicitação do proprietário.
Recomendação: manter Gemini 3.1 Flash-Lite como referência já testada e obter
acesso à API OpenAI para comparar GPT-5.6 Terra e Luna. Uma chave de projeto
com acesso a esses modelos permite os dois testes. Claude Sonnet 5 é um
terceiro provedor candidato, se a comparação inicial não atender.

Esta ordem prioriza ganho de informação e custo de teste. Não é um ranking
medido de precisão em bilhetes nem decisão de contratar ou ativar faturamento.
Os novos modelos abaixo não foram testados na conta do proprietário.

## O que precisamos avaliar

- Ler casa, evento, odds e valores sem trocar separadores decimais.
- Preservar cada seleção e seu período/time em apostas combinadas.
- Distinguir stake, retorno potencial, oferta de cashout e bônus exibidos.
- Preservar ausência de data absoluta e de resultado/liquidação.
- Devolver estrutura validável, recusar imagens ilegíveis e encaminhar
  divergências à revisão. JSON válido não demonstra acerto semântico.

## Lista curta e custo de referência

Estimativa aritmética para 1.800 imagens/mês, uma chamada por imagem, com
2.000 tokens faturáveis de entrada (incluindo imagem) e 500 de saída
(incluindo raciocínio). Não inclui repetição, segunda leitura, impostos,
ferramentas ou cache. A tokenização varia entre fornecedores e imagens;
os valores abaixo são cenários, não previsão de fatura nem limite máximo.

| Modelo                | Papel sugerido no teste                                                   | Entrada / saída por 1M tokens          | Cenário mensal USD             |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Gemini 3.1 Flash-Lite | Referência econômica com resultado real positivo                          | 0,25 / 1,50; nível gratuito disponível | 0 dentro da cota; 2,25 no pago |
| Gemini 3.8 Flash      | Comparação Google para imagens mais difíceis; disponibilidade a revalidar | 0,75 / 3,75, promoção até 31/12/2026   | 6,08 no pago                   |
| GPT-5.6 Terra         | Candidato com equilíbrio entre capacidade e custo                         | 2,00 / 12,00                           | 18,00                          |
| GPT-5.6 Luna          | Candidato de menor custo da mesma API                                     | 0,20 / 1,20                            | 1,80                           |
| Claude Sonnet 5       | Alternativa de outro fornecedor para comparação                           | 2,00 / 10,00                           | 16,20                          |

As fichas OpenAI confirmam imagem como entrada e saída estruturada. O Gemini
3.8 também documenta essas capacidades. O guia de Sonnet 5 recomenda saídas
estruturadas e preserva visão; a compatibilidade do schema concreto será
conferida no teste. Capacidade anunciada não substitui avaliação privada.

Fontes de recursos e preços:

- [Gemini 3.1](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
  e [preços Google](https://ai.google.dev/gemini-api/docs/pricing).
- [Gemini 3.8](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
  e [preço introdutório](https://ai.google.dev/gemini-api/docs/latest-model).
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
  e [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).
- [Claude Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5)
  e [visão e recursos](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide).

## OCR especializado e opções já disponíveis

[Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1) merece teste se a
dificuldade dominante for texto pequeno, layout ou documentos: oferece
extração com caixas, estrutura e confiança por bloco, além de anotações
estruturadas. O preço publicado de USD 5 por 1.000 páginas anotadas corresponde
a USD 9 para 1.800 imagens tratadas como uma página cada. Não há evidência
local de vantagem sobre os modelos multimodais nos bilhetes do proprietário.

DeepSeek V4 Flash Vision Exp já foi testado pelo Go com a imagem fornecida:
os 22 campos da resposta concluída coincidiram com o Gemini, em 91,019 s
contra 3,000 s. Foram quatro tentativas Go com ajustes no cliente e uma
Gemini; as configurações de raciocínio/transporte foram diferentes. Não
generalizar essa diferença para o modelo ou descartar sua precisão.
[Registro do ensaio](M0-16-VALIDATION.md).

A chave Google existente já serve aos candidatos Google, sujeito a acesso,
cota e disponibilidade. Não é necessário obter outra chave Google apenas
para mudar de modelo. Os limites do projeto são compartilhados entre chaves.
O principal inicial permanece Gemini 3.1; a pesquisa não muda o runtime.

## Próxima avaliação

Comparar a mesma amostra privada de bilhetes nas três casas, incluindo casos
simples, combinados, recortados, bônus/cashout, datas ausentes e texto difícil.
Fixar gabarito visual antes das chamadas. Medir acerto integral e por campo,
valores inventados, recusas, latência e tokens por tentativa. Só então decidir
modelo principal e eventual segunda leitura para casos divergentes.

Nenhuma nova assinatura ou crédito foi adquirido nesta pesquisa. Acesso e
faturamento da nova API precisam ser confirmados antes dos próximos testes.
