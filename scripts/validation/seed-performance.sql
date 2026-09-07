-- Fictional volume fixture, executed only inside a newly created disposable database.
create temporary table performance_seed on commit drop as
select n, gen_random_uuid() bet_id, gen_random_uuid() stake_journal_id,
  gen_random_uuid() settlement_journal_id from generate_series(1,10000) n;

insert into finance.journal(id,kind,effective_at,actor,reason)
select stake_journal_id,'bet_stake',now(),'synthetic-performance','Fictional volume fixture'
from performance_seed;

insert into finance.bet(id,bookmaker_id,stake,odds,placed_at,reference,state,remaining,
  unit_month,unit_amount,stake_journal_id)
select p.bet_id,c.id,10,1.5,now(),'synthetic-'||n,
  case when n%2=0 then 'settled' else 'open' end,case when n%2=0 then 0 else 10 end,
  u.month,u.amount,p.stake_journal_id
from performance_seed p cross join finance.catalog c cross join finance.monthly_unit u
where c.name='Bet365';

insert into finance.posting(journal_id,account_id,amount)
select p.stake_journal_id,a.id,case when a.kind='exposure' then 10 else -10 end
from performance_seed p cross join finance.account a
where a.kind='exposure' or a.bookmaker_id=(select id from finance.catalog where name='Bet365');

insert into finance.selection(bet_id,position,event,sport,market,selection,event_date,date_status)
select p.bet_id,s.position,'Fictional match '||n||'/'||s.position,
  case when n%3=0 and s.position=2 then 'Tênis' else 'Futebol' end,
  'Resultado','Fictional selection',
  case when n%20=0 then null else date '2026-09-01'+(n%28) end,
  case when n%20=0 then 'pending' when n%20=1 then 'estimated' else 'confirmed' end
from performance_seed p cross join lateral
  generate_series(0,case when n%3=0 then 2 else 0 end) s(position);

insert into finance.journal(id,kind,effective_at,actor,reason)
select settlement_journal_id,'bet_settlement',now(),'synthetic-performance','Fictional settlement'
from performance_seed where n%2=0;

insert into finance.settlement(bet_id,outcome,closed_principal,real_principal_closed,
  return_amount,settled_at,journal_id,reason)
select bet_id,'win',10,10,15,now(),settlement_journal_id,'Fictional settlement'
from performance_seed where n%2=0;

insert into finance.posting(journal_id,account_id,amount)
select p.settlement_journal_id,a.id,
  case when a.kind='exposure' then -10 when a.kind='counter' then -5 else 15 end
from performance_seed p cross join finance.account a
where n%2=0 and (a.kind in ('exposure','counter')
  or a.bookmaker_id=(select id from finance.catalog where name='Bet365'));
