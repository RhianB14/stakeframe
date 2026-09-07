import { createHash } from 'node:crypto';
import { cents, money, type FinanceCommand } from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import { FinanceError, type SettingsRow } from './finance-core.js';
import { applyFinanceCommand } from './finance-commands.js';

// The caller owns the transaction and must already hold finance.settings FOR UPDATE.
export async function executeFinancialCommand(
  client: PoolClient,
  actor: string,
  key: string,
  command: FinanceCommand,
  settings: SettingsRow,
) {
  if (!actor || actor.length > 200 || !/^[a-f0-9-]{36}$/i.test(key))
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  const receipt = (
    await client.query<{
      actor: string;
      hash: string;
      result: { id: string; version: number };
    }>('select actor,hash,result from finance.command_receipt where key=$1', [key])
  ).rows[0];
  if (receipt) {
    if (receipt.actor !== actor || receipt.hash !== hash)
      throw new FinanceError('IDEMPOTENCY_CONFLICT');
    return receipt.result;
  }
  if (settings.version !== command.expectedVersion) throw new FinanceError('VERSION_CONFLICT');
  const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
  const applied = await applyFinanceCommand(client, command, actor, settings, now);
  const balances = (
    await client.query<{ kind: string; amount: string }>(
      'select a.kind,coalesce(sum(p.amount),0)::text as amount from finance.account a left join finance.posting p on p.account_id=a.id group by a.id',
    )
  ).rows;
  for (const balance of balances) money(cents(balance.amount));
  money(
    balances
      .filter((value) => value.kind !== 'counter')
      .reduce((sum, value) => sum + cents(value.amount), 0n),
  );
  const open = (
    await client.query<{ amount: string }>(
      "select coalesce(sum(remaining),0)::text as amount from finance.bet where state='open' and freebet_id is null",
    )
  ).rows[0]!.amount;
  if (cents(open) !== cents(balances.find((value) => value.kind === 'exposure')?.amount ?? '0'))
    throw new FinanceError('INVALID_FINANCIAL_OPERATION');
  const result = { id: applied.id, version: settings.version + 1 };
  await client.query('update finance.settings set version=$1 where id=1', [result.version]);
  await client.query(
    'insert into finance.audit(type,actor,entity_id,before,after) values($1,$2,$3,$4,$5)',
    [
      command.type,
      actor,
      result.id,
      applied.before === null ? null : JSON.stringify(applied.before),
      JSON.stringify({ command, result }),
    ],
  );
  await client.query(
    'insert into finance.command_receipt(key,actor,hash,result) values($1,$2,$3,$4)',
    [key, actor, hash, JSON.stringify(result)],
  );
  return result;
}
