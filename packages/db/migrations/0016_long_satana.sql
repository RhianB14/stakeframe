ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_positive_stake";--> statement-breakpoint
ALTER TABLE "finance"."bet" DROP CONSTRAINT IF EXISTS "bet_remaining_bounds";--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "bookmaker_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "stake" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "odds" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "reference" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "remaining" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "stake_journal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD COLUMN IF NOT EXISTS "completion_state" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bet_completion_state') THEN
    ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_completion_state" CHECK ("finance"."bet"."completion_state" in ('incomplete','complete'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bet_complete_fields') THEN
    ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_complete_fields" CHECK ("finance"."bet"."completion_state"='incomplete' or ("finance"."bet"."bookmaker_id" is not null and "finance"."bet"."stake" is not null and "finance"."bet"."odds" is not null and "finance"."bet"."remaining" is not null and "finance"."bet"."stake_journal_id" is not null and "finance"."bet"."stake">0 and "finance"."bet"."odds">=1 and "finance"."bet"."remaining">=0 and "finance"."bet"."remaining"<="finance"."bet"."stake"));
  END IF;
END $$;
