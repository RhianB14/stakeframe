# Ensaios das APIs de imagem

Esta ferramenta do M0 faz uma única chamada real por execução, usando somente
o [bilhete fictício fixo](../tests/fixtures/ai/synthetic-ticket.png). Ela não
recebe bilhetes do proprietário, não acessa banco/Telegram/R2 e não é o
importador de apostas. Decisão de modelo em [AI-MODEL-SELECTION.md](AI-MODEL-SELECTION.md).

## Pré-requisitos

- Node.js na versão do projeto.
- Diretório privado absoluto fora do checkout, sem links, com acesso somente
  ao proprietário e SYSTEM no Windows; `0700` no Linux e arquivos `0600`.
- Arquivo `api_key` com a credencial existente da API Gemini.
- Arquivo `metadata.json` registrando a inspeção do faturamento no AI Studio:

```json
{
  "billingTier": "free",
  "billingVerifiedAt": "<data ISO da verificação pelo operador>"
}
```

O operador verifica o projeto correspondente à chave e suas cotas antes de
executar. A ferramenta exige registro com menos de 24 horas; esse registro
não consulta faturamento em tempo real nem impede uma mudança externa posterior.
Não ativar cobrança para contornar uma recusa do teste. A configuração Windows
de ACL deve ser conferida pelo operador; o checker valida modos POSIX no Linux.

## Executar deliberadamente

```bash
pnpm ai:test
pnpm ai:setup /caminho/privado gemini-3.1-flash-lite
```

Os modelos aceitos são somente `gemini-3.5-flash-lite`, `gemini-3.8-flash` e
`gemini-3.1-flash-lite`. O comando usa o host HTTPS oficial, chave em cabeçalho,
sem redirecionamentos, uma imagem PNG conferida por SHA-256, uma resposta JSON,
até 2.048 tokens de saída e prazo de 45 segundos. Não há upload de arquivos
arbitrários, ferramentas de busca, fallback ou retentativa automática.

### Candidato OpenCode Go

Também é aceito `deepseek-v4-flash-vision-exp`, exclusivamente pelo endpoint
`https://opencode.ai/zen/go/v1/chat/completions`. Para esse modelo, `api_key`
contém uma chave existente do Go e `metadata.json` registra:

```json
{
  "provider": "opencode-go",
  "subscriptionActive": true,
  "useBalance": false,
  "verifiedAt": "<data ISO da verificação pelo operador>"
}
```

O operador confere assinatura, cota e saldo extra desativado no console; o
registro local não garante que essas condições continuarão iguais. O pedido
identifica este verificador de forma explícita e inclui `x-opencode-session`.
Solicita JSON por `response_format`, com schema no prompt e validação local;
isso não equivale a schema imposto pelo servidor. Os limites continuam em
45 segundos, 2.048 tokens e 128 KiB de resposta sem streaming. Esse helper
Go foi validado offline, ainda não em chamada real com a imagem sintética.

O teste privado solicitado pelo proprietário usou outro script, fora do Git,
restrito à imagem expressamente fornecida. Sua execução bem-sucedida no Go
usou streaming, até 4.096 tokens, 120 segundos e 2 MiB para os fragmentos SSE.
Não afrouxar a restrição da imagem pública deste helper para repetir esse teste.

Um arquivo `<modelo>.intent.json` é criado exclusivamente antes da chamada.
Nova execução com o mesmo modelo e diretório é recusada, inclusive se a conexão
teve resultado ambíguo. Investigar a causa e preservar o registro antes de
uma nova execução deliberada em outro diretório privado. Não remover registros
automaticamente para repetir chamadas.

## Conferência e evidências

O gabarito é local e não é enviado no texto do pedido: casa, evento, mercado,
seleção, odd, valor apostado, retorno potencial e data ausente. O verificador
exige os oito campos, igualdade dos valores e resposta completa. Odds e dinheiro
permanecem strings decimais; inventar data ou devolver números em vez de strings
reprova o exemplo. O gabarito e a imagem são fictícios e públicos.

O arquivo `<modelo>.result.json` contém horário, modelo, hash da imagem,
latência, igualdade por campo e contagem de tokens informada pelo provedor.
Contagens ausentes ficam `null`. Não guardar nem imprimir chave, corpo bruto
de resposta, diagnósticos do provedor ou conteúdo de imagens privadas. Falhas
usam códigos fixos e metadados limitados, sem revelar a mensagem original.

Os testes offline usam o mesmo construtor e verificador, com `fetch` simulado.
Cobrem restrição da imagem/modelo, URL/cabeçalho, campos incorretos, data
inventada, resposta incompleta, 429 sem repetição, tamanho e erros sem segredo.
A CI executa somente esses testes em AMD64 e ARM64, sem chave real.

Passar nessa imagem comprova o protocolo e aquele exemplo, não a precisão em
bilhetes reais, disponibilidade contínua, custos futuros ou integração do worker.
São necessários exemplos privados das três casas antes de escolher os critérios
de registro automático. As variáveis OpenRouter em `.env.example` descrevem
o runtime escolhido depois dos ensaios e não são consumidas por este helper.
O ensaio privado e a chave do provedor escolhido estão em [OPENROUTER.md](OPENROUTER.md).

Fontes: [API generateContent](https://ai.google.dev/api/generate-content),
[imagens](https://ai.google.dev/gemini-api/docs/image-understanding) e
[saída estruturada](https://ai.google.dev/gemini-api/docs/structured-output),
[OpenCode Go](https://opencode.ai/docs/go/) e
[JSON DeepSeek](https://api-docs.deepseek.com/guides/json_mode/).
