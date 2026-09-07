import { randomUUID } from 'node:crypto';
import { cents, money, roundedDivide, saoPauloDate, type SelectionInput } from '@stakeframe/shared';
import type { PoolClient } from 'pg';

export class FinanceError extends Error {
  constructor(
    public readonly code:
      | 'STATE_CONFLICT'
      | 'VERSION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INVALID_FINANCIAL_OPERATION'
      | 'UNIT_REQUIRED'
      | 'NOT_INITIALIZED'
      | 'ALIAS_CONFLICT'
      | 'NOT_FOUND',
  ) {
    super(code);
    this.name = 'FinanceError';
  }
}
export type SettingsRow = {
  version: number;
  initialized: boolean;
  unit_percent: string;
  opened_at: Date | null;
};
export type BetRow = {
  id: string;
  bookmaker_id: string;
  tipster_id: string | null;
  stake: string;
  odds: string;
  placed_at: Date;
  created_at: Date;
  freebet_id: string | null;
  promotional_stake_returned: boolean;
  reference: string;
  state: 'open' | 'settled' | 'cancelled';
  remaining: string;
  unit_month: string | null;
  unit_amount: string | null;
  stake_journal_id: string;
};
export type AccountRow = {
  id: string;
  kind: 'reserve' | 'bookmaker' | 'exposure' | 'counter';
  name: string;
  bookmaker_id: string | null;
};

export async function accountByKind(
  client: PoolClient,
  kind: AccountRow['kind'],
  bookmakerId?: string,
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    'select * from finance.account where kind=$1 and ($2::uuid is null or bookmaker_id=$2)',
    [kind, bookmakerId ?? null],
  );
  if (result.rowCount !== 1) throw new FinanceError('NOT_FOUND');
  return result.rows[0]!;
}
export async function cashAccount(client: PoolClient, id: string) {
  const result = await client.query<AccountRow>(
    "select * from finance.account where id=$1 and kind in ('reserve','bookmaker')",
    [id],
  );
  if (!result.rows[0]) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  return result.rows[0];
}
export async function accountBalance(client: PoolClient, id: string, at?: Date) {
  const result = await client.query<{ balance: string }>(
    'select coalesce(sum(p.amount),0)::numeric(16,2)::text as balance from finance.posting p join finance.journal j on j.id=p.journal_id where p.account_id=$1 and ($2::timestamptz is null or j.effective_at<=$2)',
    [id, at ?? null],
  );
  return cents(result.rows[0]!.balance);
}
export async function activeCatalog(client: PoolClient, id: string, kind: 'bookmaker' | 'tipster') {
  const result = await client.query(
    'select id from finance.catalog where id=$1 and kind=$2 and active',
    [id, kind],
  );
  if (!result.rowCount) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
}
export function normalizeAlias(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');
}
export async function replaceAliases(
  client: PoolClient,
  id: string,
  kind: string,
  name: string,
  aliases: string[],
) {
  const unique = new Map([name, ...aliases].map((label) => [normalizeAlias(label), label]));
  for (const alias of unique.keys()) {
    const existing = await client.query(
      'select catalog_id from finance.catalog_alias where kind=$1 and alias=$2 and catalog_id<>$3',
      [kind, alias, id],
    );
    if (existing.rowCount) throw new FinanceError('ALIAS_CONFLICT');
  }
  await client.query('delete from finance.catalog_alias where catalog_id=$1', [id]);
  for (const [alias, label] of unique)
    await client.query(
      'insert into finance.catalog_alias(kind,alias,label,catalog_id) values($1,$2,$3,$4)',
      [kind, alias, label, id],
    );
}
export function verifyPast(value: string, now: Date) {
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getTime() > now.getTime() + 60_000 ||
    date.getUTCFullYear() < 2000
  )
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  return date;
}
export async function writeJournal(
  client: PoolClient,
  args: {
    kind: string;
    effectiveAt: Date;
    actor: string;
    reason: string;
    postings: { accountId: string; amount: bigint }[];
    reversalOf?: string;
  },
) {
  const amounts = new Map<string, bigint>();
  for (const posting of args.postings)
    amounts.set(posting.accountId, (amounts.get(posting.accountId) ?? 0n) + posting.amount);
  if ([...amounts.values()].reduce((sum, amount) => sum + amount, 0n) !== 0n)
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const id = randomUUID();
  await client.query(
    'insert into finance.journal(id,kind,effective_at,actor,reason,reversal_of) values($1,$2,$3,$4,$5,$6)',
    [id, args.kind, args.effectiveAt, args.actor, args.reason, args.reversalOf ?? null],
  );
  for (const [accountId, amount] of amounts)
    if (amount !== 0n)
      await client.query(
        'insert into finance.posting(journal_id,account_id,amount) values($1,$2,$3)',
        [id, accountId, money(amount)],
      );
  return id;
}
export async function reverseJournal(
  client: PoolClient,
  id: string,
  effectiveAt: Date,
  actor: string,
  reason: string,
) {
  const original = (
    await client.query<{ effective_at: Date }>(
      'select effective_at from finance.journal where id=$1',
      [id],
    )
  ).rows[0];
  if (!original) throw new FinanceError('NOT_FOUND');
  if (effectiveAt < original.effective_at) throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const existing = await client.query('select id from finance.journal where reversal_of=$1', [id]);
  if (existing.rowCount) throw new FinanceError('STATE_CONFLICT');
  const postings = await client.query<{ account_id: string; amount: string }>(
    'select account_id,amount from finance.posting where journal_id=$1',
    [id],
  );
  return writeJournal(client, {
    kind: 'reversal',
    effectiveAt,
    actor,
    reason,
    reversalOf: id,
    postings: postings.rows.map((row) => ({
      accountId: row.account_id,
      amount: -cents(row.amount),
    })),
  });
}
export async function saveSelections(
  client: PoolClient,
  betId: string,
  selections: SelectionInput[],
) {
  for (const selection of selections) {
    if (
      (!selection.eventDate && !selection.eventAt && selection.dateStatus !== 'pending') ||
      ((selection.eventDate || selection.eventAt) && selection.dateStatus === 'pending') ||
      (selection.eventAt &&
        selection.eventDate &&
        saoPauloDate(new Date(selection.eventAt)) !== selection.eventDate)
    )
      throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  }
  await client.query('delete from finance.selection where bet_id=$1', [betId]);
  for (const [position, selection] of selections.entries())
    await client.query(
      'insert into finance.selection(bet_id,position,event,sport,market,selection,odds,event_date,event_at,date_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        betId,
        position,
        selection.event,
        selection.sport,
        selection.market,
        selection.selection,
        selection.odds,
        selection.eventDate ??
          (selection.eventAt ? saoPauloDate(new Date(selection.eventAt)) : null),
        selection.eventAt,
        selection.dateStatus,
      ],
    );
}
export async function getBetRow(client: PoolClient, id: string) {
  const row = (await client.query<BetRow>('select * from finance.bet where id=$1 for update', [id]))
    .rows[0];
  if (!row) throw new FinanceError('NOT_FOUND');
  return row;
}
export async function insertUnit(
  client: PoolClient,
  month: string,
  base: bigint,
  percent: string,
  source: 'initial' | 'automatic' | 'manual',
  manual?: string,
) {
  const amount = manual ?? money(base > 0n ? roundedDivide(base * cents(percent), 10_000n) : 0n);
  await client.query(
    'insert into finance.monthly_unit(month,amount,base,percent,source) values($1,$2,$3,$4,$5)',
    [month, amount, money(base), percent, source],
  );
}
