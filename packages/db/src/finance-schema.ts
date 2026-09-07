import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const finance = pgSchema('finance');
const money = (name: string) => numeric(name, { precision: 16, scale: 2 });
const instant = (name: string) => timestamp(name, { withTimezone: true });

export const settings = finance.table(
  'settings',
  {
    id: integer('id').primaryKey().default(1),
    version: integer('version').notNull().default(1),
    initialized: boolean('initialized').notNull().default(false),
    unitPercent: numeric('unit_percent', { precision: 6, scale: 2 }).notNull().default('1.00'),
    openedAt: instant('opened_at'),
  },
  (t) => [
    check('settings_singleton', sql`${t.id}=1`),
    check('settings_percent_range', sql`${t.unitPercent}>0 and ${t.unitPercent}<=100`),
  ],
);

export const catalog = finance.table(
  'catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [check('catalog_kind', sql`${t.kind} in ('bookmaker','tipster')`)],
);
export const catalogAlias = finance.table(
  'catalog_alias',
  {
    kind: text('kind').notNull(),
    alias: text('alias').notNull(),
    label: text('label').notNull(),
    catalogId: uuid('catalog_id')
      .notNull()
      .references(() => catalog.id),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.alias] }),
    index('catalog_alias_catalog_idx').on(t.catalogId),
  ],
);

export const financialAccount = finance.table(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    bookmakerId: uuid('bookmaker_id').references(() => catalog.id),
  },
  (t) => [
    uniqueIndex('account_bookmaker_idx').on(t.bookmakerId),
    uniqueIndex('account_system_kind_idx')
      .on(t.kind)
      .where(sql`${t.kind}<>'bookmaker'`),
    check('account_kind', sql`${t.kind} in ('reserve','bookmaker','exposure','counter')`),
    check(
      'account_bookmaker_required',
      sql`(${t.kind}='bookmaker')=(${t.bookmakerId} is not null)`,
    ),
  ],
);

export const journal = finance.table(
  'journal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    effectiveAt: instant('effective_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    reversalOf: uuid('reversal_of').references((): AnyPgColumn => journal.id),
    creationTransaction: text('creation_transaction')
      .notNull()
      .default(sql`pg_current_xact_id()::text`),
  },
  (t) => [
    uniqueIndex('journal_reversal_once_idx').on(t.reversalOf),
    index('journal_effective_idx').on(t.effectiveAt, t.id),
  ],
);
export const posting = finance.table(
  'posting',
  {
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journal.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => financialAccount.id),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.journalId, t.accountId] }),
    index('posting_account_idx').on(t.accountId),
    check('posting_nonzero', sql`${t.amount}<>0`),
  ],
);

export const monthlyUnit = finance.table(
  'monthly_unit',
  {
    month: text('month').primaryKey(),
    amount: money('amount').notNull(),
    base: money('base').notNull(),
    percent: numeric('percent', { precision: 6, scale: 2 }).notNull(),
    source: text('source').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('monthly_unit_nonnegative', sql`${t.amount}>=0`),
    check('monthly_unit_source', sql`${t.source} in ('initial','automatic','manual')`),
  ],
);

export const freebet = finance.table(
  'freebet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookmakerId: uuid('bookmaker_id')
      .notNull()
      .references(() => catalog.id),
    amount: money('amount').notNull(),
    expiresOn: date('expires_on').notNull(),
    stakeReturned: boolean('stake_returned').notNull().default(false),
    usedBy: uuid('used_by').references((): AnyPgColumn => bet.id),
    note: text('note').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('freebet_positive', sql`${t.amount}>0`),
    index('freebet_bookmaker_idx').on(t.bookmakerId),
    uniqueIndex('freebet_used_by_idx').on(t.usedBy),
  ],
);

export const bet = finance.table(
  'bet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookmakerId: uuid('bookmaker_id')
      .notNull()
      .references(() => catalog.id),
    tipsterId: uuid('tipster_id').references(() => catalog.id),
    stake: money('stake').notNull(),
    odds: numeric('odds', { precision: 10, scale: 4 }).notNull(),
    placedAt: instant('placed_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    freebetId: uuid('freebet_id').references((): AnyPgColumn => freebet.id),
    promotionalStakeReturned: boolean('promotional_stake_returned').notNull().default(false),
    reference: text('reference').notNull(),
    state: text('state').notNull().default('open'),
    remaining: money('remaining').notNull(),
    unitMonth: text('unit_month').references(() => monthlyUnit.month),
    unitAmount: money('unit_amount'),
    stakeJournalId: uuid('stake_journal_id')
      .notNull()
      .references(() => journal.id),
  },
  (t) => [
    index('bet_state_placed_idx').on(t.state, t.placedAt, t.id),
    index('bet_bookmaker_idx').on(t.bookmakerId),
    index('bet_tipster_idx').on(t.tipsterId),
    index('bet_freebet_idx').on(t.freebetId),
    index('bet_unit_idx').on(t.unitMonth),
    index('bet_stake_journal_idx').on(t.stakeJournalId),
    check('bet_positive_stake', sql`${t.stake}>0 and ${t.odds}>=1`),
    check('bet_remaining_bounds', sql`${t.remaining}>=0 and ${t.remaining}<=${t.stake}`),
    check('bet_state', sql`${t.state} in ('open','settled','cancelled')`),
  ],
);

export const betSelection = finance.table(
  'selection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id')
      .notNull()
      .references(() => bet.id),
    position: integer('position').notNull(),
    event: text('event').notNull(),
    sport: text('sport'),
    market: text('market').notNull(),
    selection: text('selection').notNull(),
    odds: numeric('odds', { precision: 10, scale: 4 }),
    eventDate: date('event_date'),
    eventAt: instant('event_at'),
    dateStatus: text('date_status').notNull(),
  },
  (t) => [
    uniqueIndex('selection_bet_position_idx').on(t.betId, t.position),
    index('selection_event_date_idx').on(t.eventDate),
    check('selection_date_status', sql`${t.dateStatus} in ('confirmed','estimated','pending')`),
  ],
);

export const settlement = finance.table(
  'settlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    betId: uuid('bet_id')
      .notNull()
      .references(() => bet.id),
    outcome: text('outcome').notNull(),
    closedPrincipal: money('closed_principal').notNull(),
    realPrincipalClosed: money('real_principal_closed').notNull(),
    returnAmount: money('return_amount').notNull(),
    settledAt: instant('settled_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journal.id),
    reason: text('reason').notNull(),
  },
  (t) => [
    index('settlement_bet_idx').on(t.betId),
    index('settlement_journal_idx').on(t.journalId),
    check(
      'settlement_amounts',
      sql`${t.closedPrincipal}>0 and ${t.realPrincipalClosed}>=0 and ${t.returnAmount}>=0`,
    ),
    check(
      'settlement_outcome',
      sql`${t.outcome} in ('win','loss','void','half_win','half_loss','cashout','partial_cashout')`,
    ),
  ],
);
export const settlementReversal = finance.table(
  'settlement_reversal',
  {
    settlementId: uuid('settlement_id')
      .primaryKey()
      .references(() => settlement.id),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journal.id),
  },
  (t) => [index('settlement_reversal_journal_idx').on(t.journalId)],
);

export const financialAudit = finance.table(
  'audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entityId, t.createdAt)],
);
export const commandReceipt = finance.table('command_receipt', {
  key: uuid('key').primaryKey(),
  actor: text('actor').notNull(),
  hash: text('hash').notNull(),
  result: jsonb('result').notNull(),
  createdAt: instant('created_at').notNull().defaultNow(),
});
