# Spec — ações reais no Telegram e separação declaração×política

## ADDED Requirements

### Requirement: Ações reais nos botões do Telegram

Os botões "Alterar Status" e "Alterar Casa" DEVEM (MUST) abrir o MiniApp autenticado
por initData diretamente nas seções `section=status` e `section=bookmaker`,
resolvendo o UUID do registro canônico da mensagem; NÃO DEVE existir callback de
status/casa que apenas responda com texto sem oferecer a ação.

#### Scenario: abertura das seções

- **WHEN** o usuário toca "Alterar Status" ou "Alterar Casa" na mensagem de resultado
- **THEN** o Telegram abre `...#miniapp?import=<uuid>&section=status|bookmaker`
- **AND** o MiniApp carrega o detalhe com initData validado no servidor

### Requirement: Alteração real de status da aposta

A seção de status DEVE (MUST) exibir o estado canônico, listar somente as transições
permitidas pelo domínio para aposta pendente (ganhou, perdeu, anulada), exigir
confirmação explícita, gravar pelo comando financeiro canônico com versão
otimista, idempotência e autorização da organização, sincronizar a mensagem do
Telegram e, ao sair de pendente, enfileirar a limpeza idempotente de foto,
mensagem temporária e mensagem de resultado.

#### Scenario: liquidação pelo MiniApp

- **WHEN** o proprietário confirma "Ganhou" para uma aposta pendente
- **THEN** o financeiro registra a liquidação com retorno calculado server-side
- **AND** a web reflete o novo estado
- **AND** a mensagem do Telegram é sincronizada
- **AND** a limpeza entra na outbox

#### Scenario: repetição

- **WHEN** a mesma liquidação é enviada novamente
- **THEN** nenhum efeito é duplicado (chave de idempotência determinística)

### Requirement: Alteração real de casa com revalidação de crédito

A seção de casa DEVE (MUST) listar somente casas ativas da organização, mostrar a casa
canônica atual, salvar pelo serviço canônico com revalidação completa sob lock;
crédito freebet incompatível com a nova casa (casa diferente, expirado,
consumido ou valor divergente) NÃO DEVE ser preservado em silêncio — o crédito
é removido com aviso sanitizado para nova escolha explícita, ou a troca é
recusada quando o crédito informado acompanha o pedido.

#### Scenario: troca de casa limpa crédito incompatível

- **WHEN** o rascunho tem crédito freebet e o usuário troca para uma casa diferente
- **THEN** o crédito é removido e a resposta informa (sanitizado) que uma nova escolha é necessária

### Requirement: Declaração do usuário independente da política automática

A declaração real/freebet DEVE (MUST) ser validada apenas contra o crédito da própria
organização (casa, disponibilidade, validade, valor) e DEVE ser sempre
gravada mesmo sem arquivo de política; a política automática NÃO DEVE impedir o
registro. A importação automática DEVE permanecer estritamente fail-closed:
política ausente, inválida, layout sem `allowFreebet`, crédito inválido ou
qualquer gate divergente encaminham para revisão com motivo sanitizado.
`null` NUNCA significa autorização automática.

#### Scenario: declaração sem política

- **WHEN** o usuário escolhe uma freebet válida sem arquivo de política automática
- **THEN** a declaração é salva e o MiniApp informa que o bilhete seguirá em revisão

#### Scenario: fail-closed mantido

- **WHEN** qualquer gate automático está divergente
- **THEN** o bilhete vai para revisão com código sanitizado, nunca autoimportado
