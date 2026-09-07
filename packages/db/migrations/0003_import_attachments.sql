CREATE TABLE "integration"."attachment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"image" "bytea",
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"state" text DEFAULT 'local' NOT NULL,
	"object_key" text NOT NULL,
	"remote_attempted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "attachment_state_check" CHECK ("integration"."attachment"."state" in ('local','remote','deleting','deleted')),
	CONSTRAINT "attachment_size_check" CHECK ("integration"."attachment"."size" between 1 and 8388608)
);
--> statement-breakpoint
CREATE TABLE "integration"."extraction_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inbox_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration"."inbox" ALTER COLUMN "image" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN "attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN "imported_bet_id" uuid;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "integration"."extraction_request" ADD CONSTRAINT "extraction_request_inbox_id_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "integration"."inbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_live_hash_idx" ON "integration"."attachment" USING btree ("sha256") WHERE "integration"."attachment"."state" not in ('deleting','deleted');--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "integration"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_imported_bet_id_bet_id_fk" FOREIGN KEY ("imported_bet_id") REFERENCES "finance"."bet"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_attachment_idx" ON "integration"."inbox" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "inbox_imported_bet_idx" ON "integration"."inbox" USING btree ("imported_bet_id");
--> statement-breakpoint
INSERT INTO integration.attachment(id,sha256,image,mime,size,object_key,created_at)
SELECT id,sha256,image,CASE WHEN substring(image from 1 for 4)=decode('89504e47','hex') THEN 'image/png' ELSE 'image/jpeg' END,
octet_length(image),'tickets/'||id::text,created_at
FROM (SELECT DISTINCT ON (sha256) * FROM integration.inbox ORDER BY sha256,created_at,id) original;
--> statement-breakpoint
UPDATE integration.inbox i SET attachment_id=a.id,image=null FROM integration.attachment a WHERE a.sha256=i.sha256;
