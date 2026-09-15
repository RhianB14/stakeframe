# OpenRouter — configuração escolhida

O proprietário aprovou Gemini 3.8 Flash via OpenRouter para o projeto após
o ensaio de 06/09/2026. A chave existente foi renomeada para
`Stakeframe - Gemini 3.8 Flash`, mantendo o segredo original em arquivo
privado. O limite passou de USD 1 total para **USD 5 mensais**, com renovação
no dia 1 em UTC, confirmada no console. Isso não ativa recarga de saldo.

## Configuração preparada

As variáveis de [.env.example](../.env.example) descrevem o contrato do runtime:

- Provedor `openrouter`, endpoint `https://openrouter.ai/api/v1/chat/completions`.
- Cadeia fixa e versionada, sem aliases: `google/gemini-3.8-flash` →
  `qwen/qwen3-vl-32b-instruct` →
  `deepseek/deepseek-v4-flash-vision-exp`. A ordem reflete a triagem privada de
  15/09/2026; a OpenRouter só avança quando o modelo anterior falha.
- `OPENROUTER_API_KEY_FILE`: caminho absoluto para segredo fora do Git.
- Até 4.096 tokens de saída, raciocínio desabilitado, `seed: 0` e prazo de 60
  segundos. Raciocínio e temperatura não são enviados porque não pertencem ao
  conjunto de parâmetros comum dos três modelos.
- Schema JSON explícito e `provider.require_parameters=true`.
- `provider.allow_fallbacks=true` com ordenação por throughput permite tanto o
  failover entre endpoints do mesmo modelo quanto o avanço pela cadeia fixa.
  Não existe retry da aplicação: toda a cadeia ocorre dentro de uma única
  requisição HTTP.
- A chamada não envia `temperature`: esse parâmetro excluiria o endpoint Google
  Vertex sob `require_parameters=true` e deixaria somente o Google AI Studio.
  `seed: 0` preserva a intenção determinística sem inutilizar o failover.
- O modelo e o provedor efetivos ficam na evidência. Qwen e DeepSeek ainda não
  possuem corpus aprovado; portanto podem produzir uma extração para revisão,
  mas nunca herdam o digest da política Gemini nem importam automaticamente.
  Erros finais de crédito/cota preservam o trabalho para revisão e não
  recarregam saldo.
- Antes do envio, o worker cria uma cópia visual transitória: respeita a
  orientação EXIF e aplica realce leve de contraste/nitidez, sem alterar os
  bytes originais guardados no anexo e sem binarização de OCR.

## OCR auxiliar

O worker possui uma camada opcional de Google Document AI Enterprise OCR. Ela
é desligada por padrão (`GOOGLE_DOCUMENT_AI_ENABLED=false`) e, quando ativada,
envia a imagem original ao processor configurado antes da chamada OpenRouter.
O modelo recebe o texto, posições, blocos, linhas, confiança e qualidade como
contexto auxiliar junto da imagem. A imagem permanece a fonte de verdade e
falha do OCR é fail-closed; não existe fallback silencioso que remova essa
camada. O OCR não libera importação automática e seus dados permanecem
transitórios e privados.

Em produção, o processor exige `GOOGLE_DOCUMENT_AI_PROJECT_ID`,
`GOOGLE_DOCUMENT_AI_LOCATION`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` e uma
service account JSON montada em `GOOGLE_DOCUMENT_AI_CREDENTIALS_FILE`. O
segredo não deve ser colocado no ambiente, repositório, PR ou logs. A ativação
real exige uma rodada comparativa privada contra o corpus, medindo multimodal
sozinho versus Document AI + multimodal.
O overlay operacional está em `compose.document-ai.yml` e não é incluído nos
Composes padrão.

Na máquina do proprietário há `project.env`, segredo, metadados e resultado
em pasta privada com ACL limitada ao proprietário e SYSTEM. O segredo não
foi instalado na VPS. O worker consome essas variáveis somente quando
`AI_ENABLED=true`, conforme [INTEGRATION-RUNTIME.md](INTEGRATION-RUNTIME.md).
A ativação real e a revisão financeira permanecem pendentes. O helper `pnpm ai:setup`
continua limitado aos ensaios sintéticos Google/Go; não executa OpenRouter.

O limite remoto da chave é o controle efetivo de gasto. Uma variável local
não substitui esse limite. A chave não possui restrição remota de modelos;
a seleção exata acima é requisito do cliente, não uma permissão da chave.

## Evidência do teste autorizado

Uma chamada ao modelo selecionado terminou em `2026-09-07T01:20:27.858Z`:
HTTP 200, resposta completa, 5.141 ms, 2.121 tokens de entrada, 202 de saída,
zero de raciocínio informado e 2.323 totais. Custo retornado pela API:
**USD 0,0023247675**. Os 22 campos foram conferidos visualmente, incluindo
seleções, valores, bônus, cashout e ausência de data absoluta/liquidação.
Duas diferenças `1°`/`1º` em relação ao ensaio anterior são apenas tipográficas.
A imagem, seus valores e a transcrição permanecem fora do GitHub.

A projeção de 1.800 chamadas idênticas seria USD 4,18/mês. É uma extrapolação
de uma imagem; texto, resolução, saída, raciocínio e novas tentativas variam.
Os USD 5 escolhidos são um orçamento, não garantia de processar 1.800 bilhetes.

## Fallback operacional e qualificação por modelo

O runtime usa a cadeia fixa; a OpenRouter pode fazer failover entre provedores
do mesmo modelo dentro de uma única chamada, e o modelo/provedor efetivos ficam
registrados por caso. Um fallback (Qwen 3 VL 32B, DeepSeek V4 Flash Vision)
pode produzir resultado para revisão manual, mas nunca importa automaticamente
enquanto não tiver corpus e política próprios aprovados — o digest da política
é específico do modelo e não atravessa modelos.

A qualificação isolada de cada combinação casa × modelo roda apenas na
ferramenta privada (`validation:replay ... --model <modelo>`), que aceita
exclusivamente os três identificadores da cadeia; a seleção não existe em
request HTTP, payload de usuário, cookie, query string, variável pública ou
configuração da aplicação. A avaliação mede exatamente o modelo selecionado
(uma chamada por caso), sem fallback entre modelos; a execução registra o
modelo solicitado e o retornado, e um retorno divergente aborta de forma
sanitizada sem gravar corpus ou avaliação.

Fontes: [modelo](https://openrouter.ai/google/gemini-3.8-flash),
[saída estruturada](https://openrouter.ai/docs/guides/features/structured-outputs) e
[limites da chave](https://openrouter.ai/docs/api/api-reference/api-keys/update-keys).
