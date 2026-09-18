# STK-G0-19-R7 — ações reais do Telegram e separação declaração×política

## Por quê

A revisão do Codex na PR #136 encontrou dois bloqueios reais no incremento R6:

1. "Alterar Status" e "Alterar Casa" apenas respondiam ao callback com um toast e
   reenfileiravam a mensagem — nenhuma ação real era executada, e o teste vigente
   mascarava a ausência de funcionalidade.
2. A declaração do usuário (real/freebet) estava acoplada à política de
   importação automática (`freebetAllowedByPolicy(...) !== false`), com `null`
   ambíguo — a ausência de política chegava a impedir o registro de uma
   informação verdadeira pelo usuário.

## O quê

- "Alterar Status" e "Alterar Casa" passam a ser botões `web_app` que abrem o
  MiniApp autenticado nas seções `section=status` e `section=bookmaker`.
- Seção de status: estado canônico + transições permitidas pelo domínio
  (vitória, derrota, anulada para aposta pendente), confirmação explícita,
  execução pelo comando financeiro canônico com versão otimista, chave de
  idempotência determinística e sincronização da mensagem do Telegram; ao sair
  de pendente, a limpeza idempotente (foto, mensagem temporária e de resultado)
  entra na outbox pela regra já existente.
- Seção de casa: casa canônica atual + casas ativas da organização; salvamento
  pelo serviço canônico do rascunho; revalidação completa do crédito freebet
  associado; crédito incompatível com a nova casa é removido com aviso
  sanitizado (nova escolha explícita), nunca preservado em silêncio.
- Declaração × política: a declaração do usuário valida apenas o crédito (casa,
  disponibilidade, validade, valor, organização) e nunca é bloqueada pela
  ausência/invalidade da política automática; a importação automática permanece
  estritamente fail-closed com motivos sanitizados, e a semântica ambígua
  `freebetAllowedByPolicy(...) !== false` é eliminada.

## Impacto

- Migração aditiva `0012` (coluna `bookmaker_override_id` no inbox).
- OpenAPI regenerado; docs IMPORTS/DECISIONS/VALIDATION atualizados.
- Sem mudança de contratos existentes; regressões do R6 preservadas.
