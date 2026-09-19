# STK-G0-20 — correção e conclusão do fluxo de importação Telegram/MiniApp

## Por quê

O fluxo de recebimento, processamento, edição e sincronização de apostas
enviadas pelo Telegram está funcional, porém incompleto e desalinhado com o
contrato de produto: a mensagem de processamento usa texto antigo (três linhas,
sem o UUID de acompanhamento), a mensagem final não segue o formato acordado
(emojis por linha, campos completos), o status disponível é restrito a
ganho/perda (sem meio-ganha, meio-perdida e reembolso), a seleção de tipster não
existe, a exclusão remove o registro da Web mas não limpa as mensagens do
Telegram e a modalidade financeira híbrida (parte em dinheiro real + parte em
freebet) não é suportada. Esta unidade conclui o fluxo ponta a ponta com
sincronização bidirecional Web ↔ MiniApp ↔ Telegram.

## O quê (MUST)

- **Recebimento sem legenda**: aceitar a foto sem legenda obrigatória; após o
  recebimento enviar a mensagem de processamento com texto fixo (estrutura e
  emojis preservados; somente o UUID varia) e remover essa mensagem quando o
  processamento concluir.
- **Mensagem final**: formato com emojis por linha (Bilhete processado com
  sucesso; ID; Banca; Status; Esporte; Torneio; Evento; País; Aposta; Mercado;
  Valor Apostado; Odd; Retorno Potencial; Tipo; Enviado em; Evento em; Bônus;
  Casa; Tipster). `Enviado em` = data/hora original do Telegram (imutável);
  `Evento em` inicia pendente ou conforme extração confiável e é editável.
- **Modalidades financeiras**: dinheiro real (retorno = valor real × odd),
  freebet (retorno = freebet × (odd − 1); o valor da freebet não retorna) e
  híbrida (retorno = valor real × odd + freebet × (odd − 1)), exibidas no
  MiniApp, na Web e na mensagem do Telegram.
- **Casa e Tipster**: botões pós-processamento; opções SOMENTE dos cadastros
  ativos da organização do usuário; a seleção atualiza a aposta, a Web e a
  mensagem do Telegram.
- **Callbacks**: Editar (abre o MiniApp preenchido); Alterar Status (teclado
  inline exclusivo de status, sem abrir o MiniApp); Alterar Casa (somente casas
  ativas); Excluir (remove da Web e apaga foto + mensagens relacionadas no
  Telegram, com confirmação); Cashout (comportamento preservado; corrigido se
  quebrado, coberto por teste).
- **Status**: Ganha, Perdida, Pendente, Meio-Ganha, Meio-Perdida, Reembolsada,
  Voltar. Ao sair de Pendente: atualizar a Web, apagar a foto, a mensagem de
  processamento (se existir) e a mensagem final — sem mensagens órfãs.
- **Sincronização**: MiniApp carrega os campos atuais, salva sem perder dados
  não alterados, atualiza imediatamente Telegram e Web; alterações na Web
  atualizam o Telegram; alterações no MiniApp atualizam Web e Telegram; edição
  antiga nunca sobrescreve edição nova (versão otimista + idempotência).
- **Testes RED→GREEN** dos 18 cenários obrigatórios (foto sem legenda, mensagens
  com estrutura/UUID/emojis, real/freebet/híbrida, retorno potencial, casas e
  tipsters ativos por organização, Editar/Status/Casa/Excluir, sincronizações,
  limpeza pós-status, concorrência/idempotência, isolamento entre organizações).

## O quê (MUST NOT)

- Merge, deploy, release, tag, publicação de imagem ou migração produtiva.
- Chamadas pagas de OCR ou ativação de importação automática
  (`AUTOMATIC_IMPORT_ENABLED` permanece `false`).
- Alterar credenciais, permissões, proteções ou produção; segredos, tokens,
  PII, imagens privadas ou bilhetes em Git, PR, card ou logs.

## Impacto

- `apps/worker/src/` (telegram, telegram-message, telegram-callbacks,
  telegram-outbox), `apps/api/src/` (import-routes e contratos),
  `apps/web/src/product/` (MiniApp/seções), `packages/shared/`, `packages/db/`
  (serviços e schema quando necessário) e as suítes de teste correspondentes.
- Sem mudança de schema público de API sem contrato Zod atualizado; sem
  migração de banco da aplicação, exceto se um bloco exigir coluna nova —
  nesse caso, migração manual seguindo o padrão vigente do repositório e
  registrada na devolutiva (nunca aplicada em produção nesta tarefa).
