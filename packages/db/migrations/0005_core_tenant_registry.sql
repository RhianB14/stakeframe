CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TYPE "core"."membership_role" AS ENUM('owner', 'superadmin');--> statement-breakpoint
CREATE TABLE "core"."membership" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "core"."membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "core"."organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_name_not_empty" CHECK (btrim("core"."organization"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "core"."membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "core"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_user_id_unique" ON "core"."membership" USING btree ("user_id");--> statement-breakpoint
DO $$
DECLARE
	v_user_count integer;
	v_user_name text;
	v_organization_id uuid;
BEGIN
	SELECT count(*) INTO v_user_count FROM "auth"."user";
	IF v_user_count > 1 THEN
		RAISE EXCEPTION 'STK-F1-01: more than one pre-existing user; refusing to merge users into a shared organization';
	END IF;
	IF v_user_count = 1 THEN
		SELECT btrim("name") INTO v_user_name FROM "auth"."user";
		INSERT INTO "core"."organization" ("name")
		VALUES (coalesce(nullif(v_user_name, ''), 'Fundação'))
		RETURNING "id" INTO v_organization_id;
		INSERT INTO "core"."membership" ("organization_id", "user_id", "role")
		SELECT v_organization_id, "id", 'owner' FROM "auth"."user";
	END IF;
END $$;