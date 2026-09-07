CREATE TABLE "integration"."event_search" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"hash" text NOT NULL,
	"selection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"query" text NOT NULL,
	"event_fingerprint" text NOT NULL,
	"date_hint" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"cached_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "event_search_state" CHECK ("integration"."event_search"."state" in ('pending','processing','complete','failed')),
	CONSTRAINT "event_search_provider" CHECK ("integration"."event_search"."provider" in ('thesportsdb','tavily'))
);
--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD COLUMN "date_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD COLUMN "date_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD COLUMN "schedule_status" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
CREATE INDEX "event_search_selection_idx" ON "integration"."event_search" USING btree ("selection_id","created_at");--> statement-breakpoint
CREATE INDEX "event_search_cache_idx" ON "integration"."event_search" USING btree ("provider","event_fingerprint","date_hint","completed_at");--> statement-breakpoint
CREATE INDEX "event_search_queue_idx" ON "integration"."event_search" USING btree ("created_at") WHERE "integration"."event_search"."state"='pending';--> statement-breakpoint
CREATE INDEX "event_search_usage_idx" ON "integration"."event_search" USING btree ("provider","started_at") WHERE "integration"."event_search"."started_at" is not null;--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD CONSTRAINT "selection_date_source" CHECK ("finance"."selection"."date_source" in ('manual','thesportsdb','tavily'));--> statement-breakpoint
ALTER TABLE "finance"."selection" ADD CONSTRAINT "selection_schedule_status" CHECK ("finance"."selection"."schedule_status" in ('scheduled','postponed','cancelled'));