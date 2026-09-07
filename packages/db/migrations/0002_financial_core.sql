CREATE SCHEMA "finance";
--> statement-breakpoint
CREATE TABLE "finance"."bet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmaker_id" uuid NOT NULL,
	"tipster_id" uuid,
	"stake" numeric(16, 2) NOT NULL,
	"odds" numeric(10, 4) NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"freebet_id" uuid,
	"promotional_stake_returned" boolean DEFAULT false NOT NULL,
	"reference" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"remaining" numeric(16, 2) NOT NULL,
	"unit_month" text,
	"unit_amount" numeric(16, 2),
	"stake_journal_id" uuid NOT NULL,
	CONSTRAINT "bet_positive_stake" CHECK ("finance"."bet"."stake">0 and "finance"."bet"."odds">=1),
	CONSTRAINT "bet_remaining_bounds" CHECK ("finance"."bet"."remaining">=0 and "finance"."bet"."remaining"<="finance"."bet"."stake"),
	CONSTRAINT "bet_state" CHECK ("finance"."bet"."state" in ('open','settled','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "finance"."selection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"event" text NOT NULL,
	"sport" text,
	"market" text NOT NULL,
	"selection" text NOT NULL,
	"odds" numeric(10, 4),
	"event_date" date,
	"event_at" timestamp with time zone,
	"date_status" text NOT NULL,
	CONSTRAINT "selection_date_status" CHECK ("finance"."selection"."date_status" in ('confirmed','estimated','pending'))
);
--> statement-breakpoint
CREATE TABLE "finance"."catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_kind" CHECK ("finance"."catalog"."kind" in ('bookmaker','tipster'))
);
--> statement-breakpoint
CREATE TABLE "finance"."catalog_alias" (
	"kind" text NOT NULL,
	"alias" text NOT NULL,
	"label" text NOT NULL,
	"catalog_id" uuid NOT NULL,
	CONSTRAINT "catalog_alias_kind_alias_pk" PRIMARY KEY("kind","alias")
);
--> statement-breakpoint
CREATE TABLE "finance"."command_receipt" (
	"key" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"bookmaker_id" uuid,
	CONSTRAINT "account_kind" CHECK ("finance"."account"."kind" in ('reserve','bookmaker','exposure','counter')),
	CONSTRAINT "account_bookmaker_required" CHECK (("finance"."account"."kind"='bookmaker')=("finance"."account"."bookmaker_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "finance"."audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."freebet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmaker_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"expires_on" date NOT NULL,
	"stake_returned" boolean DEFAULT false NOT NULL,
	"used_by" uuid,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "freebet_positive" CHECK ("finance"."freebet"."amount">0)
);
--> statement-breakpoint
CREATE TABLE "finance"."journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"reversal_of" uuid,
	"creation_transaction" text DEFAULT pg_current_xact_id()::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."monthly_unit" (
	"month" text PRIMARY KEY NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"base" numeric(16, 2) NOT NULL,
	"percent" numeric(6, 2) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_unit_nonnegative" CHECK ("finance"."monthly_unit"."amount">=0),
	CONSTRAINT "monthly_unit_source" CHECK ("finance"."monthly_unit"."source" in ('initial','automatic','manual'))
);
--> statement-breakpoint
CREATE TABLE "finance"."posting" (
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	CONSTRAINT "posting_journal_id_account_id_pk" PRIMARY KEY("journal_id","account_id"),
	CONSTRAINT "posting_nonzero" CHECK ("finance"."posting"."amount"<>0)
);
--> statement-breakpoint
CREATE TABLE "finance"."settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"unit_percent" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"opened_at" timestamp with time zone,
	CONSTRAINT "settings_singleton" CHECK ("finance"."settings"."id"=1),
	CONSTRAINT "settings_percent_range" CHECK ("finance"."settings"."unit_percent">0 and "finance"."settings"."unit_percent"<=100)
);
--> statement-breakpoint
CREATE TABLE "finance"."settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bet_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"closed_principal" numeric(16, 2) NOT NULL,
	"real_principal_closed" numeric(16, 2) NOT NULL,
	"return_amount" numeric(16, 2) NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"journal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "settlement_amounts" CHECK ("finance"."settlement"."closed_principal">0 and "finance"."settlement"."real_principal_closed">=0 and "finance"."settlement"."return_amount">=0),
	CONSTRAINT "settlement_outcome" CHECK ("finance"."settlement"."outcome" in ('win','loss','void','half_win','half_loss','cashout','partial_cashout'))
);
--> statement-breakpoint
CREATE TABLE "finance"."settlement_reversal" (
	"settlement_id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_bookmaker_id_catalog_id_fk" FOREIGN KEY ("bookmaker_id") REFERENCES "finance"."catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_tipster_id_catalog_id_fk" FOREIGN KEY ("tipster_id") REFERENCES "finance"."catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_freebet_id_freebet_id_fk" FOREIGN KEY ("freebet_id") REFERENCES "finance"."freebet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_unit_month_monthly_unit_month_fk" FOREIGN KEY ("unit_month") REFERENCES "finance"."monthly_unit"("month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_stake_journal_id_journal_id_fk" FOREIGN KEY ("stake_journal_id") REFERENCES "finance"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD CONSTRAINT "selection_bet_id_bet_id_fk" FOREIGN KEY ("bet_id") REFERENCES "finance"."bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."catalog_alias" ADD CONSTRAINT "catalog_alias_catalog_id_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "finance"."catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."account" ADD CONSTRAINT "account_bookmaker_id_catalog_id_fk" FOREIGN KEY ("bookmaker_id") REFERENCES "finance"."catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."freebet" ADD CONSTRAINT "freebet_bookmaker_id_catalog_id_fk" FOREIGN KEY ("bookmaker_id") REFERENCES "finance"."catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."freebet" ADD CONSTRAINT "freebet_used_by_bet_id_fk" FOREIGN KEY ("used_by") REFERENCES "finance"."bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."journal" ADD CONSTRAINT "journal_reversal_of_journal_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "finance"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."posting" ADD CONSTRAINT "posting_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "finance"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."posting" ADD CONSTRAINT "posting_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "finance"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement" ADD CONSTRAINT "settlement_bet_id_bet_id_fk" FOREIGN KEY ("bet_id") REFERENCES "finance"."bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement" ADD CONSTRAINT "settlement_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "finance"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement_reversal" ADD CONSTRAINT "settlement_reversal_settlement_id_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "finance"."settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."settlement_reversal" ADD CONSTRAINT "settlement_reversal_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "finance"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bet_state_placed_idx" ON "finance"."bet" USING btree ("state","placed_at","id");--> statement-breakpoint
CREATE INDEX "bet_bookmaker_idx" ON "finance"."bet" USING btree ("bookmaker_id");--> statement-breakpoint
CREATE INDEX "bet_tipster_idx" ON "finance"."bet" USING btree ("tipster_id");--> statement-breakpoint
CREATE INDEX "bet_freebet_idx" ON "finance"."bet" USING btree ("freebet_id");--> statement-breakpoint
CREATE INDEX "bet_unit_idx" ON "finance"."bet" USING btree ("unit_month");--> statement-breakpoint
CREATE INDEX "bet_stake_journal_idx" ON "finance"."bet" USING btree ("stake_journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "selection_bet_position_idx" ON "finance"."selection" USING btree ("bet_id","position");--> statement-breakpoint
CREATE INDEX "selection_event_date_idx" ON "finance"."selection" USING btree ("event_date");--> statement-breakpoint
CREATE INDEX "catalog_alias_catalog_idx" ON "finance"."catalog_alias" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_bookmaker_idx" ON "finance"."account" USING btree ("bookmaker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_system_kind_idx" ON "finance"."account" USING btree ("kind") WHERE "finance"."account"."kind"<>'bookmaker';--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "finance"."audit" USING btree ("entity_id","created_at");--> statement-breakpoint
CREATE INDEX "freebet_bookmaker_idx" ON "finance"."freebet" USING btree ("bookmaker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "freebet_used_by_idx" ON "finance"."freebet" USING btree ("used_by");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_reversal_once_idx" ON "finance"."journal" USING btree ("reversal_of");--> statement-breakpoint
CREATE INDEX "journal_effective_idx" ON "finance"."journal" USING btree ("effective_at","id");--> statement-breakpoint
CREATE INDEX "posting_account_idx" ON "finance"."posting" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "settlement_bet_idx" ON "finance"."settlement" USING btree ("bet_id");--> statement-breakpoint
CREATE INDEX "settlement_journal_idx" ON "finance"."settlement" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "settlement_reversal_journal_idx" ON "finance"."settlement_reversal" USING btree ("journal_id");
--> statement-breakpoint
INSERT INTO finance.settings(id) VALUES(1);
INSERT INTO finance.account(kind,name) VALUES ('reserve','Reserva'),('exposure','Principal em aberto'),('counter','Contrapartida');
WITH defaults(name) AS (VALUES ('Bet365'),('Superbet'),('Novibet')), inserted AS (
  INSERT INTO finance.catalog(kind,name) SELECT 'bookmaker',name FROM defaults RETURNING id,name
), aliases AS (
  INSERT INTO finance.catalog_alias(kind,alias,label,catalog_id) SELECT 'bookmaker',lower(name),name,id FROM inserted
)
INSERT INTO finance.account(kind,name,bookmaker_id) SELECT 'bookmaker',name,id FROM inserted;
--> statement-breakpoint
CREATE FUNCTION finance.immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON finance.journal FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER posting_immutable BEFORE UPDATE OR DELETE ON finance.posting FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER settlement_immutable BEFORE UPDATE OR DELETE ON finance.settlement FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER settlement_reversal_immutable BEFORE UPDATE OR DELETE ON finance.settlement_reversal FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON finance.audit FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON finance.command_receipt FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
CREATE TRIGGER monthly_unit_immutable BEFORE UPDATE OR DELETE ON finance.monthly_unit FOR EACH ROW EXECUTE FUNCTION finance.immutable_history();
--> statement-breakpoint
CREATE FUNCTION finance.posting_same_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM finance.journal WHERE id=NEW.journal_id AND creation_transaction=pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'JOURNAL_ALREADY_CLOSED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posting_transaction BEFORE INSERT ON finance.posting FOR EACH ROW EXECUTE FUNCTION finance.posting_same_transaction();
--> statement-breakpoint
CREATE FUNCTION finance.check_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT coalesce(sum(amount),0) FROM finance.posting WHERE journal_id=NEW.journal_id)<>0 THEN
    RAISE EXCEPTION 'JOURNAL_NOT_BALANCED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER posting_balanced AFTER INSERT ON finance.posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.check_balanced_journal();
