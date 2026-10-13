import {
  cents,
  money,
  saoPauloDate,
  unitsFor,
  workspaceSchema,
  betSchema,
  classifyTicketKind,
  ticketKindSchema,
  type BetQuery,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { FinanceError, type BetRow, type SettingsRow } from './finance-core.js';

export async function readWorkspace(client: PoolClient) {
  const settings = (
    await client.query<SettingsRow>(
      'select * from finance.settings where organization_id=current_setting($$app.organization_id$$, true)::uuid',
    )
  ).rows[0]!;
  const accounts = (
    await client.query<{
      id: string;
      kind: string;
      name: string;
      bookmaker_id: string | null;
      balance: string;
    }>(
      'select a.*,coalesce(sum(p.amount),0)::numeric(16,2)::text as balance from finance.account a left join finance.posting p on p.account_id=a.id where a.organization_id=current_setting($$app.organization_id$$, true)::uuid group by a.id order by a.kind,a.name',
    )
  ).rows;
  const catalog = (
    await client.query<{
      id: string;
      kind: string;
      name: string;
      active: boolean;
      aliases: string[];
    }>(
      'select c.*,coalesce(array_agg(a.label order by a.label) filter(where a.alias is not null),array[]::text[]) as aliases from finance.catalog c left join finance.catalog_alias a on a.catalog_id=c.id where c.organization_id=current_setting($$app.organization_id$$, true)::uuid group by c.id order by c.kind,c.name',
    )
  ).rows;
  const units = (
    await client.query(
      'select month,amount,base,percent,source from finance.monthly_unit where organization_id=current_setting($$app.organization_id$$, true)::uuid order by month desc limit 120',
    )
  ).rows;
  const freebets = (
    await client.query<{
      id: string;
      bookmaker_id: string;
      amount: string;
      expires_on: string;
      stake_returned: boolean;
      used_by: string | null;
      note: string;
    }>(
      'select *, expires_on::text as expires_on from finance.freebet where organization_id=current_setting($$app.organization_id$$, true)::uuid order by created_at desc limit 1000',
    )
  ).rows;
  const cash = accounts.filter(
    (account) => account.kind === 'reserve' || account.kind === 'bookmaker',
  );
  const available = cash.reduce((sum, account) => sum + cents(account.balance), 0n);
  const exposure = cents(
    accounts.find((account) => account.kind === 'exposure')?.balance ?? '0.00',
  );
  const month = saoPauloDate(new Date()).slice(0, 7);
  const current = units.find((unit) => unit.month === month);
  return workspaceSchema.parse({
    version: settings.version,
    initialized: settings.initialized,
    unitPercent: settings.unit_percent,
    bankroll: money(available + exposure),
    available: money(available),
    exposure: money(exposure),
    accounts: cash.map((account) => ({
      id: account.id,
      kind: account.kind,
      name: account.name,
      bookmakerId: account.bookmaker_id,
      balance: account.balance,
    })),
    catalog: catalog.map((row) => ({
      ...row,
      aliases: row.aliases.filter((alias) => alias !== row.name),
    })),
    units,
    freebets: freebets.map((row) => ({
      id: row.id,
      bookmakerId: row.bookmaker_id,
      amount: row.amount,
      expiresOn: row.expires_on,
      stakeReturned: row.stake_returned,
      usedBy: row.used_by,
      note: row.note,
    })),
    warnings: [
      ...(cash.some((account) => cents(account.balance) < 0n) ? ['NEGATIVE_BALANCE'] : []),
      ...(settings.initialized && (!current || cents(String(current.amount)) <= 0n)
        ? ['UNIT_PENDING']
        : []),
    ],
  });
}

export async function betDtos(client: PoolClient, rows: BetRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const selections = (
    await client.query<{
      bet_id: string;
      id: string;
      event: string;
      sport: string | null;
      market: string;
      selection: string;
      odds: string | null;
      event_date: string | null;
      event_at: Date | null;
      date_status: string;
    }>(
      'select *, event_date::text as event_date from finance.selection where organization_id=current_setting($$app.organization_id$$, true)::uuid and bet_id=any($1::uuid[]) order by bet_id,position',
      [ids],
    )
  ).rows;
  const totals = (
    await client.query<{ bet_id: string; returns: string; profit: string }>(
      'select s.bet_id,coalesce(sum(s.return_amount),0)::numeric(16,2)::text as returns,coalesce(sum(s.return_amount-s.real_principal_closed),0)::numeric(16,2)::text as profit from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.organization_id=current_setting($$app.organization_id$$, true)::uuid and s.bet_id=any($1::uuid[]) and r.settlement_id is null group by s.bet_id',
      [ids],
    )
  ).rows;
  const metadata = (
    await client.query<{
      bet_id: string;
      ticket_kind: string | null;
      outcome: string | null;
    }>(
      `select b.id as bet_id,i.ticket_kind,s.outcome
       from unnest($1::uuid[]) as b(id)
       left join lateral (
         select metadata->'userOverrides'->>'ticketKind' as ticket_kind
         from integration.inbox
         where organization_id=current_setting($$app.organization_id$$, true)::uuid
           and imported_bet_id=b.id
         order by updated_at desc,id desc limit 1
       ) i on true
       left join lateral (
         select settlement.outcome
         from finance.settlement settlement
         left join finance.settlement_reversal reversal on reversal.settlement_id=settlement.id
         where settlement.organization_id=current_setting($$app.organization_id$$, true)::uuid
           and settlement.bet_id=b.id and reversal.settlement_id is null
         order by settlement.settled_at desc,settlement.created_at desc,settlement.id desc limit 1
       ) s on true`,
      [ids],
    )
  ).rows;
  return rows.map((row) => {
    const total = totals.find((value) => value.bet_id === row.id);
    const betSelections = selections.filter((value) => value.bet_id === row.id);
    const betMetadata = metadata.find((value) => value.bet_id === row.id);
    const kindOverride = ticketKindSchema.safeParse(betMetadata?.ticket_kind);
    return betSchema.parse({
      id: row.id,
      ticketNumber: row.ticket_number,
      bookmakerId: row.bookmaker_id,
      tipsterId: row.tipster_id,
      stake: row.stake,
      odds: row.odds,
      placedAt: row.placed_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      freebetId: row.freebet_id,
      freebetStakeReturned: row.freebet_id ? row.promotional_stake_returned : null,
      reference: row.reference,
      state: row.state,
      ticketKind: kindOverride.success
        ? kindOverride.data
        : classifyTicketKind(betSelections.map((selection) => ({ event: selection.event }))),
      latestOutcome: betMetadata?.outcome ?? null,
      remaining: row.remaining,
      unitMonth: row.unit_month,
      unitAmount: row.unit_amount,
      completionState: row.completion_state,
      stakeUnits: row.stake === null ? null : unitsFor(row.stake, row.unit_amount),
      returnAmount: total?.returns ?? '0.00',
      profit: total?.profit ?? '0.00',
      selections: betSelections.map((selection) => ({
        id: selection.id,
        event: selection.event,
        sport: selection.sport,
        market: selection.market,
        selection: selection.selection,
        odds: selection.odds,
        eventDate: selection.event_date,
        eventAt: selection.event_at?.toISOString() ?? null,
        dateStatus: selection.date_status,
      })),
    });
  });
}

export async function readBets(client: PoolClient, query: BetQuery) {
  const values: unknown[] = [];
  // The organization predicate is always the first clause: reads can never widen it.
  const clauses: string[] = [
    'b.organization_id=current_setting($$app.organization_id$$, true)::uuid',
  ];
  const where = (expression: string, value: unknown) => {
    values.push(value);
    clauses.push(expression.replace('?', `$${values.length}`));
  };
  if (query.state) where('b.state=?', query.state);
  if (query.bookmakerId) where('b.bookmaker_id=?', query.bookmakerId);
  if (query.tipsterId) where('b.tipster_id=?', query.tipsterId);
  if (query.from)
    where("(b.placed_at at time zone 'America/Sao_Paulo')::date>=?::date", query.from);
  if (query.to) where("(b.placed_at at time zone 'America/Sao_Paulo')::date<=?::date", query.to);
  if (query.search) {
    values.push(`%${query.search}%`);
    const pattern = `$${values.length}`;
    clauses.push(`(
      coalesce(b.reference,'') ilike ${pattern}
      or b.ticket_number::text ilike ${pattern}
      or exists (
        select 1 from finance.catalog c
        where c.organization_id=b.organization_id and c.id=b.bookmaker_id and c.name ilike ${pattern}
      )
      or exists (
        select 1 from finance.catalog t
        where t.organization_id=b.organization_id and t.id=b.tipster_id and t.name ilike ${pattern}
      )
      or exists (
        select 1 from finance.selection s
        where s.organization_id=b.organization_id and s.bet_id=b.id
          and (s.event ilike ${pattern} or s.sport ilike ${pattern}
            or s.market ilike ${pattern} or s.selection ilike ${pattern})
      )
    )`);
  }
  if (query.sport) {
    where(
      `exists (
      select 1 from finance.selection s
      where s.organization_id=b.organization_id and s.bet_id=b.id
        and lower(trim(s.sport))=lower(?)
    )`,
      query.sport,
    );
  }
  if (query.marketType) {
    where(
      `exists (
        select 1 from finance.selection s
        where s.organization_id=b.organization_id and s.bet_id=b.id
          and lower(trim(s.market))=lower(trim(?))
      )`,
      query.marketType,
    );
  }
  const ticketKindExpression = `coalesce(
    (
      select case
        when i.metadata->'userOverrides'->>'ticketKind' in ('simple','multiple','betbuild')
          then i.metadata->'userOverrides'->>'ticketKind'
        else null
      end
      from integration.inbox i
      where i.organization_id=b.organization_id and i.imported_bet_id=b.id
      order by i.updated_at desc,i.id desc limit 1
    ),
    (
      select case
        when count(*) <= 1 then 'simple'
        when count(*) filter(where s.event is null or btrim(s.event)='') > 0 then 'multiple'
        when count(distinct regexp_replace(lower(trim(s.event)), '[^[:alnum:]]+', ' ', 'g')) = 1 then 'betbuild'
        else 'multiple'
      end
      from finance.selection s
      where s.organization_id=b.organization_id and s.bet_id=b.id
    )
  )`;
  if (query.ticketKind) where(`${ticketKindExpression}=?`, query.ticketKind);
  const latestOutcomeExpression = `(
    select settlement.outcome
    from finance.settlement settlement
    left join finance.settlement_reversal reversal
      on reversal.organization_id=settlement.organization_id
      and reversal.settlement_id=settlement.id
    where settlement.organization_id=b.organization_id and settlement.bet_id=b.id
      and reversal.settlement_id is null
    order by settlement.settled_at desc,settlement.created_at desc,settlement.id desc
    limit 1
  )`;
  if (query.historyOutcome) {
    const outcome = {
      open: `b.state='open' and ${latestOutcomeExpression} is null`,
      settled: `b.state='settled'`,
      won: `${latestOutcomeExpression} in ('win','half_win')`,
      lost: `${latestOutcomeExpression} in ('loss','half_loss')`,
      void: `(b.state='cancelled' or ${latestOutcomeExpression}='void')`,
      cashout: `${latestOutcomeExpression} in ('cashout','partial_cashout')`,
    }[query.historyOutcome];
    clauses.push(`(${outcome})`);
  }
  if (query.historyBefore) {
    values.push(query.historyBefore);
    const before = `$${values.length}::date`;
    const earliestConfirmedDate = `(
      select min(coalesce((s.event_at at time zone 'America/Sao_Paulo')::date,s.event_date))
      from finance.selection s
      where s.organization_id=b.organization_id and s.bet_id=b.id
        and s.date_status='confirmed'
    )`;
    clauses.push(`coalesce(${earliestConfirmedDate},${before} - 1) < ${before}`);
  }
  const filter = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const count = (
    await client.query<{ count: string }>(`select count(*) from finance.bet b ${filter}`, values)
  ).rows[0]!;
  const summary = (
    await client.query<{
      stake: string;
      profit: string;
      stake_units: string | null;
      profit_units: string | null;
    }>(
      `select
         coalesce(sum(b.stake),0)::numeric(16,2)::text as stake,
         coalesce(sum(financial.profit),0)::numeric(16,2)::text as profit,
         case when count(b.unit_amount)>0
           then coalesce(sum(round(b.stake/nullif(b.unit_amount,0),2)),0)::numeric(16,2)::text
           else null end as stake_units,
         case when count(b.unit_amount)>0
           then coalesce(sum(round(financial.profit/nullif(b.unit_amount,0),2)),0)::numeric(16,2)::text
           else null end as profit_units
       from finance.bet b
       left join lateral (
         select coalesce(sum(s.return_amount-s.real_principal_closed),0)::numeric(16,2) as profit
         from finance.settlement s
         left join finance.settlement_reversal r
           on r.organization_id=s.organization_id and r.settlement_id=s.id
         where s.organization_id=b.organization_id and s.bet_id=b.id and r.settlement_id is null
       ) financial on true
       ${filter}`,
      values,
    )
  ).rows[0]!;
  values.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = (
    await client.query<BetRow>(
      `select b.* from finance.bet b ${filter} order by b.placed_at desc,b.id desc limit $${values.length - 1} offset $${values.length}`,
      values,
    )
  ).rows;
  return {
    items: await betDtos(client, rows),
    total: Number(count.count),
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      count: Number(count.count),
      stake: summary.stake,
      profit: summary.profit,
      stakeUnits: summary.stake_units,
      profitUnits: summary.profit_units,
    },
  };
}
export async function readBetDetail(client: PoolClient, id: string) {
  const rows = (
    await client.query<BetRow>(
      'select * from finance.bet where organization_id=current_setting($$app.organization_id$$, true)::uuid and id=$1',
      [id],
    )
  ).rows;
  if (!rows.length) throw new FinanceError('NOT_FOUND');
  const bet = (await betDtos(client, rows))[0]!;
  const settlements = (
    await client.query<{
      id: string;
      bet_id: string;
      outcome: string;
      closed_principal: string;
      return_amount: string;
      settled_at: Date;
      reversed: boolean;
      reason: string;
    }>(
      'select s.*,r.settlement_id is not null as reversed from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.organization_id=current_setting($$app.organization_id$$, true)::uuid and s.bet_id=$1 order by s.settled_at,s.created_at',
      [id],
    )
  ).rows;
  return {
    bet,
    settlements: settlements.map((row) => ({
      id: row.id,
      betId: row.bet_id,
      outcome: row.outcome,
      closedPrincipal: row.closed_principal,
      returnAmount: row.return_amount,
      settledAt: row.settled_at.toISOString(),
      reversed: row.reversed,
      reason: row.reason,
    })),
  };
}
export async function readJournal(client: PoolClient, query: { page: number; pageSize: number }) {
  const count = (
    await client.query<{ count: string }>(
      'select count(*) from finance.journal where organization_id=current_setting($$app.organization_id$$, true)::uuid',
    )
  ).rows[0]!;
  const rows = (
    await client.query<{
      id: string;
      kind: string;
      effective_at: Date;
      created_at: Date;
      reason: string;
      reversal_of: string | null;
      reversed: boolean;
    }>(
      'select j.*,exists(select 1 from finance.journal r where r.reversal_of=j.id) as reversed from finance.journal j where j.organization_id=current_setting($$app.organization_id$$, true)::uuid order by j.effective_at desc,j.created_at desc,j.id desc limit $1 offset $2',
      [query.pageSize, (query.page - 1) * query.pageSize],
    )
  ).rows;
  const postings = (
    await client.query<{ journal_id: string; account_id: string; name: string; amount: string }>(
      'select p.*,a.name from finance.posting p join finance.account a on a.id=p.account_id where p.organization_id=current_setting($$app.organization_id$$, true)::uuid and p.journal_id=any($1::uuid[]) order by a.kind,a.name',
      [rows.map((row) => row.id)],
    )
  ).rows;
  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      effectiveAt: row.effective_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      reason: row.reason,
      reversalOf: row.reversal_of,
      reversed: row.reversed,
      postings: postings
        .filter((p) => p.journal_id === row.id)
        .map((p) => ({ accountId: p.account_id, accountName: p.name, amount: p.amount })),
    })),
    total: Number(count.count),
    page: query.page,
    pageSize: query.pageSize,
  };
}
