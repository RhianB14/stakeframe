-- STK-G0-19-R7 — escolha explícita de casa pelo usuário no rascunho.
--
-- Forward-only e replay-safe, no mesmo padrão da 0011. O usuário pode ajustar a
-- casa do rascunho pelo Mini App (seção "Alterar Casa"); a escolha é validada
-- sob lock (organização, catálogo ativo) e revalida o crédito freebet associado.
-- Nenhuma semântica existente é reaproveitada: a coluna é exclusiva da escolha
-- declarada e nunca substitui a casa lida da legenda/extração.

ALTER TABLE "integration"."inbox" ADD COLUMN IF NOT EXISTS "bookmaker_override_id" uuid;--> statement-breakpoint
ALTER TABLE "integration"."inbox" DROP CONSTRAINT IF EXISTS "inbox_bookmaker_override_fk";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_bookmaker_override_fk" FOREIGN KEY ("organization_id","bookmaker_override_id") REFERENCES "finance"."catalog"("organization_id","id");--> statement-breakpoint
