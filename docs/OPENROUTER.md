# OpenRouter — configuração escolhida

O proprietário aprovou Gemini 3.8 Flash via OpenRouter para o projeto após
o ensaio de 06/09/2026. A chave existente foi renomeada para
`Stakeframe - Gemini 3.8 Flash`, mantendo o segredo original em arquivo
privado. O limite passou de USD 1 total para **USD 5 mensais**, com renovação
no dia 1 em UTC, confirmada no console. Isso não ativa recarga de saldo.

## Configuração preparada

As variáveis de [.env.example](../.env.example) descrevem o contrato planejado:

- Provedor `openrouter`, endpoint `https://openrouter.ai/api/v1/chat/completions`.
- Modelo exato `google/gemini-3.8-flash`; não usar alias `latest` ou roteamento
  automático entre modelos.
- `OPENROUTER_API_KEY_FILE`: caminho absoluto para segredo fora do Git.
- Até 2.048 tokens de saída, raciocínio `low`, prazo de 60 segundos.
- Schema JSON explícito e `provider.require_parameters=true`.
- `provider.allow_fallbacks=false`, preservando a configuração do teste.
- Erros de crédito/cota preservam o trabalho para revisão; não recarregam
  saldo, trocam modelo ou repetem uma chamada ambígua automaticamente.

Na máquina do proprietário há `project.env`, segredo, metadados e resultado
em pasta privada com ACL limitada ao proprietário e SYSTEM. O segredo não
foi instalado na VPS. Essas variáveis ainda **não são consumidas pelo worker**:
o importador contínuo é etapa posterior. O helper público `pnpm ai:setup`
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

Fontes: [modelo](https://openrouter.ai/google/gemini-3.8-flash),
[saída estruturada](https://openrouter.ai/docs/guides/features/structured-outputs) e
[limites da chave](https://openrouter.ai/docs/api/api-reference/api-keys/update-keys).
