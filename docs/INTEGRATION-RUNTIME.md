# Runtime de integrações — STK-M0-17

O worker implementa entrada contínua Telegram e extração OpenRouter, ambas
desativadas por padrão. Testes usam HTTP simulado e PostgreSQL/pg-boss reais
em bancos descartáveis. Esta entrega não ativa o bot nem faz chamadas pagas.

## Entrada durável

O consumidor aceita somente mensagens privadas da identidade configurada,
recusando grupos, bots, mensagens encaminhadas e intermediários. A verificação
antecede download e persistência. PNG/JPEG têm limite de 8 MiB; respostas HTTP
têm limites de tamanho, prazo e redirecionamentos recusados. A verificação de
formato é complementada na admissão por decodificação completa com Sharp,
limitada a uma página e 40 milhões de pixels. Arquivos truncados são recusados.

Imagem, legenda, metadados e job pg-boss são gravados na mesma transação.
O cursor só avança depois do commit. Repetir a mesma mensagem retorna a entrada
existente; imagens iguais em mensagens distintas permanecem candidatas distintas
para revisão. Um hash indexado permite investigar duplicidade sem descartar
automaticamente apostas legítimas. Um lock de sessão impede dois consumidores
Telegram; perder a conexão interrompe o consumidor e invalida sua readiness.

As imagens ficam inicialmente no PostgreSQL privado, com admissão limitada
a 2.000 entradas ativas/1 GiB de bytes locais compartilhados. O adaptador R2,
a retenção e a revisão estão implementados em [IMPORTS.md](IMPORTS.md), sem
ativar serviços externos. A capacidade bloqueia novas entradas sem confirmar sua
recepção ao Telegram. Telegram não é backup: sua retenção de updates é limitada.

## Extração

O modelo é fixado em `google/gemini-3.8-flash`, com schema estrito, 2.048 tokens,
raciocínio `low`, prazo de 60 segundos e fallback desativado. A saída é validada
novamente pelo Zod. Valores monetários permanecem strings; datas visíveis são
preservadas como texto, sem inferir ano/fuso. Toda extração vai para revisão;
o lançamento exige confirmação do proprietário pelo comando `import.confirm`.

A reserva de cota ocorre em transação antes da chamada externa: até 60 chamadas
por dia e 1.500 por mês UTC. Falhas e chamadas incertas também contam. Isso limita
requisições; o teto financeiro efetivo continua sendo USD 5 mensais da chave.
Chamadas HTTP ficam fora de transações. A fila não repete chamadas pagas.
Processamentos interrompidos por mais de três minutos ficam em falha com
`AI_OUTCOME_UNCERTAIN`, aguardando decisão explícita de reprocessamento.

Estados técnicos: `pending`, `processing`, `review`, `failed`, `discarded`,
`imported`. São independentes do resultado de uma aposta. O estado `imported`
é gravado junto da aposta/vínculo financeiro. Reprocessamento cria um pedido
durável com identificador novo, sem repetir automaticamente chamadas pagas;
respostas tardias só podem concluir a tentativa que as originou.

## Configuração e operação

`AI_ENABLED=true` exige as variáveis OpenRouter de `.env.example` e segredo
válido. `TELEGRAM_ENABLED=true` exige `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_OWNER_USER_ID` e `TELEGRAM_OWNER_CHAT_ID`; os IDs devem corresponder
à mesma conversa privada. Em produção todos os segredos usam o sufixo `_FILE`
com caminho absoluto, seguindo `readSecret`. Não ativar ambos sobre credenciais
fictícias: a validação falha e o worker não inicia.

Os Composes padrão mantêm integrações desativadas e worker sem saída externa.

> **Estado real observado em 11/09/2026 (divergente, não autorizado):** a
> produção usa `compose.integrations.yml` junto aos composes de produção e
> operações desde 07/09/2026, e o consumidor Telegram está **ativo**
> (`TELEGRAM_ENABLED=true`; `AI_ENABLED=true`), sem autorização registrada e
> sem validação operacional. A descrição de configuração padrão acima
> permanece válida para o conjunto sem overlays; a divergência, os riscos e
> os planos de contenção e reativação estão em
> [M0-40-TELEGRAM-PRODUCTION-PREFLIGHT.md](M0-40-TELEGRAM-PRODUCTION-PREFLIGHT.md).
> Para qualquer reativação autorizada futura: conferir backlog do lado
> Telegram e identidade por procedimento privado (valores reais de produção);
> R2 (bucket/credenciais); política de IA (cota/custo); e preparar a montagem
> dos arquivos privados, a saída HTTPS e o ambiente explícito antes de
> iniciar o worker. O runtime local aguarda o migrador; produção segue seu
> runbook de migração prévia.
> Logs contêm códigos estáveis, sem tokens, URLs Telegram, imagens ou conteúdo do
> provedor. Readiness não substitui o futuro monitoramento de atraso/erros da fila.

Verificação: `pnpm typecheck`, `pnpm test`, `pnpm local:test-db`, `pnpm lint`.
Os testes de integração conferem atomicidade, rollback de enqueue, concorrência,
idempotência, cursor, cotas e processamento até revisão. A migração é aditiva e
o teste de reaplicação verifica que o journal não cresce indevidamente.

Referências: [Telegram Bot API](https://core.telegram.org/bots/api#getupdates),
[OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

As consultas de programação TheSportsDB/Tavily também estão implementadas,
desativadas por padrão e com cota/cache persistentes. A fila de consultas não
atualiza datas automaticamente. Configuração e recuperação em [EVENTS.md](EVENTS.md).
