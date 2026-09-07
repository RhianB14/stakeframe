CREATE SCHEMA "integration";
--> statement-breakpoint
CREATE TABLE "integration"."ai_usage_day" (
	"day" text PRIMARY KEY NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_nonnegative" CHECK ("integration"."ai_usage_day"."requests" >= 0)
);
--> statement-breakpoint
CREATE TABLE "integration"."inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"image" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"caption" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"extraction" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "inbox_state_check" CHECK ("integration"."inbox"."state" in ('pending', 'processing', 'review', 'failed', 'discarded', 'imported')),
	CONSTRAINT "inbox_image_size_check" CHECK (octet_length("integration"."inbox"."image") between 1 and 8388608),
	CONSTRAINT "inbox_attempts_check" CHECK ("integration"."inbox"."attempts" >= 0 and "integration"."inbox"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integration"."cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"next_offset" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inbox_state_created_idx" ON "integration"."inbox" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "inbox_image_hash_idx" ON "integration"."inbox" USING btree ("sha256");