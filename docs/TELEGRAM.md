# Telegram — preparação do bot pessoal

A STK-M0-15 criou `@stakeframe_rhian_bot`, nome Stakeframe, após autorização
específica do proprietário. O token e a associação do usuário/chat ficam fora
do Git. Uma resposta de teste foi entregue ao chat do proprietário. Ainda não
há consumidor contínuo, webhook público, importação de bilhetes ou processamento
de apostas. Evidência em [M0-15-VALIDATION.md](M0-15-VALIDATION.md).

## Configuração e fronteira de acesso

O BotFather confirmou adição a grupos desativada. `getMe` conferiu o username
esperado, a correspondência com o token, grupos bloqueados e ausência de
permissão para ler todas as mensagens de grupos ou usar inline. `getWebhookInfo`
confirmou URL vazia. O setup recusa um webhook existente; não o exclui.
Referências: [BotFather](https://core.telegram.org/bots/features#botfather) e
[Bot API](https://core.telegram.org/bots/api).

Bloquear grupos e manter privacy mode não limita quem pode abrir uma conversa
privada com o bot. A autorização deve conferir os IDs numéricos exatos de
usuário e chat, tipo `private` e remetente humano. Username, nome, primeiro
contato ou texto de mensagem não autorizam acesso.

O módulo preparatório `scripts/telegram/owner.mjs` aceita somente mensagens
novas desse par. Recusa grupos/canais, bots, remetentes em nome de chat,
encaminhamentos, mensagens via outro bot ou business connection, edições e
callback queries. O consumidor futuro deve usar uma fronteira equivalente
antes de persistir conteúdo, baixar anexos, enfileirar jobs ou responder.
Esta tarefa não instalou esse consumidor na aplicação.

## Custódia privada

Diretório `telegram-m0` externo ao workspace, com acesso somente ao operador.
No Windows desta execução, a pasta tem ACL própria restrita ao usuário local
e SYSTEM; os arquivos herdam essas duas entradas. No Linux, o utilitário exige
pasta sem permissões para grupo/outros e arquivos privados. Symlinks, aliases
de diretório e arquivos maiores que 4 KiB são recusados.

| Arquivo             | Finalidade                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `bot_token`         | Token Telegram em linha única; nunca passar como argumento                    |
| `metadata.json`     | Username esperado e consumidor contínuo desativado                            |
| `challenge.json`    | Nonce aleatório de 32 bytes, válido por dez minutos; removido após associação |
| `owner.json`        | IDs exatos de usuário/chat e data da associação                               |
| `probe-intent.json` | Reserva da única resposta de teste, criada antes do envio                     |
| `result.json`       | Resultado sanitizado após confirmação da API                                  |

O token não deve entrar em capturas, logs ou URL visível do navegador. A Bot API
inclui o token no caminho HTTPS; por isso o utilitário não imprime exceções
originais de rede, respostas ou URLs. Não encaminhar esses arquivos à CI nem
copiá-los para a VPS sem autorização específica.

## Utilitário de preparação

Os comandos abaixo fazem consultas reais ao Telegram. `prepare`, `bind` e
`probe` exigem a autorização operacional correspondente, já concedida para o
ensaio desta tarefa. O diretório é um argumento; os valores privados nunca são.

```bash
pnpm telegram:test
pnpm telegram:setup check /caminho/privado/telegram-m0
pnpm telegram:setup prepare /caminho/privado/telegram-m0
# Pela sessão autenticada do proprietário: enviar /start <nonce privado> ao bot.
pnpm telegram:setup bind /caminho/privado/telegram-m0
pnpm telegram:setup probe /caminho/privado/telegram-m0
```

`check` exige o bot e as configurações esperados. `prepare` cria um desafio
novo com exclusividade e recusa associação existente. `bind` faz uma consulta
`getUpdates` limitada a 100 updates de mensagem, sem offset de confirmação;
aceita exatamente uma mensagem privada recente com o desafio correto. Não
salva o lote ou outros conteúdos. `/start` sem nonce não cadastra ninguém.
A associação é criada com exclusividade; não é sobrescrita automaticamente.

`probe` usa apenas o chat associado e envia uma mensagem fixa de preparação,
sem notificação sonora. O arquivo de intenção impede repetição automática,
inclusive após resultado de rede incerto. Inspecionar o chat antes de decidir
qualquer nova tentativa; não apagar a reserva para repetir às cegas. O
utilitário encerra ao final, sem webhook, polling contínuo ou limpeza de updates.

Um desafio expirado não autoriza associação. A renovação ou remoção dos
arquivos de associação/intenção é uma operação separada e não é feita pelo
utilitário. O token só deve ser revogado ou substituído com autorização própria.

## Próxima integração

Antes de ativar um consumidor na VPS, implementar a mesma checagem de
identidade, deduplicação por `update_id`, limites de arquivos e filas, retenção
e descarte de anexos conforme [PLAN.md](PLAN.md). Definir polling ou webhook
em tarefa própria, com testes e autorização de implantação. Nenhuma mensagem
não autorizada deve gerar resposta, download ou operação financeira.
