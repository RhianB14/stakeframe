import { type ReportQuery } from '@stakeframe/shared';
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
export const reportPopulation = `with selection_rollup as (
  select bet_id, case when bool_and(event_date is not null) then max(event_date) end event_date,
    bool_and(date_status='confirmed') confirmed,
    string_agg(event,' / ' order by position) event_summary,
    case when bool_or(sport is null or trim(sport)='') then 'unknown'
      when count(distinct translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'))>1 then 'mixed'
      else 'sport:' || min(translate(lower(regexp_replace(trim(sport),'\\s+',' ','g')),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')) end sport_key
  from finance.selection group by bet_id
), settlement_rollup as (
  select s.bet_id, sum(s.return_amount) returns, sum(s.real_principal_closed) principal,
    count(*) settlements, bool_and(s.outcome in ('win','loss','half_win','half_loss')) hit_eligible,
    bool_or(s.outcome in ('win','half_win')) hit_win
  from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id
  where r.settlement_id is null group by s.bet_id
), population as (
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
  from finance.bet b join finance.catalog c on c.id=b.bookmaker_id
  left join finance.catalog t on t.id=b.tipster_id
  left join selection_rollup sr on sr.bet_id=b.id
  left join settlement_rollup st on st.bet_id=b.id
  where b.state<>'cancelled'
    and ($3::uuid is null or b.bookmaker_id=$3)
    and ($4::text is null or coalesce(b.tipster_id::text,'none')=$4)
    and ($5::text is null or coalesce(sr.sport_key,'unknown')=$5)
    and ($6::text='all' or ($6='freebet')=(b.freebet_id is not null))
    and ($7::text is null or b.state=$7)
), eligible as (
  select * from population where event_date between $1::date and $2::date
    and ($8::boolean or confirmed)
)`;

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
  round(100.0*${count('hit_eligible and hit_win')}/nullif(${count('hit_eligible')},0),2)::text as "hitRateReal",
  ${count('hit_eligible and hit_win')} as "hitWinsReal", ${count('hit_eligible')} as "hitEligibleReal"`;

export const reportBetSql = `id,reference,event_summary as "eventSummary",event_date::text as "eventDate",
  case when confirmed then 'confirmed' else 'estimated' end as "dateStatus",
  bookmaker_id as "bookmakerId",bookmaker,tipster_id as "tipsterId",tipster,sport_key as "sportKey",sport,
  state,freebet,stake::text,remaining::text,round(returns,2)::text as returns,round(profit,2)::text as profit,
  round(profit/nullif(unit_amount,0),6)::text as "profitUnits",
  to_char(placed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "placedAt"`;
