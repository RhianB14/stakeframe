import { type ReportQuery, type SplitDimensionId } from '@stakeframe/shared';
import { FinanceError } from './finance-core.js';

export function reportRange(query: ReportQuery) {
  const start = Date.parse(`${query.from}T00:00:00Z`);
  const end = Date.parse(`${query.to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (
    !Number.isFinite(days) ||
    days < 1 ||
    days > 36_600 ||
    start - days * 86_400_000 < Date.parse('0001-01-01T00:00:00Z')
  )
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const previousTo = new Date(start - 86_400_000).toISOString().slice(0, 10);
  const previousFrom = new Date(start - days * 86_400_000).toISOString().slice(0, 10);
  return {
    days,
    previousFrom,
    previousTo,
    granularity: days <= 120 ? ('day' as const) : ('month' as const),
  };
}

// Exactly one financial row per bet. Selections and active settlements are
// aggregated independently before joining, so multiples never multiply money.
// STK-F2-03: rolagem de liquidações, filtro combinável de população e recorte
// elegível viraram blocos compartilhados — relatório, dashboard e os 12 splits
// leem o mesmo P&L e os mesmos filtros, sem caminhos paralelos.
const settlementRollupSql = `settlement_rollup as (
  select s.bet_id, sum(s.return_amount) returns, sum(s.real_principal_closed) principal,
    count(*) settlements, bool_and(s.outcome in ('win','loss','half_win','half_loss')) hit_eligible,
    bool_or(s.outcome in ('win','half_win')) hit_win
  from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id
    and r.organization_id=s.organization_id
  where s.organization_id=current_setting($$app.organization_id$$, true)::uuid and r.settlement_id is null
  group by s.bet_id
)`;
const populationFilterSql = `  where b.organization_id=current_setting($$app.organization_id$$, true)::uuid
    and b.state<>'cancelled'
    and ($3::uuid is null or b.bookmaker_id=$3)
    and ($4::text is null or coalesce(b.tipster_id::text,'none')=$4)
    and ($5::text is null or coalesce(sr.sport_key,'unknown')=$5)
    and ($6::text='all' or ($6='freebet')=(b.freebet_id is not null))
    and ($7::text is null or b.state=$7)`;
const eligibleSql = `eligible as (
  select * from population where event_date between $1::date and $2::date
    and ($8::boolean or confirmed)
)`;
export const reportPopulation = `with selection_rollup as (
  select bet_id, case when bool_and(event_date is not null) then max(event_date) end event_date,
    bool_and(date_status='confirmed') confirmed,
    string_agg(event,' / ' order by position) event_summary,
    case when bool_or(sport is null or trim(sport)='') then 'unknown'
      when count(distinct translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'))>1 then 'mixed'
      else 'sport:' || min(translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')) end sport_key
  from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid
  group by bet_id
), ${settlementRollupSql}, population as (
  select b.id,b.reference,b.bookmaker_id,c.name bookmaker,b.tipster_id,coalesce(t.name,'Sem tipster') tipster,
    b.stake,b.remaining,b.state,b.placed_at,b.unit_amount,b.freebet_id is not null freebet,
    sr.event_date,coalesce(sr.confirmed,false) confirmed,coalesce(sr.event_summary,'') event_summary,
    coalesce(sr.sport_key,'unknown') sport_key,
    case when sr.sport_key='mixed' then 'Múltiplos esportes'
      when sr.sport_key is null or sr.sport_key='unknown' then 'Esporte a conferir'
      else initcap(substring(sr.sport_key from 7)) end sport,
    coalesce(st.returns,0) returns,coalesce(st.principal,0) principal,
    coalesce(st.returns,0)-coalesce(st.principal,0) profit,
    coalesce(st.settlements,0) settlements,
    b.freebet_id is null and b.state='settled' and coalesce(st.hit_eligible,false) hit_eligible,
    coalesce(st.hit_win,false) hit_win
  from finance.bet b join finance.catalog c on c.id=b.bookmaker_id and c.organization_id=b.organization_id
  left join finance.catalog t on t.id=b.tipster_id and t.organization_id=b.organization_id
  left join selection_rollup sr on sr.bet_id=b.id
  left join settlement_rollup st on st.bet_id=b.id
${populationFilterSql}
), ${eligibleSql}`;

export const reportValues = (query: ReportQuery) => [
  query.from,
  query.to,
  query.bookmakerId ?? null,
  query.tipsterId ?? null,
  query.sport ?? null,
  query.kind,
  query.state ?? null,
  query.includeEstimated === 'true',
];

const sum = (expression: string, scale = 2) =>
  `round(coalesce(sum(${expression}),0),${scale})::text`;
const count = (condition: string) => `count(*) filter(where ${condition})::int`;
const missing = 'settlements>0 and (unit_amount is null or unit_amount<=0)';
export const reportMetricsSql = `count(*)::int as "bets",
  ${count("state='settled'")} as "settledBets", ${count("state='open'")} as "openBets",
  ${sum('case when not freebet then stake else 0 end')} as "realStake",
  ${sum('case when freebet then stake else 0 end')} as "freebetStake",
  ${sum('case when not freebet then principal else 0 end')} as "realPrincipalClosed",
  ${sum('case when not freebet then returns else 0 end')} as "realReturns",
  ${sum('case when freebet then returns else 0 end')} as "freebetReturns",
  ${sum('case when not freebet then profit else 0 end')} as "realProfit",
  ${sum('case when freebet then profit else 0 end')} as "freebetProfit",
  ${sum('profit')} as "profit",
  case when ${count(missing)}>0 then null else ${sum('profit/nullif(unit_amount,0)', 6)} end as "profitUnits",
  ${sum('profit/nullif(unit_amount,0)', 6)} as "knownProfitUnits",
  ${count(missing)} as "missingUnitBets",
  ${sum("case when not freebet and state='open' then remaining else 0 end")} as "exposure",
  round(100*sum(case when not freebet then profit else 0 end)/nullif(sum(case when not freebet then principal else 0 end),0),2)::text as "roiReal",
  round(100*sum(case when not freebet then profit else 0 end)/nullif(sum(case when not freebet then stake else 0 end),0),2)::text as "yieldReal",
  round(100.0*${count('hit_eligible and hit_win')}/nullif(${count('hit_eligible')},0),2)::text as "hitRateReal",
  ${count('hit_eligible and hit_win')} as "hitWinsReal", ${count('hit_eligible')} as "hitEligibleReal"`;

export const reportBetSql = `id,reference,event_summary as "eventSummary",event_date::text as "eventDate",
  case when confirmed then 'confirmed' else 'estimated' end as "dateStatus",
  bookmaker_id as "bookmakerId",bookmaker,tipster_id as "tipsterId",tipster,sport_key as "sportKey",sport,
  state,freebet,stake::text,remaining::text,round(returns,2)::text as returns,round(profit,2)::text as profit,
  round(profit/nullif(unit_amount,0),6)::text as "profitUnits",
  to_char(placed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "placedAt"`;

/* -------------------------------------------------------------------------- *
 * STK-F2-03 — os 12 splits analíticos (Plano §8.5, §15)
 * -------------------------------------------------------------------------- */

/**
 * Normalização de texto no SQL espelhando `classifyTicketKind`
 * (packages/shared/src/imports.ts): minúsculas, pontuação vira espaço, espaços
 * colapsados e acentos removidos. Classes POSIX em vez de barra invertida, para
 * valer igual em qualquer `standard_conforming_strings`.
 */
const normalizeText = (expression: string) =>
  `translate(regexp_replace(trim(regexp_replace(lower(${expression}),'[^[:alnum:][:space:]]+',' ','g')),'[[:space:]]+',' ','g'),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')`;

/**
 * População dos splits: mesma estrutura, joins, filtros e recorte elegível do
 * relatório (blocos compartilhados acima), acrescida do rollup de mercado, da
 * contagem de seleções/eventos que deriva o tipo de aposta e da odd total da
 * aposta. Nada aqui reprocessa histórico — dimensões sem coluna saem
 * `unknown` na própria consulta.
 */
export const splitPopulation = `with selection_rollup as (
  select bet_id, case when bool_and(event_date is not null) then max(event_date) end event_date,
    bool_and(date_status='confirmed') confirmed,
    string_agg(event,' / ' order by position) event_summary,
    case when bool_or(sport is null or trim(sport)='') then 'unknown'
      when count(distinct translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'))>1 then 'mixed'
      else 'sport:' || min(translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')) end sport_key,
    case when bool_or(market is null or trim(market)='') then 'unknown'
      when count(distinct ${normalizeText('market')})>1 then 'mixed'
      else 'market:' || min(${normalizeText('market')}) end market_key,
    min(nullif(trim(market),'')) market_sample,
    count(*)::int selection_count,
    count(*) filter (where nullif(trim(event),'') is null)::int missing_event_count,
    count(distinct ${normalizeText('event')}) distinct_event_count
  from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid
  group by bet_id
), ${settlementRollupSql}, population as (
  select b.id,b.reference,b.bookmaker_id,c.name bookmaker,b.tipster_id,coalesce(t.name,'Sem tipster') tipster,
    b.stake,b.remaining,b.state,b.placed_at,b.odds,b.unit_amount,b.freebet_id is not null freebet,
    sr.event_date,coalesce(sr.confirmed,false) confirmed,coalesce(sr.event_summary,'') event_summary,
    coalesce(sr.sport_key,'unknown') sport_key,
    case when sr.sport_key='mixed' then 'Múltiplos esportes'
      when sr.sport_key is null or sr.sport_key='unknown' then 'Esporte a conferir'
      else initcap(substring(sr.sport_key from 7)) end sport,
    coalesce(sr.market_key,'unknown') market_key,
    case when sr.market_key='mixed' then 'Múltiplos mercados'
      when sr.market_key is null or sr.market_key='unknown' then 'Mercado a conferir'
      else sr.market_sample end market,
    case when coalesce(sr.selection_count,0)<=1 then 'simple'
      when sr.missing_event_count>0 then 'multiple'
      when coalesce(sr.distinct_event_count,0)<=1 then 'betbuild'
      else 'multiple' end ticket_kind_key,
    coalesce(st.returns,0) returns,coalesce(st.principal,0) principal,
    coalesce(st.returns,0)-coalesce(st.principal,0) profit,
    coalesce(st.settlements,0) settlements,
    b.freebet_id is null and b.state='settled' and coalesce(st.hit_eligible,false) hit_eligible,
    coalesce(st.hit_win,false) hit_win
  from finance.bet b join finance.catalog c on c.id=b.bookmaker_id and c.organization_id=b.organization_id
  left join finance.catalog t on t.id=b.tipster_id and t.organization_id=b.organization_id
  left join selection_rollup sr on sr.bet_id=b.id
  left join settlement_rollup st on st.bet_id=b.id
${populationFilterSql}
), ${eligibleSql}`;

export type SplitDimensionDefinition = {
  id: SplitDimensionId;
  /** Rótulo da dimensão mostrado na interface. */
  label: string;
  /** Origem técnica do agrupamento (coluna, derivação ou `unavailable`). */
  source: string;
  /** `false` quando o modelo atual não tem a dimensão: tudo cai em `unknown`. */
  available: boolean;
  /** Nota factual de cobertura/derivação; `null` quando a fonte é a coluna. */
  note: string | null;
  /** Expressão da chave agrupada (colunas de `eligible` ou da junção extra). */
  keySql: string;
  /** Expressão do rótulo exibido; agrupada por `min(label)` na consulta. */
  labelSql: string;
  /** Junção extra quando a fonte não é coluna de `finance.*`. */
  joinSql?: string;
  /** Ordenação das linhas: natural (dimensões ordenadas) ou por volume. */
  orderSql: string;
};

/**
 * Override manual salvo no rascunho importado (mesma leitura de
 * `finance-read.ts#betDtos`): só as apostas importadas têm linha no inbox,
 * então o resto do histórico continua vindo da própria coluna ou do `unknown`.
 */
const inboxOverrideJoin = (alias: string, key: string) =>
  `left join lateral (select i.metadata->'userOverrides'->>'${key}' as override_value
    from integration.inbox i
    where i.organization_id=current_setting($$app.organization_id$$, true)::uuid
      and i.imported_bet_id=e.id
    order by i.updated_at desc, i.id desc limit 1) ${alias} on true`;

const saoPauloLocal = (expression: string) => `(${expression} at time zone 'America/Sao_Paulo')`;

const unknownDimension = (input: {
  id: SplitDimensionId;
  label: string;
  note: string;
}): SplitDimensionDefinition => ({
  ...input,
  source: 'unavailable',
  available: false,
  keySql: `'unknown'`,
  labelSql: `'Sem base'`,
  orderSql: 'count(*) desc',
});

const ticketKindKey = `case when tk.override_value in ('simple','multiple','betbuild') then tk.override_value else ticket_kind_key end`;

/**
 * Os 12 splits do Plano §8.5, na ordem do card. Dimensões sem coluna no modelo
 * atual (time, jogador, live/pré-jogo) ficam `available: false` com uma única
 * linha `unknown` — sem reprocessamento histórico (STK-F2-03, escopo excluído).
 */
export const splitDimensions: SplitDimensionDefinition[] = [
  {
    id: 'sport',
    label: 'Esporte',
    source: 'finance.selection.sport',
    available: true,
    note: null,
    keySql: 'sport_key',
    labelSql: 'sport',
    orderSql: 'count(*) desc, key',
  },
  {
    id: 'tournament',
    label: 'Liga/torneio',
    source: 'integration.inbox.metadata.userOverrides.tournament',
    available: true,
    note: 'Somente o torneio informado manualmente na importação; sem coluna em finance.selection, o restante do histórico permanece unknown, sem reprocessamento.',
    joinSql: inboxOverrideJoin('ti', 'tournament'),
    keySql: `case when nullif(trim(ti.override_value),'') is null then 'unknown' else ${normalizeText('ti.override_value')} end`,
    labelSql: `case when nullif(trim(ti.override_value),'') is null then 'Torneio a conferir' else trim(ti.override_value) end`,
    orderSql: 'count(*) desc, key',
  },
  unknownDimension({
    id: 'team',
    label: 'Time',
    note: 'O modelo atual não guarda time (finance.selection só tem evento livre); toda a população sai unknown, sem reprocessamento histórico.',
  }),
  unknownDimension({
    id: 'player',
    label: 'Jogador',
    note: 'O modelo atual não guarda jogador; toda a população sai unknown, sem reprocessamento histórico.',
  }),
  {
    id: 'ticketKind',
    label: 'Tipo de aposta',
    source:
      'derived:finance.selection (classifyTicketKind) + integration.inbox.metadata.userOverrides.ticketKind',
    available: true,
    note: 'Derivado da composição do bilhete (1 seleção = Simples, mesmo evento = BetBuild, eventos diferentes = Múltipla); o tipo manual da importação sobrepõe o derivado.',
    joinSql: inboxOverrideJoin('tk', 'ticketKind'),
    keySql: ticketKindKey,
    labelSql: `case when ${ticketKindKey}='simple' then 'Simples' when ${ticketKindKey}='multiple' then 'Múltipla' when ${ticketKindKey}='betbuild' then 'BetBuild' else 'Sem base' end`,
    orderSql: `case key when 'simple' then 1 when 'multiple' then 2 when 'betbuild' then 3 else 4 end`,
  },
  {
    id: 'market',
    label: 'Mercado',
    source: 'finance.selection.market',
    available: true,
    note: null,
    keySql: 'market_key',
    labelSql: 'market',
    orderSql: 'count(*) desc, key',
  },
  {
    id: 'bookmaker',
    label: 'Casa',
    source: 'finance.bet.bookmaker_id',
    available: true,
    note: null,
    keySql: 'bookmaker_id::text',
    labelSql: 'bookmaker',
    orderSql: 'count(*) desc, key',
  },
  {
    id: 'oddsBand',
    label: 'Faixa de odd',
    source: 'derived:finance.bet.odds',
    available: true,
    note: 'Faixa da odd total do bilhete (finance.bet.odds); aposta sem odd registrada cai em unknown.',
    keySql: `case when odds is null then 'unknown' when odds<1.5 then '<1.50' when odds<2 then '1.50-1.99' when odds<3 then '2.00-2.99' when odds<5 then '3.00-4.99' when odds<10 then '5.00-9.99' else '>=10.00' end`,
    labelSql: `case when odds is null then 'Sem base' when odds<1.5 then 'Abaixo de 1,50' when odds<2 then '1,50 a 1,99' when odds<3 then '2,00 a 2,99' when odds<5 then '3,00 a 4,99' when odds<10 then '5,00 a 9,99' else '10,00 ou mais' end`,
    orderSql: 'min(odds)',
  },
  {
    id: 'weekday',
    label: 'Dia da semana',
    source: 'derived:finance.bet.placed_at@America/Sao_Paulo',
    available: true,
    note: 'Dia da semana em que a aposta foi registrada, em São Paulo.',
    keySql: `case extract(isodow from ${saoPauloLocal('placed_at')}) when 1 then 'seg' when 2 then 'ter' when 3 then 'qua' when 4 then 'qui' when 5 then 'sex' when 6 then 'sab' else 'dom' end`,
    labelSql: `case extract(isodow from ${saoPauloLocal('placed_at')}) when 1 then 'Segunda-feira' when 2 then 'Terça-feira' when 3 then 'Quarta-feira' when 4 then 'Quinta-feira' when 5 then 'Sexta-feira' when 6 then 'Sábado' else 'Domingo' end`,
    orderSql: `min(extract(isodow from ${saoPauloLocal('placed_at')}))`,
  },
  {
    id: 'hour',
    label: 'Hora',
    source: 'derived:finance.bet.placed_at@America/Sao_Paulo',
    available: true,
    note: 'Hora em que a aposta foi registrada, em São Paulo.',
    keySql: `to_char(${saoPauloLocal('placed_at')},'HH24')`,
    labelSql: `to_char(${saoPauloLocal('placed_at')},'HH24') || ':00–' || to_char(${saoPauloLocal('placed_at')},'HH24') || ':59'`,
    orderSql: `min(extract(hour from ${saoPauloLocal('placed_at')}))`,
  },
  unknownDimension({
    id: 'live',
    label: 'Live/pré-jogo',
    note: 'O modelo atual não guarda se a aposta foi ao vivo ou pré-jogo; toda a população sai unknown, sem reprocessamento histórico.',
  }),
  {
    id: 'tipster',
    label: 'Tipster',
    source: 'finance.bet.tipster_id',
    available: true,
    note: null,
    keySql: `coalesce(tipster_id::text,'none')`,
    labelSql: 'tipster',
    orderSql: 'count(*) desc, key',
  },
];

/**
 * Uma consulta por dimensão sobre a mesma população do relatório: chave e
 * rótulo por linha, depois `min(label)` (mescla variações de caixa) e as
 * mesmas métricas do relatório — ROI, P&L, yield e `N` juntos em cada linha.
 */
export const splitDimensionSql = (dimension: SplitDimensionDefinition) =>
  `${splitPopulation}
  select key, min(label) as label, ${reportMetricsSql}
  from (select ${dimension.keySql} as key, ${dimension.labelSql} as label, e.*
    from eligible e ${dimension.joinSql ?? ''}) split_rows
  group by 1 order by ${dimension.orderSql}`;
