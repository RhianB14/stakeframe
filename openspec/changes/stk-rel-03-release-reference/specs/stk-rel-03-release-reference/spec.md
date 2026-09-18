# Spec — referência da release beta

## ADDED Requirements

### Requirement: Commit-fonte sem SHA fixo

As notas da release DEVEM (MUST) descrever o commit-fonte como o SHA exato do
commit alvo da tag `v0.1.0-beta.1`, definido e reconfirmado no momento da
autorização da tag — sem nenhum SHA fixo sujeito a staleness.

#### Scenario: novo squash na main

- **WHEN** qualquer PR integra um novo squash na main
- **THEN** as notas permanecem corretas, pois o commit-fonte é resolvido na autorização da tag

#### Scenario: referência histórica

- **WHEN** um SHA antigo aparece em registros históricos (changes OpenSpec anteriores)
- **THEN** a referência NÃO é alterada

### Requirement: Passo de publicação vinculado ao commit final validado

O passo de publicação DEVE (MUST) declarar que a tag aponta para o commit final
da `main` validado pelo Codex, com o SHA confirmado nos gates imediatamente
antes da criação da tag, e que o GitHub Release usa a mesma tag — nunca um SHA
antigo.

#### Scenario: autorização da tag

- **WHEN** a tag for autorizada
- **THEN** o SHA alvo é o commit final da main no momento da autorização, reconfirmado nos gates

### Requirement: Limites

A versão `0.1.0-beta.1`, a tag candidata `v0.1.0-beta.1` e a declaração de
release preparada/não publicada DEVEM (MUST) permanecer; e a tarefa NÃO DEVE
(MUST NOT) criar tag, GitHub Release, publicação, deploy ou migração.

#### Scenario: nada publicado

- **WHEN** a tarefa termina
- **THEN** PR aberta, CI 5/5 e card em REVIEW, sem merge
