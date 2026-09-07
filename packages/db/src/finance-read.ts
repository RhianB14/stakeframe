import {
  cents,
  money,
  saoPauloDate,
  unitsFor,
  workspaceSchema,
  betSchema,
  type BetQuery,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { FinanceError, type BetRow, type SettingsRow } from './finance-core.js';

export async function readWorkspace(client: PoolClient) {
  const settings = (await client.query<SettingsRow>('select * from finance.settings where id=1'))
    .rows[0]!;
  const accounts = (
    await client.query<{
      id: string;
      kind: string;
      name: string;
      bookmaker_id: string | null;
      balance: string;
    }>(
      'select a.*,coalesce(sum(p.amount),0)::numeric(16,2)::text as balance from finance.account a left join finance.posting p on p.account_id=a.id group by a.id order by a.kind,a.name',
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
      'select c.*,coalesce(array_agg(a.label order by a.label) filter(where a.alias is not null),array[]::text[]) as aliases from finance.catalog c left join finance.catalog_alias a on a.catalog_id=c.id group by c.id order by c.kind,c.name',
    )
  ).rows;
  const units = (
    await client.query(
      'select month,amount,base,percent,source from finance.monthly_unit order by month desc limit 120',
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
      'select *, expires_on::text as expires_on from finance.freebet order by created_at desc limit 1000',
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

async function betDtos(client: PoolClient, rows: BetRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const selections = (
    await client.query<{
      bet_id: string;
      event: string;
      sport: string | null;
      market: string;
      selection: string;
      odds: string | null;
      event_date: string | null;
      event_at: Date | null;
      date_status: string;
    }>(
      'select *, event_date::text as event_date from finance.selection where bet_id=any($1::uuid[]) order by bet_id,position',
      [ids],
    )
  ).rows;
  const totals = (
    await client.query<{ bet_id: string; returns: string; profit: string }>(
      'select s.bet_id,coalesce(sum(s.return_amount),0)::numeric(16,2)::text as returns,coalesce(sum(s.return_amount-s.real_principal_closed),0)::numeric(16,2)::text as profit from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.bet_id=any($1::uuid[]) and r.settlement_id is null group by s.bet_id',
      [ids],
    )
  ).rows;
  return rows.map((row) => {
    const total = totals.find((value) => value.bet_id === row.id);
    return betSchema.parse({
      id: row.id,
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
      remaining: row.remaining,
      unitMonth: row.unit_month,
      unitAmount: row.unit_amount,
      stakeUnits: unitsFor(row.stake, row.unit_amount),
      returnAmount: total?.returns ?? '0.00',
      profit: total?.profit ?? '0.00',
      selections: selections
        .filter((value) => value.bet_id === row.id)
        .map((selection) => ({
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
  const clauses: string[] = [];
  const where = (expression: string, value: unknown) => {
    values.push(value);
    clauses.push(expression.replace('?', `$${values.length}`));
  };
  if (query.state) where('state=?', query.state);
  if (query.bookmakerId) where('bookmaker_id=?', query.bookmakerId);
  if (query.tipsterId) where('tipster_id=?', query.tipsterId);
  if (query.from) where("(placed_at at time zone 'America/Sao_Paulo')::date>=?::date", query.from);
  if (query.to) where("(placed_at at time zone 'America/Sao_Paulo')::date<=?::date", query.to);
  const filter = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const count = (
    await client.query<{ count: string }>(`select count(*) from finance.bet ${filter}`, values)
  ).rows[0]!;
  values.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = (
    await client.query<BetRow>(
      `select * from finance.bet ${filter} order by placed_at desc,id desc limit $${values.length - 1} offset $${values.length}`,
      values,
    )
  ).rows;
  return {
    items: await betDtos(client, rows),
    total: Number(count.count),
    page: query.page,
    pageSize: query.pageSize,
  };
}
export async function readBetDetail(client: PoolClient, id: string) {
  const rows = (await client.query<BetRow>('select * from finance.bet where id=$1', [id])).rows;
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
      'select s.*,r.settlement_id is not null as reversed from finance.settlement s left join finance.settlement_reversal r on r.settlement_id=s.id where s.bet_id=$1 order by s.settled_at,s.created_at',
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
  const count = (await client.query<{ count: string }>('select count(*) from finance.journal'))
    .rows[0]!;
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
      'select j.*,exists(select 1 from finance.journal r where r.reversal_of=j.id) as reversed from finance.journal j order by j.effective_at desc,j.created_at desc,j.id desc limit $1 offset $2',
      [query.pageSize, (query.page - 1) * query.pageSize],
    )
  ).rows;
  const postings = (
    await client.query<{ journal_id: string; account_id: string; name: string; amount: string }>(
      'select p.*,a.name from finance.posting p join finance.account a on a.id=p.account_id where p.journal_id=any($1::uuid[]) order by a.kind,a.name',
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
