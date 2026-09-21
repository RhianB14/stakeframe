ALTER TABLE "finance"."settings" ADD COLUMN "next_ticket_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD COLUMN "ticket_number" integer;--> statement-breakpoint
WITH numbered AS (
  SELECT organization_id, id,
         row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id)::integer AS number
  FROM finance.bet
)
UPDATE finance.bet b
SET ticket_number = numbered.number
FROM numbered
WHERE numbered.organization_id = b.organization_id
  AND numbered.id = b.id;--> statement-breakpoint
ALTER TABLE "finance"."bet" ALTER COLUMN "ticket_number" SET NOT NULL;--> statement-breakpoint
UPDATE finance.settings s
SET next_ticket_number = COALESCE((
  SELECT max(b.ticket_number) + 1
  FROM finance.bet b
  WHERE b.organization_id = s.organization_id
), 1);--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_organization_id_ticket_number_idx" UNIQUE("organization_id","ticket_number");--> statement-breakpoint
ALTER TABLE "finance"."bet" ADD CONSTRAINT "bet_ticket_number_positive" CHECK ("finance"."bet"."ticket_number">0);
