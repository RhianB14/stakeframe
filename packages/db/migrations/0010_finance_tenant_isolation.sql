-- STK-F1-13 — multi-tenant isolation of the financial core and private import artifacts.
--
-- Forward-only. Replay-safe (the tenant-registry harness rebuilds `core` and replays 0005+):
-- every structural statement drops before creating, columns are added with IF NOT EXISTS, and the
-- backfill tolerates a replay where the founding organization was recreated with a new id.
--
-- The organization context used while the columns are added is the transaction-local setting
-- (`app.organization_id`), the same value the RLS policies read. Existing rows are backfilled by
-- the ADD COLUMN default itself, which never touches rows (immutability triggers on journal,
-- posting, settlement, settlement_reversal, audit, command_receipt and monthly_unit stay inert).
-- Without a founding organization (fresh database before any client) only the untouched default
-- seed of migration 0002 is cleared and the migration applies over empty tables.

-- Replay: leave every table without forced RLS while the backfill and constraints run.
ALTER TABLE "finance"."settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."catalog" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."catalog_alias" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."account" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."journal" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."posting" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."monthly_unit" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."freebet" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."bet" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."selection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."settlement" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."settlement_reversal" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."audit" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "finance"."command_receipt" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration"."attachment" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration"."inbox" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration"."extraction_request" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration"."event_search" NO FORCE ROW LEVEL SECURITY;

-- Founding organization: the organization of the oldest `owner` membership (deterministic).
-- The transaction-local context feeds the ADD COLUMN defaults below; no UPDATE ever runs before
-- the columns exist, and immutable history is never rewritten.
DO $$
DECLARE founder uuid;
BEGIN
  SELECT m.organization_id INTO founder
  FROM core.membership m WHERE m.role = 'owner'
  ORDER BY m.created_at ASC, m.organization_id ASC
  LIMIT 1;
  IF founder IS NULL THEN
    -- No client ever used this database: refuse to orphan operational history, otherwise clear
    -- the untouched 0002 seed so every column can be added over empty tables.
    IF EXISTS (SELECT 1 FROM finance.journal)
       OR EXISTS (SELECT 1 FROM finance.bet)
       OR EXISTS (SELECT 1 FROM finance.settlement)
       OR EXISTS (SELECT 1 FROM finance.settlement_reversal)
       OR EXISTS (SELECT 1 FROM finance.audit)
       OR EXISTS (SELECT 1 FROM finance.command_receipt)
       OR EXISTS (SELECT 1 FROM finance.monthly_unit)
       OR EXISTS (SELECT 1 FROM finance.freebet)
       OR EXISTS (SELECT 1 FROM finance.selection)
       OR EXISTS (SELECT 1 FROM finance.posting)
    THEN
      RAISE EXCEPTION 'STK-F1-13: financial history without a founding organization';
    END IF;
    DELETE FROM finance.catalog_alias;
    DELETE FROM finance.account;
    DELETE FROM finance.catalog;
    DELETE FROM finance.settings;
    RETURN;
  END IF;
  PERFORM set_config('app.organization_id', founder::text, true);
END $$;

ALTER TABLE "finance"."settings" DROP CONSTRAINT IF EXISTS "settings_singleton";--> statement-breakpoint
ALTER TABLE "integration"."extraction_request" DROP CONSTRAINT IF EXISTS "extraction_request_inbox_id_inbox_id_fk";
--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_attachment_id_attachment_id_fk";
--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_imported_bet_id_bet_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_bookmaker_id_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_tipster_id_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_freebet_id_freebet_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_unit_month_monthly_unit_month_fk";
--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_stake_journal_id_journal_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."selection" DROP CONSTRAINT IF EXISTS "selection_bet_id_bet_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."catalog_alias" DROP CONSTRAINT IF EXISTS "catalog_alias_catalog_id_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."account" DROP CONSTRAINT IF EXISTS "account_bookmaker_id_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."freebet" DROP CONSTRAINT IF EXISTS "freebet_bookmaker_id_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."freebet" DROP CONSTRAINT IF EXISTS "freebet_used_by_bet_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."journal" DROP CONSTRAINT IF EXISTS "journal_reversal_of_journal_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."posting" DROP CONSTRAINT IF EXISTS "posting_journal_id_journal_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."posting" DROP CONSTRAINT IF EXISTS "posting_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."settlement" DROP CONSTRAINT IF EXISTS "settlement_bet_id_bet_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."settlement" DROP CONSTRAINT IF EXISTS "settlement_journal_id_journal_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."settlement_reversal" DROP CONSTRAINT IF EXISTS "settlement_reversal_settlement_id_settlement_id_fk";
--> statement-breakpoint
ALTER TABLE "finance"."settlement_reversal" DROP CONSTRAINT IF EXISTS "settlement_reversal_journal_id_journal_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "integration"."attachment_live_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."selection_bet_position_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."account_bookmaker_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."account_system_kind_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."audit_entity_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."freebet_used_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "finance"."journal_reversal_once_idx";--> statement-breakpoint
ALTER TABLE "finance"."catalog_alias" DROP CONSTRAINT IF EXISTS "catalog_alias_kind_alias_pk";--> statement-breakpoint
ALTER TABLE "finance"."posting" DROP CONSTRAINT IF EXISTS "posting_journal_id_account_id_pk";--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'finance'
                AND table_name = 'command_receipt'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

ALTER TABLE "finance"."command_receipt" DROP CONSTRAINT IF EXISTS "command_receipt_pkey";--> statement-breakpoint
/* 
    Unfortunately in current drizzle-kit version we can't automatically get name for primary key.
    We are working on making it available!

    Meanwhile you can:
        1. Check pk name in your database, by running
            SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema = 'finance'
                AND table_name = 'monthly_unit'
                AND constraint_type = 'PRIMARY KEY';
        2. Uncomment code below and paste pk name manually
        
    Hope to release this update as soon as possible
*/

ALTER TABLE "finance"."monthly_unit" DROP CONSTRAINT IF EXISTS "monthly_unit_pkey";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'finance' AND c.relname = 'settings' AND a.attname = 'id' AND a.attidentity = ''
  ) THEN
    EXECUTE 'ALTER TABLE "finance"."settings" ALTER COLUMN "id" DROP DEFAULT';
    EXECUTE 'ALTER TABLE "finance"."settings" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (sequence name "finance"."settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1)';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integration"."attachment" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."extraction_request" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."catalog" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."catalog_alias" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."command_receipt" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."account" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."audit" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."freebet" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."journal" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."monthly_unit" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."posting" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."settings" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."settlement" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."settlement_reversal" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."event_search" ADD COLUMN IF NOT EXISTS "organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='catalog_alias_organization_id_kind_alias_pk' AND conrelid='finance.catalog_alias'::regclass) THEN ALTER TABLE "finance"."catalog_alias" ADD CONSTRAINT "catalog_alias_organization_id_kind_alias_pk" PRIMARY KEY("organization_id","kind","alias"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='command_receipt_organization_id_key_pk' AND conrelid='finance.command_receipt'::regclass) THEN ALTER TABLE "finance"."command_receipt" ADD CONSTRAINT "command_receipt_organization_id_key_pk" PRIMARY KEY("organization_id","key"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monthly_unit_organization_id_month_pk' AND conrelid='finance.monthly_unit'::regclass) THEN ALTER TABLE "finance"."monthly_unit" ADD CONSTRAINT "monthly_unit_organization_id_month_pk" PRIMARY KEY("organization_id","month"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='posting_organization_id_journal_id_account_id_pk' AND conrelid='finance.posting'::regclass) THEN ALTER TABLE "finance"."posting" ADD CONSTRAINT "posting_organization_id_journal_id_account_id_pk" PRIMARY KEY("organization_id","journal_id","account_id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='attachment_organization_id_id_idx' AND conrelid='integration.attachment'::regclass) THEN ALTER TABLE "integration"."attachment" ADD CONSTRAINT "attachment_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_organization_id_id_idx' AND conrelid='integration.inbox'::regclass) THEN ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_organization_id_id_idx' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='selection_organization_id_id_idx' AND conrelid='finance.selection'::regclass) THEN ALTER TABLE "finance"."selection" ADD CONSTRAINT "selection_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='catalog_organization_id_id_idx' AND conrelid='finance.catalog'::regclass) THEN ALTER TABLE "finance"."catalog" ADD CONSTRAINT "catalog_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_organization_id_id_idx' AND conrelid='finance.account'::regclass) THEN ALTER TABLE "finance"."account" ADD CONSTRAINT "account_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='freebet_organization_id_id_idx' AND conrelid='finance.freebet'::regclass) THEN ALTER TABLE "finance"."freebet" ADD CONSTRAINT "freebet_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='journal_organization_id_id_idx' AND conrelid='finance.journal'::regclass) THEN ALTER TABLE "finance"."journal" ADD CONSTRAINT "journal_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settings_organization_id_unique' AND conrelid='finance.settings'::regclass) THEN ALTER TABLE "finance"."settings" ADD CONSTRAINT "settings_organization_id_unique" UNIQUE("organization_id"); END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settlement_organization_id_id_idx' AND conrelid='finance.settlement'::regclass) THEN ALTER TABLE "finance"."settlement" ADD CONSTRAINT "settlement_organization_id_id_idx" UNIQUE("organization_id","id"); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='extraction_request_inbox_fk' AND conrelid='integration.extraction_request'::regclass) THEN ALTER TABLE "integration"."extraction_request" ADD CONSTRAINT "extraction_request_inbox_fk" FOREIGN KEY ("organization_id","inbox_id") REFERENCES "integration"."inbox"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_attachment_fk' AND conrelid='integration.inbox'::regclass) THEN ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_attachment_fk" FOREIGN KEY ("organization_id","attachment_id") REFERENCES "integration"."attachment"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inbox_imported_bet_fk' AND conrelid='integration.inbox'::regclass) THEN ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_imported_bet_fk" FOREIGN KEY ("organization_id","imported_bet_id") REFERENCES "finance"."bet"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_bookmaker_fk' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_bookmaker_fk" FOREIGN KEY ("organization_id","bookmaker_id") REFERENCES "finance"."catalog"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_tipster_fk' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_tipster_fk" FOREIGN KEY ("organization_id","tipster_id") REFERENCES "finance"."catalog"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_freebet_fk' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_freebet_fk" FOREIGN KEY ("organization_id","freebet_id") REFERENCES "finance"."freebet"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_unit_fk' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_unit_fk" FOREIGN KEY ("organization_id","unit_month") REFERENCES "finance"."monthly_unit"("organization_id","month") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bet_stake_journal_fk' AND conrelid='finance.bet'::regclass) THEN ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_stake_journal_fk" FOREIGN KEY ("organization_id","stake_journal_id") REFERENCES "finance"."journal"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='selection_bet_fk' AND conrelid='finance.selection'::regclass) THEN ALTER TABLE "finance"."selection" ADD CONSTRAINT "selection_bet_fk" FOREIGN KEY ("organization_id","bet_id") REFERENCES "finance"."bet"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='catalog_alias_catalog_fk' AND conrelid='finance.catalog_alias'::regclass) THEN ALTER TABLE "finance"."catalog_alias" ADD CONSTRAINT "catalog_alias_catalog_fk" FOREIGN KEY ("organization_id","catalog_id") REFERENCES "finance"."catalog"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_bookmaker_fk' AND conrelid='finance.account'::regclass) THEN ALTER TABLE "finance"."account" ADD CONSTRAINT "account_bookmaker_fk" FOREIGN KEY ("organization_id","bookmaker_id") REFERENCES "finance"."catalog"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='freebet_bookmaker_fk' AND conrelid='finance.freebet'::regclass) THEN ALTER TABLE "finance"."freebet" ADD CONSTRAINT "freebet_bookmaker_fk" FOREIGN KEY ("organization_id","bookmaker_id") REFERENCES "finance"."catalog"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='journal_reversal_fk' AND conrelid='finance.journal'::regclass) THEN ALTER TABLE "finance"."journal" ADD CONSTRAINT "journal_reversal_fk" FOREIGN KEY ("organization_id","reversal_of") REFERENCES "finance"."journal"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='posting_journal_fk' AND conrelid='finance.posting'::regclass) THEN ALTER TABLE "finance"."posting" ADD CONSTRAINT "posting_journal_fk" FOREIGN KEY ("organization_id","journal_id") REFERENCES "finance"."journal"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='posting_account_fk' AND conrelid='finance.posting'::regclass) THEN ALTER TABLE "finance"."posting" ADD CONSTRAINT "posting_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "finance"."account"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settings_organization_id_organization_id_fk' AND conrelid='finance.settings'::regclass) THEN ALTER TABLE "finance"."settings" ADD CONSTRAINT "settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "core"."organization"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settlement_bet_fk' AND conrelid='finance.settlement'::regclass) THEN ALTER TABLE "finance"."settlement" ADD CONSTRAINT "settlement_bet_fk" FOREIGN KEY ("organization_id","bet_id") REFERENCES "finance"."bet"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settlement_journal_fk' AND conrelid='finance.settlement'::regclass) THEN ALTER TABLE "finance"."settlement" ADD CONSTRAINT "settlement_journal_fk" FOREIGN KEY ("organization_id","journal_id") REFERENCES "finance"."journal"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settlement_reversal_settlement_fk' AND conrelid='finance.settlement_reversal'::regclass) THEN ALTER TABLE "finance"."settlement_reversal" ADD CONSTRAINT "settlement_reversal_settlement_fk" FOREIGN KEY ("organization_id","settlement_id") REFERENCES "finance"."settlement"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='settlement_reversal_journal_fk' AND conrelid='finance.settlement_reversal'::regclass) THEN ALTER TABLE "finance"."settlement_reversal" ADD CONSTRAINT "settlement_reversal_journal_fk" FOREIGN KEY ("organization_id","journal_id") REFERENCES "finance"."journal"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_search_selection_fk' AND conrelid='integration.event_search'::regclass) THEN ALTER TABLE "integration"."event_search" ADD CONSTRAINT "event_search_selection_fk" FOREIGN KEY ("organization_id","selection_id") REFERENCES "finance"."selection"("organization_id","id") ON DELETE no action ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "attachment_live_hash_idx";
CREATE UNIQUE INDEX "attachment_live_hash_idx" ON "integration"."attachment" USING btree ("organization_id","sha256") WHERE "integration"."attachment"."state" not in ('deleting','deleted');--> statement-breakpoint
DROP INDEX IF EXISTS "selection_bet_position_idx";
CREATE UNIQUE INDEX "selection_bet_position_idx" ON "finance"."selection" USING btree ("organization_id","bet_id","position");--> statement-breakpoint
DROP INDEX IF EXISTS "account_bookmaker_idx";
CREATE UNIQUE INDEX "account_bookmaker_idx" ON "finance"."account" USING btree ("organization_id","bookmaker_id");--> statement-breakpoint
DROP INDEX IF EXISTS "account_system_kind_idx";
CREATE UNIQUE INDEX "account_system_kind_idx" ON "finance"."account" USING btree ("organization_id","kind") WHERE "finance"."account"."kind"<>'bookmaker';--> statement-breakpoint
DROP INDEX IF EXISTS "audit_entity_idx";
CREATE INDEX "audit_entity_idx" ON "finance"."audit" USING btree ("organization_id","entity_id","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "freebet_used_by_idx";
CREATE UNIQUE INDEX "freebet_used_by_idx" ON "finance"."freebet" USING btree ("organization_id","used_by");--> statement-breakpoint
DROP INDEX IF EXISTS "journal_reversal_once_idx";
CREATE UNIQUE INDEX "journal_reversal_once_idx" ON "finance"."journal" USING btree ("organization_id","reversal_of");--> statement-breakpoint
-- Replay: re-point rows left orphaned by a recreated founding organization. Only mutable tables
-- are touched; immutable history (journal, posting, settlement, settlement_reversal, audit,
-- command_receipt, monthly_unit) cannot be rewritten by design and keeps its original reference.
DO $$
DECLARE founder uuid;
BEGIN
  SELECT m.organization_id INTO founder
  FROM core.membership m WHERE m.role = 'owner'
  ORDER BY m.created_at ASC, m.organization_id ASC
  LIMIT 1;
  IF founder IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.organization_id', founder::text, true);
  UPDATE finance.settings SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.catalog SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.catalog_alias SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.account SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.freebet SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.bet SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE finance.selection SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE integration.attachment SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE integration.inbox SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE integration.extraction_request SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
  UPDATE integration.event_search SET organization_id = founder
    WHERE organization_id IS NULL OR organization_id <> founder;
END $$;



-- Fail-closed row-level security. FORCE reaches the table owner (the application role);
-- without a context `current_setting(..., true)` is NULL and the expression matches no row,
-- and writes are refused by WITH CHECK. `cursor` and `ai_usage_day` stay global infrastructure.
ALTER TABLE "finance"."settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."settings";
CREATE POLICY "organization_isolation" ON "finance"."settings"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."catalog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."catalog";
CREATE POLICY "organization_isolation" ON "finance"."catalog"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."catalog_alias" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."catalog_alias";
CREATE POLICY "organization_isolation" ON "finance"."catalog_alias"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."account" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."account";
CREATE POLICY "organization_isolation" ON "finance"."account"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."journal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."journal";
CREATE POLICY "organization_isolation" ON "finance"."journal"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."posting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."posting";
CREATE POLICY "organization_isolation" ON "finance"."posting"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."monthly_unit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."monthly_unit";
CREATE POLICY "organization_isolation" ON "finance"."monthly_unit"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."freebet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."freebet";
CREATE POLICY "organization_isolation" ON "finance"."freebet"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."bet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."bet";
CREATE POLICY "organization_isolation" ON "finance"."bet"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."selection" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."selection";
CREATE POLICY "organization_isolation" ON "finance"."selection"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."settlement" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."settlement";
CREATE POLICY "organization_isolation" ON "finance"."settlement"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."settlement_reversal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."settlement_reversal";
CREATE POLICY "organization_isolation" ON "finance"."settlement_reversal"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."audit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."audit";
CREATE POLICY "organization_isolation" ON "finance"."audit"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "finance"."command_receipt" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "finance"."command_receipt";
CREATE POLICY "organization_isolation" ON "finance"."command_receipt"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "integration"."attachment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."attachment";
CREATE POLICY "organization_isolation" ON "integration"."attachment"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "integration"."inbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."inbox";
CREATE POLICY "organization_isolation" ON "integration"."inbox"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "integration"."extraction_request" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."extraction_request";
CREATE POLICY "organization_isolation" ON "integration"."extraction_request"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
ALTER TABLE "integration"."event_search" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."event_search";
CREATE POLICY "organization_isolation" ON "integration"."event_search"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
