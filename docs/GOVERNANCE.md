# Governança — revisão, aprovação, merge e implantação

Este documento operacionaliza as regras de [AGENTS.md](../AGENTS.md). Em caso
de conflito, vale o texto mais restritivo.

## Matriz de autorização

| Ação                                             | Quem autoriza                     |
| ------------------------------------------------ | --------------------------------- |
| Implementar, testar, corrigir (escopo da tarefa) | Codex, no prompt da tarefa        |
| Criar branch, commits, push, abrir/atualizar PR  | Antecipado no prompt              |
| Corrigir pontos apontados em revisão             | Escopo da revisão do Codex        |
| **Merge**                                        | **Codex, posterior e específico** |
| Release e deploy                                 | Codex, autorização explícita      |
| Migração em produção                             | Codex, com backup validado        |
| Alterar proteções/credenciais/permissões         | Codex, autorização específica     |
| Apagar dados, reescrever histórico, excluir repo | Decisão explícita separada        |

## Ciclo de uma tarefa

1. **Prompt do Codex** com identificador, objetivo, escopo, exclusões,
   critérios de aceite, operações Git autorizadas, evidências exigidas e
   condições de retorno.
2. **Execução pelo Hermes** dentro do escopo, com verificações reais.
3. **Devolutiva do Hermes**: link da PR, head SHA, base SHA, resumo,
   evidências verificáveis, alterações de banco e limitações.
4. **Revisão do Codex**: análise do diff e das evidências; correções quando
   necessário. Novos commits durante a revisão reiniciam a etapa.
5. **Autorização de merge** no formato:

   > **Merge autorizado:** PR #N, head SHA `<sha>`, base validada `<sha>`, por
   > squash, com os checks obrigatórios aprovados. Esta autorização não inclui
   > deploy ou migração em produção, salvo indicação explícita.

6. **Execução do merge pelo Hermes**, somente após confirmar que a PR e seus
   commits correspondem exatamente à autorização (head SHA, base, checks).
   Havendo qualquer divergência, retorna ao Codex.
7. **Pós-merge**: Hermes reporta o commit resultante (squash), a CI na `main`
   e o encerramento da issue vinculada.

## Registro de aprovação retransmitida

Como o repositório opera com uma única identidade GitHub, o GitHub não registra
uma aprovação independente. O protocolo é:

- O texto de autorização emitido pelo Codex é reproduzido **integralmente**
  como comentário na PR, precedido de: "Autorização retransmitida pelo
  proprietário — revisão conduzida pelo Codex fora do GitHub:".
- O registro inclui: número da PR, head SHA revisado, resultado dos checks
  obrigatórios e data.
- Esse registro é **trilha operacional**, não aprovação formal do GitHub. Não
  configurar exigência de aprovação que dependa de autoaprovação.

## Regras de invalidação

- **Novo commit na branch da PR** invalida qualquer autorização anterior.
- **Qualquer mudança do SHA da `main`** (merge de outra PR, push de emergência
  autorizado, correção de histórico autorizada) exige nova validação da base,
  **mesmo sem rebase ou merge na branch da PR**.
- **Mudança da base da PR** (rebase/merge da `main` na branch) exige nova
  validação.
- **Falha de check obrigatório** impede o merge e devolve a PR à revisão.
- Aprovação **não é inferida** de silêncio, elogio, ausência de comentários ou
  sucesso de testes.

## Implantação

- Nenhum deploy, release ou migração de produção acontece sem autorização
  específica do Codex.
- Procedimentos planejados (ainda não implementados) em
  [docs/DEPLOYMENT.md](DEPLOYMENT.md) e [docs/RECOVERY.md](RECOVERY.md).
