# Delta — STK-G0-19-R9

## ADDED Requirements

### Requirement: Idempotência por operação do cliente

As rotas POST `/api/v1/imports/:id/bookmaker`, `/origin` e `/event` DEVEM (MUST) exigir o header `idempotency-key` (UUID). O servidor DEVE registrar um recibo por organização+chave com o hash do pedido e o resultado sanitizado. Mesma chave com o mesmo corpo DEVE devolver o mesmo resultado (inclusive quando a versão já avançou); mesma chave com corpo diferente DEVE falhar com `IDEMPOTENCY_CONFLICT`; chave nova DEVE executar a operação normalmente, mesmo que o valor já tenha sido usado antes. A verificação do recibo DEVE ocorrer antes de qualquer rejeição por versão da entidade; para operação inédita, a versão otimista continua obrigatória.

#### Scenario: Retry da mesma confirmação

- **WHEN** o cliente reenvia a mesma ação com a mesma chave e o mesmo corpo depois de a versão da inbox avançar
- **THEN** a resposta repete o resultado gravado, sem novo journal, consumo ou edição

#### Scenario: Mesma chave com pedido diferente

- **WHEN** a mesma chave é usada com outro livro, crédito ou data
- **THEN** a resposta é `IDEMPOTENCY_CONFLICT` sem qualquer efeito

#### Scenario: Novo valor com chave nova

- **WHEN** o usuário repete uma alteração para um valor já utilizado antes, com chave nova
- **THEN** a operação é executada e aplicada

### Requirement: Recibos de ação de importação

O sistema DEVE (MUST) persistir recibos de ação de importação em armazenamento dedicado vinculado à organização (chave, hash do pedido, resultado sanitizado, timestamps, unicidade por organização+chave), sem expor dados pessoais ou conteúdo de bilhete.

#### Scenario: Recibo consultável por replay

- **WHEN** um replay chega com a mesma chave
- **THEN** o resultado sanitizado é devolvido do recibo, sem reexecução

### Requirement: Créditos da casa de destino

O sistema DEVE (MUST) disponibilizar `GET /api/v1/imports/:id/credits?bookmakerId=<uuid>` autenticada, filtrada no servidor por organização, casa solicitada, valor exato da stake, disponibilidade (`used_by is null`) e validade no fuso de São Paulo, com quantidade limitada. O Mini App DEVE carregar os créditos da casa escolhida (nunca da casa anterior), não habilitar confirmação de freebet sem crédito compatível, nunca sugerir o crédito consumido e bloquear a gravação quando a leitura falhar.

#### Scenario: Troca de casa de aposta freebet pela interface

- **WHEN** o usuário escolhe outra casa para uma aposta freebet
- **THEN** apenas créditos compatíveis com a casa de destino aparecem e a confirmação salva casa e crédito atomicamente

### Requirement: Bloqueio após liquidação

`bet.bookmaker` e `bet.origin` DEVEM (MUST) recusar quando existir qualquer registro de settlement da aposta (inclusive `partial_cashout`), quando existir histórico de settlement revertido (fato histórico não é relabelado) ou quando `remaining !== stake`, com erro estável e sanitizado e sem nenhuma alteração parcial em bet, crédito, journal, inbox ou outbox.

#### Scenario: Partial cashout seguido de troca de casa

- **WHEN** uma aposta passou por `partial_cashout` e o usuário tenta trocar a casa
- **THEN** a operação é recusada e o histórico permanece na casa original

### Requirement: Ledger sem journals vazios

Trocas não monetárias (freebet→freebet, casa de freebet→casa de freebet) NÃO DEVEM (MUST) criar journal financeiro sem lançamentos; o registro DEVE ficar na auditoria/recibo.

#### Scenario: Freebet troca de casa

- **WHEN** uma aposta freebet muda de casa mantendo crédito da nova casa
- **THEN** nenhum journal vazio é inserido e a mudança fica auditada

### Requirement: Sincronização renderizada por etapa

Os testes DEVEM (MUST) comprovar, com a outbox executada e cliente Telegram mockado, que cada etapa de A→B→A→B renderiza a casa correspondente, que operação antiga não sobrescreve a mais recente, que replay idempotente não gera nova edição e que web e Mini App leem o mesmo estado.

#### Scenario: Quatro trocas em sequência

- **WHEN** a casa é alterada A→B→A→B
- **THEN** cada edição renderizada mostra a casa vigente da etapa

### Requirement: Compatibilidade com os comandos financeiros pós-importação (R8)

Os comandos `bet.bookmaker` e `bet.origin` DEVEM (MUST) permanecer transacionais, com idempotência determinística e versão otimista; a chave interna DEVE derivar da operação solicitada pelo cliente (recibo de ação), preservando os demais comandos financeiros.

#### Scenario: Retry após falha de rede

- **WHEN** o cliente repete a mesma confirmação após uma falha de transporte
- **THEN** o comando correspondente não é reaplicado
