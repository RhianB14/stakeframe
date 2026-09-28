-- STK-F2-10 — freebets: requisitos, preferências de notificação e fila de alertas.
--
-- Numeração 0021 (e não 0020): a 0020 do main é a auditoria do painel interno
-- (STK-F2-11). A renomeação veio do conflito de journal do rebase sobre e9afb48.
--
-- Forward-only e replay-safe (IF NOT EXISTS / DROP ... IF EXISTS), no mesmo padrão
-- da 0010 e da 0011. Esta migração é LOCAL: nada é executado em produção sem o
-- fluxo de autorização, backup e recuperação do runbook.
--
-- 1) finance.freebet ganha `requirements` (jsonb) e `updated_at`: o registro de
--    freebet passa a guardar os requisitos relevantes do bônus (§8.7) de forma
--    estruturada, para que a calculadora de valor efetivo possa verificá-los sem
--    interpretar texto livre. A coluna nova é nullable — linhas existentes ficam
--    com lista vazia em tempo de leitura, sem backfill destrutivo.
--
-- 2) schema `notification` (novo): `preference` (por USUÁRIO, com timezone e
--    quiet hours) e `outbox` (fila durável com chave de deduplicação). As duas
--    tabelas são privadas: RLS habilitada e política por organização, sempre com
--    predicado explícito `organization_id = current_setting(...)`.

-- ---------------------------------------------------------------- freebets
ALTER TABLE "finance"."freebet" ADD COLUMN IF NOT EXISTS "requirements" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "finance"."freebet" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Revogação é soft-delete auditável: a linha sai da lista e do alerta, mas
-- permanece no histórico. NULL = nunca revogada (não confundir com `used_by`,
-- que pertence à máquina financeira do consumo do crédito).
ALTER TABLE "finance"."freebet" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "freebet_expiry_idx" ON "finance"."freebet" USING btree ("organization_id","expires_on") WHERE "finance"."freebet"."used_by" is null AND "finance"."freebet"."revoked_at" is null;--> statement-breakpoint

-- ---------------------------------------------------------- notification
CREATE SCHEMA IF NOT EXISTS "notification";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification"."preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"user_id" text NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"quiet_hours_start" integer DEFAULT 1320 NOT NULL,
	"quiet_hours_end" integer DEFAULT 360 NOT NULL,
	"topics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_quiet_hours_check" CHECK (("notification"."preference"."quiet_hours_start" between 0 and 1439) and ("notification"."preference"."quiet_hours_end" between 0 and 1439)),
	CONSTRAINT "notification_preference_timezone_check" CHECK (char_length("notification"."preference"."timezone") between 1 and 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preference_user_idx" ON "notification"."preference" USING btree ("organization_id","user_id");
CREATE TABLE IF NOT EXISTS "notification"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"subject_id" uuid,
	"window" text DEFAULT 'default' NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "notification_outbox_topic_check" CHECK ("notification"."outbox"."topic" in ('bet_settled','review_pending','freebet_expiring')),
	CONSTRAINT "notification_outbox_state_check" CHECK ("notification"."outbox"."state" in ('pending','delivered','skipped_quiet_hours','failed','cancelled')),
	CONSTRAINT "notification_outbox_attempts_check" CHECK (("notification"."outbox"."attempts" >= 0) and char_length("notification"."outbox"."window") between 1 and 16),
	CONSTRAINT "notification_outbox_organization_id_id_idx" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_dedupe_idx" ON "notification"."outbox" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_due_idx" ON "notification"."outbox" USING btree ("state","scheduled_for");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_subject_idx" ON "notification"."outbox" USING btree ("organization_id","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_user_idx" ON "notification"."outbox" USING btree ("organization_id","user_id","created_at");

-- SEM FK para core.membership (decisão deliberada): `tenant-context.test.ts`
-- derruba core.membership para simular falha de lookup e `tenant-registry`
-- derruba o schema core no replay — uma FK para lá recusaria os dois
-- ("cannot drop table because other objects depend on it"). O vínculo
-- usuário↔organização é o de core.membership, validado na aplicação; a defesa
-- de isolamento é o predicado explícito de organização, não a FK.
--
-- RLS: isolamento por organização, fail-closed sem contexto (nullif '' → NULL).
-- As políticas são profundidade para um papel futuro; a defesa efetiva são os
-- predicados explícitos no código, porque o papel de conexão é dono/superusuário.
ALTER TABLE "notification"."preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "notification"."preference";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "notification"."preference"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notification"."outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "notification"."outbox";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "notification"."outbox"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
