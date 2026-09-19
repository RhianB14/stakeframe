-- STK-G0-20 B2b/B3 — modalidade híbrida e tipster no recibo de importação.
-- Forward-only e replay-safe: o CHECK do rascunho passa a aceitar 'hibrida'
-- (valor real + crédito freebet de valor distinto) e o recibo das ações de
-- importação aceita 'tipster'. 'real'/'freebet' permanecem idênticos; nenhum
-- dado existente é reescrito.
ALTER TABLE "integration"."inbox" DROP CONSTRAINT "inbox_bet_origin_check";--> statement-breakpoint
ALTER TABLE "integration"."import_action_receipt" DROP CONSTRAINT "import_action_receipt_action_check";--> statement-breakpoint
ALTER TABLE "integration"."inbox" ADD CONSTRAINT "inbox_bet_origin_check" CHECK ("integration"."inbox"."bet_origin" is null or "integration"."inbox"."bet_origin" in ('real', 'freebet', 'hibrida'));--> statement-breakpoint
ALTER TABLE "integration"."import_action_receipt" ADD CONSTRAINT "import_action_receipt_action_check" CHECK ("integration"."import_action_receipt"."action" in ('bookmaker', 'origin', 'event', 'tipster'));