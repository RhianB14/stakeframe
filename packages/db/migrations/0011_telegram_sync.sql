-- STK-G0-19-R5 — fluxo definitivo de importação Telegram/Web.
--
-- Forward-only e replay-safe (Idempotente: IF NOT EXISTS / DROP ... IF EXISTS),
-- no mesmo padrão da 0010. integration.inbox ganha os campos canônicos do
-- rascunho (origem financeira declarada pelo usuário e datas com semânticas
-- separadas) e o vínculo privado com o Telegram. integration.telegram_outbox é
-- a fila idempotente de operações Telegram (envio/edição/exclusão) executada
-- pelo worker depois do commit canônico.

ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "bet_origin" text;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "freebet_id" uuid;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "event_date_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_source_message_id" bigint;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_processing_message_id" bigint;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_result_message_id" bigint;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_sync_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_synced_version" integer;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "telegram_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_bet_origin_check";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_bet_origin_check" CHECK ("integration"."inbox"."bet_origin" is null or "integration"."inbox"."bet_origin" in ('real', 'freebet'));--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_event_date_check";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_event_date_check" CHECK ("integration"."inbox"."event_date_status" in ('pending', 'confirmed') and ("integration"."inbox"."event_date_status" = 'pending' or "integration"."inbox"."event_at" is not null));--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_telegram_sync_state_check";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_telegram_sync_state_check" CHECK ("integration"."inbox"."telegram_sync_state" in ('none', 'pending', 'synced', 'failed', 'deleted'));--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_freebet_fk";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_freebet_fk" FOREIGN KEY ("organization_id","freebet_id") REFERENCES "finance"."freebet"("organization_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_telegram_source_idx" ON "integration"."inbox" USING btree ("organization_id","telegram_source_message_id") WHERE "integration"."inbox"."telegram_source_message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_telegram_result_idx" ON "integration"."inbox" USING btree ("organization_id","telegram_result_message_id") WHERE "integration"."inbox"."telegram_result_message_id" is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration"."telegram_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "telegram_outbox_operation_check" CHECK ("integration"."telegram_outbox"."operation" in ('send_processing_message', 'send_result_message', 'edit_result_message', 'delete_processing_message', 'delete_source_message', 'delete_result_message')),
	CONSTRAINT "telegram_outbox_state_check" CHECK ("integration"."telegram_outbox"."state" in ('pending', 'processing', 'done', 'failed', 'skipped')),
	CONSTRAINT "telegram_outbox_attempts_check" CHECK ("integration"."telegram_outbox"."attempts" >= 0 and "integration"."telegram_outbox"."version" > 0),
	CONSTRAINT "telegram_outbox_organization_id_id_idx" UNIQUE("organization_id","id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_outbox_idempotency_idx" ON "integration"."telegram_outbox" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_due_idx" ON "integration"."telegram_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_outbox_inbox_idx" ON "integration"."telegram_outbox" USING btree ("organization_id","inbox_id");--> statement-breakpoint
ALTER TABLE "integration"."telegram_outbox" DROP CONSTRAINT IF EXISTS "telegram_outbox_inbox_fk";--> statement-breakpoint
ALTER TABLE "integration"."telegram_outbox" ADD CONSTRAINT "telegram_outbox_inbox_fk" FOREIGN KEY ("organization_id","inbox_id") REFERENCES "integration"."inbox"("organization_id","id");--> statement-breakpoint
