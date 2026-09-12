# STK-M0-54 — egress do monitor no Worker agendado

Data: 12/09/2026  
Estado: implementação concluída; validação em produção pendente de autorização

## 1. Problema observado

O fetch autenticado do monitor para `/api/v1/operations/health`, quando
executado dentro do Durable Object, atingia repetidamente o teto de 10 s sem
que qualquer SYN chegasse à VPS. Na mesma investigação, um Worker simples
alcançou a origem em aproximadamente 1 s, e uma leitura autenticada direta do
proprietário respondeu em menos de 1 s. A rota pública, a aplicação e a borda
Oracle, portanto, não explicavam a diferença observada.

A evidência delimita a falha ao contexto de egress do Durable Object usado pelo
monitor. Ela não identifica uma causa interna mais específica do runtime.

## 2. Correção

O I/O externo foi removido do Durable Object:

1. o Worker agendado pede ao Durable Object uma tentativa (`/check/start`);
2. o Durable Object registra o disparo e concede uma lease exclusiva;
3. o Worker agendado consulta a API e valida o payload;
4. o Worker envia ao Durable Object apenas o resultado sanitizado
   (`/check/complete`);
5. quando há mudança de assinatura, o Worker envia a notificação e confirma a
   entrega ao Durable Object (`/check/confirm-delivery`).

O Durable Object continua responsável pela exclusão mútua, persistência,
deduplicação e transição de entrega. O Worker agendado fica responsável pelo
fetch da origem e pelo envio ao Telegram. Os endpoints de coordenação são
internos ao binding do Durable Object; o único endpoint HTTPS exposto pelo
Worker continua sendo o `/status` autenticado.

## 3. Garantias preservadas

- dupla entrega do cron não inicia duas sondas durante a lease;
- conclusão antiga ou inconsistente é recusada;
- tentativa de alerta é persistida como `uncertain` antes do envio;
- confirmação antiga ou com assinatura divergente é recusada;
- falha de envio permanece `uncertain` e não é reenviada automaticamente;
- `/status`, schema SQLite, categorias sanitizadas e política de alertas são
  compatíveis com a versão anterior;
- nenhum URL completo, mensagem de exceção, payload privado ou segredo é
  persistido.

## 4. Evidência local

Os testes cobrem execução saudável, incidentes e recuperação, concorrência,
reinício com entrega incerta, falhas timeout/rede/HTTP/payload, configuração,
monitor desabilitado, autenticação do `/status`, migração legada e rejeição de
mensagens internas antigas ou semanticamente inconsistentes.

## 5. Limite da conclusão

Esta mudança corrige a arquitetura no limite do diagnóstico comprovado, mas
não constitui validação operacional. Depois de merge, release e deploy
explicitamente autorizados, duas leituras autenticadas do `/status`, separadas
por ao menos um ciclo, devem comprovar avanço de `lastFiredAt` e
`lastCompletedAt`. O resultado esperado para uma resposta válida da aplicação
é `lastError=null`, `lastHttpStatus=200` e `lastSignature` correspondente aos
checks realmente degradados. A entrega e uma recuperação natural também
continuam pendentes de observação.

Nenhum deploy, migração, alteração de segredo, trigger ou binding integra esta
tarefa.
