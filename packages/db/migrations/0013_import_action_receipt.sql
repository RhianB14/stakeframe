-- STK-G0-19-R9 — recibos idempotentes das ações de importação.
--
-- Forward-only e replay-safe (padrão de 0010/0011/0012). Cada operação
-- solicitada pelo usuário (alterar casa, origem ou data de uma importação)
-- registra um recibo por organização+chave: retries legítimos devolvem o
-- resultado gravado ANTES de qualquer checagem de versão, e a mesma chave com
-- conteúdo diferente conflita (IDEMPOTENCY_CONFLICT). Nada de PII: apenas
-- hash do pedido, ação e resultado sanitizado.

CREATE TABLE IF NOT EXISTS "integration"."import_action_receipt" (
	"organization_id" uuid DEFAULT current_setting('app.organization_id', true)::uuid NOT NULL,
	"key" uuid NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"hash" text NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_action_receipt_pk" PRIMARY KEY ("organization_id","key"),
	CONSTRAINT "import_action_receipt_action_check" CHECK ("integration"."import_action_receipt"."action" in ('bookmaker', 'origin', 'event'))
);--> statement-breakpoint
ALTER TABLE "integration"."import_action_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_isolation" ON "integration"."import_action_receipt";--> statement-breakpoint
CREATE POLICY "organization_isolation" ON "integration"."import_action_receipt"
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);--> statement-breakpoint
