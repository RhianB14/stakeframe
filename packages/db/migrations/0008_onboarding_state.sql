CREATE TABLE "core"."onboarding_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"timezone" text,
	"profile_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_state_timezone_not_empty" CHECK ("core"."onboarding_state"."timezone" is null or btrim("core"."onboarding_state"."timezone") <> '')
);
--> statement-breakpoint
ALTER TABLE "core"."onboarding_state" ADD CONSTRAINT "onboarding_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."onboarding_state" ADD CONSTRAINT "onboarding_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "core"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_state_organization_idx" ON "core"."onboarding_state" USING btree ("organization_id");