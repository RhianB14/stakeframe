# Spec — finalização das notas da release beta

## ADDED Requirements

### Requirement: Commit-fonte atualizado nas notas

`docs/releases/v0.1.0-beta.1.md` DEVE (MUST) registrar como commit-fonte o
squash atual da `main` (`30e2cf78bb5fd82553a73be3d1d0096a64689668`), em todas
as referências operacionais que atribuam o commit de origem da release —
mantendo inalterado o restante do conteúdo (versão, limitações, passos).

#### Scenario: referência stale corrigida

- **WHEN** as notas afirmam que `964a3e2…` é o commit-fonte da release
- **THEN** a referência é atualizada para `30e2cf78…`

#### Scenario: referência histórica preservada

- **WHEN** o SHA antigo aparece em registros históricos (documentação de
  rodadas, planos, PRs e diffs anteriores)
- **THEN** a referência NÃO é alterada

### Requirement: Declarações de estado preservadas

As notas DEVEM (MUST) continuar declarando: tag não criada, GitHub Release não
criada, imagens não publicadas, deploy não executado, migrações produtivas não
aplicadas, importação automática desligada e release preparada/não publicada,
com a versão vinda do `package.json` raiz.

#### Scenario: revalidação do rodapé

- **WHEN** a auditoria confere as declarações após a edição
- **THEN** todas permanecem verdadeiras e explícitas

### Requirement: Limites da finalização

A finalização DEVE (MUST) ocorrer em branch própria com PR aberta, CI 5/5 e
card em REVIEW — sem merge e sem qualquer operação de release antes de
autorização vinculada ao SHA final.

#### Scenario: nada publicado

- **WHEN** a tarefa termina
- **THEN** zero tag, zero release, zero publicação, zero deploy e zero migração
