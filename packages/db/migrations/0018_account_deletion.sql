CREATE TYPE "core"."account_deletion_state" AS ENUM('pending', 'cancelled', 'purged');--> statement-breakpoint
CREATE TABLE "core"."account_deletion" (
	"user_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"state" "core"."account_deletion_state" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."account_deletion" ADD CONSTRAINT "account_deletion_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletion_organization_idx" ON "core"."account_deletion" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_deletion_due_idx" ON "core"."account_deletion" USING btree ("state","expires_at");