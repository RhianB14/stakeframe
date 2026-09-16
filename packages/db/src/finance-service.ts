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
import {
  createTenantContext,
  type OrganizationContext,
  type WithOrganizationTransactionOptions,
} from './tenant-context.js';
export { FinanceError } from './finance-core.js';

/** The organization-scoped settings lock: PK lookup, resolved from the authenticated context. */
const LOCK_SETTINGS_SQL = `select * from finance.settings
  where organization_id=current_setting('app.organization_id', true)::uuid for update`;

export function createFinanceService(database: Database) {
  const tenant = createTenantContext(database);
  const read = <T>(
    context: OrganizationContext,
    action: (client: PoolClient) => Promise<T>,
    options: WithOrganizationTransactionOptions = { isolation: 'repeatable read' },
  ) => tenant.withOrganizationTransaction(context, action, options);
  async function ensureCurrentUnit(context: OrganizationContext) {
    return tenant.withOrganizationTransaction(context, async (client) => {
      const settings = (await client.query<SettingsRow>(LOCK_SETTINGS_SQL)).rows[0]!;
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
          await client.query(
            "update finance.settings set version=version+1 where organization_id=current_setting('app.organization_id', true)::uuid",
          );
          await client.query(
            "insert into finance.audit(type,actor,entity_id,after) values('unit.automatic','system',$1,$2)",
            [month, JSON.stringify({ base, percent: settings.unit_percent })],
          );
        }
      }
    });
  }
  return {
    /** Returns the authenticated user's organization context (provisioning on first use). */
    ensureContext(userId: string) {
      return tenant.ensureOrganizationMembership(userId);
    },
    ensureCurrentUnit,
    async workspace(context: OrganizationContext) {
      await ensureCurrentUnit(context);
      return read(context, readWorkspace);
    },
    bets(context: OrganizationContext, query: BetQuery) {
      return read(context, (client) => readBets(client, query));
    },
    bet(context: OrganizationContext, id: string) {
      return read(context, (client) => readBetDetail(client, id));
    },
    journal(context: OrganizationContext, query: { page: number; pageSize: number }) {
      return read(context, (client) => readJournal(client, query));
    },
    async command(context: OrganizationContext, key: string, input: FinanceCommand) {
      const command = financeCommandSchema.parse(input);
      const actor = context.userId;
      await ensureCurrentUnit(context);
      if (!actor || actor.length > 200 || !/^[a-f0-9-]{36}$/i.test(key))
        throw new FinanceError('INVALID_FINANCIAL_OPERATION');
      return tenant.withOrganizationTransaction(context, async (client) => {
        try {
          const settings = (await client.query<SettingsRow>(LOCK_SETTINGS_SQL)).rows[0]!;
          return await executeFinancialCommand(client, actor, key, command, settings);
        } catch (error) {
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
        }
      });
    },
  };
}
export type FinanceService = ReturnType<typeof createFinanceService>;
