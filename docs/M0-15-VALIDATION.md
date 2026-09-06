# STK-M0-15 — Evidência de preparação Telegram

Data: 2026-09-06. [Issue #30](https://github.com/RhianB14/stakeframe/issues/30).
Criação, implementação e verificação executadas diretamente pelo Codex.

O proprietário autorizou criar `@stakeframe_rhian_bot`, enviar comandos de
criação/configuração ao BotFather, bloquear grupos, guardar o token fora do
Git, enviar `/start` pela sua sessão e testar uma resposta ao próprio chat.
O proprietário concluiu o login do Telegram Web.

## Evidência real

- BotFather criou Stakeframe e confirmou `DISABLED` para adição a grupos.
- Token armazenado em arquivo privado externo, com ACL restrita ao usuário
  local e SYSTEM. Associação e arquivos de resultado herdam a mesma proteção.
- `TELEGRAM_BOT_SETTINGS_VERIFIED`: token corresponde ao bot esperado,
  grupos bloqueados, sem inline/leitura geral de grupos e webhook vazio.
- `/start` genérico não associou o chat. O primeiro bind foi recusado porque
  o desafio ainda não tinha sido enviado pelo campo ativo do navegador.
  Após conferir o campo e enviar o desafio único, o bind retornou
  `TELEGRAM_PRIVATE_OWNER_BOUND`. O arquivo de desafio foi removido.
- `TELEGRAM_PRIVATE_PROBE_PASS`: API confirmou envio da mensagem fixa ao
  chat privado associado; o navegador exibiu a resposta de conexão confirmada.
- O resultado privado registra `continuousConsumerEnabled=false`. Nenhum
  processo de polling, webhook público ou serviço da VPS foi ativado.

## Verificação automatizada

Seis testes sem rede em `pnpm telegram:test` cobrem a identidade exata,
recusa de outra identidade mesmo com o mesmo nome, grupos/canais, bots,
remetentes indiretos, encaminhamentos, business connection, tipos de update
não aceitos, IDs inválidos, desafio divergente, duplicado, antigo ou expirado.
A CI executa essa suíte nos jobs AMD64 e ARM64. Lint e formatação conferidos.

A recusa de outro usuário foi simulada; não foi enviada mensagem pela conta
real de uma segunda pessoa. A mensagem real de teste foi enviada somente ao
proprietário. IDs, token, nonce e conteúdo do lote de updates não fazem parte
do relatório versionado. Não há alteração de schema ou código da aplicação.

## Limites

O bot está criado e a associação privada foi demonstrada; a proteção do
consumidor contínuo ainda depende de sua implementação futura. Bloquear grupos
no BotFather não impede contatos privados de terceiros. Importação, fila,
idempotência, anexos e fluxo financeiro continuam em etapas posteriores.
Procedimento e contratos em [TELEGRAM.md](TELEGRAM.md). M0 permanece aberto.
