# STK-M0-69 — preflight do alerta de backup atrasado

**Data:** 13/09/2026  
**Classificação:** PARCIAL — regra e deduplicação verificadas; alerta real de
atraso ainda não observado

## Objetivo e limite

Esta tarefa verifica a política que classifica um backup como atrasado e a
garantia de que um incidente de backup gera uma única tentativa de alerta,
seguida de recuperação quando a assinatura volta a `ready`. Não foi
interrompido o daemon de backup, editado `backup.json`, alterado segredo ou
gerado alerta artificial em produção.

## Evidência de código e testes

Após `pnpm build:types`, foram executados os testes de política e do monitor:

```text
node --test tests/operations/policy.test.mjs tests/operations/monitor.test.mjs
26 pass / 0 fail
```

Os testes cobrem, entre outros casos:

- cutoff com mais de uma hora, cutoff futuro ou status ausente → `overdue`;
- cutoff dentro do limite → `ready`;
- incidente `backup:failed` com uma única tentativa de alerta;
- silêncio em ciclos subsequentes com a mesma assinatura;
- recuperação para `ready` com uma nova tentativa, sem reenvio duplicado;
- entrega incerta preservada sem retry automático.

Essa é a prova determinística da política e da deduplicação; não substitui um
evento real de atraso na produção.

## Preflight read-only da produção

Leitura feita em `2026-09-13T14:53:04Z` no host de produção:

- `backup.json`: `state=ready`, `retention=true`, cutoff
  `2026-09-13T14:30:02.091Z`, concluído às `14:30:17.180Z`;
- cutoff com aproximadamente 23 minutos de idade, dentro do RPO de uma hora;
- manifesto com `imageCount=1` e 23.877 bytes;
- `api`, `worker`, `web`, `operations` e `postgres` em `running/healthy`, todos
  com `restart=0`;
- serviços de backup e restore inativos no momento da leitura;
- zero recursos Docker com a etiqueta de restore.

Nenhuma leitura de segredo foi feita. O `/status` autenticado do monitor não
foi coletado nesta janela porque o bearer permanece no procedimento privado do
proprietário; portanto não há afirmação adicional sobre a entrega de alerta.

## Resultado e próximo critério

O alerta está **implementado e coberto por testes**, e o backup real estava
saudável no preflight. Como não ocorreu um atraso natural e não foi autorizado
um cenário sintético, o item “alerta de backup atrasado verificado” permanece
pendente no checklist.

Para fechá-lo, uma janela futura deve observar uma transição real de
`backup:ready` para `backup:overdue` e sua recuperação, com leitura sanitizada
do monitor e confirmação do proprietário no Telegram. Induzir essa transição
(por exemplo, alterando credenciais ou interrompendo o backup) exige
autorização operacional separada e não faz parte desta tarefa.

Não houve deploy, migração, restart, escrita no R2, alteração de banco ou
envio de mensagem nesta janela.
