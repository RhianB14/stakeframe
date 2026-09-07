# AGENTS.md — Papéis, limites e protocolo

Este documento define como os agentes operam no repositório Stakeframe.

## Diretriz temporária do proprietário — 06/09/2026

Rhian determinou: **o Codex assume as implementações por enquanto, até nova
orientação do proprietário**. Durante esse período, Codex também executa as
verificações e operações Git/GitHub autorizadas por tarefa. Esta diretriz
substitui a divisão de execução com Hermes descrita abaixo enquanto estiver
vigente; não é necessário retransmitir prompts de implementação ao Hermes.

As exigências de autorização de merge, deploy, migração e operações destrutivas
continuam válidas. A autoria direta do Codex deve constar dos registros, sem
apresentar a verificação do próprio código como revisão independente do GitHub.

## Papéis

- **Codex** — planeja, decide tecnicamente, revisa e autoriza. É o orquestrador
  do projeto e a única fonte de autorizações de merge, release, deploy e
  migração em produção.
- **Hermes Desktop** — executa implementações, verificações e todas as
  operações Git/GitHub autorizadas. Não aprova o próprio trabalho.
- **Proprietário (Rhian)** — decide produto, encaminha prompts e relatórios
  entre Codex e Hermes, e é o único usuário final da aplicação.

## Regras obrigatórias

1. **Hermes implementa; Codex revisa e autoriza.**
2. **Autorização por tarefa** permite implementar, criar a branch indicada,
   executar verificações, fazer commits, push e abrir/atualizar a PR — dentro
   do escopo do prompt da tarefa.
3. **CI verde não equivale a autorização de merge.** Checks passando não
   autorizam o Hermes a integrar nada.
4. **Merge depende de PR, head SHA e base validados pelo Codex**, com a
   autorização vinculada a um SHA específico.
5. **Novo commit invalida a autorização anterior.** Após qualquer commit novo
   na branch da PR, o Hermes retorna ao Codex antes de qualquer integração.
6. **Alterações na base exigem nova validação.** Rebase ou atualização da PR
   em relação à `main` invalida a autorização e requer revisão nova.
7. **Deploy e migração em produção exigem autorização explícita**, que pode
   agrupar release + deploy, mas nunca é inferida.
8. **Aprovação retransmitida pelo proprietário é identificada como tal.** Como
   existe uma única identidade GitHub (o GitHub não permite autoaprovação), a
   revisão do Codex é registrada na PR como trilha operacional — texto
   retransmitido, número da PR, SHA revisado e resultado dos checks — sem
   fingir revisão independente no GitHub.
9. **Alterações de proteções, credenciais, permissões, histórico ou exclusões
   destrutivas** exigem autorização específica e separada.
10. **Segredos não entram no repositório** — nem em código, documentação,
    prompts, relatórios ou logs.

## Fluxo de revisão

1. Hermes abre/atualiza a PR e devolve: link, head SHA, resumo, evidências
   verificáveis, alterações de banco e limitações.
2. Codex revisa o diff e as evidências; pede correções quando necessário.
3. Codex emite a autorização de merge no formato definido em
   [docs/PLAN.md](docs/PLAN.md) §5.3.
4. Hermes confirma que a PR corresponde à autorização (head SHA, base,
   checks) e só então executa o squash merge.
5. Hermes reporta o commit resultante, a CI na `main` e o encerramento da
   issue.

## Estado atual

O setup operacional do M0 continua em andamento. Por determinação do
proprietário, Codex também avança na implementação local do produto;
fundação e núcleo financeiro estão implementados. Os registros de cada PR
distinguem código validado, operação pendente e autorização de produção.
As regras deste documento valem desde o primeiro commit.
