import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './core-schema.js';

export const finance = pgSchema('finance');
const money = (name: string) => numeric(name, { precision: 16, scale: 2 });
const instant = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Multi-tenant isolation (STK-F1-13): every private financial table carries its organization.
 * The DEFAULT reads the transaction-local setting (`app.organization_id`, set by
 * `withOrganizationTransaction`), so unqualified INSERTs inherit the authenticated organization
 * and any statement executed without context fails closed (NULL violates NOT NULL).
 */
const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .default(sql`current_setting('app.organization_id', true)::uuid`);

/**
 * Composite target for organization-scoped foreign keys: references are (organization_id, id)
 * pairs, so a row can never point at another organization's record even if it presents a valid
 * foreign id (defense in depth over the row-level security policies).
 */

export const settings = finance.table(
  'settings',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    organizationId: uuid('organization_id')
      .notNull()
      .unique()
      .references(() => organization.id),
    version: integer('version').notNull().default(1),
    initialized: boolean('initialized').notNull().default(false),
    unitPercent: numeric('unit_percent', { precision: 6, scale: 2 }).notNull().default('1.00'),
    openedAt: instant('opened_at'),
  },
  (t) => [check('settings_percent_range', sql`${t.unitPercent}>0 and ${t.unitPercent}<=100`)],
);

export const catalog = finance.table(
  'catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('catalog_kind', sql`${t.kind} in ('bookmaker','tipster')`),
    unique('catalog_organization_id_id_idx').on(t.organizationId, t.id),
  ],
);
export const catalogAlias = finance.table(
  'catalog_alias',
  {
    organizationId: organizationId(),
    kind: text('kind').notNull(),
    alias: text('alias').notNull(),
    label: text('label').notNull(),
    catalogId: uuid('catalog_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.kind, t.alias] }),
    index('catalog_alias_catalog_idx').on(t.catalogId),
    foreignKey({
      name: 'catalog_alias_catalog_fk',
      columns: [t.organizationId, t.catalogId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
  ],
);

export const financialAccount = finance.table(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    bookmakerId: uuid('bookmaker_id'),
  },
  (t) => [
    unique('account_organization_id_id_idx').on(t.organizationId, t.id),
    uniqueIndex('account_bookmaker_idx').on(t.organizationId, t.bookmakerId),
    uniqueIndex('account_system_kind_idx')
      .on(t.organizationId, t.kind)
      .where(sql`${t.kind}<>'bookmaker'`),
    check('account_kind', sql`${t.kind} in ('reserve','bookmaker','exposure','counter')`),
    check(
      'account_bookmaker_required',
      sql`(${t.kind}='bookmaker')=(${t.bookmakerId} is not null)`,
    ),
    foreignKey({
      name: 'account_bookmaker_fk',
      columns: [t.organizationId, t.bookmakerId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
  ],
);

export const journal = finance.table(
  'journal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    kind: text('kind').notNull(),
    effectiveAt: instant('effective_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    reversalOf: uuid('reversal_of'),
    creationTransaction: text('creation_transaction')
      .notNull()
      .default(sql`pg_current_xact_id()::text`),
  },
  (t) => [
    unique('journal_organization_id_id_idx').on(t.organizationId, t.id),
    uniqueIndex('journal_reversal_once_idx').on(t.organizationId, t.reversalOf),
    index('journal_effective_idx').on(t.effectiveAt, t.id),
    foreignKey({
      name: 'journal_reversal_fk',
      columns: [t.organizationId, t.reversalOf],
      foreignColumns: [t.organizationId, t.id],
    }),
  ],
);
export const posting = finance.table(
  'posting',
  {
    journalId: uuid('journal_id').notNull(),
    accountId: uuid('account_id').notNull(),
    organizationId: organizationId(),
    amount: money('amount').notNull(),
  },
  (t) => [
    // Business columns first: the deferred balanced/same-transaction triggers scan by
    // journal_id on every posting, and the organization is also carried explicitly.
    primaryKey({ columns: [t.journalId, t.accountId, t.organizationId] }),
    index('posting_account_idx').on(t.accountId),
    check('posting_nonzero', sql`${t.amount}<>0`),
    foreignKey({
      name: 'posting_journal_fk',
      columns: [t.organizationId, t.journalId],
      foreignColumns: [journal.organizationId, journal.id],
    }),
    foreignKey({
      name: 'posting_account_fk',
      columns: [t.organizationId, t.accountId],
      foreignColumns: [financialAccount.organizationId, financialAccount.id],
    }),
  ],
);

export const monthlyUnit = finance.table(
  'monthly_unit',
  {
    organizationId: organizationId(),
    month: text('month').notNull(),
    amount: money('amount').notNull(),
    base: money('base').notNull(),
    percent: numeric('percent', { precision: 6, scale: 2 }).notNull(),
    source: text('source').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.month] }),
    check('monthly_unit_nonnegative', sql`${t.amount}>=0`),
    check('monthly_unit_source', sql`${t.source} in ('initial','automatic','manual')`),
  ],
);

export const freebet = finance.table(
  'freebet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    bookmakerId: uuid('bookmaker_id').notNull(),
    amount: money('amount').notNull(),
    expiresOn: date('expires_on').notNull(),
    stakeReturned: boolean('stake_returned').notNull().default(false),
    usedBy: uuid('used_by'),
    note: text('note').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('freebet_positive', sql`${t.amount}>0`),
    unique('freebet_organization_id_id_idx').on(t.organizationId, t.id),
    index('freebet_bookmaker_idx').on(t.bookmakerId),
    uniqueIndex('freebet_used_by_idx').on(t.organizationId, t.usedBy),
    foreignKey({
      name: 'freebet_bookmaker_fk',
      columns: [t.organizationId, t.bookmakerId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
  ],
);

export const bet = finance.table(
  'bet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    bookmakerId: uuid('bookmaker_id').notNull(),
    tipsterId: uuid('tipster_id'),
    stake: money('stake').notNull(),
    odds: numeric('odds', { precision: 10, scale: 4 }).notNull(),
    placedAt: instant('placed_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    freebetId: uuid('freebet_id'),
    promotionalStakeReturned: boolean('promotional_stake_returned').notNull().default(false),
    reference: text('reference').notNull(),
    state: text('state').notNull().default('open'),
    remaining: money('remaining').notNull(),
    unitMonth: text('unit_month'),
    unitAmount: money('unit_amount'),
    stakeJournalId: uuid('stake_journal_id').notNull(),
  },
  (t) => [
    unique('bet_organization_id_id_idx').on(t.organizationId, t.id),
    index('bet_state_placed_idx').on(t.state, t.placedAt, t.id),
    index('bet_bookmaker_idx').on(t.bookmakerId),
    index('bet_tipster_idx').on(t.tipsterId),
    index('bet_freebet_idx').on(t.freebetId),
    index('bet_unit_idx').on(t.unitMonth),
    index('bet_stake_journal_idx').on(t.stakeJournalId),
    check('bet_positive_stake', sql`${t.stake}>0 and ${t.odds}>=1`),
    check('bet_remaining_bounds', sql`${t.remaining}>=0 and ${t.remaining}<=${t.stake}`),
    check('bet_state', sql`${t.state} in ('open','settled','cancelled')`),
    foreignKey({
      name: 'bet_bookmaker_fk',
      columns: [t.organizationId, t.bookmakerId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
    foreignKey({
      name: 'bet_tipster_fk',
      columns: [t.organizationId, t.tipsterId],
      foreignColumns: [catalog.organizationId, catalog.id],
    }),
    foreignKey({
      name: 'bet_freebet_fk',
      columns: [t.organizationId, t.freebetId],
      foreignColumns: [freebet.organizationId, freebet.id],
    }),
    foreignKey({
      name: 'bet_unit_fk',
      columns: [t.organizationId, t.unitMonth],
      foreignColumns: [monthlyUnit.organizationId, monthlyUnit.month],
    }),
    foreignKey({
      name: 'bet_stake_journal_fk',
      columns: [t.organizationId, t.stakeJournalId],
      foreignColumns: [journal.organizationId, journal.id],
    }),
  ],
);

export const betSelection = finance.table(
  'selection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    betId: uuid('bet_id').notNull(),
    position: integer('position').notNull(),
    event: text('event').notNull(),
    sport: text('sport'),
    market: text('market').notNull(),
    selection: text('selection').notNull(),
    odds: numeric('odds', { precision: 10, scale: 4 }),
    eventDate: date('event_date'),
    eventAt: instant('event_at'),
    dateStatus: text('date_status').notNull(),
    dateSource: text('date_source').notNull().default('manual'),
    dateEvidence: jsonb('date_evidence'),
    scheduleStatus: text('schedule_status').notNull().default('scheduled'),
  },
  (t) => [
    unique('selection_organization_id_id_idx').on(t.organizationId, t.id),
    uniqueIndex('selection_bet_position_idx').on(t.organizationId, t.betId, t.position),
    index('selection_event_date_idx').on(t.eventDate),
    check('selection_date_status', sql`${t.dateStatus} in ('confirmed','estimated','pending')`),
    check('selection_date_source', sql`${t.dateSource} in ('manual','thesportsdb','tavily')`),
    check(
      'selection_schedule_status',
      sql`${t.scheduleStatus} in ('scheduled','postponed','cancelled')`,
    ),
    foreignKey({
      name: 'selection_bet_fk',
      columns: [t.organizationId, t.betId],
      foreignColumns: [bet.organizationId, bet.id],
    }),
  ],
);

export const settlement = finance.table(
  'settlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    betId: uuid('bet_id').notNull(),
    outcome: text('outcome').notNull(),
    closedPrincipal: money('closed_principal').notNull(),
    realPrincipalClosed: money('real_principal_closed').notNull(),
    returnAmount: money('return_amount').notNull(),
    settledAt: instant('settled_at').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    journalId: uuid('journal_id').notNull(),
    reason: text('reason').notNull(),
  },
  (t) => [
    unique('settlement_organization_id_id_idx').on(t.organizationId, t.id),
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
    foreignKey({
      name: 'settlement_bet_fk',
      columns: [t.organizationId, t.betId],
      foreignColumns: [bet.organizationId, bet.id],
    }),
    foreignKey({
      name: 'settlement_journal_fk',
      columns: [t.organizationId, t.journalId],
      foreignColumns: [journal.organizationId, journal.id],
    }),
  ],
);
export const settlementReversal = finance.table(
  'settlement_reversal',
  {
    settlementId: uuid('settlement_id').primaryKey(),
    organizationId: organizationId(),
    journalId: uuid('journal_id').notNull(),
  },
  (t) => [
    index('settlement_reversal_journal_idx').on(t.journalId),
    foreignKey({
      name: 'settlement_reversal_settlement_fk',
      columns: [t.organizationId, t.settlementId],
      foreignColumns: [settlement.organizationId, settlement.id],
    }),
    foreignKey({
      name: 'settlement_reversal_journal_fk',
      columns: [t.organizationId, t.journalId],
      foreignColumns: [journal.organizationId, journal.id],
    }),
  ],
);

export const financialAudit = finance.table(
  'audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: organizationId(),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.organizationId, t.entityId, t.createdAt)],
);
export const commandReceipt = finance.table(
  'command_receipt',
  {
    organizationId: organizationId(),
    key: uuid('key').notNull(),
    actor: text('actor').notNull(),
    hash: text('hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);
