# Análises e exportações — M5

Implementação e verificação diretas do Codex, conforme D019. Os relatórios são
privados e usam os registros do PostgreSQL. Não há dados de demonstração na
interface de produção nem metas ou recomendações de apostas.

## População e datas

Uma linha financeira por aposta. Seleções e liquidações são agregadas antes
dos joins, evitando multiplicar stake, retorno ou resultado em múltiplas.
O resultado integral pertence à data do último evento em São Paulo; todos os
eventos precisam ter data. Horário ausente não impede uma data confirmada.
Datas estimadas entram somente por filtro explícito. Apostas canceladas e
liquidações estornadas não entram no desempenho.

O contador de datas incompletas considera todos os períodos dentro dos demais
filtros, pois esses registros não podem ser atribuídos a uma data. O contador
de estimativas excluídas considera apenas o período selecionado. A programação
do evento pode ser corrigida no calendário; isso atualiza o desempenho
histórico, sem alterar lançamentos financeiros.

Casa, tipster, esporte, origem real/freebet e situação usam o mesmo critério
no resumo, nas dimensões, no detalhamento e no CSV. Esporte é normalizado por
caixa, acentos e espaços. Múltiplas de esportes distintos pertencem a
`Múltiplos esportes`; qualquer seleção sem esporte leva o bilhete inteiro a
`Esporte a conferir`. Cada dimensão reconcilia com o total.

## Definições

| Indicador             | Cálculo                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Resultado real        | Retornos ativos reais menos principal real encerrado                                                                                        |
| Resultado de freebets | Retornos promocionais creditados na banca real                                                                                              |
| Resultado total       | Resultado real + resultado de freebets                                                                                                      |
| ROI real              | 100 × resultado real / principal real encerrado ativo; inclui anulações e cashouts, exclui freebets; base zero retorna ausente              |
| Acerto real           | Vitórias completas ou parciais / apostas reais totalmente liquidadas apenas em win/loss/half_win/half_loss; exclui qualquer void ou cashout |
| Exposição             | Principal real ainda aberto **agora** nas apostas do período; não é saldo histórico no encerramento daquele dia                             |
| Resultado em unidades | Soma de resultado / unidade histórica positiva da aposta, arredondada ao final para seis casas                                              |

Dinheiro usa `numeric` no PostgreSQL e strings decimais na API. Agregados
admitem valores superiores ao limite de uma movimentação individual. O gráfico
converte valores em números somente para posicionamento; tooltips e tabelas
preservam os valores exatos. Séries longas usam meses; séries curtas usam dias,
com períodos sem movimento preenchidos com zero. A curva acumulada começa no
início do filtro, e não representa o saldo da banca.

Se uma aposta com liquidação ativa não tem unidade positiva, o total em
unidades fica ausente; `knownProfitUnits` identifica a parcela calculável e
`missingUnitBets` informa a pendência. Cadastrar uma unidade histórica não
altera apostas silenciosamente: `bet.unit.resolve` associa explicitamente o
valor histórico, com versão, idempotência e motivo auditado. Não sobrescreve
unidades positivas nem cria movimentações.

A comparação usa o período imediatamente anterior com o mesmo número de
dias e os mesmos filtros. O resumo, as dimensões e a série de uma consulta
compartilham uma transação de leitura repetível. Novas consultas e downloads
podem refletir alterações posteriores.

## Exportações

- `GET /api/v1/exports/csv`: todas as apostas elegíveis do filtro; cabeçalho
  fixo, UTF-8 com BOM, vírgulas, aspas RFC 4180 e ponto decimal. Campos de texto
  com prefixos de fórmula são neutralizados com apóstrofo; valores numéricos
  exatos, inclusive negativos, são preservados.
- `GET /api/v1/exports/json`: histórico estruturado completo, independente de
  filtros. Inclui cadastros, contas, lançamentos e partidas, unidades,
  apostas/seleções, liquidações/estornos, auditoria, recibos idempotentes,
  importações, metadados de anexos, pesquisas de eventos e uso de integração.
  Mantém valores textuais originais.

O JSON tem `schemaVersion`, `generatedAt` e `financialVersion`; tabelas são
listas identificadas pelo nome qualificado. Somente colunas explicitamente
permitidas são consultadas. Não inclui autenticação, tokens, credenciais,
bytes de imagens nem chaves dos objetos privados. É portabilidade de dados;
a recuperação operacional continua sendo feita pelo backup criptografado.

Ambos exigem sessão antes de validar parâmetros ou consultar dados e usam
`no-store`, `nosniff` e `Content-Disposition: attachment`. Cada download tem
um snapshot independente e processa lotes de 500 registros. CSV usa cursor;
JSON usa paginação pelas chaves primárias, inclusive compostas. Não existe
limite silencioso de linhas. Há uma exportação ativa por processo, prazo de
120 segundos e liberação da conexão ao terminar ou interromper. Uma falha
interrompe o arquivo, evitando apresentá-lo como exportação completa.

## Verificação

`tests/integration/reports.test.ts` confere múltiplas, filtros, estimativas,
estornos, cashouts, freebets, denominadores, unidades pendentes, acesso e
snapshot durante mutações concorrentes. `tests/unit/reports.test.ts` cobre
valores agregados, datas e fórmulas CSV. Cenários Playwright validam gráficos,
filtros, detalhamento, estados de erro e layout em computador e celular.

O conjunto completo e os resultados de CI ficam vinculados ao SHA na PR do
M5. A implementação não ativa deploy, migrações, provedores ou credenciais em
produção. Nenhuma migração adicional é necessária para este módulo.
