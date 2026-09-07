# Eventos, datas e calendário — STK-M4-01

Calendário e conferência de programação estão implementados localmente. A
liquidação continua manual. Autoria e verificações diretas do Codex, conforme
D019; esta entrega não ativa fontes externas nem migra produção.

## Datas e identidade

Cada seleção tem UUID estável. Corrigir mercado ou reordenar seleções preserva
esse UUID, a programação e sua evidência quando os dados do evento não mudam.
Um UUID de outra aposta é recusado. Exclusões e alterações permanecem no
histórico auditável do comando; as consultas externas mantêm seus registros,
mesmo quando a seleção é removida posteriormente.

`eventAt` é um instante ISO com offset; `eventDate` é a data civil em São Paulo.
Uma data conhecida sem horário não recebe meia-noite. Instantes são convertidos
para `America/Sao_Paulo`, inclusive quando isso muda o dia. A interface recusa
horários históricos inexistentes ou ambíguos na transição do horário de verão.
Datas podem estar confirmadas, estimadas ou pendentes.

`event.update` exige versão do espaço, chave idempotente e justificativa.
Atualiza apenas a programação e a auditoria da aposta. Não registra retorno,
estorno ou liquidação. Adiamento limpa a data antiga e exige nova conferência;
cancelamento do evento também não cancela financeiramente a aposta.

Uma sugestão não altera uma data salva. O usuário precisa selecionar a fonte,
conferir data/fuso e confirmar o formulário. Uma fonte só pode ser vinculada
ao evento para o qual foi consultada; renomear o evento invalida a evidência
anterior para novas confirmações. A evidência estruturada é preservada junto
da seleção, além do histórico da consulta.

## Agenda

A grade mensal filtra a agenda por mês ou dia. A lista é paginada por seleção
(25 por página) e informa separadamente o total de apostas distintas. Não há
soma financeira por seleção ou por dia. Uma múltipla aparece nos eventos
relacionados e mantém um único bilhete financeiro.

Pendências mostram datas ausentes e adiamentos de todos os meses; o contador
acompanha o filtro de situação da aposta. Datas parciais são exibidas na agenda
com “Hora a definir”, sem perder sua certeza confirmada/estimada. Fontes,
histórico recente de busca e correção também são acessíveis pelos detalhes da
aposta.

## Fontes, custos e limites

| Fonte       | Configuração                                               | Limite local por minuto / dia / mês UTC |
| ----------- | ---------------------------------------------------------- | --------------------------------------- |
| TheSportsDB | API pública v1, chave pública `123`                        | 10 / 60 / 1.500                         |
| Tavily      | Somente `basic`, `auto_parameters=false`, até 5 resultados | 10 / 20 / 600                           |

TheSportsDB retorna uma seleção limitada de candidatos na modalidade gratuita;
ausência não comprova inexistência. O adaptador preserva `dateEvent`, `strTime`
e `strTimestamp` originais. Timestamp sem offset não é assumido como UTC.
Somente um instante explicitamente completo produz sugestão convertida.

Tavily retorna título, link HTTPS e trecho da fonte; não usamos resposta gerada
nem conteúdo bruto. Datas de publicação e datas citadas em texto não são
tratadas automaticamente como datas de evento. Os links são apenas exibidos:
o worker não acessa URLs arbitrárias retornadas pelo provedor.

Cache de 24 horas por fonte, evento/esporte e data aproximada. O usuário pode
pedir uma atualização explícita sem cache, consumindo uma consulta. O cache
não renova a validade ao ser reutilizado. Limites são persistidos no PostgreSQL
antes da chamada, contando também falhas e resultados incertos. Não equivalem
a um limite remoto de cobrança e não concedem permissão de assinatura paga.

Referências consultadas em 07/09/2026:

- [TheSportsDB — documentação e acesso gratuito](https://www.thesportsdb.com/documentation).
- [Tavily — parâmetros de Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).
- [Tavily — créditos e planos](https://docs.tavily.com/documentation/api-credits).

## Fila e recuperação

`POST /api/v1/event-search` persiste uma solicitação com chave idempotente.
O mesmo corpo/chave retorna a mesma solicitação; outro corpo é conflito.
O navegador guarda a solicitação antes do POST e recupera a chave original
após erro de rede/recarga. Não há repetição automática do POST.

A tabela de solicitações é a fila durável do worker, com transações curtas e
admissão serializada por advisory lock. Há até 100 solicitações ativas. O worker
reclama uma solicitação e reserva a cota na mesma transação; HTTP ocorre depois
do commit, com timeout de 15 segundos, resposta limitada a 256 KiB e redirects
recusados. Não repete consultas automaticamente após falha. Processamento
interrompido por mais de cinco minutos vira `EVENT_OUTCOME_UNCERTAIN`; resposta
tardia não pode reabrir ou concluir essa solicitação.

## Configuração e verificação

`THESPORTSDB_ENABLED` e `TAVILY_ENABLED` são `false` por padrão. API e worker
devem receber a mesma configuração. Tavily requer `TAVILY_API_KEY` no runtime
local ou `TAVILY_API_KEY_FILE` absoluto e privado em produção. Não habilitar
cobrança automática ou rota paga sem autorização. TheSportsDB usa a chave
pública gratuita fixa; não usa credencial premium.

Os Composes padrão mantêm as fontes desligadas e worker sem saída externa.
A ativação operacional precisa preparar os arquivos privados, as variáveis
dos dois serviços e a saída HTTPS para os endpoints fixos. Migração
`0004_event_calendar` é aditiva, com índices de agenda, fila, cache e uso;
produção exige o fluxo de autorização, backup e recuperação do runbook.

Verificações: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm local:test-db`,
`pnpm test:e2e` e `pnpm api:spec:check`. Fixtures são fictícias e chamadas
externas são simuladas. Os testes conferem cota persistente, concorrência,
cache, recarga, fontes ambíguas, fusos, datas parciais, adiamentos, preservação
da banca e bloqueio de acessos não autorizados.
