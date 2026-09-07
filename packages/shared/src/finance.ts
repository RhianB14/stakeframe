import { z } from 'zod';
import { cents, oddsInteger } from './decimal.js';

export const moneySchema = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export const signedMoneySchema = z.string().regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export const positiveMoneySchema = moneySchema.refine((value) => {
  try {
    return cents(value) > 0n;
  } catch {
    return false;
  }
}, 'Informe um valor maior que zero.');
export const oddsSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})(\.\d{1,4})?$/)
  .refine((value) => {
    try {
      oddsInteger(value);
      return true;
    } catch {
      return false;
    }
  }, 'Odd fora do intervalo permitido.');
const label = z.string().trim().min(1).max(100);
const note = z.string().trim().min(3).max(500);
const instant = z.iso.datetime({ offset: true });
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const version = z.number().int().positive().max(2_147_483_646);
export const catalogKindSchema = z.enum(['bookmaker', 'tipster']);
export const outcomeSchema = z.enum([
  'win',
  'loss',
  'void',
  'half_win',
  'half_loss',
  'cashout',
  'partial_cashout',
]);

export const selectionInputSchema = z.strictObject({
  event: z.string().trim().min(1).max(300),
  sport: label.nullable(),
  market: z.string().trim().min(1).max(300),
  selection: z.string().trim().min(1).max(300),
  odds: oddsSchema.nullable(),
  eventDate: z.iso.date().nullable(),
  eventAt: instant.nullable(),
  dateStatus: z.enum(['confirmed', 'estimated', 'pending']),
});
const command = z.strictObject({ expectedVersion: version });
export const financeCommandSchema = z
  .discriminatedUnion('type', [
    command.extend({
      type: z.literal('catalog.create'),
      kind: catalogKindSchema,
      name: label,
      aliases: z.array(label).max(20),
    }),
    command.extend({
      type: z.literal('catalog.update'),
      id: z.uuid(),
      name: label,
      aliases: z.array(label).max(20),
      active: z.boolean(),
    }),
    command.extend({
      type: z.literal('bankroll.initialize'),
      reserve: moneySchema,
      balances: z.array(z.strictObject({ bookmakerId: z.uuid(), amount: moneySchema })).max(100),
      unitPercent: positiveMoneySchema,
    }),
    command.extend({
      type: z.literal('money.move'),
      kind: z.enum(['deposit', 'withdrawal', 'transfer', 'reconcile']),
      accountId: z.uuid(),
      targetAccountId: z.uuid().nullable(),
      amount: signedMoneySchema,
      effectiveAt: instant,
      reason: note,
    }),
    command.extend({
      type: z.literal('journal.reverse'),
      id: z.uuid(),
      effectiveAt: instant,
      reason: note,
    }),
    command.extend({
      type: z.literal('unit.set'),
      month: monthSchema,
      amount: positiveMoneySchema,
      reason: note,
    }),
    command.extend({ type: z.literal('settings.update'), unitPercent: positiveMoneySchema }),
    command.extend({
      type: z.literal('freebet.create'),
      bookmakerId: z.uuid(),
      amount: positiveMoneySchema,
      expiresOn: z.iso.date(),
      stakeReturned: z.boolean(),
      note: z.string().max(500),
    }),
    command.extend({
      type: z.literal('bet.create'),
      bookmakerId: z.uuid(),
      tipsterId: z.uuid().nullable(),
      stake: positiveMoneySchema,
      odds: oddsSchema,
      placedAt: instant,
      freebetId: z.uuid().nullable(),
      reference: z.string().trim().max(150),
      selections: z.array(selectionInputSchema).min(1).max(40),
      allowMissingUnit: z.boolean(),
    }),
    command.extend({
      type: z.literal('bet.update'),
      id: z.uuid(),
      tipsterId: z.uuid().nullable(),
      reference: z.string().trim().max(150),
      selections: z.array(selectionInputSchema).min(1).max(40),
      reason: note,
    }),
    command.extend({
      type: z.literal('bet.cancel'),
      id: z.uuid(),
      effectiveAt: instant,
      reason: note,
    }),
    command.extend({
      type: z.literal('bet.settle'),
      id: z.uuid(),
      outcome: outcomeSchema,
      closedPrincipal: positiveMoneySchema,
      returnAmount: moneySchema,
      settledAt: instant,
      reason: note,
    }),
    command.extend({
      type: z.literal('settlement.reverse'),
      id: z.uuid(),
      effectiveAt: instant,
      reason: note,
    }),
  ])
  .meta({ id: 'FinanceCommand' });
export type FinanceCommand = z.infer<typeof financeCommandSchema>;
export type SelectionInput = z.infer<typeof selectionInputSchema>;
export const commandHeadersSchema = z.object({ 'idempotency-key': z.uuid() });
export const commandResultSchema = z
  .object({ id: z.string(), version })
  .meta({ id: 'CommandResult' });

export const catalogSchema = z.object({
  id: z.uuid(),
  kind: catalogKindSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  active: z.boolean(),
});
export const accountSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['reserve', 'bookmaker']),
  name: z.string(),
  bookmakerId: z.uuid().nullable(),
  balance: signedMoneySchema,
});
export const unitSchema = z.object({
  month: monthSchema,
  amount: moneySchema,
  base: signedMoneySchema,
  percent: moneySchema,
  source: z.enum(['initial', 'automatic', 'manual']),
});
export const freebetSchema = z.object({
  id: z.uuid(),
  bookmakerId: z.uuid(),
  amount: moneySchema,
  expiresOn: z.iso.date(),
  stakeReturned: z.boolean(),
  usedBy: z.uuid().nullable(),
  note: z.string(),
});
export const workspaceSchema = z
  .object({
    version,
    initialized: z.boolean(),
    unitPercent: moneySchema,
    bankroll: signedMoneySchema,
    available: signedMoneySchema,
    exposure: signedMoneySchema,
    accounts: z.array(accountSchema),
    catalog: z.array(catalogSchema),
    units: z.array(unitSchema),
    freebets: z.array(freebetSchema),
    warnings: z.array(z.enum(['NEGATIVE_BALANCE', 'UNIT_PENDING'])),
  })
  .meta({ id: 'Workspace' });
export type Workspace = z.infer<typeof workspaceSchema>;
export type CatalogItem = z.infer<typeof catalogSchema>;

export const betSchema = z
  .object({
    id: z.uuid(),
    bookmakerId: z.uuid(),
    tipsterId: z.uuid().nullable(),
    stake: moneySchema,
    odds: oddsSchema,
    placedAt: instant,
    createdAt: instant,
    freebetId: z.uuid().nullable(),
    reference: z.string(),
    freebetStakeReturned: z.boolean().nullable(),
    state: z.enum(['open', 'settled', 'cancelled']),
    remaining: moneySchema,
    unitMonth: monthSchema.nullable(),
    unitAmount: moneySchema.nullable(),
    stakeUnits: z.string().nullable(),
    returnAmount: moneySchema,
    profit: signedMoneySchema,
    selections: z.array(selectionInputSchema),
  })
  .meta({ id: 'Bet' });
export type Bet = z.infer<typeof betSchema>;
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const betQuerySchema = pageQuerySchema.extend({
  state: z.enum(['open', 'settled', 'cancelled']).optional(),
  bookmakerId: z.uuid().optional(),
  tipsterId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type BetQuery = z.infer<typeof betQuerySchema>;
export const betPageSchema = z
  .object({
    items: z.array(betSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'BetPage' });
export const settlementSchema = z.object({
  id: z.uuid(),
  betId: z.uuid(),
  outcome: outcomeSchema,
  closedPrincipal: moneySchema,
  returnAmount: moneySchema,
  settledAt: instant,
  reversed: z.boolean(),
  reason: z.string(),
});
export const betDetailSchema = z
  .object({ bet: betSchema, settlements: z.array(settlementSchema) })
  .meta({ id: 'BetDetail' });
export const journalSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  effectiveAt: instant,
  createdAt: instant,
  reason: z.string(),
  reversalOf: z.uuid().nullable(),
  reversed: z.boolean(),
  postings: z.array(
    z.object({ accountId: z.uuid(), accountName: z.string(), amount: signedMoneySchema }),
  ),
});
export const journalPageSchema = z
  .object({
    items: z.array(journalSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'JournalPage' });
