# Stakeframe — o que estamos tentando realizar

Aplicação **pessoal e privada** para registrar apostas esportivas, controlar a
banca e acompanhar resultados. O usuário final é o próprio proprietário
(Rhian); não há multi-tenant comercial, foco em VPS própria ou times.

Este documento responde "o que estamos tentando realizar". Ele **não** substitui:

- `AGENTS.md` — como os agentes operam (regras obrigatórias)
- `docs/DECISIONS.md` — as decisões e por que foram tomadas
- `STATUS.md` — onde o projeto está agora (estado mutável)

## Objetivo

Registrar apostas por três caminhos (Telegram, upload de imagem e cadastro
manual), controlar a banca (reserva, saldos por casa, principal em apostas
abertas) e acompanhar resultados com liquidação manual e auditoria completa.

## Princípios que não se negociam

Estes vêm do Plano Master 2026 e valem para qualquer card novo:

1. **Fail-closed** — na dúvida, o item vai para ação manual. Erro de IA,
   timeout ou resposta incerta **nunca** viram escrita automática nem fallback
   silencioso.
2. **N sempre visível** — toda métrica derivada vem com a contagem de amostras
   ao lado. Amostra pequena gera aviso e **nenhuma** recomendação.
3. **Escrita financeira sempre confirmada** — preview explícito antes de
   qualquer lançamento. Não existe escrita automática nem `/undo` temporizado.
4. **Auditoria** — toda decisão financeira tem trilha: quem, quando, com qual
   versão. Exclusão é `revoked`/arquivado, nunca `DELETE` silencioso.
5. **Private by design** — links exigem login, snapshots são imutáveis,
   outbound nunca é público. Zero URL temporária compartilhável.
6. **Segredos fora do repo** — sempre via file-secret e `*_FILE`. Nem código,
   nem doc, nem prompt, nem log, nem card.

## O que o beta FAZ

- Registro por Telegram (foto única com preview, ou texto em PT-BR) e por CSV
  (template Stakeframe ou mapeamento visual de colunas)
- Controle de banca: reserva, saldos por casa, principal em aberto
- Liquidação manual com trilha de auditoria, incluindo cashout parcial
- Freebets com alerta de expiração e calculadora de valor efetivo
- Dashboard analítico (ROI, P&L, yield, N) e 12 splits com filtros
- Relatórios HTML privados por cadência de plano, com snapshot imutável
- Comandos Telegram de consulta e configuração
- Mini App do Telegram reutilizando a web responsiva
- Painel interno para `superadmin` (metadados, uso, filas, flags, erros)

## O que o beta NÃO faz (e por quê)

- **Não cobra.** Preços são indefinidos no beta; existem planos (Free/Starter/
  Pro) para calcular entitlement, sem pagamento.
- **Não automatiza a casa.** Nenhuma casa é habilitada por padrão; corpus e
  OCR são condicionados a políticas privadas.
- **Não usa IA generativa na narrativa.** Relatórios usam dados e heurísticas
  do produto. Insights com IA são pós-volume e opt-in.
- **Não faz impersonação.** O painel interno proíbe; acesso a conteúdo de
  usuário exigiria consentimento + justificativa + auditoria.
- **Não tem app nativo, PWA nem offline.** Confirmação financeira exige
  conexão.
- **Não processa áudio/Whisper nem webhooks de terceiros.**
- **Não faz parsing de concorrentes nem importa histórico de outros produtos.**

## Limites de custo e segurança

- Teto global de gasto em IA de **R$200/mês**, com circuit breakers nos três
  escopos (global, diário, por usuário). Ao atingir o teto, chamadas pagas são
  recusadas e o item fica disponível para preenchimento manual.
- A cota de IA é contabilizada **somente** quando a extração estruturada é
  apresentada para revisão — mesmo que seja descartada depois. Falha técnica não
  consome cota.
- Persistência de IA guarda apenas estrutura sanitizada, versão do pipeline,
  hashes, categoria de erro e uso. **Nunca** prompt ou resposta bruta.
- Bilhetes reais nunca entram em log.

## Estado do produto

Beta fechado, sem times externos, sem receita. Ver `STATUS.md` para o placar
de cards e o que está em andamento. Decisões que moldaram este documento estão
em `docs/DECISIONS.md` (D001–D031+).
