import {
  cents,
  saoPauloDate,
  financeCommandSchema,
  type FinanceCommand,
  type BetQuery,
} from '@stakeframe/shared';
import type { PoolClient } from 'pg';
import type { Database } from './index.js';
import { FinanceError, insertUnit, type SettingsRow } from './finance-core.js';
import { executeFinancialCommand } from './finance-transaction.js';
import { readWorkspace, readBets, readBetDetail, readJournal } from './finance-read.js';
export { FinanceError } from './finance-core.js';

export function createFinanceService(database: Database) {
  async function read<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await database.pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const value = await action(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async function ensureCurrentUnit() {
    const client = await database.pool.connect();
    try {
      await client.query('begin');
      const settings = (
        await client.query<SettingsRow>('select * from finance.settings where id=1 for update')
      ).rows[0]!;
      if (settings.initialized) {
        const now = (await client.query<{ now: Date }>('select now()')).rows[0]!.now;
        const month = saoPauloDate(now).slice(0, 7);
        if (
          !(await client.query('select month from finance.monthly_unit where month=$1', [month]))
            .rowCount
        ) {
          // PostgreSQL resolves the calendar boundary using the IANA zone, including historical DST.
          // Late backdated entries never change a frozen unit or pretend to have existed at rollover.
          const base = (
            await client.query<{ amount: string }>(
              "select coalesce(sum(p.amount),0)::numeric(16,2)::text as amount from finance.posting p join finance.account a on a.id=p.account_id join finance.journal j on j.id=p.journal_id where a.kind<>'counter' and j.effective_at < ($1::date::timestamp at time zone 'America/Sao_Paulo') and j.created_at < ($1::date::timestamp at time zone 'America/Sao_Paulo')",
              [`${month}-01`],
            )
          ).rows[0]!.amount;
          await insertUnit(client, month, cents(base), settings.unit_percent, 'automatic');
          await client.query('update finance.settings set version=version+1 where id=1');
          await client.query(
            "insert into finance.audit(type,actor,entity_id,after) values('unit.automatic','system',$1,$2)",
            [month, JSON.stringify({ base, percent: settings.unit_percent })],
          );
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    ensureCurrentUnit,
    async workspace() {
      await ensureCurrentUnit();
      return read(readWorkspace);
    },
    bets(query: BetQuery) {
      return read((client) => readBets(client, query));
    },
    bet(id: string) {
      return read((client) => readBetDetail(client, id));
    },
    journal(query: { page: number; pageSize: number }) {
      return read((client) => readJournal(client, query));
    },
    async command(actor: string, key: string, input: FinanceCommand) {
      const command = financeCommandSchema.parse(input);
      await ensureCurrentUnit();
      if (!actor || actor.length > 200 || !/^[a-f0-9-]{36}$/i.test(key))
        throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      const client = await database.pool.connect();
      try {
        await client.query('begin');
        const settings = (
          await client.query<SettingsRow>('select * from finance.settings where id=1 for update')
        ).rows[0]!;
        const result = await executeFinancialCommand(client, actor, key, command, settings);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        if (error instanceof FinanceError) throw error;
        if (
          error instanceof Error &&
          ['INVALID_MONEY', 'MONEY_OUT_OF_RANGE', 'INVALID_ODDS'].includes(error.message)
        )
          throw new FinanceError('INVALID_FINANCIAL_OPERATION');
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['23505', '23514', '23503'].includes(String(error.code))
        )
          throw new FinanceError('STATE_CONFLICT');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export type FinanceService = ReturnType<typeof createFinanceService>;
