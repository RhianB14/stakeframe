CREATE TYPE "core"."beta_invitation_status" AS ENUM('pending', 'accepted', 'revoked');--> statement-breakpoint
CREATE TABLE "core"."beta_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "core"."beta_invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beta_invitation_email_not_empty" CHECK (btrim("core"."beta_invitation"."email") <> '')
);
--> statement-breakpoint
ALTER TABLE "core"."beta_invitation" ADD CONSTRAINT "beta_invitation_accepted_user_id_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invitation_token_hash_key" ON "core"."beta_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "beta_invitation_pending_email_key" ON "core"."beta_invitation" USING btree ("email") WHERE "core"."beta_invitation"."status" = 'pending';